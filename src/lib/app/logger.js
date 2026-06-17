// Frontend structured logger — mirrors server-side log format.
//
// In development : writes to browser console (color-coded) only.
// In production  : batches entries and ships them to POST /api/log so they
//                  appear in Vercel Logs alongside server-side logs.
//
// Usage (anywhere in React):
//   import { log } from './logger.js';
//   log.info('OrgChart loaded', { squadCount: squads.length });
//   log.warn('allocation mismatch', { userId, total });
//   log.error('fetchOrgChart failed', { error: err.message });
//
// The logger is a singleton — context (userId, workspaceId) is read lazily
// from window.__APP_CONTEXT__ / VITE_DEV_* so it's always up-to-date.

const IS_DEV = import.meta.env.DEV;
const LOG_ENDPOINT = '/api/log';

// ── Batch flush config ───────────────────────────────────────────────────────
const FLUSH_INTERVAL_MS = 3_000; // ship queued entries every 3 s
const MAX_BATCH = 20;            // or immediately when batch reaches this size

let queue = [];
let flushTimer = null;

function getCtx() {
  try {
    const ctx = typeof window !== 'undefined' && window.__APP_CONTEXT__;
    if (ctx) return { userId: ctx.userId, workspaceId: ctx.workspaceId };
    if (IS_DEV) {
      return {
        userId: import.meta.env.VITE_DEV_USER_ID ?? null,
        workspaceId: import.meta.env.VITE_DEV_WORKSPACE_ID ?? null,
      };
    }
  } catch (_) {}
  return {};
}

function buildEntry(level, msg, extra = {}) {
  return {
    level,
    msg,
    ts: new Date().toISOString(),
    source: 'client',
    ...getCtx(),
    ...extra,
  };
}

// ── Console output (dev only) ────────────────────────────────────────────────
const CONSOLE_STYLE = {
  info:  'color:#4A9EFF;font-weight:bold',
  warn:  'color:#F5A623;font-weight:bold',
  error: 'color:#E63946;font-weight:bold',
};

function toConsole(level, msg, extra) {
  const label = `%c[${level.toUpperCase()}]%c ${msg}`;
  const reset = 'color:inherit;font-weight:normal';
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (Object.keys(extra).length) {
    fn(label, CONSOLE_STYLE[level], reset, extra);
  } else {
    fn(label, CONSOLE_STYLE[level], reset);
  }
}

// ── Remote flush (prod only) ─────────────────────────────────────────────────
async function flush() {
  if (queue.length === 0) return;
  const batch = queue.splice(0, MAX_BATCH);
  try {
    await fetch(LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: batch }),
      // keepalive lets the request survive page unload (e.g. navigation errors).
      keepalive: true,
    });
  } catch (_) {
    // Swallow — logging should never break the app. If the endpoint is down,
    // devs still have the console output above.
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
}

// Flush on page unload so we don't lose the last batch.
if (typeof window !== 'undefined') {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}

// ── Core emit ────────────────────────────────────────────────────────────────
function emit(level, msg, extra = {}) {
  const entry = buildEntry(level, msg, extra);

  // Always write to console in dev; also in prod for error level.
  if (IS_DEV || level === 'error') {
    toConsole(level, msg, extra);
  }

  if (!IS_DEV) {
    queue.push(entry);
    if (queue.length >= MAX_BATCH) {
      flush(); // immediate flush when batch is full
    } else {
      scheduleFlush();
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────
export const log = {
  /** Routine operational events (component mounted, data loaded, …) */
  info:  (msg, extra) => emit('info',  msg, extra),
  /** Expected-but-notable events (empty state, fallback triggered, …) */
  warn:  (msg, extra) => emit('warn',  msg, extra),
  /** Unexpected errors — always shown in console AND shipped immediately */
  error: (msg, extra) => emit('error', msg, extra),
};
