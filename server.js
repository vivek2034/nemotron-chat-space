'use strict';
require('dotenv').config?.();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.NVIDIA_API_KEY;
const APP_PASSWORD = process.env.APP_PASSWORD;
const SECRET = process.env.SESSION_SECRET || 'development-only-change-this-secret';
const MODEL = process.env.MODEL_ID || 'nvidia/nemotron-3-ultra-550b-a55b';
const STORE_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(STORE_DIR, 'store.json');

if (!APP_PASSWORD) console.warn('WARNING: APP_PASSWORD is not set. Login is disabled only for local development.');
if (!API_KEY) console.warn('WARNING: NVIDIA_API_KEY is not set. Add it in your environment before chatting.');

fs.mkdirSync(STORE_DIR, { recursive: true });
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch { return { sessions: [], settings: {} }; }
}
let store = loadStore();
function saveStore() {
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('hex');
}
function makeToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 1000 * 60 * 60 * 24 * 14 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function validToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.');
  if (!safeEqual(signature, sign(payload))) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); }
  catch { return false; }
}
function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return next();
  const token = req.cookies?.nw_auth || parseCookies(req.headers.cookie || '').nw_auth;
  if (!validToken(token)) return res.status(401).json({ error: 'Please sign in again.' });
  next();
}
function parseCookies(header) {
  return Object.fromEntries(header.split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('='); return [v.slice(0, i), decodeURIComponent(v.slice(i + 1))];
  }));
}
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false }));

app.get('/api/health', (_req, res) => res.json({ ok: true, model: MODEL, configured: Boolean(API_KEY) }));
app.get('/api/auth/status', (req, res) => {
  const token = parseCookies(req.headers.cookie || '').nw_auth;
  res.json({ passwordRequired: Boolean(APP_PASSWORD), authenticated: !APP_PASSWORD || validToken(token) });
});
app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  if (!safeEqual(req.body?.password || '', APP_PASSWORD)) return res.status(401).json({ error: 'That password is not correct.' });
  res.cookie('nw_auth', makeToken(), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict', maxAge: 14 * 24 * 60 * 60 * 1000, path: '/'
  });
  res.json({ ok: true });
});
app.post('/api/logout', (_req, res) => {
  res.clearCookie('nw_auth', { httpOnly: true, sameSite: 'strict', path: '/' });
  res.json({ ok: true });
});

app.use('/api', requireAuth);
app.get('/api/bootstrap', (_req, res) => res.json({ sessions: store.sessions, settings: store.settings, model: MODEL }));
app.put('/api/store', (req, res) => {
  if (!req.body || !Array.isArray(req.body.sessions) || typeof req.body.settings !== 'object') {
    return res.status(400).json({ error: 'Invalid data.' });
  }
  if (JSON.stringify(req.body).length > 8_000_000) return res.status(413).json({ error: 'Workspace is too large.' });
  store = { sessions: req.body.sessions.slice(0, 300), settings: req.body.settings };
  saveStore();
  res.json({ ok: true });
});

app.post('/api/chat', async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'NVIDIA_API_KEY is not configured on the server.' });
  const { messages, temperature = 0.6, top_p = 0.95, max_tokens = 8192, system_prompt, enable_thinking = true } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'Messages are required.' });
  if (messages.length > 300 || JSON.stringify(messages).length > 1_500_000) return res.status(413).json({ error: 'Conversation is too large.' });

  
  const payload = {
      model: MODEL,
      messages: [
          ...(system_prompt
              ? [{ role: 'system', content: String(system_prompt).slice(0, 30000) }]
              : []),
          ...messages.map(m => ({
              role: ['user', 'assistant'].includes(m.role) ? m.role : 'user',
              content: String(m.content || '')
          }))
      ],
      temperature: Math.max(0, Math.min(2, Number(temperature))),
      top_p: Math.max(0, Math.min(1, Number(top_p))),
      max_tokens: Math.max(256, Math.min(32768, Number(max_tokens))),
      stream: true
  };

  let upstream;
  try {
    upstream = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10 * 60 * 1000)
    });
  } catch (err) {
    return res.status(502).json({ error: `Could not reach NVIDIA: ${err.message}` });
  }
  if (!upstream.ok) {
    const detail = await upstream.text();
    return res.status(upstream.status).json({ error: detail.slice(0, 3000) || 'NVIDIA request failed.' });
  }

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    if (!res.destroyed) res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Nemotron Workstation listening on ${PORT}`));
