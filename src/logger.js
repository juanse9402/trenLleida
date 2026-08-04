/**
 * logger.js — Centralized, timestamped UI log.
 * All modules import this instead of calling console.log or touching the DOM directly.
 */

const MAX_ENTRIES = 50;
let _listEl = null;

/**
 * Bind the logger to a <ul> or <ol> DOM element.
 * @param {HTMLElement} el
 */
export function initLogger(el) {
  _listEl = el;
}

/**
 * Log a message.
 * @param {string} message
 * @param {'info'|'success'|'warn'|'error'} level
 */
export function log(message, level = 'info') {
  const time = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Console output
  const consoleFn = { info: 'log', success: 'log', warn: 'warn', error: 'error' }[level] || 'log';
  console[consoleFn](`[AudioIlertren][${level.toUpperCase()}] ${message}`);

  if (!_listEl) return;

  // Enforce max entries
  while (_listEl.children.length >= MAX_ENTRIES) {
    _listEl.removeChild(_listEl.lastChild);
  }

  const li = document.createElement('li');
  li.className = 'log-line';
  li.dataset.level = level;

  const levelClass = level === 'success' ? 'ok' : level === 'warn' ? 'warn' : level === 'error' ? 'error' : '';
  li.innerHTML = `
    <span class="log-dot ${levelClass}"></span>
    <span class="log-time">${time}</span>
    <span class="log-msg ${levelClass}">${message}</span>`;

  _listEl.prepend(li);

  // Auto-scroll: como los nuevos logs van arriba (prepend), llevar al inicio
  // para que el conductor siempre vea el evento más reciente sin scroll manual.
  _listEl.scrollTop = 0;
}

export const logInfo    = (msg) => log(msg, 'info');
export const logSuccess = (msg) => log(msg, 'success');
export const logWarn    = (msg) => log(msg, 'warn');
export const logError   = (msg) => log(msg, 'error');
