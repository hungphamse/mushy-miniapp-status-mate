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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const ctx = await verifyRequest(req);
  if (!ctx) return res.status(401).json({ error: 'unauthorized' });

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY chưa set' });

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );
  if (!r.ok) {
    const text = await r.text();
    return res.status(502).json({ error: 'upstream', detail: text });
  }
  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return res.status(200).json({ text, workspaceId: ctx.workspaceId });
}
