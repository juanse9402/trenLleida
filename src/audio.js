/**
 * audio.js — Audio playback with a strict state machine.
 *
 * States: idle → playing → idle (loop)
 *                        → error → idle
 *
 * Guarantees:
 *  - Only one audio plays at a time
 *  - currentStopIndex increments ONLY after successful play starts (onloadeddata)
 *  - Object URLs are revoked after use to prevent memory leaks
 */

import { getState, setState, subscribe } from './state.js';
import { logInfo, logSuccess, logWarn, logError } from './logger.js';
import { getAudio } from './db.js';
import { castVideo } from './cast.js';

const AUDIO_PREFIX = 'indexeddb_';
let _player = null;
let _ambientPlayer = null;
let _currentObjectUrl = null;

// Preload state
let _preloadedStopIndex = -1;
let _preloadedObjectUrl = null;
let _unlocked = false;

// Web Audio API context and nodes for iOS volume control bypass
let _audioCtx = null;
let _ambientSource = null;
let _ambientGainNode = null;

function initAmbientWebAudio() {
  if (!_ambientPlayer) return;
  if (_ambientGainNode) return; // already initialized
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    _audioCtx = new AudioContextClass();
    _ambientSource = _audioCtx.createMediaElementSource(_ambientPlayer);
    _ambientGainNode = _audioCtx.createGain();
    _ambientSource.connect(_ambientGainNode);
    _ambientGainNode.connect(_audioCtx.destination);
    _ambientGainNode.gain.setValueAtTime(AMBIENT_VOLUME_NORMAL, _audioCtx.currentTime);
  } catch (err) {
    console.error('Error initializing Web Audio API for ambient:', err);
  }
}

// Minimal valid WAV (silence) for iOS/Android audio unlock
const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

const AMBIENT_VOLUME_NORMAL = 0.35;
const AMBIENT_VOLUME_DUCKED = 0.08;
const FADE_DOWN_MS = 600;
const FADE_UP_MS = 1000;

let _fadeInterval = null;

function fadeVolume(audioEl, targetVol, durationMs) {
  // If fading the ambient player and we have Web Audio API active, fade the GainNode instead of element volume (fixes iOS read-only volume limitation)
  if (audioEl === _ambientPlayer && _ambientGainNode && _audioCtx) {
    if (_audioCtx.state === 'suspended') {
      _audioCtx.resume();
    }
    const startVol = _ambientGainNode.gain.value;
    const steps = 40;
    const stepMs = durationMs / steps;
    const stepSize = (targetVol - startVol) / steps;
    let i = 0;
    if (_fadeInterval) clearInterval(_fadeInterval);
    _fadeInterval = setInterval(() => {
      i++;
      _ambientGainNode.gain.setValueAtTime(
        Math.max(0, Math.min(1, startVol + stepSize * i)),
        _audioCtx.currentTime
      );
      if (i >= steps) {
        _ambientGainNode.gain.setValueAtTime(targetVol, _audioCtx.currentTime);
        clearInterval(_fadeInterval);
        _fadeInterval = null;
      }
    }, stepMs);
    return;
  }

  const startVol = audioEl.volume;
  const steps = 40;
  const stepMs = durationMs / steps;
  const stepSize = (targetVol - startVol) / steps;
  let i = 0;
  if (_fadeInterval) clearInterval(_fadeInterval);
  _fadeInterval = setInterval(() => {
    i++;
    audioEl.volume = Math.max(0, Math.min(1, startVol + stepSize * i));
    if (i >= steps) {
      audioEl.volume = targetVol;
      clearInterval(_fadeInterval);
      _fadeInterval = null;
    }
  }, stepMs);
}

/**
 * Bind to the <audio> DOM element.
 * @param {HTMLAudioElement} el
 */
export function initAudio(el) {
  _player = el;

  _ambientPlayer = new Audio('assets/ambientetren.mp3');
  _ambientPlayer.loop = true;
  _ambientPlayer.volume = AMBIENT_VOLUME_NORMAL;

  _player.addEventListener('play', () => {
    if (_ambientPlayer && !_ambientPlayer.paused) {
      fadeVolume(_ambientPlayer, AMBIENT_VOLUME_DUCKED, FADE_DOWN_MS);
    }
  });

  _player.addEventListener('ended', () => {
    _revokeCurrentUrl();
    setState({ audioStatus: 'idle' });
    logInfo('Audio finalizado.');
    if (_ambientPlayer && !_ambientPlayer.paused) {
      fadeVolume(_ambientPlayer, AMBIENT_VOLUME_NORMAL, FADE_UP_MS);
    }

    const { route, currentStopIndex } = getState();
    const finishedStop = route[currentStopIndex - 1];
    if (finishedStop && finishedStop.autoNext && currentStopIndex < route.length) {
      logInfo(`Empalmando automáticamente con la siguiente parada...`);
      setTimeout(() => playCurrentStop(), 1000); // 1s de respiro antes del siguiente
    }
  });

  _player.addEventListener('pause', () => {
    if (_ambientPlayer && !_ambientPlayer.paused && _player.ended === false) {
      fadeVolume(_ambientPlayer, AMBIENT_VOLUME_NORMAL, FADE_UP_MS);
    }
  });

  _player.addEventListener('error', () => {
    _revokeCurrentUrl();
    
    // Ignore errors triggered by intentional resource resets (empty src or data URI silent WAV)
    const src = _player.src;
    if (!src || src === '' || src === window.location.href || src.startsWith('data:')) {
      setState({ audioStatus: 'idle' });
      return;
    }
    
    setState({ audioStatus: 'error' });
    logError(`Error de reproducción: ${_player.error?.message ?? 'desconocido'}`);
    // Auto-recover to idle so GPS can continue
    setState({ audioStatus: 'idle' });
    if (_ambientPlayer && !_ambientPlayer.paused) {
      fadeVolume(_ambientPlayer, AMBIENT_VOLUME_NORMAL, FADE_UP_MS);
    }
  });

  // Ensure media session doesn't try to auto-handle media keys for ambient
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', null);
    navigator.mediaSession.setActionHandler('pause', null);
  }

  // Auto-preload the next audio whenever currentStopIndex changes
  subscribe('currentStopIndex', () => {
    preloadNextAudio();
  });
}

/**
 * Preloads the audio for the currentStopIndex silently in the background
 */
export async function preloadNextAudio() {
  const { route, currentStopIndex } = getState();
  if (currentStopIndex >= route.length) return;

  if (_preloadedStopIndex === currentStopIndex) return; // Already preloaded

  const stop = route[currentStopIndex];
  if (!stop || !stop.audio) return;

  if (stop.audio.startsWith(AUDIO_PREFIX)) {
    try {
      const blob = await getAudio(stop.audio);
      if (blob) {
        if (_preloadedObjectUrl) URL.revokeObjectURL(_preloadedObjectUrl);
        _preloadedObjectUrl = URL.createObjectURL(blob);
        _preloadedStopIndex = currentStopIndex;
      }
    } catch (err) {
      console.warn(`Failed to preload audio: ${stop.audio}`, err);
    }
  }
}

let _ambientWakeLock = null;

async function acquireAmbientWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (_ambientWakeLock === null) {
      _ambientWakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (err) {
    logWarn(`Wake Lock ambiente no disponible: ${err.message}`);
  }
}

async function releaseAmbientWakeLock() {
  if (_ambientWakeLock !== null) {
    try { await _ambientWakeLock.release(); } catch(_) {}
    _ambientWakeLock = null;
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && isAmbientPlaying()) {
    await acquireAmbientWakeLock();
  }
});

/**
 * Play ambient track
 */
export function playAmbient() {
  if (_ambientPlayer) {
    _ambientPlayer.play()
      .then(() => acquireAmbientWakeLock())
      .catch(e => logWarn(`No se pudo iniciar ambiente: ${e.message}`));
  }
}

/**
 * Pause ambient track
 */
export function pauseAmbient() {
  if (_ambientPlayer) {
    _ambientPlayer.pause();
    releaseAmbientWakeLock();
  }
}

/**
 * Stop ambient track completely
 */
export function stopAmbient() {
  if (_ambientPlayer) {
    _ambientPlayer.pause();
    _ambientPlayer.currentTime = 0;
    releaseAmbientWakeLock();
  }
}

/**
 * Check if ambient track is playing
 */
export function isAmbientPlaying() {
  return _ambientPlayer && !_ambientPlayer.paused;
}

/**
 * Toggle ambient track manually
 */
export function toggleAmbient() {
  if (!_ambientPlayer) return false;
  if (_ambientPlayer.paused) {
    _ambientPlayer.play()
      .then(() => acquireAmbientWakeLock())
      .catch(e => console.warn('Toggle ambient error:', e));
    return true;
  } else {
    _ambientPlayer.pause();
    releaseAmbientWakeLock();
    return false;
  }
}

/**
 * Unlock audio playback on mobile devices.
 * Must be called from a user gesture (click/tap) handler.
 * Safe to call multiple times — only executes once.
 */
export async function unlockAudio() {
  if (_unlocked || !_player) return;
  try {
    // Initialize Web Audio API to bypass iOS volume fading limitations
    initAmbientWebAudio();
    if (_audioCtx && _audioCtx.state === 'suspended') {
      await _audioCtx.resume();
    }

    _player.src = SILENT_WAV;
    await _player.play();
    _player.pause();
    _player.src = '';
    _unlocked = true;

    // Also unlock ambient player if needed
    if (_ambientPlayer) {
      const prevVol = _ambientPlayer.volume;
      _ambientPlayer.volume = 0;
      await _ambientPlayer.play();
      _ambientPlayer.pause();
      _ambientPlayer.volume = prevVol;
    }
  } catch (err) {
    console.warn('Silent unlock failed:', err);
  }
}

function _revokeCurrentUrl() {
  if (_currentObjectUrl) {
    URL.revokeObjectURL(_currentObjectUrl);
    _currentObjectUrl = null;
  }
}

/**
 * Resolve the audio source for a stop.
 * Returns an object URL (for IndexedDB blobs) or a string path.
 * @param {Object} stop
 * @returns {Promise<string>}
 */
async function _resolveSource(stop) {
  if (!stop.audio) throw new Error('Esta parada no tiene audio asignado.');

  const { route, currentStopIndex } = getState();

  if (stop.audio.startsWith(AUDIO_PREFIX)) {
    if (_preloadedStopIndex === currentStopIndex && _preloadedObjectUrl) {
      _currentObjectUrl = _preloadedObjectUrl;
      // Detach preloaded reference so it doesn't get revoked unexpectedly
      _preloadedObjectUrl = null;
      _preloadedStopIndex = -1;
      return _currentObjectUrl;
    }

    const blob = await getAudio(stop.audio);
    if (!blob) throw new Error(`Audio local no encontrado: "${stop.audio}"`);
    _currentObjectUrl = URL.createObjectURL(blob);
    return _currentObjectUrl;
  }

  return `./audios/${stop.audio}`;
}

/**
 * Play the audio for the stop at currentStopIndex.
 * Advances the index only after playback begins successfully.
 *
 * @returns {Promise<void>}
 */
export async function playCurrentStop() {
  const { route, currentStopIndex } = getState();

  if (currentStopIndex >= route.length) {
    logInfo('Fin de ruta. No hay más paradas.');
    return;
  }

  const stop = route[currentStopIndex];
  logInfo(`▶ Reproduciendo: ${stop.name}`);

  // Sincronizar transmisión al Chromecast
  try {
    const stopNumStr = String(currentStopIndex + 1).padStart(2, '0');
    const videoFilename = stop.audio.replace(/\.wav$/i, '.mp4');
    const videoUrl = `${window.location.origin}/SDVideo/${stopNumStr}/${videoFilename}`;
    castVideo(videoUrl, stop.name);
  } catch (err) {
    console.error('Error enviando video al Chromecast:', err);
  }

  // Stop any current playback cleanly first
  stopAudio();

  setState({ audioStatus: 'playing' });

  // Safety net: ensure audio is unlocked on mobile
  if (!_unlocked) await unlockAudio();

  try {
    const src = await _resolveSource(stop);

    await new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(_player.error?.message ?? 'Error cargando audio'));
      };

      function cleanup() {
        _player.removeEventListener('canplaythrough', onReady);
        _player.removeEventListener('error', onError);
      }

      _player.addEventListener('canplaythrough', onReady, { once: true });
      _player.addEventListener('error', onError, { once: true });

      _player.src = src;
      _player.load();
    });

    await _player.play();

    // Audio started successfully — advance index NOW
    setState({ currentStopIndex: currentStopIndex + 1 });
    logSuccess(`Parada completada: ${stop.name}`);

  } catch (err) {
    _revokeCurrentUrl();
    setState({ audioStatus: 'error' });
    logError(`Error en "${stop.name}": ${err.message}`);
    // Recover: don't advance index so user can retry or skip manually
    setState({ audioStatus: 'idle' });
  }
}

/**
 * Stop audio immediately and reset.
 */
export function stopAudio() {
  if (_player) {
    _player.pause();
    _player.currentTime = 0;
  }
  _revokeCurrentUrl();
  setState({ audioStatus: 'idle' });
}

/**
 * Pause audio playback in progress.
 */
export function pauseAudio() {
  if (_player && !_player.paused) {
    _player.pause();
    setState({ audioStatus: 'paused' });
  }
}
/**
 * Resume paused audio playback.
 */
export function resumeAudio() {
  if (_player && _player.paused && _player.src) {
    _player.play().then(() => {
      setState({ audioStatus: 'playing' });
    }).catch(err => {
      logError(`Error reanudando audio: ${err.message}`);
      setState({ audioStatus: 'error' });
    });
  }
}
