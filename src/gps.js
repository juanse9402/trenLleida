/**
 * gps.js — GPS tracking with accuracy filtering and trigger cooldown.
 *
 * Safety guarantees:
 *  - Positions with accuracy > MAX_ACCURACY_METERS are silently discarded
 *  - Each stop has a cooldown window; duplicate triggers within it are ignored
 *  - watchPosition is never started twice (guard on watchId)
 *  - All errors are classified and logged
 */

import { getState, setState, markStopTriggered, loadSavedProgress, clearSavedProgress } from './state.js';
import { logInfo, logWarn, logError, logSuccess } from './logger.js';
import { playCurrentStop } from './audio.js';

const STOP_RADIUS_METERS    = 10;   // Distance to trigger audio (Rule 3)
const MAX_ACCURACY_METERS   = 35;   // Discard GPS readings worse than this
const STOP_COOLDOWN_MS      = 5000; // Min ms between triggers for the same stop

let _lastPositionTimestamp = null;
let _watchdogInterval = null;

/** Haversine distance in meters between two lat/lon pairs. @public */
export function haversine(lat1, lon1, lat2, lon2) {
  const R  = 6_371_000; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) ** 2
          + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Smart Route Start ───────────────────────────────────────────────────────

/**
 * Smart route initialization:
 * 1. Check for saved progress → offer resume
 * 2. If no progress or declined → find closest stop via GPS
 * 3. Start GPS tracking
 *
 * This replaces the raw startGPS() for the Play button.
 */
export async function startRoute() {
  const { route } = getState();

  if (route.length === 0) {
    logError('No hay ruta cargada.');
    return;
  }

  // 1. Check saved progress
  const savedIndex = loadSavedProgress();
  if (savedIndex !== null && savedIndex >= 0 && savedIndex < route.length) {
    const wantsResume = confirm(
      `Tienes una ruta en curso.\n\nPróxima parada guardada:\n${route[savedIndex].name}\n\n¿Deseas continuar desde ahí?\n\n(Pulsa Cancelar para calcular tu ubicación más cercana)`
    );
    if (wantsResume) {
      setState({ currentStopIndex: savedIndex });
      logSuccess(`Ruta reanudada desde: ${route[savedIndex].name}`);
      startGPS();
      return;
    }
  }

  // 2. Find closest stop via GPS
  if (localStorage.getItem('routemaker_gps_consent') !== 'true') {
    logWarn('Iniciando ruta: esperando consentimiento de GPS.');
    return;
  }

  if (!navigator.geolocation) {
    logError('GPS no disponible. Iniciando desde parada 1.');
    setState({ currentStopIndex: 0 });
    startGPS();
    return;
  }

  logInfo('Calculando el punto más cercano...');
  setState({ gpsStatus: 'running' });
  window.dispatchEvent(new CustomEvent('gps:started'));

  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      });
    });

    const { latitude, longitude } = position.coords;

    // Build candidates with distances
    const candidates = route.map((stop, i) => ({
      index: i,
      distance: haversine(latitude, longitude, stop.lat, stop.lon),
    }));

    // Find minimum distance
    const minDist = Math.min(...candidates.map(c => c.distance));

    // Threshold: all stops within 20m of closest (or 40m absolute)
    // Then pick the earliest in route order to avoid confusion at crossings
    const threshold = Math.max(minDist + 20, 40);
    const valid = candidates
      .filter(c => c.distance <= threshold)
      .sort((a, b) => a.index - b.index);

    const chosen = valid[0];
    setState({ currentStopIndex: chosen.index });
    logSuccess(`Ruta iniciada desde: ${route[chosen.index].name} (${Math.round(chosen.distance)}m)`);

  } catch (err) {
    logWarn(`Error GPS inicial: ${err.message}. Iniciando desde parada 1.`);
    setState({ currentStopIndex: 0 });
  }

  // 3. Start continuous tracking (setState already set gpsStatus above,
  //    but startGPS will handle the watchPosition)
  // Reset gpsStatus to idle first so startGPS doesn't think it's already running
  setState({ gpsStatus: 'idle', watchId: null });
  startGPS();
}

/** Classify GeolocationPositionError codes into readable strings. */
function classifyGPSError(code) {
  switch (code) {
    case 1: return "Permiso de GPS denegado. Actívalo en ajustes del navegador.";
    case 2: return "No se pudo obtener la posición GPS.";
    case 3: return "Tiempo de espera GPS agotado. Inténtalo de nuevo.";
    default: return "Error GPS desconocido.";
  }
}

/**
 * Handle each GPS position update.
 * @param {GeolocationPosition} position
 */
function onPosition(position) {
  const { route, currentStopIndex, audioStatus, gpsStatus } = getState();

  if (gpsStatus !== 'running') return;

  // Watchdog reset: record the timestamp of the last active signal from the browser
  _lastPositionTimestamp = Date.now();

  const { latitude, longitude, accuracy } = position.coords;
  setState({ lastAccuracy: Math.round(accuracy) });

  if (currentStopIndex >= route.length) {
    logSuccess('🎉 ¡Todas las paradas completadas!');
    clearSavedProgress();
    stopGPS();
    return;
  }

  const target   = route[currentStopIndex];
  const distance = haversine(latitude, longitude, target.lat, target.lon);
  
  // Rule 3: Fixed 10m radius, but expand up to half of the GPS accuracy if it's poor
  const baseRadius = target.radius || STOP_RADIUS_METERS;
  const effectiveRadius = Math.max(baseRadius, accuracy * 0.5);

  // Dynamic filter: discard low-accuracy readings, UNLESS we are already very close to the target (< effectiveRadius)
  if (accuracy > MAX_ACCURACY_METERS && distance > effectiveRadius) {
    logWarn(`GPS impreciso (±${Math.round(accuracy)}m) a ${Math.round(distance)}m. Ignorando lectura.`);
    return;
  }

  // Update distance display via custom event (keeps GPS module UI-agnostic)
  window.dispatchEvent(new CustomEvent('gps:distance', {
    detail: { 
      distance: Math.round(distance), 
      accuracy: Math.round(accuracy), 
      speed: position.coords.speed,
      heading: position.coords.heading,   // degrees CW from north; null if unavailable
      latitude,
      longitude
    }
  }));

  if (distance <= effectiveRadius) {
    // Cooldown guard — prevents double trigger on same stop
    const canTrigger = markStopTriggered(currentStopIndex, STOP_COOLDOWN_MS);
    if (!canTrigger) return;

    logSuccess(`📍 Llegada a: ${target.name} (${Math.round(distance)}m)`);
    playCurrentStop();
  }
}

/**
 * Handle GPS errors.
 * @param {GeolocationPositionError} error
 */
function onError(error) {
  const msg = classifyGPSError(error.code);
  logError(`GPS: ${msg}`);
  setState({ gpsStatus: 'error' });

  window.dispatchEvent(new CustomEvent('gps:error', { detail: { message: msg, code: error.code } }));

  // Auto-restart on lost signal (code 2) or timeout (code 3)
  if (error.code === 2 || error.code === 3) {
    logInfo('Pérdida temporal de señal GPS. Reintentando reconexión en 3s...');
    stopGPS();
    setTimeout(startGPS, 3000);
  }
}

/**
 * Start GPS tracking.
 */
export function startGPS() {
  const { watchId } = getState();

  if (localStorage.getItem('routemaker_gps_consent') !== 'true') {
    logWarn('Rastreo GPS bloqueado: falta el consentimiento.');
    return;
  }

  if (!navigator.geolocation) {
    logError('Geolocalización no soportada en este dispositivo.');
    return;
  }

  if (watchId !== null) {
    logWarn('GPS ya activo. Ignorando llamada duplicada.');
    return;
  }

  logInfo('Iniciando GPS...');
  setState({ gpsStatus: 'running' });

  // Initialize watchdog timestamp
  _lastPositionTimestamp = Date.now();

  const id = navigator.geolocation.watchPosition(
    onPosition,
    onError,
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10_000,
    }
  );

  setState({ watchId: id });
  window.dispatchEvent(new CustomEvent('gps:started'));

  // Start the Watchdog timer to detect silent GPS freezes (e.g. browser background throttling)
  if (!_watchdogInterval) {
    _watchdogInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - _lastPositionTimestamp;
      if (elapsed > 15000) { // 15 seconds without a position update
        logWarn('GPS inactivo (congelamiento detectado). Reiniciando seguimiento...');
        stopGPS();
        startGPS();
      }
    }, 5000); // Check every 5 seconds
  }
}

/**
 * Stop GPS tracking and clean up.
 */
export function stopGPS() {
  const { watchId } = getState();

  // Clear Watchdog timer
  if (_watchdogInterval) {
    clearInterval(_watchdogInterval);
    _watchdogInterval = null;
  }

  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    setState({ watchId: null });
  }

  setState({ gpsStatus: 'idle' });
  window.dispatchEvent(new CustomEvent('gps:stopped'));
  logInfo('GPS pausado.');
}
