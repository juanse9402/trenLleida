/**
 * main.js — Orchestrator.
 * Connects modules to DOM. Contains zero business logic.
 * Business logic lives in gps.js, audio.js, route.js, editor.js.
 *
 * Hardening:
 *  - Screen Wake Lock: prevents device from sleeping during navigation
 *  - Page Visibility: logs when app goes to background
 *  - Audio Unlock: silent WAV trick for iOS/Android autoplay
 *  - Global error boundary: catches uncaught errors
 *  - Service Worker registration for offline capability
 */

import { getState, setState, subscribe, resetTriggerLog, clearSavedProgress, markStopTriggered } from './state.js';
import { initLogger, logInfo, logSuccess, logWarn, logError } from './logger.js';
import { loadRoute } from './route.js';
import { initAudio, playCurrentStop, stopAudio, unlockAudio, pauseAudio, resumeAudio, playAmbient, pauseAmbient, stopAmbient, toggleAmbient, isAmbientPlaying } from './audio.js';
import { startGPS, stopGPS, startRoute, haversine } from './gps.js';
import { initEditor } from './editor.js';
import { castVideo } from './cast.js';

// ─── DOM References ───────────────────────────────────────────────────────────

const el = {
  // Status
  gpsPill:      document.getElementById('gpsPill'),
  gpsDot:       document.getElementById('gpsDot'),
  gpsStatus:    document.getElementById('gpsStatus'),
  accuracyBadge: document.getElementById('accuracyBadge'),
  currentTimeClock: document.getElementById('currentTimeClock'),

  // GPS Alert Banner
  gpsAlertBanner: document.getElementById('gpsAlertBanner'),
  gpsAlertTitle:  document.getElementById('gpsAlertTitle'),
  gpsAlertSub:    document.getElementById('gpsAlertSub'),
  gpsAlertRetry:  document.getElementById('gpsAlertRetry'),

  // Now-playing label
  nowPlayingLabel: document.getElementById('nowPlayingLabel'),

  // Info card
  stopSelector:  document.getElementById('stopSelector'),
  distanceValue: document.getElementById('distanceValue'),
  stopCounter:   document.getElementById('stopCounter'),
  progressBar:   document.getElementById('progressBar'),

  // GPS Error Retry
  btnGpsRetry: document.getElementById('btnGpsRetry'),

  // RGPD Modal
  rgpdModal:      document.getElementById('rgpdModal'),
  btnRgpdToggle:  document.getElementById('btnRgpdToggle'),
  rgpdMoreInfo:   document.getElementById('rgpdMoreInfo'),
  btnRgpdAccept:  document.getElementById('btnRgpdAccept'),

  // Controls (Visual Redesign Hold & Pause/Stop)
  holdBtn:      document.getElementById('holdBtn'),
  holdFill:     document.getElementById('holdFill'),
  holdCore:     document.getElementById('holdCore'),
  holdLabel:    document.getElementById('holdLabel'),
  holdHint:     document.getElementById('holdHint'),
  pauseRow:     document.getElementById('pauseRow'),
  pauseBtn:     document.getElementById('pauseBtn'),
  pauseIcon:    document.getElementById('pauseIcon'),
  pauseLabel:   document.getElementById('pauseLabel'),
  // Ambient toggle
  ambientBtn:   document.getElementById('ambientBtn'),
  ambientLabel: document.getElementById('ambientLabel'),
  ambientToggleEl: document.getElementById('ambientToggleEl'),
  btnPlayLast:  document.getElementById('btnPlayLast'),
  btnSkip:      document.getElementById('btnSkip'),

  // Log
  logList: document.getElementById('logList'),

  // Audio
  audioPlayer: document.getElementById('audioPlayer'),

  // Map Stats
  mapEta:          document.getElementById('mapEta'),
  mapStopCounter:  document.getElementById('mapStopCounter'),
  mapTimeInRoute:  document.getElementById('mapTimeInRoute'),
  mapSpeed:        document.getElementById('mapSpeed'),
  mapDistancia:    document.getElementById('mapDistancia'),
  mapRouteTraveled:document.getElementById('mapRouteTraveled'),
  mapVehicleMarker:document.getElementById('mapVehicleMarker'),

  // Editor
  editorScreen:   document.getElementById('editorScreen'),
  editorStopsList: document.getElementById('editorStopsList'),
  btnOpenEditor:  document.getElementById('btnOpenEditor'),
  btnCloseEditor: document.getElementById('btnCloseEditor'),
  btnAddStop:     document.getElementById('btnAddStop'),
  btnExport:      document.getElementById('btnExport'),
  btnResetRoute:  document.getElementById('btnResetRoute'),

  // Planilla
  btnOpenPlanilla: document.getElementById('btnOpenPlanilla'),
  btnClosePlanilla: document.getElementById('btnClosePlanilla'),
  planillaScreen:  document.getElementById('planillaScreen'),
  planillaIframe:  document.getElementById('planillaIframe'),

  // Theme toggle
  btnTheme: document.getElementById('btnTheme'),
  btnFullscreen: document.getElementById('btnFullscreen'),
  btnDownloadOffline: document.getElementById('btnDownloadOffline'),
};

// ─── Fullscreen API ───────────────────────────────────────────────────────────

async function enterFullscreen() {
  try {
    const el = document.documentElement;
    if (el.requestFullscreen) {
      await el.requestFullscreen();
    } else if (el.webkitRequestFullscreen) {
      await el.webkitRequestFullscreen();
    }
  } catch (err) {
    logWarn('Fullscreen no disponible: ' + err.message);
  }
}

async function exitFullscreen() {
  try {
    if (document.exitFullscreen) {
      await document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      await document.webkitExitFullscreen();
    }
  } catch (err) {
    logWarn('Error saliendo de fullscreen: ' + err.message);
  }
}

// ─── Wake Lock ────────────────────────────────────────────────────────────────

let _wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => {
      _wakeLock = null;
      logInfo('Wake Lock liberado (pantalla puede apagarse).');
    });
    logInfo('🔒 Pantalla bloqueada: no se apagará durante la ruta.');
  } catch (err) {
    logWarn(`Wake Lock no disponible: ${err.message}`);
  }
}

async function releaseWakeLock() {
  if (_wakeLock) {
    try { await _wakeLock.release(); } catch { /* already released */ }
    _wakeLock = null;
  }
}

// Re-acquire wake lock when page becomes visible again if ambient music is on (required by spec / Rule 5)
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    const ambientSaved = localStorage.getItem('audio_ilertren_ambient');
    if (ambientSaved === 'on' && !_wakeLock) {
      await requestWakeLock();
    }
  }
});

// ─── Page Visibility ──────────────────────────────────────────────────────────

document.addEventListener('visibilitychange', () => {
  const { gpsStatus } = getState();
  if (document.visibilityState === 'hidden' && gpsStatus === 'running') {
    logWarn('⚠ App en segundo plano. El GPS sigue activo.');
  } else if (document.visibilityState === 'visible' && gpsStatus === 'running') {
    logInfo('App visible de nuevo. GPS continúa.');
  }
});

// ─── UI Update Functions ──────────────────────────────────────────────────────

function populateStopSelector(route, currentLat = null, currentLon = null) {
  if (!el.stopSelector) return;

  // Don't update options if the driver has the select dropdown open/focused
  if (document.activeElement === el.stopSelector) return;

  const currentSelection = el.stopSelector.value;
  el.stopSelector.innerHTML = '';

  if (route.length === 0) {
    el.stopSelector.innerHTML = '<option value="empty" disabled selected>Sin ruta cargada</option>';
    return;
  }

  // Get closest stops if we have coordinates
  let closestStops = [];
  if (currentLat !== null && currentLon !== null) {
    const stopsWithDist = route.map((stop, index) => {
      const dist = haversine(currentLat, currentLon, stop.lat, stop.lon);
      return { stop, index, dist };
    });

    // Sort by distance and take top 3
    stopsWithDist.sort((a, b) => a.dist - b.dist);
    closestStops = stopsWithDist.slice(0, 3);
  }

  // Add closest group
  if (closestStops.length > 0) {
    const groupClose = document.createElement('optgroup');
    groupClose.label = '📍 Cerca de ti';
    closestStops.forEach(({ stop, index, dist }) => {
      const opt = document.createElement('option');
      opt.value = index;
      const distStr = dist < 1000 ? `${Math.round(dist)}m` : `${(dist/1000).toFixed(1)}km`;
      opt.textContent = `${String(index + 1).padStart(2, '0')}. ${stop.name} (${distStr})`;
      groupClose.appendChild(opt);
    });
    el.stopSelector.appendChild(groupClose);
  }

  // Add all stops group
  const groupAll = document.createElement('optgroup');
  groupAll.label = '🚏 Todas las paradas';
  route.forEach((stop, index) => {
    const opt = document.createElement('option');
    opt.value = index;
    opt.textContent = `${String(index + 1).padStart(2, '0')}. ${stop.name}`;
    groupAll.appendChild(opt);
  });
  el.stopSelector.appendChild(groupAll);

  // Restore selection
  if (currentSelection && el.stopSelector.querySelector(`option[value="${currentSelection}"]`)) {
    el.stopSelector.value = currentSelection;
  } else {
    const { currentStopIndex } = getState();
    el.stopSelector.value = currentStopIndex;
  }
}

function updateAmbientToggleUI() {
  if (el.ambientToggleLabel) {
    el.ambientToggleLabel.textContent = isAmbientPlaying() ? 'Música ambiente: ON' : 'Música ambiente: OFF';
  }
}

const Estados = { INACTIVO: 'inactivo', ACTIVO: 'activo', PAUSADO: 'pausado' };

function aplicarEstado(estado) {
  const { currentStopIndex } = getState();
  if (el.btnSkip) el.btnSkip.disabled = estado === Estados.INACTIVO;
  if (el.btnPlayLast) el.btnPlayLast.disabled = estado === Estados.INACTIVO || currentStopIndex === 0;
}

// (Leaflet map features disabled)

function updateRouteUI() {
  const { route, currentStopIndex } = getState();
  const total = route.length;

  const elParadaActual = document.getElementById('paradaActualNombre');
  const elParadaSiguiente = document.getElementById('paradaSiguienteNombre');

  if (total === 0) {
    if (elParadaActual) elParadaActual.textContent = 'Sin ruta cargada';
    if (elParadaSiguiente) elParadaSiguiente.textContent = '—';
    if (el.stopCounter) el.stopCounter.textContent = '— / —';
    if (el.mapStopCounter) el.mapStopCounter.textContent = '— / —';
    return;
  }

  if (currentStopIndex >= total) {
    if (elParadaActual) elParadaActual.textContent = '¡Ruta completada!';
    if (elParadaSiguiente) elParadaSiguiente.textContent = '—';
    if (el.distanceValue) el.distanceValue.textContent = '—';
    if (el.stopCounter) el.stopCounter.textContent = `${total} / ${total}`;
    if (el.mapStopCounter) el.mapStopCounter.textContent = `${total} / ${total}`;
    return;
  }

  if (elParadaActual) {
    if (currentStopIndex > 0 && route[currentStopIndex - 1]) {
      const p = route[currentStopIndex - 1];
      const numStr = String(currentStopIndex).padStart(2, '0');
      elParadaActual.innerHTML = `<span class="now-playing-num">${numStr}.</span> ${p.name}`;
    } else {
      elParadaActual.textContent = 'Inactivo';
    }
  }

  if (elParadaSiguiente) {
    if (route[currentStopIndex]) {
      const p = route[currentStopIndex];
      const numStr = String(currentStopIndex + 1).padStart(2, '0');
      elParadaSiguiente.textContent = `${numStr}. ${p.name}`;
    } else {
      elParadaSiguiente.textContent = '—';
    }
  }
  
  if (el.stopCounter) {
    el.stopCounter.textContent = `${currentStopIndex + 1} / ${total}`;
  }
  if (el.mapStopCounter) {
    el.mapStopCounter.textContent = `${currentStopIndex + 1} / ${total}`;
  }

  // Update progress strip labels with active stop and next stop
  const elAudioLabel = document.getElementById('audioLabel');
  const elAudioNext = document.getElementById('audioNextLabel');
  
  if (elAudioLabel) {
    if (currentStopIndex > 0 && route[currentStopIndex - 1]) {
      elAudioLabel.textContent = `${route[currentStopIndex - 1].name}`;
    } else {
      elAudioLabel.textContent = 'Inactivo';
    }
  }

  if (elAudioNext) {
    if (route[currentStopIndex]) {
      elAudioNext.textContent = `Siguiente: ${route[currentStopIndex].name}`;
    } else {
      elAudioNext.textContent = 'Siguiente: —';
    }
  }

  if (el.btnPlayLast) {
    const { gpsStatus } = getState();
    el.btnPlayLast.disabled = gpsStatus === 'idle' || currentStopIndex === 0;
  }
  if (el.stopSelector) {
    el.stopSelector.value = currentStopIndex;
  }
}

function updateGPSStatusUI(status, errorMsg) {
  if (!el.gpsPill || !el.gpsStatus || !el.gpsDot) return;
  
  updateAmbientToggleUI();

  if (status === 'running') {
    el.gpsPill.className = 'pill pill-gps-active';
    el.gpsStatus.textContent = 'GPS activo';
    el.gpsDot.classList.add('active');
  } else if (status === 'paused') {
    el.gpsPill.className = 'pill pill-gps-paused';
    el.gpsStatus.textContent = 'GPS en pausa';
    el.gpsDot.classList.remove('active');
  } else if (status === 'error') {
    el.gpsPill.className = 'pill pill-gps-off';
    el.gpsStatus.textContent = errorMsg || 'Error GPS';
    el.gpsDot.classList.remove('active');
  } else {
    el.gpsPill.className = 'pill pill-gps-off';
    el.gpsStatus.textContent = 'GPS inactivo';
    el.gpsDot.classList.remove('active');
  }
}

function updateAudioStatusUI(status) {
  if (el.btnSkip) {
    el.btnSkip.disabled = false;
  }
}

// ─── Hold-to-Start Button Logic ──────────────────────────────────────────

let holdStartTime = null;
let holdRafId = null;
let routeStarted = false;
const CIRCUMFERENCE = 478;
const HOLD_MS = 1500;

// ─── Circular Route Mode ────────────────────────────────────────────────
let _lapCount = 0;          // In-memory lap counter (not persisted)
let _buttonMode = 'idle';   // 'idle' | 'running' | 'paused' | 'next-lap'

/**
 * Set the circular button mode.
 * Controls appearance, interaction model, and visual state.
 * @param {'idle'|'running'|'paused'|'next-lap'} mode
 */
function setButtonMode(mode) {
  _buttonMode = mode;

  if (el.holdCore) {
    el.holdCore.classList.remove('started', 'running');
    el.holdCore.style.borderColor = '';
    el.holdCore.style.boxShadow = '';
  }

  switch (mode) {
    case 'idle':
      if (el.holdLabel) el.holdLabel.textContent = 'INICIAR';
      if (el.holdHint) el.holdHint.textContent = 'Mantén pulsado 1.5s';
      if (el.holdCore) el.holdCore.style.borderColor = 'var(--brick-bright)';
      setHoldProgress(0);
      break;

    case 'running':
      if (el.holdLabel) el.holdLabel.textContent = 'EN CURSO';
      if (el.holdHint) el.holdHint.textContent = 'GPS activo';
      if (el.holdCore) {
        el.holdCore.style.borderColor = 'var(--ok)';
        el.holdCore.classList.add('started', 'running');
      }
      break;

    case 'paused':
      if (el.holdLabel) el.holdLabel.textContent = 'Ruta en pausa';
      if (el.holdCore) {
        el.holdCore.style.borderColor = 'var(--brass)';
      }
      break;

    case 'next-lap':
      if (el.holdLabel) el.holdLabel.textContent = 'Siguiente vuelta';
      if (el.holdHint) el.holdHint.textContent = `Toca para iniciar vuelta ${_lapCount + 1}`;
      if (el.holdCore) {
        el.holdCore.style.borderColor = 'var(--brass)';
        el.holdCore.style.boxShadow = '0 0 0 3px rgba(201,154,74,.25)';
      }
      setHoldProgress(0);
      break;
  }
}

function setHoldProgress(p) {
  if (el.holdFill) {
    el.holdFill.style.strokeDashoffset = CIRCUMFERENCE - (CIRCUMFERENCE * p);
  }
}

function holdTick(timestamp) {
  if (!holdStartTime) holdStartTime = timestamp;
  const elapsed = timestamp - holdStartTime;
  const p = Math.min(elapsed / HOLD_MS, 1);
  setHoldProgress(p);
  if (p >= 1) {
    onHoldComplete();
    return;
  }
  holdRafId = requestAnimationFrame(holdTick);
}

function onHoldPress(e) {
  // Unlock audio immediately on direct user gesture (mousedown/touchstart)
  unlockAudio();

  // In 'next-lap' mode: single tap starts immediately, no hold needed
  if (_buttonMode === 'next-lap') {
    if (e.cancelable) e.preventDefault();
    executeNextLap();
    return;
  }
  if (routeStarted) return;
  if (e.cancelable) e.preventDefault();
  holdStartTime = null;
  if (el.holdCore) el.holdCore.style.transform = 'scale(0.96)';
  holdRafId = requestAnimationFrame(holdTick);
}

function onHoldRelease() {
  if (_buttonMode === 'next-lap') return; // handled on press
  if (routeStarted) return;
  cancelAnimationFrame(holdRafId);
  if (el.holdCore) el.holdCore.style.transform = 'scale(1)';
  setHoldProgress(0);
  holdStartTime = null;
}

async function onHoldComplete() {
  if ('vibrate' in navigator) navigator.vibrate(50);
  const { route } = getState();
  if (route.length === 0) {
    logError('No hay ruta cargada. Edita o importa una ruta primero.');
    holdReset();
    return;
  }

  // Unlock audio on first user gesture (iOS/Android requirement)
  await unlockAudio();

  // Check GPS consent first
  if (localStorage.getItem('routemaker_gps_consent') !== 'true') {
    window.dispatchEvent(new CustomEvent('gps:request-consent', {
      detail: {
        callback: async () => {
          await executeRouteStart();
        }
      }
    }));
  } else {
    await executeRouteStart();
  }
}

function holdReset() {
  routeStarted = false;
  cancelAnimationFrame(holdRafId);
  if (el.holdCore) {
    el.holdCore.style.transform = 'scale(1)';
  }
  setButtonMode('idle');
  holdStartTime = null;
}

async function executeRouteStart() {
  routeStarted = true;
  if (el.holdCore) {
    el.holdCore.style.transform = 'scale(1)';
  }
  setButtonMode('running');

  // Play stop 1 immediately (synchronously trigger it to preserve user gesture context)
  setState({ currentStopIndex: 0 });
  markStopTriggered(0, 5000);
  playCurrentStop();

  // Update GPS pill visual state
  updateGPSStatusUI('running');

  // Trigger GPS route tracking (async background tasks)
  startRoute().catch(err => logError(err.message));
  if (localStorage.getItem('audio_ilertren_ambient') === 'on') {
    playAmbient();
  }
  enterFullscreen().catch(err => logWarn(err.message));

  // Show pause row
  if (el.pauseRow) el.pauseRow.classList.add('visible');

  // Start travel timer
  startRouteTimer();

  aplicarEstado(Estados.ACTIVO);
}

/**
 * Execute the start of the next lap (single-tap, no hold).
 * GPS stays active, ambient music continues, no permission re-request.
 */
async function executeNextLap() {
  if ('vibrate' in navigator) navigator.vibrate(50);
  routeStarted = true;
  setButtonMode('running');

  // Update now-playing label back to normal
  if (el.nowPlayingLabel) el.nowPlayingLabel.textContent = 'Reproduciendo ahora';

  // GPS pill back to running
  updateGPSStatusUI('running');

  // GPS is already active from previous lap — just ensure watchPosition is running
  const { gpsStatus } = getState();
  if (gpsStatus !== 'running') {
    startGPS();
  }

  // Show pause row (in case hidden)
  if (el.pauseRow) el.pauseRow.classList.add('visible');

  aplicarEstado(Estados.ACTIVO);
  logSuccess(`Vuelta ${_lapCount + 1} iniciada. GPS activo.`);

  // Play stop 1 immediately and mark it as triggered
  setState({ currentStopIndex: 0 });
  markStopTriggered(0, 5000);
  playCurrentStop();
}

/**
 * Called when the last stop audio finishes. Resets the route for the next lap
 * WITHOUT touching ambient music, GPS, or requiring new permissions.
 */
function onRouteComplete() {
  _lapCount++;
  const { route } = getState();

  logSuccess(`🎉 Vuelta ${_lapCount} completada. Lista para vuelta ${_lapCount + 1}.`);

  // 1. Reset internal route state
  setState({ currentStopIndex: 0 });
  resetTriggerLog();

  // 2. Ambient music: DO NOT touch it — continues playing as-is

  // 3. Update the now-playing card for "ready for next lap"
  const elParadaActual = document.getElementById('paradaActualNombre');
  const elParadaSiguiente = document.getElementById('paradaSiguienteNombre');

  if (el.nowPlayingLabel) el.nowPlayingLabel.textContent = 'LISTA PARA SIGUIENTE VUELTA';
  if (elParadaActual && route[0]) {
    elParadaActual.innerHTML = `<span class="now-playing-num">01.</span> ${route[0].name}`;
  }
  if (elParadaSiguiente && route[1]) {
    elParadaSiguiente.textContent = `02. ${route[1].name}`;
  }

  // Reset progress bar
  if (el.progressBar) el.progressBar.style.width = '0%';
  const elCurrentTime = document.getElementById('audioCurrentTime');
  const elDuration = document.getElementById('audioDuration');
  if (elCurrentTime) elCurrentTime.textContent = '0:00';
  if (elDuration) elDuration.textContent = '0:00';

  // Reset stop counter
  if (el.mapStopCounter) el.mapStopCounter.textContent = `1 / ${route.length}`;

  // 4. Change button to "next-lap" mode (single tap)
  setButtonMode('next-lap');

  // Keep pause/stop visible so conductor can still stop the whole session
}

// ─── Journey Stopwatch Logic ──────────────────────────────────────────────────

let routeTimerStartTimestamp = null;
let routeTimeElapsedMs = 0;
let routeTimerInterval = null;

function startRouteTimer() {
  if (routeTimerInterval) clearInterval(routeTimerInterval);
  routeTimerStartTimestamp = Date.now();
  routeTimerInterval = setInterval(() => {
    const elapsed = routeTimeElapsedMs + (Date.now() - routeTimerStartTimestamp);
    updateRouteTimerDisplay(elapsed);
  }, 1000);
}

function stopRouteTimer() {
  if (routeTimerInterval) {
    clearInterval(routeTimerInterval);
    routeTimerInterval = null;
  }
  if (routeTimerStartTimestamp) {
    routeTimeElapsedMs += Date.now() - routeTimerStartTimestamp;
    routeTimerStartTimestamp = null;
  }
}

function updateRouteTimerDisplay(ms) {
  const totalSecs = Math.floor(ms / 1000);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  
  const timeStr = `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  if (el.mapTimeInRoute) el.mapTimeInRoute.textContent = timeStr;
}

// ─── Clock logic ──────────────────────────────────────────────────────────────

function startClock() {
  const updateClock = () => {
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    if (el.currentTimeClock) el.currentTimeClock.textContent = timeStr;
  };
  updateClock();
  setInterval(updateClock, 15000);
}

// ─── GPS Alert Banner — 3-Level Degradation System ───────────────────────────────

let _poorAccuracyTimer = null;
let _gpsLostTimerL2    = null;   // 15s → amber
let _gpsLostTimerL3    = null;   // 60s → red
let _lastKnownPosition = null;   // { latitude, longitude, accuracy, timestamp }
let _currentGpsAlertLevel = null; // null | 'inactive' | 'weak' | 'lost'

// Default banner content (GPS not started)
const GPS_BANNER_DEFAULTS = {
  title: 'GPS INACTIVO — La ruta no puede guiarse',
  sub:   'Activa la ubicación antes de salir. Los audios no se dispararán automáticamente.',
  btn:   'Activar GPS ahora',
  bg:    'linear-gradient(135deg, #8C0A0A, #C8451E)',
};

function _syncMainHeight(bannerVisible) {
  // Desactivado: el flex:1 en CSS maneja la altura de forma dinámica nativa sin desbordamientos
}

/**
 * Show the GPS alert banner in "app not started" mode (red).
 * Used at boot or when GPS fails before a route is active.
 */
function showGpsAlert() {
  if (!el.gpsAlertBanner) return;

  // Reset to default content
  if (el.gpsAlertTitle) el.gpsAlertTitle.textContent = GPS_BANNER_DEFAULTS.title;
  if (el.gpsAlertSub)   el.gpsAlertSub.textContent   = GPS_BANNER_DEFAULTS.sub;
  if (el.gpsAlertRetry) el.gpsAlertRetry.textContent  = GPS_BANNER_DEFAULTS.btn;
  el.gpsAlertBanner.style.background = GPS_BANNER_DEFAULTS.bg;

  el.gpsAlertBanner.classList.add('visible');
  _currentGpsAlertLevel = 'inactive';
  _syncMainHeight(true);

  if ('vibrate' in navigator) navigator.vibrate([300, 100, 300]);
}

/**
 * Show the GPS alert banner adapted for an active route.
 * @param {'weak'|'lost'} level
 */
function showGpsAlertInRoute(level) {
  if (!el.gpsAlertBanner) return;

  if (level === 'weak') {
    if (el.gpsAlertTitle) el.gpsAlertTitle.textContent = '⚠️ SEÑAL GPS DÉBIL — Usando última posición conocida';
    if (el.gpsAlertSub)   el.gpsAlertSub.textContent   = 'Los audios seguirán activándose al recuperar señal';
    if (el.gpsAlertRetry) el.gpsAlertRetry.textContent  = 'Activar manualmente';
    el.gpsAlertBanner.style.background = 'linear-gradient(135deg, #7A5500, #C99A4A)';
    _currentGpsAlertLevel = 'weak';
  } else if (level === 'lost') {
    if (el.gpsAlertTitle) el.gpsAlertTitle.textContent = '🔴 GPS PERDIDO — Activa manualmente las paradas';
    if (el.gpsAlertSub)   el.gpsAlertSub.textContent   = "Pulsa 'Siguiente audio' cuando llegues a cada punto";
    if (el.gpsAlertRetry) el.gpsAlertRetry.textContent  = 'Entendido';
    el.gpsAlertBanner.style.background = 'linear-gradient(135deg, #8C0A0A, #C8451E)';
    _currentGpsAlertLevel = 'lost';

    // Update GPS pill to "GPS perdido"
    updateGPSStatusUI('error', 'GPS perdido');
  }

  el.gpsAlertBanner.classList.add('visible');
  _syncMainHeight(true);

  if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
}

/** Hide the GPS alert banner and reset all degradation timers. */
function hideGpsAlert() {
  if (!el.gpsAlertBanner) return;
  el.gpsAlertBanner.classList.remove('visible');
  el.gpsAlertBanner.style.background = '';
  _currentGpsAlertLevel = null;
  _syncMainHeight(false);
  _clearGpsLossTimers();
}

/** Clear all GPS loss degradation timers. */
function _clearGpsLossTimers() {
  if (_gpsLostTimerL2) { clearTimeout(_gpsLostTimerL2); _gpsLostTimerL2 = null; }
  if (_gpsLostTimerL3) { clearTimeout(_gpsLostTimerL3); _gpsLostTimerL3 = null; }
  if (_poorAccuracyTimer) { clearTimeout(_poorAccuracyTimer); _poorAccuracyTimer = null; }
}

/**
 * Start the GPS loss degradation timers (route-active context).
 * Level 2 at 15s, Level 3 at 60s.
 */
function _startGpsLossTimers() {
  if (_gpsLostTimerL2) return; // already running

  _gpsLostTimerL2 = setTimeout(() => {
    _gpsLostTimerL2 = null;
    showGpsAlertInRoute('weak');
    logWarn('Señal GPS débil durante >15s. Usando última posición conocida.');
  }, 15000);

  _gpsLostTimerL3 = setTimeout(() => {
    _gpsLostTimerL3 = null;
    showGpsAlertInRoute('lost');
    logError('GPS perdido durante >60s. Activa las paradas manualmente.');
  }, 60000);
}

/** Start/reset the poor-accuracy countdown (>50m for 10s → show alert). */
function onAccuracyCheck(accuracy) {
  if (accuracy > 50) {
    if (!_poorAccuracyTimer) {
      _poorAccuracyTimer = setTimeout(() => {
        if (routeStarted) {
          showGpsAlertInRoute('weak');
        } else {
          showGpsAlert();
        }
        _poorAccuracyTimer = null;
      }, 10000);
    }
  } else {
    if (_poorAccuracyTimer) {
      clearTimeout(_poorAccuracyTimer);
      _poorAccuracyTimer = null;
    }
  }
}

/**
 * GPS Recovery: check if any stops were skipped during GPS loss.
 * Compares lastKnownPosition vs newPosition against the route.
 * Advances index without playing skipped audios.
 */
function _checkSkippedStops(newLat, newLon, accuracy) {
  if (!_lastKnownPosition) return;

  const { route, currentStopIndex } = getState();
  if (!route || route.length === 0 || currentStopIndex >= route.length) return;

  // Find the closest remaining stop in route sequence order
  let closestIndex = currentStopIndex;
  let minDistance = Infinity;

  for (let i = currentStopIndex; i < route.length; i++) {
    const stop = route[i];
    const dist = haversine(newLat, newLon, stop.lat, stop.lon);
    if (dist < minDistance) {
      minDistance = dist;
      closestIndex = i;
    }
  }

  // Calculate effective radius and recovery threshold for target stop
  const targetStop = route[closestIndex];
  const baseRadius = targetStop.radius || 10;
  const effectiveRadius = Math.max(baseRadius, accuracy * 0.5);
  const recoveryThreshold = Math.max(effectiveRadius, 20); // 20m recovery margin

  if (closestIndex > currentStopIndex && minDistance <= recoveryThreshold) {
    logWarn(`GPS recuperado: saltando paradas omitidas hasta "${targetStop.name}" (distancia: ${Math.round(minDistance)}m).`);
    setState({ currentStopIndex: closestIndex });

    // If we are within the effective radius, play immediately
    if (minDistance <= effectiveRadius) {
      const canTrigger = markStopTriggered(closestIndex, 5000);
      if (canTrigger) {
        logSuccess(`📍 Llegada a (recuperado): ${targetStop.name} (${Math.round(minDistance)}m)`);
        playCurrentStop();
      }
    }
  }
}

// ─── Event Wiring ─────────────────────────────────────────────────────────────

let routePaused = false;

function wireControls() {
  // Circular Hold-to-Start Event Listeners
  if (el.holdBtn) {
    // Prevent magnifying glass / copy-paste popup menus on touch devices during hold
    el.holdBtn.addEventListener('contextmenu', e => e.preventDefault());

    const startTarget = el.holdCore || el.holdBtn;
    startTarget.addEventListener('mousedown', onHoldPress);
    startTarget.addEventListener('touchstart', e => {
      if (e.cancelable) e.preventDefault();
      onHoldPress(e);
    }, { passive: false });
    
    window.addEventListener('mouseup', onHoldRelease);
    window.addEventListener('touchend', onHoldRelease);
    window.addEventListener('touchcancel', onHoldRelease);
  }

  // Pause / Resume Route Event Listener
  if (el.pauseBtn) {
    el.pauseBtn.addEventListener('click', () => {
      if ('vibrate' in navigator) navigator.vibrate(50);
      routePaused = !routePaused;
      if (routePaused) {
        // Apply Paused Visuals
        el.pauseBtn.classList.add('is-paused');
        if (el.pauseIcon) el.pauseIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
        if (el.pauseLabel) el.pauseLabel.textContent = 'Reanudar';
        if (el.holdHint) el.holdHint.textContent = 'GPS en pausa';
        setButtonMode('paused');
        updateGPSStatusUI('paused');

        // Geolocation & Audio Pause actions
        stopGPS();
        pauseAudio();
        stopRouteTimer();
      } else {
        // Apply Active Visuals
        el.pauseBtn.classList.remove('is-paused');
        if (el.pauseIcon) el.pauseIcon.innerHTML = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
        if (el.pauseLabel) el.pauseLabel.textContent = 'Pausa';
        setButtonMode('running');
        updateGPSStatusUI('running');

        // Geolocation & Audio Resume actions
        startGPS();
        resumeAudio();
        if (localStorage.getItem('audio_ilertren_ambient') === 'on') {
          playAmbient();
        }
        startRouteTimer();
      }
    });
  }

  // PlayLast: immediately replay the last visited stop
  if (el.btnPlayLast) {
    el.btnPlayLast.addEventListener('click', () => {
      const { currentStopIndex } = getState();
      if (currentStopIndex > 0) {
        logInfo('Repitiendo parada anterior...');
        setState({ currentStopIndex: currentStopIndex - 1 });
        playCurrentStop();
      }
    });
  }

  // Skip: manually advance to next stop and play immediately
  if (el.btnSkip) {
    el.btnSkip.addEventListener('click', () => {
      if (el.btnSkip.hasAttribute('data-throttled')) return;
      el.btnSkip.setAttribute('data-throttled', 'true');
      setTimeout(() => el.btnSkip.removeAttribute('data-throttled'), 2000);

      if ('vibrate' in navigator) navigator.vibrate(50);
      logInfo('Parada omitida manualmente.');
      playCurrentStop();
    });
  }

  // PlayLast event ended

  // Retry GPS
  if (el.btnGpsRetry) {
    el.btnGpsRetry.addEventListener('click', () => {
      logInfo('Reintentando activar GPS...');
      el.btnGpsRetry.classList.add('hidden');
      startGPS();
    });
  }

  // GPS Alert Banner retry button — context-aware behavior
  if (el.gpsAlertRetry) {
    el.gpsAlertRetry.addEventListener('click', () => {
      // Level 3 "Entendido" — just dismiss the banner
      if (_currentGpsAlertLevel === 'lost') {
        hideGpsAlert();
        return;
      }
      // Otherwise, try to activate GPS
      if (el.btnGpsRetry) {
        el.btnGpsRetry.click();
      } else {
        logInfo('Reintentando activar GPS desde banner...');
        startGPS();
      }
    });
  }

  // Ambient toggle button
  if (el.btnAmbientToggle) {
    el.btnAmbientToggle.addEventListener('click', () => {
      if ('vibrate' in navigator) navigator.vibrate(50);
      toggleAmbient();
      updateAmbientToggleUI();
    });
  }

  // Dropdown manual stop selection
  if (el.stopSelector) {
    el.stopSelector.addEventListener('change', (e) => {
      const { route } = getState();
      const newIndex = parseInt(e.target.value, 10);
      if (Number.isFinite(newIndex) && newIndex >= 0 && newIndex < route.length) {
        stopAudio();
        setState({ currentStopIndex: newIndex });
        if (el.distanceValue) el.distanceValue.textContent = '—';
        logInfo(`Parada cambiada manualmente a: ${route[newIndex].name}`);
      }
    });
  }
}

function wireGPSEvents() {
  // Distance updates from GPS module — valid position received
  window.addEventListener('gps:distance', (e) => {
    const { distance, accuracy, speed, latitude, longitude } = e.detail;
    if (el.distanceValue) el.distanceValue.textContent  = distance;
    if (el.accuracyBadge) el.accuracyBadge.textContent  = `±${accuracy}m`;
    
    // Highlight closest stops in the manual selector dropdown
    const { route } = getState();
    populateStopSelector(route, latitude, longitude);
    
    // Update schematic map details
    if (el.mapEta) {
      el.mapEta.textContent = `🚏 Próxima en ${distance} m`;
    }
    if (el.mapDistancia) {
      el.mapDistancia.textContent = `${distance} m`;
    }
    if (el.mapSpeed) {
      const kmh = speed !== null && speed >= 0 ? Math.round(speed * 3.6) : 0;
      el.mapSpeed.textContent = `${kmh} km/h`;
    }

    // GPS Recovery: if we were in a loss state, check for skipped stops
    if (_currentGpsAlertLevel === 'weak' || _currentGpsAlertLevel === 'lost') {
      _checkSkippedStops(latitude, longitude);
      logSuccess('Señal GPS recuperada.');
    }

    // Store last known position for degradation recovery
    _lastKnownPosition = { latitude, longitude, accuracy, timestamp: Date.now() };

    // GPS is delivering valid positions → hide alert banner and clear all timers
    hideGpsAlert();

    // Monitor accuracy degradation (>50m for 10s → GPS blocked in buildings)
    onAccuracyCheck(accuracy);
  });

  window.addEventListener('gps:started', () => {
    updateGPSStatusUI('running');
    // Only hide alert if there's no active degradation (watchdog restarts
    // dispatch gps:started but don't mean we have signal yet)
    if (!_gpsLostTimerL2 && !_gpsLostTimerL3 && _currentGpsAlertLevel !== 'weak' && _currentGpsAlertLevel !== 'lost') {
      hideGpsAlert();
    }
    aplicarEstado(Estados.ACTIVO);
  });

  window.addEventListener('gps:stopped', () => {
    // Don't downgrade UI during active route with GPS loss (watchdog restarts
    // dispatch gps:stopped transiently — should be invisible to the user)
    if (routeStarted && (_currentGpsAlertLevel === 'weak' || _currentGpsAlertLevel === 'lost' || _gpsLostTimerL2)) {
      return;
    }
    updateGPSStatusUI('idle');
    if (el.distanceValue) el.distanceValue.textContent = '—';
    aplicarEstado(Estados.PAUSADO);
  });

  window.addEventListener('gps:error', (e) => {
    const { message } = e.detail || {};
    updateGPSStatusUI('error', message);

    if (!routeStarted) {
      // Pre-route: show the standard inactive alert
      showGpsAlert();
    } else {
      // Route active: start the 3-level degradation timers
      // Level 1 (<15s): silent — just let the timers run
      _startGpsLossTimers();
    }
  });
}

function initRGPD() {
  const modal = el.rgpdModal;
  const btnToggle = el.btnRgpdToggle;
  const moreInfo = el.rgpdMoreInfo;
  const btnAccept = el.btnRgpdAccept;

  if (!modal || !btnToggle || !moreInfo || !btnAccept) return;

  btnToggle.addEventListener('click', () => {
    const isExpanded = btnToggle.getAttribute('aria-expanded') === 'true';
    btnToggle.setAttribute('aria-expanded', !isExpanded);
    moreInfo.classList.toggle('hidden', isExpanded);
  });

  window.addEventListener('gps:request-consent', (e) => {
    const callback = e.detail?.callback;
    modal.classList.remove('hidden');
    
    const onAccept = () => {
      localStorage.setItem('routemaker_gps_consent', 'true');
      modal.classList.add('hidden');
      unlockAudio().then(() => {
        if (typeof callback === 'function') callback();
      });
    };
    
    btnAccept.addEventListener('click', onAccept, { once: true });
  });
}

// Warning if there are unexported edits & release WakeLock on close
window.addEventListener('beforeunload', (e) => {
  releaseWakeLock();
  const isEdited = localStorage.getItem('routemaker_route_edited_v1') === 'true';
  if (isEdited) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function wireEditorEvents() {
  // Pause GPS and release wake lock when editor opens
  window.addEventListener('editor:open', () => {
    stopGPS();
    stopRouteTimer();
    exitFullscreen();
  });

  window.addEventListener('editor:close', () => {
    const { gpsStatus } = getState();
    if (gpsStatus === 'running') {
      enterFullscreen();
    }
  });
}

// ─── State Subscriptions ──────────────────────────────────────────────────────

function wireStateSubscriptions() {
  subscribe(['currentStopIndex', 'route'], updateRouteUI);
  subscribe('route', (newRoute) => {
    populateStopSelector(newRoute);
    // Reset offline cache status since the route has changed
    localStorage.removeItem('audio_ilertren_offline_downloaded');
    if (el.btnDownloadOffline) {
      el.btnDownloadOffline.className = 'btn-edit';
      const btnText = el.btnDownloadOffline.querySelector('.btn-text');
      if (btnText) btnText.textContent = 'Descargar offline';
    }
  });
  subscribe('gpsStatus',   (val) => updateGPSStatusUI(val));
  subscribe('audioStatus', (val) => updateAudioStatusUI(val));
}

// ─── Service Worker ───────────────────────────────────────────────────────────

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    logInfo(`Service Worker registrado (scope: ${reg.scope}).`);
  } catch (err) {
    logWarn(`Service Worker no registrado: ${err.message}`);
  }
}

// ─── Audio Playback Progress Tracking ────────────────────────────────────────

function wireAudioProgressEvents() {
  if (!el.audioPlayer || !el.progressBar) return;

  const formatTime = (secs) => {
    if (isNaN(secs) || !isFinite(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  el.audioPlayer.addEventListener('play', () => {
    el.progressBar.classList.add('playing-active');
    el.progressBar.classList.remove('playing-ended');
  });

  el.audioPlayer.addEventListener('timeupdate', () => {
    const current = el.audioPlayer.currentTime || 0;
    const duration = el.audioPlayer.duration || 0;
    const percent = duration > 0 ? (current / duration) * 100 : 0;
    el.progressBar.style.width = `${percent}%`;

    const elCurrent = document.getElementById('audioCurrentTime');
    if (elCurrent) {
      elCurrent.textContent = formatTime(current);
    }
  });

  el.audioPlayer.addEventListener('durationchange', () => {
    const duration = el.audioPlayer.duration || 0;
    const elDuration = document.getElementById('audioDuration');
    if (elDuration) {
      elDuration.textContent = formatTime(duration);
    }
  });

  const resetProgressUI = () => {
    el.progressBar.style.width = '0%';
    el.progressBar.classList.remove('playing-active', 'playing-ended');
    const elCurrent = document.getElementById('audioCurrentTime');
    const elDuration = document.getElementById('audioDuration');
    if (elCurrent) elCurrent.textContent = '0:00';
    if (elDuration) elDuration.textContent = '0:00';
  };

  el.audioPlayer.addEventListener('emptied', resetProgressUI);
  el.audioPlayer.addEventListener('ended', () => {
    // Leave progress bar full at 100% when audio ends naturally
    el.progressBar.style.width = '100%';
    el.progressBar.classList.remove('playing-active');
    el.progressBar.classList.add('playing-ended');
    const duration = el.audioPlayer.duration || 0;
    const elCurrent = document.getElementById('audioCurrentTime');
    if (elCurrent) {
      elCurrent.textContent = formatTime(duration);
    }
    const { route, currentStopIndex } = getState();
    if (route.length > 0 && currentStopIndex >= route.length) {
      onRouteComplete();
    }
  });
}

// ─── Planilla Events ─────────────────────────────────────────────────────────

function wirePlanillaEvents() {
  if (el.btnOpenPlanilla) {
    el.btnOpenPlanilla.addEventListener('click', (e) => {
      e.preventDefault();
      if (el.planillaScreen && el.planillaIframe) {
        el.planillaIframe.src = './planilla.html';
        el.planillaScreen.classList.remove('hidden');
      }
    });
  }

  if (el.btnClosePlanilla) {
    el.btnClosePlanilla.addEventListener('click', () => {
      if (el.planillaScreen && el.planillaIframe) {
        el.planillaScreen.classList.add('hidden');
        el.planillaIframe.src = '';
      }
    });
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    // 1. Logger
    initLogger(el.logList);
    logInfo('Audio Ilertren iniciando...');

    // 2. Audio player
    initAudio(el.audioPlayer);

    // 3. Editor
    initEditor({
      screen:    el.editorScreen,
      stopsList: el.editorStopsList,
      btnOpen:   el.btnOpenEditor,
      btnClose:  el.btnCloseEditor,
      btnAdd:    el.btnAddStop,
      btnExport: el.btnExport,
      btnReset:  el.btnResetRoute,
    });

    // 4. Wire UI
    wireControls();
    wireGPSEvents();
    wireEditorEvents();
    wireStateSubscriptions();
    wireAudioProgressEvents();
    wirePlanillaEvents();
    
    // 5. Initialize secondary UI elements
    initRGPD();
    initTheme();
    initFullscreenBtn();
    initAmbientToggle();
    initDownloadOffline();

    // Start local time clock
    startClock();

    // Set initial button states
    aplicarEstado(Estados.INACTIVO);

    // Auto-start GPS if consent exists, otherwise show alert banner
    if (localStorage.getItem('routemaker_gps_consent') === 'true') {
      startGPS();
    } else {
      showGpsAlert();
    }

    // 5. WakeLock ligado a música de ambiente (Rule 5)
    const ambientSaved = localStorage.getItem('audio_ilertren_ambient');
    if (ambientSaved === 'on') {
      await requestWakeLock();
    }

    // 6. Load route
    const loaded = await loadRoute();
    if (loaded) {
      populateStopSelector(getState().route);
      updateRouteUI();
      logSuccess('Listo. Mantén pulsado "Iniciar Ruta" para comenzar.');

      // 6. Lazy-init live map (only after route is ready, reduces billable loads)
      const mapCard = document.getElementById('mapCard');
      if (mapCard) {
        // initMap(mapCard); // Desactivado temporalmente para mostrar mapa simulado
      }
    } else {
      if (el.holdLabel) {
        el.holdLabel.textContent = 'Sin ruta';
      }
    }

    // 6. Service Worker (non-blocking)
    registerServiceWorker();

  } catch (err) {
    console.error('[AudioIlertren] Fatal boot error:', err);
    if (el.stopSelector) el.stopSelector.innerHTML = '<option disabled selected>Error de inicio</option>';
    if (el.logList) {
      const li = document.createElement('li');
      li.dataset.level = 'error';
      li.innerHTML = `<span class="log-time">—</span><span class="log-msg">Error fatal: ${err.message}</span>`;
      el.logList.prepend(li);
    }
  }
}

// ─── Theme Toggle (Modo Claro / Oscuro) ─────────────────────────────────────────────

function initTheme() {
  const btn = el.btnTheme;
  if (!btn) return;

  // Restore last saved preference
  const saved = localStorage.getItem('audio_ilertren_theme');
  if (saved === 'dark') {
    document.documentElement.classList.add('dark-mode');
    btn.textContent = '☀️';
    btn.title = 'Cambiar a modo día';
    btn.setAttribute('aria-label', 'Cambiar a modo día');
  } else {
    document.documentElement.classList.remove('dark-mode');
    btn.textContent = '🌙';
    btn.title = 'Cambiar a modo noche';
    btn.setAttribute('aria-label', 'Cambiar a modo noche');
  }

  btn.addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark-mode');
    if (isDark) {
      btn.textContent = '☀️';
      btn.title = 'Cambiar a modo día';
      btn.setAttribute('aria-label', 'Cambiar a modo día');
      localStorage.setItem('audio_ilertren_theme', 'dark');
    } else {
      btn.textContent = '🌙';
      btn.title = 'Cambiar a modo noche';
      btn.setAttribute('aria-label', 'Cambiar a modo noche');
      localStorage.setItem('audio_ilertren_theme', 'day');
    }
  });
}

function initFullscreenBtn() {
  const btn = el.btnFullscreen;
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      enterFullscreen().catch(err => {
        if (typeof logWarn === 'function') logWarn(err.message);
      });
    } else {
      exitFullscreen();
    }
  });
}

// ─── Offline Route Caching ───────────────────────────────────────────────────

function initDownloadOffline() {
  const btn = el.btnDownloadOffline;
  if (!btn) return;

  const btnText = btn.querySelector('.btn-text');

  // Restore saved state
  const savedState = localStorage.getItem('audio_ilertren_offline_downloaded');
  if (savedState === 'success') {
    btn.classList.add('success');
    if (btnText) btnText.textContent = 'Todo descargado';
  }

  btn.addEventListener('click', async () => {
    if (btn.classList.contains('downloading')) return;

    btn.className = 'btn-edit downloading';
    if (btnText) btnText.textContent = 'Preparando...';
    if ('vibrate' in navigator) navigator.vibrate(50);

    try {
      const { route } = getState();
      if (!route || route.length === 0) {
        throw new Error('No hay ruta cargada.');
      }

      // Base assets to cache
      const urls = [
        './route.json',
        './assets/ambientetren.mp3',
        './assets/logos/ilertren-logo.png'
      ];

      // Add route audio files
      route.forEach(stop => {
        if (stop.audio && !stop.audio.startsWith('indexeddb_')) {
          urls.push(`./audios/${encodeURIComponent(stop.audio)}`);
        }
      });

      // Find active service worker cache
      const cacheNames = await caches.keys();
      const cacheName = cacheNames.find(name => name.startsWith('routemaker-')) || 'routemaker-v40';
      const cache = await caches.open(cacheName);

      let completed = 0;
      const total = urls.length;

      for (const url of urls) {
        try {
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          await cache.put(url, response);
          completed++;
          const percent = Math.round((completed / total) * 100);
          if (btnText) btnText.textContent = `Descargando... ${percent}%`;
        } catch (err) {
          console.error(`Failed to pre-download ${url}:`, err);
          throw new Error(`Fallo en ${url.split('/').pop()}`);
        }
      }

      btn.className = 'btn-edit success';
      if (btnText) btnText.textContent = 'Todo descargado';
      localStorage.setItem('audio_ilertren_offline_downloaded', 'success');
      logSuccess('¡Ruta y audios guardados en caché local!');
      if ('vibrate' in navigator) navigator.vibrate([100, 50, 100]);

    } catch (err) {
      console.error('Offline caching failed:', err);
      btn.className = 'btn-edit error';
      if (btnText) btnText.textContent = 'Error. Reintentar';
      logError(`Descarga fallida: ${err.message}`);
      if ('vibrate' in navigator) navigator.vibrate(300);
    }
  });
}

// ─── Ambient Toggle ──────────────────────────────────────────────────────────

function initAmbientToggle() {
  const btn = el.ambientBtn;
  const label = el.ambientLabel;
  if (!btn || !label) return;

  // Restore state from localStorage
  const saved = localStorage.getItem('audio_ilertren_ambient');
  let ambientOn = (saved === 'on');

  const updateUI = () => {
    btn.classList.toggle('on', ambientOn);
    label.textContent = ambientOn ? 'Música ambiente - ON' : 'Música ambiente';
  };

  // Set initial UI (audio is unlocked later via user interaction)
  updateUI();

  if (ambientOn) {
    document.addEventListener('click', function startAmbientOnFirstTouch() {
      // Re-read current state to ensure the user didn't turn it off manually in between
      const currentSaved = localStorage.getItem('audio_ilertren_ambient');
      if (currentSaved === 'on') {
        import('./audio.js').then(({ playAmbient }) => {
          playAmbient();
        });
      }
    }, { once: true });
  }

  btn.addEventListener('click', () => {
    ambientOn = !ambientOn;
    localStorage.setItem('audio_ilertren_ambient', ambientOn ? 'on' : 'off');
    updateUI();

    import('./audio.js').then(({ playAmbient, stopAmbient }) => {
      if (ambientOn) {
        playAmbient();
        requestWakeLock();
      } else {
        stopAmbient();
        releaseWakeLock();
      }
    });
  });
}

// ─── Global Error Boundary ───────────────────────────────────────────────────

window.addEventListener('unhandledrejection', (e) => {
  console.error('[AudioIlertren] Unhandled promise rejection:', e.reason);
  logError?.(`Error no controlado: ${e.reason?.message ?? e.reason}`);
});

window.addEventListener('error', (e) => {
  console.error('[AudioIlertren] Uncaught error:', e.error);
  logError?.(`Error: ${e.error?.message ?? e.message}`);
});

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
