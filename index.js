// index.js (Messenger Router) — flujo simple: nombre → departamento → zona → WhatsApp
import 'dotenv/config';
import express from 'express';
import fs from 'fs';

const router = express.Router();
router.use(express.json());

// ===== ENV =====
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const CATALOG_URL = process.env.CATALOG_URL || 'https://tinyurl.com/PORTAFOLIO-NEWCHEM';
const WA_SELLER_NUMBER = (process.env.WA_SELLER_NUMBER || '').replace(/\D/g,'');
const STORE_LAT = process.env.STORE_LAT || '-17.7580406';
const STORE_LNG = process.env.STORE_LNG || '-63.1532503';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/,'');

// ===== DATA =====
function loadJSON(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return {}; } }
let FAQS = loadJSON('./knowledge/faqs.json');

// ===== CONSTANTES =====
const DEPARTAMENTOS = [
  'Santa Cruz','Cochabamba','La Paz','Chuquisaca','Tarija',
  'Oruro','Potosí','Beni','Pando'
];
const SUBZONAS_SCZ  = ['Norte','Este','Sur','Valles','Chiquitania'];

// ===== SESIONES =====
const sessions = new Map();
function getSession(psid){
  if(!sessions.has(psid)){
    sessions.set(psid,{
      pending: null, // 'nombre' | 'departamento' | 'subzona' | 'subzona_free'
      vars: {
        departamento:null, subzona:null,
        hectareas:null, phone:null
      },
      profileName: null,
      memory: [],
      lastPrompt: null
    });
  }
  return sessions.get(psid);
}
function clearSession(psid){ sessions.delete(psid); }
function remember(psid, role, content){
  const s=getSession(psid);
  s.memory.push({role,content,ts:Date.now()});
  if(s.memory.length>12) s.memory=s.memory.slice(-12);
}

// ===== HELPERS =====
const norm  = (t='') => t.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
const title = s => s.replace(/\w\S*/g, w => w[0].toUpperCase()+w.slice(1).toLowerCase());
const clamp = (t, n=20) => (t.length<=n? t : t.slice(0,n-1)+'…');

const linkMaps  = () => `https://www.google.com/maps?q=${encodeURIComponent(`${STORE_LAT},${STORE_LNG}`)}`;

function canonicalizeDepartamento(raw=''){
  const t = norm(raw);
  if (t.includes('santa cruz')) return 'Santa Cruz';
  if (t.includes('cochabamba')) return 'Cochabamba';
  if (t.includes('la paz')) return 'La Paz';
  if (t.includes('chuquisaca')) return 'Chuquisaca';
  if (t.includes('tarija')) return 'Tarija';
  if (t.includes('oruro')) return 'Oruro';
  if (t.includes('potosi')) return 'Potosí';
  if (t.includes('beni')) return 'Beni';
  if (t.includes('pando')) return 'Pando';
  return title(raw.trim());
}

function detectDepartamento(text){
  const t = norm(text);
  for (const d of DEPARTAMENTOS) if (t.includes(norm(d))) return d;
  return null;
}
function detectSubzonaSCZ(text){
  const t = norm(text);
  for (const z of SUBZONAS_SCZ) if (t.includes(norm(z))) return z;
  return null;
}

function parseHectareas(text){
  const m = String(text).match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(ha|hect[aá]reas?)/i);
  return m ? m[1].replace(',','.') : null;
}
function parsePhone(text){
  const m = String(text).match(/(\+?\d[\d\s\-]{6,17}\d)/);
  return m ? m[1].replace(/[^\d+]/g,'') : null;
}

// Intenciones “globales”
const wantsCatalog  = t => /cat[aá]logo|portafolio|lista de precios/i.test(t) || /portafolio[- _]?newchem/i.test(norm(t));
const wantsLocation = t => /(ubicaci[oó]n|direcci[oó]n|mapa|d[oó]nde est[aá]n|donde estan)/i.test(t);
const wantsClose    = t => /(no gracias|gracias|eso es todo|listo|nada m[aá]s|ok gracias|est[aá] bien|finalizar)/i.test(norm(t));
const asksPrice     = t => /(precio|cu[aá]nto vale|cu[aá]nto cuesta|cotizar|costo|proforma|cotizaci[oó]n)/i.test(t);
const wantsAgent    = t => /asesor|humano|ejecutivo|vendedor|representante|agente|contact(a|o|arme)|whats?app|wasap|wsp|wpp|n[uú]mero|telefono|tel[eé]fono|celular/i.test(norm(t));

// ===== FB SENDERS =====
async function httpFetchAny(...args){ const f=globalThis.fetch||(await import('node-fetch')).default; return f(...args); }
async function sendText(psid, text){
  const url=`https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const payload={ recipient:{id:psid}, message:{ text:String(text).slice(0,2000) } };
  const r=await httpFetchAny(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!r.ok) console.error('sendText', await r.text());
}
async function sendQR(psid, text, options=[]){
  const quick_replies=(options||[]).slice(0,11).map(o=>{
    if(typeof o==='string'){
      return { content_type:'text', title: clamp(o), payload:`QR_${o.replace(/\s+/g,'_').toUpperCase()}` };
    }
    return { content_type:'text', title: clamp(o.title), payload: o.payload || `QR_${o.title.replace(/\s+/g,'_').toUpperCase()}` };
  });
  const url=`https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const payload={ recipient:{id:psid}, message:{ text, quick_replies } };
  const r=await httpFetchAny(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!r.ok) console.error('sendQR', await r.text());
}
async function sendButtons(psid, text, buttons=[]){
  const url=`https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const payload={
    recipient:{id:psid},
    message:{ attachment:{ type:'template', payload:{
      template_type:'button',
      text:text.slice(0,640),
      buttons: buttons.slice(0,3).map(b=>{
        if(b.type==='web_url') return { type:'web_url', url:b.url, title:clamp(b.title) };
        if(b.type==='postback') return { type:'postback', payload:b.payload.slice(0,1000), title:clamp(b.title) };
        return null;
      }).filter(Boolean)
    } } }
  };
  const r=await httpFetchAny(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!r.ok) console.error('sendButtons', await r.text());
}

// ===== PREGUNTAS ATÓMICAS =====
async function askName(psid){
  const s=getSession(psid);
  if (s.pending==='nombre') return;
  s.pending='nombre';
  await sendText(psid, 'Antes de continuar, ¿Cuál es tu nombre completo? ✍️');
}
async function askDepartamento(psid){
  const s=getSession(psid);
  if (s.pending==='departamento') return;
  s.pending='departamento';
  const nombre = s.profileName ? `Gracias, ${s.profileName}. 😊\n` : '';
  await sendQR(psid,
    `${nombre}📍 Cuéntanos, ¿desde qué departamento de Bolivia nos escribes?`,
    DEPARTAMENTOS.map(d => ({title:d, payload:`DPTO_${d.toUpperCase().replace(/\s+/g,'_')}`}))
  );
}
async function askSubzonaSCZ(psid){
  const s=getSession(psid);
  if (s.pending==='subzona') return;
  s.pending='subzona';
  await sendQR(psid,'Gracias. ¿Qué *zona de Santa Cruz*?', [
    { title:'Norte',       payload:'SUBZ_NORTE'       },
    { title:'Este',        payload:'SUBZ_ESTE'        },
    { title:'Sur',         payload:'SUBZ_SUR'         },
    { title:'Valles',      payload:'SUBZ_VALLES'      },
    { title:'Chiquitania', payload:'SUBZ_CHIQUITANIA' }
  ]);
}
async function askSubzonaLibre(psid){
  const s=getSession(psid);
  if (s.pending==='subzona_free') return;
  s.pending='subzona_free';
  await sendText(psid, `Perfecto. ¿En qué *zona / municipio* de *${s.vars.departamento}* te encuentras? ✍️`);
}

// ===== RESUMEN / WHATSAPP =====
function summaryTextForFinal(s){
  const nombre = s.profileName || 'Cliente';
  const dep = s.vars.departamento || 'ND';
  const zona = s.vars.subzona || 'ND';
  const extra = [
    s.vars.hectareas ? `• Hectáreas: ${s.vars.hectareas}` : null,
    s.vars.phone ? `• Teléfono: ${s.vars.phone}` : null
  ].filter(Boolean).join('\n');

  return `¡Excelente, ${nombre}! 🚜 abajo la demas información recopilada
• Departamento: ${dep}
• Zona: ${zona}
${extra ? extra + '\n' : ''}Ten en cuenta que nuestra compra mínima es de USD 3.000 y la entrega del producto se realiza en nuestro almacén de Santa Cruz.
📲 Seguimos por WhatsApp para coordinar tu cotización.
Haz clic aquí 👇`;
}
function whatsappLinkFromSession(s){
  if(!WA_SELLER_NUMBER) return null;
  const nombre = s.profileName || 'Cliente';
  const txt = [
    `Hola, soy ${nombre} (vía Messenger). Me gustaría realizar una cotización con New Chem:`,
    `• Departamento/Zona: ${s.vars.departamento || 'ND'}${s.vars.subzona? ' – '+s.vars.subzona:''}`,
    s.vars.hectareas ? `• Hectáreas: ${s.vars.hectareas}` : null,
    s.vars.phone ? `• Teléfono: ${s.vars.phone}` : null,
    `Entiendo la compra mínima de US$ 3.000.`,
    `La entrega del pedido se realiza en el almacén de Santa Cruz.`
  ].filter(Boolean).join('\n');
  return `https://wa.me/${WA_SELLER_NUMBER}?text=${encodeURIComponent(txt)}`;
}
async function finishAndWhatsApp(psid){
  const s=getSession(psid);
  await sendText(psid, summaryTextForFinal(s));
  const wa = whatsappLinkFromSession(s);
  if (wa){
    await sendButtons(psid, '📲 Continuar en WhatsApp', [
      { type:'web_url', url: wa, title:'📲 Continuar en WhatsApp' }
    ]);
  }else{
    await sendText(psid, 'Comparte un número de contacto y te escribimos por WhatsApp.');
  }
}

// ===== Orquestador =====
async function nextStep(psid){
  const s=getSession(psid);
  if(!s.profileName) return askName(psid);
  if(!s.vars.departamento) return askDepartamento(psid);
  if(s.vars.departamento==='Santa Cruz' && !s.vars.subzona) return askSubzonaSCZ(psid);
  if(s.vars.departamento!=='Santa Cruz' && !s.vars.subzona) return askSubzonaLibre(psid);
  return finishAndWhatsApp(psid);
}

// ===== VERIFY =====
router.get('/webhook',(req,res)=>{
  const { ['hub.mode']:mode, ['hub.verify_token']:token, ['hub.challenge']:challenge } = req.query;
  if(mode==='subscribe' && token===VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ===== RECEIVE =====
router.post('/webhook', async (req,res)=>{
  try{
    if(req.body.object!=='page') return res.sendStatus(404);

    for(const entry of req.body.entry||[]){
      for(const ev of entry.messaging||[]){
        const psid = ev?.sender?.id; if(!psid) continue;
        if(ev.message?.is_echo) continue;

        const s = getSession(psid);
        if(!s.profileName) s.profileName = null; // pediremos nombre

        // GET_STARTED
        if(ev.postback?.payload === 'GET_STARTED'){
          await sendText(psid, '👋 ¡Hola! Bienvenido(a) a New Chem.\nTenemos agroquímicos al mejor precio y calidad para tu campaña. 🌱');
          await askName(psid);
          continue;
        }

        // INPUT
        let text = (ev.message?.text||'').trim();
        const qr = ev.message?.quick_reply?.payload || null;

        if(qr){
          if(qr==='QR_FINALIZAR'){
            await sendText(psid, '¡Gracias por escribirnos! Si más adelante te surge algo, aquí estoy para ayudarte. 👋');
            clearSession(psid);
            continue;
          }
          if(/^DPTO_/.test(qr)){
            const depRaw = qr.replace('DPTO_','').replace(/_/g,' ');
            const dep = canonicalizeDepartamento(depRaw);
            s.vars.departamento = dep; s.vars.subzona = null; s.pending=null;
            if(dep==='Santa Cruz') await askSubzonaSCZ(psid); else await askSubzonaLibre(psid);
            continue;
          }
          if(/^SUBZ_/.test(qr)){
            const z = qr.replace('SUBZ_','').toLowerCase();
            const mapa = { norte:'Norte', este:'Este', sur:'Sur', valles:'Valles', chiquitania:'Chiquitania' };
            if (s.vars.departamento==='Santa Cruz') s.vars.subzona = mapa[z] || null;
            s.pending=null;
            await nextStep(psid);
            continue;
          }
          // convertir otros QR a texto plano (por si los agregas luego)
          text = qr.replace(/^QR_/,'').replace(/_/g,' ').trim() || text;
        }
        if(!text) continue;
        remember(psid,'user',text);

        // === CAPTURA PASIVA EXTRA ===
        const ha   = parseHectareas(text); if(ha) s.vars.hectareas = ha;
        const phone= parsePhone(text);     if(phone) s.vars.phone = phone;

        // === CAPTURA DEL NOMBRE ===
        if(s.pending==='nombre'){
          const cleaned = title(text.replace(/\s+/g,' ').trim());
          if (cleaned.length >= 2){
            s.profileName = cleaned;
            s.pending=null;
            await askDepartamento(psid);
          }else{
            await sendText(psid,'¿Me repites tu *nombre completo* por favor? ✍️');
          }
          continue;
        }

        // INTENCIONES GLOBALES (responden en cualquier etapa)
        if(wantsLocation(text)){
          await sendButtons(psid, 'Nuestra ubicación en Google Maps 👇', [{type:'web_url', url: linkMaps(), title:'Ver ubicación'}]);
          continue;
        }
        if(wantsCatalog(text)){
          await sendButtons(psid, 'Abrir catálogo completo', [{type:'web_url', url: CATALOG_URL, title:'Ver catálogo'}]);
          continue;
        }
        if(asksPrice(text)){
          await sendText(psid, 'Con gusto te preparamos una *cotización*. Primero confirmemos tu ubicación para asignarte el asesor correcto.');
          await nextStep(psid);
          continue;
        }
        if(wantsAgent(text)){
          const wa = whatsappLinkFromSession(s);
          if (wa){
            await sendButtons(psid, 'Abramos WhatsApp para atenderte directamente:', [{type:'web_url', url: wa, title:'📲 Continuar en WhatsApp'}]);
          }else{
            await sendText(psid, 'Compártenos un número de contacto y seguimos por WhatsApp.');
          }
          continue;
        }
        if(wantsClose(text)){
          await sendText(psid, '¡Gracias por escribirnos! Si más adelante te surge algo, aquí estoy para ayudarte. 👋');
          clearSession(psid);
          continue;
        }

        // Captura de departamento por texto
        if(!s.vars.departamento){
          const depTyped = detectDepartamento(text);
          if(depTyped){
            s.vars.departamento = depTyped; s.vars.subzona=null;
            if(depTyped==='Santa Cruz') await askSubzonaSCZ(psid); else await askSubzonaLibre(psid);
            continue;
          }
        }

        // Captura de subzona:
        if(s.pending==='subzona_free' && !s.vars.subzona){
          const z = title(text.trim());
          if (z){ s.vars.subzona = z; s.pending=null; await nextStep(psid); }
          else { await sendText(psid,'¿Podrías escribir el *nombre de tu zona o municipio*?'); }
          continue;
        }
        if(s.vars.departamento==='Santa Cruz' && !s.vars.subzona){
          const z = detectSubzonaSCZ(text);
          if(z){ s.vars.subzona = z; await nextStep(psid); continue; }
        }

        // Si nada de lo anterior aplica, seguimos el flujo normal
        await nextStep(psid);
      }
    }

    res.sendStatus(200);
  }catch(e){
    console.error('❌ /webhook', e);
    res.sendStatus(500);
  }
});

export default router;
