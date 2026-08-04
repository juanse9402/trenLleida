/**
 * route.js — Route loading, validation, and persistence.
 * Responsible for fetching route.json, validating schema,
 * and syncing with localStorage as offline fallback.
 */

import { setState, loadSavedProgress } from './state.js';
import { logInfo, logSuccess, logWarn, logError } from './logger.js';

const STORAGE_KEY = 'routemaker_saved_route';
const ROUTE_URL   = './route.json';
const EDITED_KEY  = 'routemaker_route_edited_v1';

/**
 * Clear the local edit flag and local storage route.
 */
export function clearRouteEdits() {
  try {
    localStorage.removeItem(EDITED_KEY);
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* safe to ignore */ }
}

/**
 * Validate that a route array has the correct shape.
 * Returns { valid: bool, errors: string[] }
 */
export function validateRoute(data) {
  const errors = [];

  if (!Array.isArray(data)) {
    errors.push('La ruta debe ser un array JSON.');
    return { valid: false, errors };
  }

  if (data.length === 0) {
    errors.push('La ruta está vacía (0 paradas).');
    return { valid: false, errors };
  }

  data.forEach((stop, i) => {
    if (typeof stop.name !== 'string' || stop.name.trim() === '') {
      errors.push(`Parada ${i + 1}: falta "name".`);
    }
    if (typeof stop.lat !== 'number' || isNaN(stop.lat)) {
      errors.push(`Parada ${i + 1}: "lat" inválida (${stop.lat}).`);
    }
    if (typeof stop.lon !== 'number' || isNaN(stop.lon)) {
      errors.push(`Parada ${i + 1}: "lon" inválida (${stop.lon}).`);
    }
    if (stop.lat !== undefined && (stop.lat < -90 || stop.lat > 90)) {
      errors.push(`Parada ${i + 1}: latitud fuera de rango (${stop.lat}).`);
    }
    if (stop.lon !== undefined && (stop.lon < -180 || stop.lon > 180)) {
      errors.push(`Parada ${i + 1}: longitud fuera de rango (${stop.lon}).`);
    }
  });

  return { valid: errors.length === 0, errors };
}

/**
 * Sanitize a raw route array — normalize types and fill defaults.
 */
function sanitizeRoute(data) {
  return data.map((stop, i) => ({
    name:  String(stop.name  ?? `Parada ${i + 1}`).trim(),
    lat:   parseFloat(stop.lat),
    lon:   parseFloat(stop.lon),
    audio: typeof stop.audio === 'string' ? stop.audio.trim() : '',
  }));
}

/**
 * Persist route to localStorage.
 */
export function saveRouteToStorage(route) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(route));
    logInfo('Ruta guardada en almacenamiento local.');
  } catch (e) {
    logWarn(`No se pudo guardar en localStorage: ${e.message}`);
  }
}

/**
 * Load route from localStorage fallback.
 * Returns null if not found or invalid.
 */
function loadRouteFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const { valid, errors } = validateRoute(parsed);
    if (!valid) {
      logWarn(`Ruta en caché inválida: ${errors.join(', ')}`);
      return null;
    }
    return sanitizeRoute(parsed);
  } catch (e) {
    logWarn(`Error leyendo caché: ${e.message}`);
    return null;
  }
}

/**
 * Main entry point: load route from network, fallback to localStorage.
 * Sets global state on success.
 * @returns {Promise<boolean>} true if route was loaded successfully
 */
export async function loadRoute() {
  logInfo('Cargando ruta...');

  // 1. Check if we have a locally modified route
  const isEdited = localStorage.getItem(EDITED_KEY) === 'true';
  if (isEdited) {
    const cached = loadRouteFromStorage();
    if (cached) {
      const saved = loadSavedProgress();
      const startIndex = (saved !== null && saved >= 0 && saved < cached.length) ? saved : 0;
      setState({ route: cached, currentStopIndex: startIndex });
      
      logWarn('Se ha recuperado una ruta guardada anteriormente.');
      if (startIndex > 0) {
        logSuccess(`Ruta local cargada: ${cached.length} parada(s). Progreso restaurado en parada ${startIndex + 1}.`);
      } else {
        logSuccess(`Ruta local cargada: ${cached.length} parada(s).`);
      }
      return true;
    }
  }

  // 2. Try network
  try {
    const res = await fetch(`${ROUTE_URL}?_=${Date.now()}`, {
      cache: 'no-store',
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const raw = await res.json();
    const { valid, errors } = validateRoute(raw);

    if (!valid) {
      throw new Error(`Ruta inválida: ${errors.join(' | ')}`);
    }

    const route = sanitizeRoute(raw);
    saveRouteToStorage(route);

    // Restore saved progress if available, otherwise start from 0
    const saved = loadSavedProgress();
    const startIndex = (saved !== null && saved >= 0 && saved < route.length) ? saved : 0;
    setState({ route, currentStopIndex: startIndex });

    if (startIndex > 0) {
      logSuccess(`Ruta cargada: ${route.length} parada(s). Progreso restaurado en parada ${startIndex + 1}.`);
    } else {
      logSuccess(`Ruta cargada: ${route.length} parada(s).`);
    }
    return true;

  } catch (networkErr) {
    logWarn(`Red no disponible (${networkErr.message}). Buscando copia local...`);
  }

  // 3. Fallback: localStorage
  const cached = loadRouteFromStorage();
  if (cached) {
    const saved = loadSavedProgress();
    const startIndex = (saved !== null && saved >= 0 && saved < cached.length) ? saved : 0;
    setState({ route: cached, currentStopIndex: startIndex });

    if (startIndex > 0) {
      logSuccess(`Ruta offline: ${cached.length} parada(s). Progreso restaurado en parada ${startIndex + 1}.`);
    } else {
      logSuccess(`Ruta offline cargada: ${cached.length} parada(s).`);
    }
    return true;
  }

  // 4. Total failure
  logError('No se pudo cargar ninguna ruta. Verifica route.json.');
  return false;
}
