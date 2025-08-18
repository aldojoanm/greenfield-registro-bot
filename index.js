// index.js (Messenger Router)
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
let CATALOG = loadJSON('./knowledge/catalog.json');
let PLAY    = loadJSON('./knowledge/playbooks.json');
let FAQS    = loadJSON('./knowledge/faqs.json');

// ===== CONSTANTES =====
const DEPARTAMENTOS = [
  'Santa Cruz','Cochabamba','La Paz','Chuquisaca','Tarija',
  'Oruro','Potosí','Beni','Pando'
];
const SUBZONAS_SCZ  = ['Norte','Este','Sur','Valles','Chiquitania'];
const CAT_QR = [
  { title: 'Herbicida',   payload: 'CAT_HERBICIDA' },
  { title: 'Insecticida', payload: 'CAT_INSECTICIDA' },
  { title: 'Fungicida',   payload: 'CAT_FUNGICIDA' }
];

// ===== SESIONES =====
const sessions = new Map();
function getSession(psid){
  if(!sessions.has(psid)){
    sessions.set(psid,{
      stage: 'discovery',
      pending: null,
      asked: { departamento:false, subzona:false, cultivo:false, categoria:false },
      vars: {
        departamento:null, subzona:null, category:null,
        cultivos: [],
        last_product:null, cantidad:null, hectareas:null, phone:null,
        last_detail_sku:null, last_detail_ts:0,
        candidate_sku:null
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
const upperNoDia = (t='') => t.normalize('NFD').replace(/\p{Diacritic}/gu,'').toUpperCase();

async function fetchProfileName(psid){
  try{
    const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(psid)}?fields=first_name,last_name&access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
    const f = globalThis.fetch || (await import('node-fetch')).default;
    const r = await f(url);
    if(!r.ok) return null;
    const j = await r.json();
    const fn = (j.first_name||'').trim();
    const ln = (j.last_name||'').trim();
    const full = [fn, ln].filter(Boolean).join(' ');
    return full || null;
  }catch{ return null; }
}

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

function findProduct(text){
  const nt = norm(text);
  return (CATALOG||[]).find(p=>{
    const n = norm(p.nombre||''); if(nt.includes(n)) return true;
    return n.split(/\s+/).filter(Boolean).every(tok=>nt.includes(tok));
  }) || null;
}

function levenshtein(a='', b=''){
  const m=a.length, n=b.length;
  const dp=Array.from({length:m+1},()=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++) dp[i][0]=i;
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      const cost = a[i-1]===b[j-1]?0:1;
      dp[i][j]=Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}
function fuzzyCandidate(text){
  const qRaw = norm(text).replace(/[^a-z0-9\s]/g,'').trim();
  if(!qRaw) return null;
  let best=null, bestScore=-1;
  for(const p of (CATALOG||[])){
    const name = norm(p.nombre||'');
    const dist = levenshtein(qRaw, name);
    const sim  = 1 - dist/Math.max(qRaw.length, name.length);
    if (sim > bestScore){ best = p; bestScore = sim; }
  }
  if (best && bestScore >= 0.75) return { prod: best, score: bestScore };
  return null;
}

// Categorías
function getProductsByCategory(cat){
  const key = norm(cat||'');
  return (CATALOG||[]).filter(p=>{
    const c = norm(p.categoria||'');
    if(key==='herbicida') return c.includes('herbicida');
    if(key==='insecticida') return c.includes('insecticida') || c.includes('acaricida') || c.includes('insecticida-acaricida');
    if(key==='fungicida')   return c.includes('fungicida');
    return false;
  });
}

function parseCantidad(text){
  const m = String(text).match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(l|lt|lts|litro?s|kg|kilos?|unid|unidad(?:es)?)/i);
  return m ? `${m[1].replace(',','.') } ${m[2].toLowerCase()}` : null;
}
function parseHectareas(text){
  const m = String(text).match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(ha|hect[aá]reas?)/i);
  return m ? m[1].replace(',','.') : null;
}
function parsePhone(text){
  const m = String(text).match(/(\+?\d[\d\s\-]{6,17}\d)/);
  return m ? m[1].replace(/[^\d+]/g,'') : null;
}
function detectDepartamento(text){
  const t = norm(text);
  for (const d of DEPARTAMENTOS) if (t.includes(norm(d))) return d;
  return null;
}
function detectSubzona(text){
  const t = norm(text);
  for (const z of SUBZONAS_SCZ) if (t.includes(norm(z))) return z;
  return null;
}

function detectCategory(text){
  const t = norm(text);
  if (/fungicida/.test(t)) return 'Fungicida';
  if (/insecticida\s*\+\s*acaricida|ins\.\s*\+\s*acaricida|insecticida-?acaricida|acaricida/.test(t)) return 'Insecticida';
  if (/herbicida/.test(t)) return 'Herbicida';
  if (/insecticida/.test(t)) return 'Insecticida';
  return null;
}
const mentionsAcaricida = t => /acaricida|insecticida\s*\+\s*acaricida|insecticida-?acaricida/i.test(norm(t));

const wantsCatalog  = t => /cat[aá]logo|portafolio|lista de precios/i.test(t) || /portafolio[- _]?newchem/i.test(norm(t));
const wantsLocation = t => /(ubicaci[oó]n|direcci[oó]n|mapa|d[oó]nde est[aá]n|donde estan)/i.test(t);
const wantsClose    = t => /(no gracias|gracias|eso es todo|listo|nada m[aá]s|ok gracias|est[aá] bien|finalizar)/i.test(norm(t));
const wantsBuy      = t => /(comprar|cerrar pedido|prepara pedido|proforma)/i.test(t);
const asksPrice     = t => /(precio|cu[aá]nto vale|cu[aá]nto cuesta|cotizar|costo)/i.test(t);

// NUEVO: detectar intención de pedir asesor / WhatsApp / número
const wantsAgent = t => /asesor|humano|ejecutivo|vendedor|representante|agente|contact(a|o|arme)|whats?app|wasap|wsp|wpp|n[uú]mero|telefono|tel[eé]fono|celular/i.test(norm(t));

const linkMaps  = () => `https://www.google.com/maps?q=${encodeURIComponent(`${STORE_LAT},${STORE_LNG}`)}`;
const humanZone = s => s.vars.departamento ? `${s.vars.departamento}${s.vars.subzona? ' – '+s.vars.subzona:''}` : 'tu zona';

function inferUnitFromProduct(s){
  const name = s?.vars?.last_product || '';
  const prod = name ? (CATALOG||[]).find(p => norm(p.nombre||'')===norm(name)) : null;
  const pres = (prod?.presentaciones||[]).join(' ').toLowerCase();
  if(/kg/.test(pres)) return 'Kg';
  if(/\b(l|lt|lts|litro)s?\b/.test(pres)) return 'L';
  const cat = (prod?.categoria || s?.vars?.category || '').toLowerCase();
  if(/herbicida|insecticida|fungicida/.test(cat)) return 'L';
  return 'Kg';
}

function summaryFrom(s, override={}){
  return {
    cliente: (override.cliente ?? s.profileName) || 'ND',
    departamento: override.departamento ?? (s.vars.departamento || 'ND'),
    subzona: override.subzona ?? (s.vars.subzona || 'ND'),
    cultivos: override.cultivos ?? (s.vars.cultivos?.length ? s.vars.cultivos.join(', ') : 'ND'),
    producto: override.producto ?? (s.vars.last_product || 'No especificado'),
    cantidad: override.cantidad ?? s.vars.cantidad,
    hectareas: override.hectareas ?? s.vars.hectareas,
    phone: override.phone ?? s.vars.phone
  };
}
function summaryText(s){
  const sum = summaryFrom(s);
  const logi = '**La entrega de tu pedido se realiza en nuestro almacén*. Con gusto podemos ayudarte a coordinar la logística del transporte si lo necesitas, pero ten en cuenta que este servicio no está incluido en el precio final.';
  return `Resumen de interés:
• ${sum.cliente}
• Departamento: ${sum.departamento}
• Zona: ${sum.subzona}
• Cultivos: ${sum.cultivos}
• Producto: ${sum.producto}
${sum.cantidad ? `• Cantidad: ${sum.cantidad}\n` : ''}${sum.hectareas ? `• Hectáreas: ${sum.hectareas}\n` : ''}${sum.phone ? `• Teléfono: ${sum.phone}\n` : ''}**Compra mínima: US$ 3.000 (puedes combinar productos).*
${logi}`;
}
function whatsappLink(sumOrSession){
  const sum = ('cliente' in (sumOrSession||{})) ? sumOrSession : summaryFrom(sumOrSession);
  if(!WA_SELLER_NUMBER) return null;
  const txt = [
    `Hola, soy ${sum.cliente} (vía Messenger). Me gustaría realizar una cotización con New Chem:`,
    `• Producto: ${sum.producto}`,
    sum.cantidad ? `• Cantidad: ${sum.cantidad}` : null,
    sum.hectareas ? `• Hectáreas: ${sum.hectareas}` : null,
    `• Cultivos: ${sum.cultivos}`,
    `• Departamento/Zona: ${sum.departamento}${sum.subzona!=='ND'?' – '+sum.subzona:''}`,
    sum.phone ? `• Teléfono: ${sum.phone}` : null,
    `Entiendo la compra mínima de US$ 3.000.`,
    `La entrega de tu pedido se realiza en nuestro almacén.`
  ].filter(Boolean).join('\n');
  return `https://wa.me/${WA_SELLER_NUMBER}?text=${encodeURIComponent(txt)}`;
}
const shouldShowDetail = (s, sku) => {
  if (s.vars.last_detail_sku !== sku) return true;
  return (Date.now() - (s.vars.last_detail_ts||0)) > 60000;
};
const markDetailShown = (s, sku) => { s.vars.last_detail_sku = sku; s.vars.last_detail_ts = Date.now(); };

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

// ===== IMÁGENES =====
function productImageSource(prod){
  const direct = prod.image_url || prod.imagen || (Array.isArray(prod.images)&&prod.images[0]) || prod.img;
  if (direct && /^https?:\/\//i.test(direct)) return { url: direct };

  const name = upperNoDia(prod?.nombre || '').trim();
  if(!name) return null;

  const baseA = name.replace(/[^A-Z0-9]/g,'');     
  const baseB = name.replace(/[^A-Z0-9]+/g,'_');   
  const exts = ['.png','.jpg','.jpeg','.webp'];

  for(const b of [baseA, baseB]){
    for(const ext of exts){
      const localPath = `image/${b}${ext}`;
      if (fs.existsSync(localPath)) {
        if (PUBLIC_BASE_URL) {
          return { url: `${PUBLIC_BASE_URL}/image/${b}${ext}` };
        } else {
          return { path: localPath };
        }
      }
    }
  }
  return null;
}

async function uploadAttachmentFromFile(filePath){
  const url = `https://graph.facebook.com/v20.0/me/message_attachments?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;

  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const mime =
    ext === 'png'  ? 'image/png'  :
    ext === 'jpg'  ? 'image/jpeg' :
    ext === 'jpeg' ? 'image/jpeg' :
    ext === 'webp' ? 'image/webp' :
                     'application/octet-stream';

  const buf = fs.readFileSync(filePath);
  const blob = new Blob([buf], { type: mime });
  const filename = filePath.split(/[\\/]/).pop();

  const form = new FormData();
  form.append('message', JSON.stringify({
    attachment: { type: 'image', payload: { is_reusable: true } }
  }));
  form.append('filedata', blob, filename);

  const r = await fetch(url, { method: 'POST', body: form });
  if(!r.ok){
    console.error('uploadAttachmentFromFile', await r.text());
    return null;
  }
  const j = await r.json();
  return j?.attachment_id || null;
}

// Envía imagen por URL o por attachment_id
async function sendImage(psid, source){
  const url=`https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;

  if (source?.path) {
    const attachment_id = await uploadAttachmentFromFile(source.path);
    if (!attachment_id) return;
    const payload = {
      recipient:{id:psid},
      message:{ attachment:{ type:'image', payload:{ attachment_id } } }
    };
    const r=await httpFetchAny(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!r.ok) console.error('sendImage(attachment_id)', await r.text());
    return;
  }

  if (source?.url) {
    const payload={
      recipient:{id:psid},
      message:{ attachment:{ type:'image', payload:{ url: source.url, is_reusable:true } } }
    };
    const r=await httpFetchAny(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!r.ok) console.error('sendImage(url)', await r.text());
  }
}

// ===== PREGUNTAS ATÓMICAS =====
async function askDepartamento(psid){
  const s=getSession(psid);
  if (s.lastPrompt==='departamento') return;
  s.lastPrompt='departamento'; s.pending='departamento'; s.asked.departamento=true;
  await sendQR(psid, '¡Perfecto! Para orientarte mejor podrias decirme, ¿en qué *departamento* produces?', DEPARTAMENTOS.map(d => ({title:d, payload:`DPTO_${d.toUpperCase().replace(/\s+/g,'_')}`})));
}
async function askSubzona(psid){
  const s=getSession(psid);
  if (s.lastPrompt==='subzona') return;
  s.lastPrompt='subzona'; s.pending='subzona'; s.asked.subzona=true;
  await sendQR(psid,'Gracias. ¿Qué *zona de Santa Cruz*?', [
    { title:'Norte',       payload:'SUBZ_NORTE'       },
    { title:'Este',        payload:'SUBZ_ESTE'        },
    { title:'Sur',         payload:'SUBZ_SUR'         },
    { title:'Valles',      payload:'SUBZ_VALLES'      },
    { title:'Chiquitania', payload:'SUBZ_CHIQUITANIA' }
  ]);
}
async function askCultivo(psid){
  const s=getSession(psid);
  if (s.lastPrompt==='cultivo') return;
  s.lastPrompt='cultivo'; s.pending='cultivo'; s.asked.cultivo=true;
  await sendText(psid,'Perfecto 🙌. Para darte una recomendación precisa, cuéntame por favor que *cultivos* manejas (por ejemplo: soya).');
}
async function askCategory(psid){
  const s=getSession(psid);
  if (s.lastPrompt==='categoria') return;
  s.stage='product';
  s.lastPrompt='categoria'; s.pending='categoria'; s.asked.categoria=true;
  await sendQR(psid,'¿Qué tipo de producto te interesa? Te puedo guiar 👇', CAT_QR);
}
async function listByCategory(psid){
  const s=getSession(psid);
  const prods = getProductsByCategory(s.vars.category||'');
  if(!prods.length) { await sendText(psid,'Por ahora no tengo productos en esa categoría. ¿Querés ver el catálogo completo?'); return; }
  s.pending='producto'; s.lastPrompt='producto';
  await sendText(psid, `${s.vars.category} disponibles:\n${prods.slice(0,10).map(p=>`• ${p.nombre}`).join('\n')}\n\nDecime cuál te interesa y te paso el detalle. *Compra mínima: US$ 3.000*`);
  await sendQR(psid, 'Sugerencias:', prods.slice(0,11).map(p=>({ title:p.nombre, payload:`PROD_${p.sku}` })));
}
async function showProduct(psid, prod){
  const s=getSession(psid);
  s.vars.last_product = prod.nombre;
  if (!shouldShowDetail(s, prod.sku)) return;

  const src = productImageSource(prod);
  if (src) {
    await sendImage(psid, src);
  } else {
    const plagas=(prod.plaga||[]).slice(0,5).join(', ')||'-';
    const present=(prod.presentaciones||[]).join(', ')||'-';
    await sendText(psid,
`Gracias por la info 🙌. Sobre *${prod.nombre}* (${prod.categoria}):
• Formulación / acción: ${prod.formulacion}
• Dosis de referencia: ${prod.dosis}
• Espectro objetivo: ${plagas}
• Presentaciones: ${present}
Ficha técnica: ${prod.link_ficha}
`
    );
  }

  markDetailShown(s, prod.sku);
}
async function afterSummary(psid){
  const s=getSession(psid);
  if(!s.profileName || s.profileName==='Cliente' || s.profileName==='ND'){
    const fetched = await fetchProfileName(psid);
    if (fetched) s.profileName = fetched;
  }

  await sendText(psid, summaryText(s));

  const wa = whatsappLink(s);
  if (wa) {
    await sendButtons(psid, 'Para enviarte tu cotización de forma detallada, continuaremos la conversación por WhatsApp.', [
      { type:'web_url', url: wa, title:'Abrir WhatsApp' }
    ]);
  } else {
    await sendText(psid, 'Podemos continuar por WhatsApp para coordinar mejor. Si lo prefieres, compárteme un número de contacto y te escribimos.');
  }

  await sendQR(psid, 'Si hay algo más en lo que pueda asistirte, házmelo saber.', [
    { title:'Seguir',    payload:'QR_SEGUIR' },
    { title:'Finalizar', payload:'QR_FINALIZAR' }
  ]);
}

// Helper para enviar link de WhatsApp en cualquier solicitud de “asesor/whatsapp/número”
async function sendWhatsAppLink(psid, session){
  const wa = whatsappLink(session);
  if (wa) {
    await sendButtons(psid, 'Abramos WhatsApp para atenderte directamente:', [
      { type:'web_url', url: wa, title:'Abrir WhatsApp' }
    ]);
  } else {
    await sendText(psid, 'Compárteme un número de contacto y te escribimos por WhatsApp.');
  }
  await sendQR(psid, '¿Hay algo más en lo que pueda ayudarte?', [
    { title:'Seguir', payload:'QR_SEGUIR' },
    { title:'Finalizar', payload:'QR_FINALIZAR' }
  ]);
}

async function nextStep(psid){
  const s=getSession(psid);
  if(!s.vars.departamento) return askDepartamento(psid);
  if(s.vars.departamento==='Santa Cruz' && !s.vars.subzona) return askSubzona(psid);
  if(!s.vars.cultivos || s.vars.cultivos.length===0) return askCultivo(psid);
  if(s.vars.last_product){
    if(!s.vars.cantidad && !s.vars.hectareas){
      s.pending='cantidad'; s.lastPrompt='cantidad';
      return sendText(psid,'Para poder realizar tu cotización, ¿me podrías decir qué *cantidad* necesitas *(L/KG)*?');
    }
    return;
  }
  if(!s.vars.category) return askCategory(psid);
  if(s.vars.category && !s.vars.last_product) return listByCategory(psid);
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
        if(!s.profileName) s.profileName = 'Cliente';

        // GET_STARTED
        if(ev.postback?.payload === 'GET_STARTED'){
          await sendText(psid, PLAY?.greeting || '¡Hola! 👋 Bienvenido/a a **New Chem**. Estoy aquí para ayudarte a elegir el producto correcto para *tu cultivo* y *tu zona*, de forma simple y segura.');
          await sendText(psid, '¿Te parece si empezamos por tu ubicación? Luego te muestro las opciones más adecuadas.');
          await sendQR(psid, 'También puedo guiarte por categoría 👇', CAT_QR);
          s.stage = 'discovery'; s.pending = null; s.lastPrompt=null;
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
          if(qr==='QR_SEGUIR'){
            await sendText(psid, 'Perfecto, seguimos por aquí 🙌. ¿En qué más te puedo ayudar?');
            await sendQR(psid, 'Puedes elegir una categoría para continuar 👇', CAT_QR);
            continue;
          }

          if(/^DPTO_/.test(qr)){
            const depRaw = qr.replace('DPTO_','').replace(/_/g,' ');
            const dep = canonicalizeDepartamento(depRaw);
            s.vars.departamento = dep; s.asked.departamento = true; s.pending=null; s.lastPrompt=null;
            s.vars.subzona = (dep==='Santa Cruz') ? s.vars.subzona : null;
            if(dep==='Santa Cruz' && !s.vars.subzona){ await askSubzona(psid); }
            else { await nextStep(psid); }
            continue;
          }
          if(/^SUBZ_/.test(qr)){
            const z = qr.replace('SUBZ_','').toLowerCase();
            const mapa = { norte:'Norte', este:'Este', sur:'Sur', valles:'Valles', chiquitania:'Chiquitania' };
            if (s.vars.departamento==='Santa Cruz') s.vars.subzona = mapa[z] || null;
            s.pending=null; s.lastPrompt=null;
            await nextStep(psid);
            continue;
          }
          if(/^CAT_/.test(qr)){
            const key = qr.replace('CAT_','').toLowerCase();
            s.vars.category = key==='herbicida' ? 'Herbicida' :
                              key==='insecticida' ? 'Insecticida' :
                              'Fungicida';
            s.stage='product'; s.pending=null; s.lastPrompt=null;
            await nextStep(psid);
            continue;
          }
          if(/^PROD_/.test(qr)){
            const sku = qr.replace('PROD_','');
            const prod = (CATALOG||[]).find(p=>p.sku===sku);
            if(prod){
              s.vars.last_product = prod.nombre;
              if (s.vars.departamento && (s.vars.departamento!=='Santa Cruz' || s.vars.subzona)){
                await showProduct(psid, prod);
              }
              await nextStep(psid);
            }
            continue;
          }
          if (qr==='OPEN_CATALOG'){
            await sendButtons(psid, 'Abrir catálogo completo', [{type:'web_url', url: CATALOG_URL, title:'Ver catálogo'}]);
            await sendQR(psid, '¿Hay algo más en lo que pueda ayudarte?', [
              { title:'Seguir', payload:'QR_SEGUIR' },
              { title:'Finalizar', payload:'QR_FINALIZAR' }
            ]);
            continue;
          }
          if (qr==='OPEN_LOCATION'){
            await sendButtons(psid, 'Nuestra ubicación en Google Maps 👇', [{type:'web_url', url: linkMaps(), title:'Ver ubicación'}]);
            await sendQR(psid, '¿Hay algo más en lo que pueda ayudarte?', [
              { title:'Seguir', payload:'QR_SEGUIR' },
              { title:'Finalizar', payload:'QR_FINALIZAR' }
            ]);
            continue;
          }

          text = qr.replace(/^QR_/,'').replace(/_/g,' ').trim() || text;
        }
        if(!text) continue;
        remember(psid,'user',text);

        // === CAPTURA PASIVA ===
        let cant = parseCantidad(text);
        if(!cant && (getSession(psid).pending==='cantidad')){
          const mOnly = text.match(/^\s*(\d{1,6}(?:[.,]\d{1,2})?)\s*$/);
          if(mOnly){
            const unit = inferUnitFromProduct(getSession(psid)).toLowerCase();
            cant = `${mOnly[1].replace(',','.') } ${unit}`;
          }
        }
        if(cant) getSession(psid).vars.cantidad = cant;

        const ha   = parseHectareas(text); if(ha) getSession(psid).vars.hectareas = ha;
        const phone= parsePhone(text);     if(phone) getSession(psid).vars.phone = phone;

        const prodExact = findProduct(text); if (prodExact) getSession(psid).vars.last_product = prodExact.nombre;

        if (wantsAgent(text)) {
          await sendWhatsAppLink(psid, getSession(psid));
          continue;
        }

        if(asksPrice(text)){
          const catTyped = detectCategory(text);
          if (prodExact) { getSession(psid).vars.last_product = prodExact.nombre; }
          if (catTyped)  { getSession(psid).vars.category = catTyped; getSession(psid).stage='product'; }
          if (mentionsAcaricida(text)) {
            await sendText(psid, 'Te muestro Insecticidas que cubren ácaros.');
          }
          await sendText(psid, 'Con gusto te preparo una *cotización* con un precio a medida. Solo necesito que me compartas unos datos para poder recomendarte la mejor opción para tu zona y cultivo');
          await nextStep(psid);
          continue;
        }

        const depTyped = detectDepartamento(text);
        if(depTyped){
          s.vars.departamento = depTyped; s.asked.departamento=true;
          s.vars.subzona = (depTyped==='Santa Cruz') ? s.vars.subzona : null;
          if (depTyped === 'Santa Cruz' && !s.vars.subzona){ await askSubzona(psid); }
          else { await nextStep(psid); }
          continue;
        }
        // Subzona SCZ por texto
        const subOnly = detectSubzona(text);
        if (subOnly && s.vars.departamento==='Santa Cruz' && !s.vars.subzona){
          s.vars.subzona = subOnly; await nextStep(psid); continue;
        }

        // Cultivos por texto libre (si está pendiente)
        if (s.pending==='cultivo'){
          const raw = text.split(/[,\s]+y\s+|,\s*|\s+y\s+/i).map(t=>t.trim()).filter(Boolean);
          const normalized = raw.map(t => title(t.toLowerCase()));
          s.vars.cultivos = Array.from(new Set([...(s.vars.cultivos||[]), ...normalized]));
          s.pending=null; s.lastPrompt=null;
          await nextStep(psid);
          continue;
        }

        // Peticiones globales
        if(wantsLocation(text)){
          await sendButtons(psid, 'Nuestra ubicación en Google Maps 👇', [{type:'web_url', url: linkMaps(), title:'Ver ubicación'}]);
          await sendQR(psid, '¿Hay algo más en lo que pueda ayudarte?', [
            { title:'Seguir', payload:'QR_SEGUIR' },
            { title:'Finalizar', payload:'QR_FINALIZAR' }
          ]);
          continue;
        }
        if(wantsCatalog(text)){
          await sendButtons(psid, 'Abrir catálogo completo', [{type:'web_url', url: CATALOG_URL, title:'Ver catálogo'}]);
          await sendQR(psid, '¿Hay algo más en lo que pueda ayudarte?', [
            { title:'Seguir', payload:'QR_SEGUIR' },
            { title:'Finalizar', payload:'QR_FINALIZAR' }
          ]);
          continue;
        }

        // Categoría por texto
        const catTyped2 = detectCategory(text);
        if(catTyped2){
          s.vars.category=catTyped2; s.asked.categoria=true; s.stage='product';
          if (mentionsAcaricida(text) && catTyped2==='Insecticida') {
            await sendText(psid, 'Te muestro Insecticidas que cubren ácaros.');
          }
        }

        // CIERRE
        if(wantsClose(text)){
          await sendText(psid, '¡Gracias por escribirnos! Si más adelante te surge algo, aquí estoy para ayudarte. 👋');
          clearSession(psid);
          continue;
        }

        // INTENCIÓN DE PRODUCTO
        const productIntent = prodExact || catTyped2 || asksPrice(text) || wantsBuy(text) || /producto|herbicida|insecticida|fungicida|acaricida|informaci[oó]n/i.test(norm(text));
        if (s.stage === 'discovery' && productIntent) s.stage = 'product';

        // Sugerencia fuzzy
        if (s.stage==='product' && !prodExact && !s.vars.last_product
            && !['departamento','subzona','cultivo','categoria'].includes(s.pending||'') ) {
          const cand = fuzzyCandidate(text);
          if (cand) {
            await sendQR(psid, `¿Te referías a *${cand.prod.nombre}*?`, [
              { title:`Sí, ${cand.prod.nombre}`, payload:`PROD_${cand.prod.sku}` },
              { title:'No, ver categorías', payload:'CAT_HERBICIDA' }
            ]);
            continue;
          }
        }

        if (s.stage === 'product') {
          await nextStep(psid);

          if (s.vars.last_product && s.vars.departamento && (s.vars.departamento!=='Santa Cruz' || s.vars.subzona)){
            const prod = findProduct(s.vars.last_product) || prodExact;
            if (prod) {
              await showProduct(psid, prod);
              if (s.vars.cantidad || s.vars.hectareas || wantsBuy(text) || asksPrice(text)) {
                await afterSummary(psid);
                continue;
              }
              if(!s.vars.cantidad && !s.vars.hectareas){
                s.pending='cantidad'; s.lastPrompt='cantidad';
                await sendText(psid,'Para poder realizar tu cotización, ¿me podrías decir qué *cantidad* necesitas *(L/KG)*?');
              }
            }
          }
          continue;
        }

        // Guía (solo categorías en QR)
        if (s.stage === 'discovery') {
          await sendText(psid, '¡Qué gusto saludarte!, Soy el asistente virtual de *New Chem* cuéntame en qué te ayudo. Puedes decirme el *nombre del producto*, tus *cultivos*, o elegir una *categoría* y te acompaño paso a paso.');
          await sendQR(psid, 'Puedo guiarte por categoría 👇', CAT_QR);
          continue;
        }

        // Fallback
        await sendText(psid, 'Para avanzar, indícame *producto, cultivos o categoría*.');
        await sendQR(psid, '¿Cómo deseas continuar?', CAT_QR);
      }
    }

    res.sendStatus(200);
  }catch(e){
    console.error('❌ /webhook', e);
    res.sendStatus(500);
  }
});

export default router;
