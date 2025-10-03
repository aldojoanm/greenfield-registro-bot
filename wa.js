import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { ensureEmployeeSheet, appendExpenseRow, todayTotalFor } from './sheets.js';

const app = express();
app.use(express.json());

/** ========= ENV & Utils ========= */
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'VERIFY_123';
const WA_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const DEBUG = process.env.DEBUG_LOGS === '1';
const dbg = (...a) => { if (DEBUG) console.log('[DBG]', ...a); };

// Sesiones en memoria: fromId -> { etapa, empleado, pend: {...}, ultimaCategoria }
const S = new Map();
const getS = (id) => { if (!S.has(id)) S.set(id, { etapa: 'ask_nombre' }); return S.get(id); };
const setS = (id, v) => S.set(id, v);

/** ========= WhatsApp helpers ========= */
async function waSendQ(to, payload) {
  const url = `https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const t = await r.text().catch(()=>'');
    console.error('[WA SEND ERROR]', r.status, t);
  }
}

const toText = (to, body) => waSendQ(to, {
  messaging_product: 'whatsapp', to, type: 'text',
  text: { body: String(body).slice(0, 4096), preview_url: false }
});

const clamp = (t, n=20)=> (String(t).length<=n? String(t) : String(t).slice(0,n-1)+'…');

const toButtons = (to, body, buttons=[]) => waSendQ(to, {
  messaging_product:'whatsapp', to, type:'interactive',
  interactive:{
    type:'button',
    body:{ text: String(body).slice(0,1024) },
    action:{ buttons: buttons.slice(0,3).map(b=>({ type:'reply', reply:{ id:b.payload || b.id, title: clamp(b.title) }})) }
  }
});

const toList = (to, body, title, rows=[]) => waSendQ(to, {
  messaging_product:'whatsapp', to, type:'interactive',
  interactive:{
    type:'list',
    body:{ text:String(body).slice(0,1024) },
    action:{
      button: title.slice(0,20),
      sections:[{ title, rows: rows.slice(0,10).map(r=>{
        const id = r.payload || r.id;
        const t  = clamp(r.title ?? '', 24);
        return { id, title: t };
      }) }]
    }
  }
});

/** ========= Flujo ========= */
const CATEGORIAS_MONETARIAS = [
  'combustible','alimentacion','hospedaje','peajes','aceites','llantas','frenos','otros'
];
const TODAS_CATEGORIAS = [...CATEGORIAS_MONETARIAS, 'kilometraje vehiculo'];

function saludo() {
  return `👋 Hola, soy el *Bot de Gastos*.\nRegistraré tus gastos en tu hoja personal de Excel (Google Sheets).`;
}

function pedirNombre() {
  return `¿Cuál es tu *nombre y apellido*? (Lo usaré como nombre de tu hoja; ejemplo: "Juan Pérez")`;
}

async function pedirCategoria(to) {
  const items = TODAS_CATEGORIAS.map(c => ({ title: c[0].toUpperCase()+c.slice(1), payload: `CAT_${c.toUpperCase().replace(/\s+/g,'_')}` }));
  await toList(to, '¿Qué deseas *registrar* ahora?', 'Elegir categoría', items);
}

async function pedirDetalle(to) {
  await toText(to, 'Escribe un *detalle* breve (ej.: "Ruta a Warnes", "Cambio pastillas", etc.).');
}

async function pedirFactura(to) {
  await toText(to, 'Número/serie de *factura o recibo* (si no aplica, escribe "ninguno").');
}

async function pedirMonto(to, categoria) {
  if (categoria === 'kilometraje vehiculo') {
    await toText(to, 'Indica los *kilómetros* (solo número).');
  } else {
    await toText(to, 'Indica el *monto* en Bs (solo número, ej.: 120.50).');
  }
}

function parseNumberFlexible(s='') {
  const t = String(s).replace(/\s+/g,'').replace(/,/g,'.');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** ========= Webhook verify ========= */
app.get('/wa/webhook', (req,res) => {
  const mode  = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const chall = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(String(chall || ''));
  return res.sendStatus(403);
});

/** ========= Webhook receive ========= */
app.post('/wa/webhook', async (req,res) => {
  try {
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    const msg    = value?.messages?.[0];

    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const s = getS(from);

    // Primer saludo
    if (!s.greeted) {
      s.greeted = true;
      await toText(from, saludo());
      await toText(from, '✨ *Flujo:* nombre → categoría → detalle → factura → monto/km → guardado → total del día.');
      await toText(from, 'También puedes escribir: "resumen" para ver total del día, o "cambiar nombre".');
      await toText(from, pedirNombre());
      s.etapa = 'ask_nombre';
      setS(from, s);
      return res.sendStatus(200);
    }

    /** Botones/lista */
    if (msg.type === 'interactive') {
      const br = msg.interactive?.button_reply;
      const lr = msg.interactive?.list_reply;
      const id = br?.id || lr?.id;

      if (id?.startsWith('CAT_')) {
        const categoria = id.replace('CAT_','').toLowerCase().replace(/_/g,' ');
        s.ultimaCategoria = categoria;
        s.pend = { detalle:null, factura:null, monto:null, km:null };
        s.etapa = 'ask_detalle';
        await pedirDetalle(from);
        setS(from, s);
        return res.sendStatus(200);
      }
      return res.sendStatus(200);
    }

    /** Texto libre */
    if (msg.type === 'text') {
      const text = (msg.text?.body || '').trim();

      // comandos rápidos
      if (/^cambiar\s+nombre$/i.test(text)) {
        s.etapa = 'ask_nombre';
        await toText(from, 'Ok, vamos a actualizar tu nombre/hoja.');
        await toText(from, pedirNombre());
        setS(from, s);
        return res.sendStatus(200);
      }
      if (/^resumen$/i.test(text)) {
        if (!s.empleado) {
          await toText(from, 'Primero necesito tu *nombre* para crear/usar tu hoja.');
          s.etapa = 'ask_nombre';
          await toText(from, pedirNombre());
          setS(from, s);
          return res.sendStatus(200);
        }
        const total = await todayTotalFor(s.empleado);
        await toText(from, `📅 *Total de HOY* para *${s.empleado}*: Bs ${total.toFixed(2)}.\n¿Registrar otra cosa?`);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }

      // flujo principal
      if (s.etapa === 'ask_nombre') {
        const nombre = text.replace(/\s+/g,' ').trim();
        if (nombre.length < 3 || !/\s/.test(nombre)) {
          await toText(from, 'Por favor, envía *nombre y apellido*. Ej.: "María López".');
          return res.sendStatus(200);
        }
        const hoja = await ensureEmployeeSheet(nombre);
        s.empleado = hoja;
        s.etapa = 'ask_categoria';
        await toText(from, `✅ Usaremos la hoja: *${hoja}*`);
        await pedirCategoria(from);
        setS(from, s);
        return res.sendStatus(200);
      }

      if (s.etapa === 'ask_categoria') {
        // Si la persona escribe la categoría en texto
        const t = text.toLowerCase();
        const hit = TODAS_CATEGORIAS.find(c => t.includes(c));
        if (!hit) {
          await toText(from, 'Elige/Escribe una *categoría* válida.');
          await pedirCategoria(from);
          return res.sendStatus(200);
        }
        s.ultimaCategoria = hit;
        s.pend = { detalle:null, factura:null, monto:null, km:null };
        s.etapa = 'ask_detalle';
        await pedirDetalle(from);
        setS(from, s);
        return res.sendStatus(200);
      }

      if (s.etapa === 'ask_detalle') {
        s.pend.detalle = text;
        s.etapa = 'ask_factura';
        await pedirFactura(from);
        setS(from, s);
        return res.sendStatus(200);
      }

      if (s.etapa === 'ask_factura') {
        s.pend.factura = /^ninguno$/i.test(text) ? '' : text;
        s.etapa = 'ask_monto';
        await pedirMonto(from, s.ultimaCategoria);
        setS(from, s);
        return res.sendStatus(200);
      }

      if (s.etapa === 'ask_monto') {
        if (s.ultimaCategoria === 'kilometraje vehiculo') {
          const km = parseNumberFlexible(text);
          if (!Number.isFinite(km) || km < 0) {
            await toText(from, 'Por favor, envía un *número* válido de *kilómetros* (ej.: 35).');
            return res.sendStatus(200);
          }
          s.pend.km = km;
        } else {
          const monto = parseNumberFlexible(text);
          if (!Number.isFinite(monto) || monto < 0) {
            await toText(from, 'Por favor, envía un *monto* válido en Bs (ej.: 120.50).');
            return res.sendStatus(200);
          }
          s.pend.monto = monto;
        }

        // Guardar en Sheets
        if (!s.empleado) {
          await toText(from, 'Falta tu *nombre* para crear/usar tu hoja.');
          s.etapa = 'ask_nombre';
          await toText(from, pedirNombre());
          setS(from, s);
          return res.sendStatus(200);
        }

        const { detalle, factura, monto, km } = s.pend;
        const saved = await appendExpenseRow(s.empleado, {
          detalle,
          factura,
          categoria: s.ultimaCategoria,
          monto,
          km
        });

        // Total del día
        const totalHoy = await todayTotalFor(s.empleado);

        await toText(from,
          `✅ *Guardado* en *${s.empleado}*\n` +
          `• Categoría: ${s.ultimaCategoria}\n` +
          `• Detalle: ${detalle}\n` +
          (factura ? `• Fact/Rec: ${factura}\n` : `• Fact/Rec: —\n`) +
          (s.ultimaCategoria === 'kilometraje vehiculo' ? `• Km: ${km}\n` : `• Monto: Bs ${monto?.toFixed(2)}\n`) +
          `• ID: ${saved.id} — Fecha: ${saved.fecha}\n\n` +
          `📅 *Total de HOY*: Bs ${totalHoy.toFixed(2)}`
        );

        // Reiniciar para siguiente registro
        s.etapa = 'ask_categoria';
        s.pend = null;
        await toButtons(from, '¿Registrar otra cosa?', [
          { title:'Sí, seguir', payload:'SEGUIR' },
          { title:'Ver resumen', payload:'RESUMEN' }
        ]);
        setS(from, s);
        return res.sendStatus(200);
      }

      // Respuestas a los botones “seguir / resumen” si llegan en texto:
      if (/^seguir$/i.test(text)) {
        s.etapa = 'ask_categoria';
        await pedirCategoria(from);
        setS(from, s);
        return res.sendStatus(200);
      }
      if (/^ver\s+resumen$/i.test(text) || /^resumen$/i.test(text)) {
        const total = await todayTotalFor(s.empleado);
        await toText(from, `📅 *Total de HOY* para *${s.empleado}*: Bs ${total.toFixed(2)}.\n¿Registrar otra cosa?`);
        await pedirCategoria(from);
        return res.sendStatus(200);
      }

      // fallback
      if (s.etapa === 'ask_categoria') {
        await pedirCategoria(from);
      } else if (s.etapa === 'ask_nombre') {
        await toText(from, pedirNombre());
      }

      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    res.sendStatus(500);
  }
});

/** ========= Arranque ========= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BOT escuchando en http://localhost:${PORT}`);
});
