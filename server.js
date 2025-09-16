// server.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { fileURLToPath, pathToFileURL } from 'url';

import waRouter from './wa.js';
import messengerRouter from './index.js';
import pricesRouter from './prices.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------------- Sheets loader (acepta ./src/sheets.js o ./sheets.js) ----------------
async function loadSheetsModule() {
  const candidates = [
    path.join(__dirname, 'src', 'sheets.js'),
    path.join(__dirname, 'sheets.js'),
  ];
  for (const p of candidates) {
    try {
      const mod = await import(pathToFileURL(p).href);
      console.log('[server] sheets cargado desde', p);
      return mod;
    } catch (e) {
      // sigue probando
    }
  }
  throw new Error('No encontré sheets.js. Colócalo en ./src/sheets.js o ./sheets.js');
}

const {
  summariesLastNDays,
  historyForIdLastNDays,
  appendMessage,
  readPrices,
  writePrices,
  readRate,
  writeRate,
} = await loadSheetsModule();

// ---------------- Estáticos ----------------
app.use('/image', express.static(path.join(__dirname, 'image')));
app.use(express.static(path.join(__dirname, 'public')));

// Sirve el Inbox UI (agent.html) desde /inbox
app.get('/inbox', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'agent.html'))
);

// ---------------- Básicos ----------------
app.get('/', (_req, res) => res.send('OK'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/privacidad', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
});

// ---------------- Routers existentes ----------------
app.use(messengerRouter);
app.use(waRouter);
app.use(pricesRouter);

// ================== AUTH simple para el Inbox ==================
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
function validateToken(token) {
  if (!AGENT_TOKEN) return true;               // si no configuras token, acepta cualquiera
  return token && token === AGENT_TOKEN;
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.sendStatus(401);
  if (!validateToken(h.slice(7).trim())) return res.sendStatus(401);
  next();
}

// ================== SSE (EventSource) ==================
const sseClients = new Set();
function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch {} }
}
app.get('/wa/agent/stream', (req, res) => {
  const token = String(req.query.token || '');
  if (!validateToken(token)) return res.sendStatus(401);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.write(': hi\n\n');

  const ping = setInterval(() => {
    try { res.write('event: ping\ndata: "💓"\n\n'); } catch {}
  }, 25000);

  sseClients.add(res);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// ================== Estado efímero (solo para UI) ==================
const STATE = new Map(); // id -> { human:boolean, unread:number, last?:string, name?:string }

// ================== API del Inbox (respaldado en Sheets Hoja 4) ==================
// Lista de conversaciones (lee últimos 30 días de Hoja 4 y combina con STATE)
app.get('/wa/agent/convos', auth, async (_req, res) => {
  try {
    const items = await summariesLastNDays(30); // [{id,name,last,lastTs}]
    // Combina con STATE (human/unread efímeros)
    const convos = items.map(it => {
      const st = STATE.get(it.id) || { human:false, unread:0 };
      return {
        id: it.id,
        name: it.name || it.id,
        last: it.last || '',
        unread: st.unread || 0,
        human: !!st.human,
      };
    })
    // orden por ts desc (ya viene, pero por si acaso)
    .sort((a,b)=> (b.lastTs||0) - (a.lastTs||0));

    res.json({ convos });
  } catch (e) {
    console.error('[convos]', e);
    res.status(500).json({ error: 'no se pudo leer Hoja 4' });
  }
});

// Historial de un chat (últimos 60 días)
app.get('/wa/agent/history/:id', auth, async (req, res) => {
  const id = String(req.params.id || '');
  try {
    const rows = await historyForIdLastNDays(id, 60); // [{wa_id,name,ts,role,content}]
    const memory = rows.map(r => ({ role:r.role, content:r.content, ts:r.ts }));
    const name = rows[rows.length-1]?.name || id;

    // setea last para UI
    const last = memory[memory.length-1]?.content || '';
    const st = STATE.get(id) || { human:false, unread:0 };
    STATE.set(id, { ...st, last, name, unread:0 });

    res.json({ id, name, human: !!st.human, memory });
  } catch (e) {
    console.error('[history]', e);
    res.status(500).json({ error: 'no se pudo leer historial' });
  }
});

// Enviar texto del asesor (guarda en Hoja 4 y emite SSE)
app.post('/wa/agent/send', auth, async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: 'to y text requeridos' });
  const id = String(to);
  const ts = Date.now();
  const name = (STATE.get(id)?.name) || id;

  try {
    await appendMessage({ waId:id, name, ts, role:'agent', content:String(text) });

    const st = STATE.get(id) || { human:false, unread:0 };
    STATE.set(id, { ...st, last:text, unread:0 });

    sseBroadcast('msg', { id, role:'agent', content:String(text), ts });
    res.json({ ok:true });
  } catch (e) {
    console.error('[send]', e);
    res.status(500).json({ error: 'no se pudo guardar en Hoja 4' });
  }
});

// Marcar como leído (solo efímero)
app.post('/wa/agent/read', auth, (req, res) => {
  const id = String(req.body?.to || '');
  if (!id) return res.status(400).json({ error:'to requerido' });
  const st = STATE.get(id) || { human:false, unread:0 };
  STATE.set(id, { ...st, unread:0 });
  res.json({ ok:true });
});

// Tomar/soltar por humano (solo efímero para UI)
app.post('/wa/agent/handoff', auth, (req, res) => {
  const id = String(req.body?.to || '');
  const mode = String(req.body?.mode || '');
  if (!id) return res.status(400).json({ error:'to requerido' });
  const st = STATE.get(id) || { human:false, unread:0 };
  STATE.set(id, { ...st, human: mode === 'human' });
  res.json({ ok:true });
});

// Envío de media (solo “logea” líneas en historial para que el agente lo vea)
const upload = multer({ storage: multer.memoryStorage() });
app.post('/wa/agent/send-media', auth, upload.array('files'), async (req, res) => {
  const { to, caption = '' } = req.body || {};
  if (!to) return res.status(400).json({ error: 'to requerido' });

  const id = String(to);
  const baseTs = Date.now();
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return res.status(400).json({ error: 'files vacío' });

  try {
    let idx = 0;
    for (const f of files) {
      const sizeKB = Math.round((Number(f.size || 0) / 1024) * 10) / 10;
      const line = `📎 Archivo: ${f.originalname} (${sizeKB} KB)`;
      const ts = baseTs + (idx++);
      await appendMessage({ waId:id, name:STATE.get(id)?.name || id, ts, role:'agent', content:line });
      sseBroadcast('msg', { id, role:'agent', content:line, ts });
    }
    if (caption && caption.trim()) {
      const ts = baseTs + files.length;
      await appendMessage({ waId:id, name:STATE.get(id)?.name || id, ts, role:'agent', content:String(caption) });
      sseBroadcast('msg', { id, role:'agent', content:String(caption), ts });
      const st = STATE.get(id) || { human:false, unread:0 };
      STATE.set(id, { ...st, last:caption, unread:0 });
    }
    res.json({ ok:true, sent: files.length });
  } catch (e) {
    console.error('[send-media]', e);
    res.status(500).json({ error: 'no se pudo guardar en Hoja 4' });
  }
});

// ================== (Opcional) endpoints de precios usando Hoja 3 ==================
app.get('/api/prices', async (_req, res) => {
  try {
    const { prices, version, rate } = await readPrices();
    res.json({ prices, version, rate });
  } catch (e) {
    console.error('[api/prices]', e);
    res.status(500).json({ error:'no se pudo leer Hoja 3' });
  }

  // ======= Importar todos los chats desde Sheets (Hoja 4) =======
  app.post('/wa/agent/import-whatsapp', auth, async (req, res) => {
  try {
    const days = Number(req.body?.days || 365); // rango de lectura
    const items = await summariesLastNDays(days); // [{id,name,last,lastTs}]

    // Pre-cargar estado efímero para la UI (nombre/last)
    for (const it of items) {
      const st = STATE.get(it.id) || { human:false, unread:0 };
      STATE.set(it.id, { ...st, name: it.name || it.id, last: it.last || '' });
    }

    res.json({ ok: true, imported: items.length });
  } catch (e) {
    console.error('[import-whatsapp]', e);
    res.status(500).json({ error: 'no se pudo importar desde Sheets' });
  }
});

});



// ================== Arranque ==================
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
});
