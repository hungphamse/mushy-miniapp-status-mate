// Vercel Serverless Function — proxy gọi AI để giấu API key.
// Mini-app gọi: POST /api/ai-proxy với { prompt }
//   header: Authorization: Bearer {token}, X-Workspace-Id: {workspaceId}
//
// Set env ở Vercel:
//   GEMINI_API_KEY  (AI provider — secret thật, KHÔNG cho vào mushy.config.json)
//
// _verify.js dùng anon + user JWT (không cần service_role). URL + anon key
// đọc từ mushy.config.json đã committed.

import { verifyRequest } from './_verify.js';
import { makeLogger } from './_logger.js';

export default async function handler(req, res) {
  const log = makeLogger(req);

  if (req.method !== 'POST') {
    log.warn('method not allowed', { method: req.method });
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const ctx = await verifyRequest(req);
  if (!ctx) return res.status(401).json({ error: 'unauthorized' });

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    log.warn('bad request: prompt missing or not a string', { userId: ctx.userId });
    return res.status(400).json({ error: 'prompt required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log.error('GEMINI_API_KEY not set');
    return res.status(500).json({ error: 'GEMINI_API_KEY chưa set' });
  }

  log.info('ai-proxy: calling Gemini', {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    promptLength: prompt.length,
  });

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );

  if (!r.ok) {
    const detail = await r.text();
    log.error('ai-proxy: Gemini upstream error', {
      upstreamStatus: r.status,
      detail,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return res.status(502).json({ error: 'upstream', detail });
  }

  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  log.info('ai-proxy: ok', {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    responseLength: text.length,
  });

  return res.status(200).json({ text, workspaceId: ctx.workspaceId });
}
