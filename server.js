// server.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import waRouter from './wa.js';
import messengerRouter from './index.js';
import pricesRouter from './prices.js';      // ⬅️ nuevo

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

app.use('/image', express.static(path.join(__dirname, 'image')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => res.send('OK'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/privacidad', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
});

app.use(messengerRouter);
app.use(waRouter);
app.use(pricesRouter);                       // ⬅️ monta /admin/prices (GET y PUT)

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server unificado escuchando en :${PORT}`);
  console.log('   • Messenger:  GET/POST /webhook');
  console.log('   • WhatsApp:   GET/POST /wa/webhook');
  console.log('   • Prices API: GET/PUT  /admin/prices');
  console.log('   • Health:     GET /healthz');
  console.log('   • Imágenes:   /image/*');
  console.log('   • Privacidad: GET /privacidad');
});
