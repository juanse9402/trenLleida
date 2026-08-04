/**
 * state.js — Single source of truth for the entire app.
 * No module is allowed to hold its own state outside of this object.
 * All changes go through setState() so mutations are traceable.
 *
 * Progress persistence: currentStopIndex is auto-saved to localStorage
 * so the app can resume after accidental close or reload.
 */

const PROGRESS_KEY = 'routemaker_progress_v1';

const _state = {
  // Route data
  route: [],
  currentStopIndex: 0,

  // GPS
  gpsStatus: 'idle',       // 'idle' | 'running' | 'error'
  watchId: null,
  lastAccuracy: null,

  // Audio state machine
  audioStatus: 'idle',     // 'idle' | 'playing' | 'done' | 'error'

  // Per-stop trigger guard: prevents double-firing at same stop
  // Key: stop index, Value: timestamp of last trigger
  triggerLog: {},

  // Editor
  editorOpen: false,
};

// Subscribers: { key: [callbacks] }
const _subscribers = {};

/**
 * Read current state (returns a shallow copy for safety)
 */
export function getState() {
  return { ..._state };
}

/**
 * Update state and notify subscribers.
 * Auto-persists currentStopIndex to localStorage for resume capability.
 * @param {Partial<typeof _state>} patch
 */
export function setState(patch) {
  const changedKeys = [];

  for (const key of Object.keys(patch)) {
    if (!(key in _state)) {
      console.warn(`[state] Unknown key: "${key}". Skipping.`);
      continue;
    }
    if (_state[key] !== patch[key]) {
      _state[key] = patch[key];
      changedKeys.push(key);
    }
  }

  if (changedKeys.length === 0) return;

  // Auto-persist progress when currentStopIndex changes
  if (changedKeys.includes('currentStopIndex')) {
    try {
      localStorage.setItem(PROGRESS_KEY, _state.currentStopIndex.toString());
    } catch { /* localStorage may be full or unavailable — safe to ignore */ }
  }

  // Notify per-key subscribers
  for (const key of changedKeys) {
    if (_subscribers[key]) {
      for (const cb of _subscribers[key]) {
        try { cb(_state[key], key); } catch (e) { console.error(`[state] Subscriber error on "${key}":`, e); }
      }
    }
  }

  // Notify wildcard subscribers
  if (_subscribers['*']) {
    for (const cb of _subscribers['*']) {
      try { cb({ ..._state }, changedKeys); } catch (e) { console.error('[state] Wildcard subscriber error:', e); }
    }
  }
}

/**
 * Load saved progress from localStorage.
 * Returns the saved stop index, or null if none exists.
 * @returns {number|null}
 */
export function loadSavedProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (raw === null) return null;
    const idx = parseInt(raw, 10);
    return Number.isFinite(idx) && idx >= 0 ? idx : null;
  } catch {
    return null;
  }
}

/**
 * Clear saved progress (e.g. on route completion or restart).
 */
export function clearSavedProgress() {
  try {
    localStorage.removeItem(PROGRESS_KEY);
  } catch { /* safe to ignore */ }
}

/**
 * Subscribe to state changes.
 * @param {string|string[]} keys - Key(s) to watch, or '*' for all changes
 * @param {Function} callback
 * @returns {Function} Unsubscribe function
 */
export function subscribe(keys, callback) {
  const keyList = Array.isArray(keys) ? keys : [keys];
  for (const key of keyList) {
    if (!_subscribers[key]) _subscribers[key] = [];
    _subscribers[key].push(callback);
  }
  return () => {
    for (const key of keyList) {
      _subscribers[key] = (_subscribers[key] || []).filter(cb => cb !== callback);
    }
  };
}

/**
 * Mark a stop as triggered. Returns false if it was already triggered
 * within the cooldown window (prevents double audio fires).
 * @param {number} stopIndex
 * @param {number} cooldownMs
 */
export function markStopTriggered(stopIndex, cooldownMs = 3000) {
  const now = Date.now();
  const last = _state.triggerLog[stopIndex];
  if (last && (now - last) < cooldownMs) return false;

  // Must mutate the object directly since setState does shallow compare
  _state.triggerLog = { ..._state.triggerLog, [stopIndex]: now };
  return true;
}

/**
 * Reset trigger log (e.g. when route restarts)
 */
export function resetTriggerLog() {
  _state.triggerLog = {};
}
