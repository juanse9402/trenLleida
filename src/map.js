/**
 * map.js — Google Maps integration for RouteMaker GPS
 *
 * Provides a CarPlay-style live navigation view centered on the vehicle.
 * - Lazy-loads the Google Maps JS API only when needed (reduces billable loads)
 * - Auto-follows the vehicle using existing gps:distance events (no duplicate watchPosition)
 * - Heading-aware vehicle marker that rotates with direction of travel
 * - Marks ONLY the next immediate stop (not the full route)
 * - Full offline fallback — GPS/audio continue working without the map
 * - Adapts palette when light-mode class is toggled on body
 */

// ─── Map State ────────────────────────────────────────────────────────────────

let _map            = null;
let _vehicleMarker  = null;
let _nextStopMarker = null;
let _containerEl    = null;
let _initialized    = false;
let _themeObserver  = null;

// ─── Custom Map Styles ────────────────────────────────────────────────────────

/** Dark palette matching the app's carbón/crema identity */
const STYLE_DARK = [
  { elementType: 'geometry',            stylers: [{ color: '#1A1511' }] },
  { elementType: 'labels.text.fill',    stylers: [{ color: '#8E8369' }] },
  { elementType: 'labels.text.stroke',  stylers: [{ color: '#120F0C' }] },

  { featureType: 'road',
    elementType: 'geometry',            stylers: [{ color: '#2C2418' }] },
  { featureType: 'road',
    elementType: 'geometry.stroke',     stylers: [{ color: '#1A1511' }] },
  { featureType: 'road',
    elementType: 'labels.text.fill',    stylers: [{ color: '#C9BFA9' }] },

  { featureType: 'road.highway',
    elementType: 'geometry',            stylers: [{ color: '#3D3025' }] },
  { featureType: 'road.highway',
    elementType: 'geometry.stroke',     stylers: [{ color: '#2C2418' }] },
  { featureType: 'road.highway',
    elementType: 'labels.text.fill',    stylers: [{ color: '#EDE6D6' }] },

  { featureType: 'water',
    elementType: 'geometry',            stylers: [{ color: '#0D1A24' }] },
  { featureType: 'water',
    elementType: 'labels.text.fill',    stylers: [{ color: '#3A5572' }] },

  { featureType: 'poi',                 stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park',
    elementType: 'geometry',            stylers: [{ color: '#131D10' }, { visibility: 'on' }] },
  { featureType: 'transit',             stylers: [{ visibility: 'off' }] },

  { featureType: 'administrative',
    elementType: 'geometry',            stylers: [{ color: '#3D3324' }] },
  { featureType: 'administrative.locality',
    elementType: 'labels.text.fill',    stylers: [{ color: '#C9BFA9' }] },
  { featureType: 'administrative.neighborhood',
    elementType: 'labels.text.fill',    stylers: [{ color: '#8E8369' }] },
];

/** Light palette for daytime / high-contrast mode */
const STYLE_LIGHT = [
  { featureType: 'poi',    stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road',
    elementType: 'labels.text.fill',   stylers: [{ color: '#241C12' }] },
  { featureType: 'road.highway',
    elementType: 'geometry',           stylers: [{ color: '#D6CAA9' }] },
  { featureType: 'road.highway',
    elementType: 'labels.text.fill',   stylers: [{ color: '#241C12' }] },
  { featureType: 'administrative.locality',
    elementType: 'labels.text.fill',   stylers: [{ color: '#4A3D26' }] },
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the map inside `containerEl`.
 * No-ops if already initialized or if containerEl has no #googleMap child.
 * @param {HTMLElement} containerEl  — the .cluster-card wrapper
 */
export async function initMap(containerEl) {
  _containerEl = containerEl;

  if (!navigator.onLine) {
    _showFallback('📡', 'Mapa no disponible sin conexión',
      'El mapa requiere datos móviles o Wi-Fi.<br>El GPS y el audio siguen funcionando con normalidad.');
    window.addEventListener('online', _onOnline, { once: true });
    return;
  }

  const key = window.GOOGLE_MAPS_KEY;
  if (!key) {
    _showFallback('🗺️', 'Mapa no configurado',
      'Variable de entorno GOOGLE_MAPS_KEY no encontrada.<br>Configúrala en Netlify y redespliega.');
    return;
  }

  try {
    await _loadScript(key);
    _createMap();
    _wireGPSEvents();
  } catch (err) {
    console.error('[Map] Error al cargar Google Maps:', err);
    _showFallback('⚠️', 'Error al cargar el mapa',
      'Comprueba la conexión o la API key.');
  }
}

/**
 * Update the vehicle marker position and heading.
 * Called by the gps:distance event listener (wired internally).
 * @param {number} lat
 * @param {number} lng
 * @param {number} heading  — degrees clockwise from north (0-360)
 */
export function updateMapPosition(lat, lng, heading) {
  if (!_initialized || !_map) return;
  const pos = { lat, lng };
  _map.panTo(pos);
  if (_vehicleMarker) {
    _vehicleMarker.setPosition(pos);
    _vehicleMarker.setIcon(_vehicleIcon(heading ?? 0));
  }
}

/**
 * Place / move the next-stop marker.
 * @param {number} lat
 * @param {number} lng
 * @param {string} name  — tooltip label
 */
export function updateNextStop(lat, lng, name) {
  if (!_initialized || !_map) return;
  const pos = { lat, lng };
  if (!_nextStopMarker) {
    _nextStopMarker = new window.google.maps.Marker({
      map: _map,
      position: pos,
      title: name || 'Próxima parada',
      zIndex: 500,
      icon: _stopIcon(),
    });
  } else {
    _nextStopMarker.setPosition(pos);
    _nextStopMarker.setTitle(name || 'Próxima parada');
  }
}

/** Remove the next-stop marker (e.g. when route ends) */
export function clearNextStop() {
  if (_nextStopMarker) {
    _nextStopMarker.setMap(null);
    _nextStopMarker = null;
  }
}

/** Clean up all map resources */
export function destroyMap() {
  _map            = null;
  _vehicleMarker  = null;
  _nextStopMarker = null;
  _initialized    = false;
  if (_themeObserver) { _themeObserver.disconnect(); _themeObserver = null; }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function _loadScript(key) {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) { resolve(); return; }

    const cb = '_gmReady_' + Date.now();
    window[cb] = () => { delete window[cb]; resolve(); };

    const s = document.createElement('script');
    s.src   = `https://maps.googleapis.com/maps/api/js?key=${key}&callback=${cb}&loading=async`;
    s.async = true;
    s.defer = true;
    s.onerror = () => reject(new Error('Script load failed'));
    document.head.appendChild(s);
  });
}

function _createMap() {
  const mapDiv = _containerEl?.querySelector('#googleMap');
  if (!mapDiv || !window.google?.maps) return;

  // Remove offline/fallback message if present
  mapDiv.innerHTML = '';

  const isLight = document.body.classList.contains('light-mode');

  _map = new window.google.maps.Map(mapDiv, {
    zoom: 17,
    // Default center: Vitoria-Gasteiz (Ilertren home base)
    center: { lat: 42.8406, lng: -2.6722 },
    mapTypeId: 'roadmap',
    disableDefaultUI: true,      // no default controls
    gestureHandling: 'none',     // auto-follow only — driver should not pan manually
    styles: isLight ? STYLE_LIGHT : STYLE_DARK,
    backgroundColor: '#1A1511',
  });

  // Vehicle marker — starts at center, real GPS moves it
  _vehicleMarker = new window.google.maps.Marker({
    map: _map,
    icon: _vehicleIcon(0),
    zIndex: 1000,
  });

  _initialized = true;

  // Auto-switch map style when theme toggle fires
  _themeObserver = new MutationObserver(() => {
    if (!_map) return;
    const isLight = document.body.classList.contains('light-mode');
    _map.setOptions({ styles: isLight ? STYLE_LIGHT : STYLE_DARK });
  });
  _themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

function _wireGPSEvents() {
  // Tap into the existing gps:distance events — no second watchPosition needed
  window.addEventListener('gps:distance', (e) => {
    const { latitude, longitude, heading } = e.detail;
    if (latitude && longitude) {
      updateMapPosition(latitude, longitude, heading);
    }
  });
}

function _onOnline() {
  // Retry map initialization once network comes back
  if (_containerEl && !_initialized) initMap(_containerEl);
}

function _showFallback(icon, title, text) {
  const mapDiv = _containerEl?.querySelector('#googleMap');
  if (!mapDiv) return;
  mapDiv.innerHTML = `
    <div class="map-fallback">
      <span class="map-fallback-icon">${icon}</span>
      <span class="map-fallback-title">${title}</span>
      <span class="map-fallback-text">${text}</span>
    </div>`;
}

/** Car/arrow icon that rotates with heading, using brand brick-bright color */
function _vehicleIcon(heading) {
  return {
    path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
    scale: 7,
    fillColor: '#C8451E',
    fillOpacity: 1,
    strokeColor: '#EDE6D6',
    strokeWeight: 1.5,
    rotation: heading,
    anchor: new window.google.maps.Point(0, 2.5),
  };
}

/** Next stop marker icon — brass/gold dot */
function _stopIcon() {
  return {
    path: window.google.maps.SymbolPath.CIRCLE,
    scale: 10,
    fillColor: '#C99A4A',
    fillOpacity: 1,
    strokeColor: '#120F0C',
    strokeWeight: 2,
  };
}
