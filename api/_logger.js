// Platform-agnostic structured logger — works in both Node (Vercel Functions)
// and browser (React frontend via api/log.js forwarding).
//
// ── Server-side (api/*.js) ──────────────────────────────────────────────────
//   import { makeLogger } from './_logger.js';
//   export default async function handler(req, res) {
//     const log = makeLogger(req);
//     log.info('handler started', { userId: ctx.userId });
//     log.warn('bad input', { field: 'prompt' });
//     log.error('upstream failed', { status: 502, detail });
//   }
//
// ── Client-side (React) ─────────────────────────────────────────────────────
//   Use src/lib/app/logger.js instead — it wraps this format and ships entries
//   to api/log.js so they appear in Vercel Logs alongside server-side logs.
//
// ── Log format (NDJSON) ─────────────────────────────────────────────────────
//   { level, msg, ts, requestId, method, url, ...extra }
//
//   Emitted as one JSON line per stdout write. Vercel captures stdout per
//   invocation; Log Drains (Datadog, Better Stack, …) parse fields automatically.

/**
 * Build a logger scoped to one Vercel Function invocation.
 * Emits NDJSON to stdout — parsed automatically by Vercel Log Drains.
 *
 * @param {import('@vercel/node').VercelRequest} req
 * @returns {{ info(msg: string, extra?: object): void, warn(msg: string, extra?: object): void, error(msg: string, extra?: object): void }}
 */
export function makeLogger(req) {
  // x-vercel-id is injected by Vercel on every inbound request.
  // Use it as a correlation ID so you can group all log lines for one request.
  const requestId =
    req?.headers?.['x-vercel-id'] ??
    req?.headers?.['x-request-id'] ??
    null;
  const method = req?.method ?? 'UNKNOWN';
  const url = req?.url ?? '';

  function emit(level, msg, extra = {}) {
    const entry = {
      level,
      msg,
      ts: new Date().toISOString(),
      requestId,
      method,
      url,
      ...extra,
    };
    // process.stdout.write — avoids any monkey-patched console.log and writes
    // directly to the stream Vercel captures as the function log.
    process.stdout.write(JSON.stringify(entry) + '\n');
  }

  return {
    /** Routine operational events (request received, query ok, …) */
    info: (msg, extra) => emit('info', msg, extra),
    /** Expected-but-notable events (auth failure, bad input, missing env var) */
    warn: (msg, extra) => emit('warn', msg, extra),
    /** Unexpected errors — shown in red in the Vercel dashboard */
    error: (msg, extra) => emit('error', msg, extra),
  };
}
