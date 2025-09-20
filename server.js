// server.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// Routers
import waRouter from './wa.js';
import messengerRouter from './index.js';
import pricesRouter from './prices.js';

// (Opcional) utilidades de Sheets SOLO para el import del Inbox
import { summariesLastNDays } from './sheets.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ===== Estáticos / UI =====
app.use('/image', express.static(path.join(__dirname, 'image')));
app.use(express.static(path.join(__dirname, 'public')));

// UI del inbox
app.get('/inbox', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'agent.html'));
});

// Básicos
app.get('/', (_req, res) => res.send('OK'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/privacidad', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
});

// ===== Routers de negocio =====
app.use(messengerRouter);
app.use(waRouter);
app.use(pricesRouter);

// ===== AUTH simple para utilidades Inbox (solo si usas el import manual) =====
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
function validateToken(token) {
  if (!AGENT_TOKEN) return true; // si no configuras token, acepta cualquiera
  return token && token === AGENT_TOKEN;
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.sendStatus(401);
  if (!validateToken(h.slice(7).trim())) return res.sendStatus(401);
  next();
}

// ======= Endpoint opcional: importar WhatsApp desde Sheets al Inbox UI =======
// (nota) NO colisiona con /wa/agent/* porque usamos prefijo /inbox/*
const STATE = new Map(); // id -> { human:boolean, unread:number, last?:string, name?:string }

app.post('/inbox/import-whatsapp', auth, async (req, res) => {
  try {
    const days = Number(req.body?.days || 3650);       // ~10 años
    const items = await summariesLastNDays(days);      // [{ id, name, last, lastTs }]
    for (const it of items) {
      const st = STATE.get(it.id) || { human:false, unread:0 };
      STATE.set(it.id, { ...st, name: it.name || it.id, last: it.last || '' });
    }
    res.json({ ok: true, imported: items.length });
  } catch (e) {
    console.error('[inbox/import-whatsapp]', e);
    res.status(500).json({ error: 'no se pudo importar desde Sheets' });
  }
});

// ===== Arranque =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server escuchando en :${PORT}`);
  console.log('   • Messenger:        GET/POST /webhook');
  console.log('   • WhatsApp:         GET/POST /wa/webhook');
  console.log('   • Inbox UI:         GET       /inbox');
  console.log('   • Inbox API (WA):   /wa/agent/*  (expuesto por wa.js)');
  console.log('   • Import Inbox:     POST      /inbox/import-whatsapp  (opcional)');
  console.log('   • Health:           GET       /healthz');
});
