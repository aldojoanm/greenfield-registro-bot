// server.js (o el archivo donde inicias tu app)
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import waRouter from './wa.js';
import messengerRouter from './index.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// __dirname para ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Estáticos
app.use('/image', express.static(path.join(__dirname, 'image')));   // ya lo tenías
app.use(express.static(path.join(__dirname, 'public')));            // <-- sirve /public

// Health
app.get('/', (_req, res) => res.send('OK'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Política de privacidad (ruta “bonita”)
app.get('/privacidad', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
});

// Routers
app.use(messengerRouter);
app.use(waRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server unificado escuchando en :${PORT}`);
  console.log('   • Messenger:  GET/POST /webhook');
  console.log('   • WhatsApp:   GET/POST /wa/webhook');
  console.log('   • Health:     GET /healthz');
  console.log('   • Imágenes:   /image/*');
  console.log('   • Privacidad: GET /privacidad');
});
