// Vercel Serverless Function — receives structured log entries from the React
// frontend and emits them to stdout so they appear in Vercel Logs alongside
// server-side logs.
//
// Called by src/lib/app/logger.js (frontend).
// Does NOT require auth — log entries carry no secrets. Rate-limit concerns
// are acceptable for a mini-app; add a token check here if abused.
//
// POST /api/log
// Body: { entries: Array<{ level, msg, ts, ...extra }> }
// Response: 204 No Content

import { makeLogger } from './_logger.js';

export default async function handler(req, res) {
  const log = makeLogger(req);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { entries } = req.body || {};
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'entries array required' });
  }

  for (const entry of entries) {
    const { level = 'info', msg = '(no msg)', ts, ...extra } = entry;
    // Re-emit each frontend entry through the server logger so it lands in
    // Vercel Logs as NDJSON with source=client tag for easy filtering.
    const safeLevel = ['info', 'warn', 'error'].includes(level) ? level : 'info';
    log[safeLevel](msg, { source: 'client', clientTs: ts, ...extra });
  }

  // 204 — no body needed, the frontend fire-and-forgets this.
  return res.status(204).end();
}
