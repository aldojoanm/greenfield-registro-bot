import 'dotenv/config';
import express from 'express';
import waRouter from './wa.js';
import messengerRouter from './index.js'; 

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// Estáticos (imágenes)
app.use('/image', express.static('image'));

// Health
app.get('/', (_req, res) => res.send('OK'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Routers
app.use(messengerRouter); 
app.use(waRouter);      
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server unificado escuchando en :${PORT}`);
  console.log('   • Messenger: GET/POST /webhook');
  console.log('   • WhatsApp:  GET/POST /wa/webhook');
  console.log('   • Health:    GET /healthz');
  console.log('   • Imágenes:  /image/*');
});
