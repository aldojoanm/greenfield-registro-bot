// server.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';

import waRouter from './wa.js';
import messengerRouter from './index.js';
import pricesRouter from './prices.js';

// 🟣 Sheets (Hoja 4 = historial de chats)
import {
  summariesLastNDays,
  historyForIdLastNDays,
  appendMessage,
} from './src/sheets.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ========= ESTÁTICOS =========
app.use('/image', express.static(path.join(__dirname, 'image')));
app.use(express.static(path.join(__dirname, 'public')));

// Sirve el Inbox UI en /inbox
app.get('/inbox', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'inbox.html'))
);

// ========= BÁSICOS =========
app.get('/', (_req, res) => res.send('OK'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/privacidad', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
});

// ========= ROUTERS EXISTENTES =========
app.use(messengerRouter);
app.use(waRouter);
app.use(pricesRouter); // expone /api/prices y /price-data.json

// ========= AUTH SIMPLE PARA INBOX AGENTE =========
const AGENT_TOKEN = process.env.AGENT_TOKEN || ''; // si está vacío, acepta cualquiera
function validateToken(token) {
  if (!AGENT_TOKEN) return true;
  return token && token === AGENT_TOKEN;
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.sendStatus(401);
  const tok = h.slice(7).trim();
  if (!validateToken(tok)) return res.sendStatus(401);
  next();
}

// ========= SSE (EventSource) =========
const sseClients = new Set();
function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch {} }
}
app.get('/wa/agent/stream', (req, res) => {
  const token = String(req.query.token || '');
  if (!validateToken(token)) return res.sendStatus(401);

  res.setHeader('Content-Type',  'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.write(': ok\n\n');
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write('event: ping\ndata: "💓"\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// ========= ESTADO EFÍMERO (solo UI) =========
// "human" por chat (ya que Hoja 4 no guarda este flag)
const HUMAN = new Map(); // id -> boolean

// ========= INBOX API (Sheets Hoja 4) =========

// Lista de conversaciones (desde Hoja 4)
const INBOX_LIST_DAYS = Number(process.env.INBOX_HIST_DAYS || 30);
app.get('/wa/agent/convos', auth, async (_req, res) => {
  try {
    const rows = await summariesLastNDays(INBOX_LIST_DAYS);
    const convos = rows
      .map(r => ({
        id: String(r.id),
        name: r.name || String(r.id),
        last: r.last || '',
        unread: 0,                 // sin contador en Sheets
        human: !!HUMAN.get(String(r.id)),
      }))
      // ordenar por "último ts" descendente (ya viene así; por si acaso)
      .sort((a,b)=> (a.lastTs||0) < (b.lastTs||0) ? 1 : -1);

    res.json({ convos });
  } catch (err) {
    console.error('[convos]', err?.message || err);
    res.status(500).json({ error: 'no se pudo listar' });
  }
});

// Historial de un chat (desde Hoja 4)
const INBOX_HIST_DAYS = Number(process.env.INBOX_HIST_DAYS || 90);
app.get('/wa/agent/history/:id', auth, async (req, res) => {
  const id = String(req.params.id);
  try {
    const hist = await historyForIdLastNDays(id, INBOX_HIST_DAYS);
    const memory = hist.map(h => ({
      role: (h.role || '').toLowerCase(),   // user|bot|agent|sys
      content: h.content || '',
      ts: Number(h.ts) || Date.now(),
    }));
    const name = (hist[hist.length-1]?.name || id);
    res.json({ id, name, human: !!HUMAN.get(id), memory });
  } catch (err) {
    console.error('[history]', err?.message || err);
    res.status(500).json({ error: 'no se pudo leer historial' });
  }
});

// Enviar mensaje de ASESOR —> Hoja 4 (append) + SSE
app.post('/wa/agent/send', auth, async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: 'to y text requeridos' });

  const id = String(to);
  const ts = Date.now();

  try {
    // intentar leer el nombre actual (si existe en las últimas N horas)
    let displayName = '';
    try {
      const hist = await historyForIdLastNDays(id, 180);
      displayName = hist[hist.length-1]?.name || '';
    } catch {}

    await appendMessage({
      waId: id,
      name: displayName || id,
      ts,
      role: 'agent',
      content: String(text),
    });

    // Notificar al Inbox
    sseBroadcast('msg', { id, role:'agent', content:String(text), ts });

    res.json({ ok: true });
  } catch (err) {
    console.error('[send]', err?.message || err);
    res.status(500).json({ error: 'falló envío' });
  }
});

// Marcar como leído (efímero, no se guarda en Sheets)
app.post('/wa/agent/read', auth, (req, res) => {
  // Como la persistencia es Sheets, no hay estado "unread" global.
  // Respondemos OK para que la UI limpie el badge.
  res.json({ ok: true });
});

// Tomar/soltar por humano (efímero)
app.post('/wa/agent/handoff', auth, (req, res) => {
  const { to, mode } = req.body || {};
  if (!to) return res.status(400).json({ error: 'to requerido' });
  const id = String(to);
  HUMAN.set(id, mode === 'human');
  res.json({ ok: true });
});

// Envío de media -> Hoja 4 como líneas "📎 Archivo: ...", y caption si llega
const upload = multer({ storage: multer.memoryStorage() });
app.post('/wa/agent/send-media', auth, upload.array('files'), async (req, res) => {
  const { to, caption = '' } = req.body || {};
  const files = Array.isArray(req.files) ? req.files : [];
  if (!to) return res.status(400).json({ error: 'to requerido' });
  if (!files.length) return res.status(400).json({ error: 'files vacío' });

  const id = String(to);
  const tsBase = Date.now();

  // intentar nombre
  let displayName = '';
  try {
    const hist = await historyForIdLastNDays(id, 180);
    displayName = hist[hist.length-1]?.name || '';
  } catch {}

  try {
    let i = 0;
    for (const f of files) {
      const sizeKB = Math.round((Number(f.size || 0) / 1024) * 10) / 10;
      const line = `📎 Archivo: ${f.originalname} (${sizeKB} KB)`;
      const ts = tsBase + i++;
      await appendMessage({
        waId: id,
        name: displayName || id,
        ts,
        role: 'agent',
        content: line,
      });
      sseBroadcast('msg', { id, role:'agent', content:line, ts });
    }

    if (caption && caption.trim()) {
      const ts = tsBase + files.length;
      await appendMessage({
        waId: id,
        name: displayName || id,
        ts,
        role: 'agent',
        content: String(caption),
      });
      sseBroadcast('msg', { id, role:'agent', content:String(caption), ts });
    }

    res.json({ ok: true, sent: files.length });
  } catch (err) {
    console.error('[send-media]', err?.message || err);
    res.status(500).json({ error: 'falló envío media' });
  }
});

// ========= ARRANQUE =========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server unificado escuchando en :${PORT}`);
  console.log('   • Messenger:        GET/POST /webhook');
  console.log('   • WhatsApp:         GET/POST /wa/webhook');
  console.log('   • Precios API:      GET       /api/prices');
  console.log('   • Health:           GET       /healthz');
  console.log('   • Imágenes:         /image/*');
  console.log('   • Privacidad:       GET       /privacidad');
  console.log('   • Inbox UI:         GET       /inbox');
  console.log('   • Inbox API:        /wa/agent/* (convos, history, send, read, handoff, send-media, stream)');
  console.log('   • Sheets:           Hoja 4 (historial chats) — SHEETS_SPREADSHEET_ID');
  console.log('   • Días lista/hist:  INBOX_HIST_DAYS =', process.env.INBOX_HIST_DAYS || '(30/90 por defecto)');
});
