// wa.js — WhatsApp 
import 'dotenv/config';
import express from 'express';
import fs from 'fs';

const router = express.Router();
router.use(express.json());

// ===== ENV =====
const PORT_WA      = process.env.PORT_WA || 3001; 
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'VERIFY_123';
const WA_TOKEN     = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID  = process.env.WHATSAPP_PHONE_ID || '';
const CATALOG_URL  = process.env.CATALOG_URL || 'https://tinyurl.com/PORTAFOLIO-NEWCHEM';
const STORE_LAT    = process.env.STORE_LAT || '-17.7580406';
const STORE_LNG    = process.env.STORE_LNG || '-63.1532503';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/,'');

// ===== DATA =====
function loadJSON(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return {}; } }
const CATALOG = loadJSON('./knowledge/catalog.json');
const PLAY    = loadJSON('./knowledge/playbooks.json');
const FAQS    = loadJSON('./knowledge/faqs.json');

// ===== CONSTANTES =====
const DEPARTAMENTOS = ['Santa Cruz','Cochabamba','La Paz','Chuquisaca','Tarija','Oruro','Potosí','Beni','Pando'];
const SUBZONAS_SCZ  = ['Norte','Este','Sur','Valles','Chiquitania'];
const CAT_QR = [
  { title: 'Herbicida',   payload: 'CAT_HERBICIDA' },
  { title: 'Insecticida', payload: 'CAT_INSECTICIDA' },
  { title: 'Fungicida',   payload: 'CAT_FUNGICIDA' }
];
const linkMaps  = () => `https://www.google.com/maps?q=${encodeURIComponent(`${STORE_LAT},${STORE_LNG}`)}`;

// ===== MODO HUMANO (mute 4h) =====
const humanSilence = new Map(); 
const HOURS = (h)=> h*60*60*1000;
const humanOn  = (id, hours=4)=> humanSilence.set(id, Date.now()+HOURS(hours));
const humanOff = (id)=> humanSilence.delete(id);
const isHuman  = (id)=> (humanSilence.get(id)||0) > Date.now();

// ===== SESIONES =====
const sessions = new Map();
function S(id){
  if(!sessions.has(id)){
    sessions.set(id,{
      greeted:false,
      stage: 'discovery',
      pending: null,
      asked: { departamento:false, subzona:false, cultivo:false, categoria:false },
      vars: {
        departamento:null, subzona:null, category:null,
        cultivos: [],
        cultivo_etapa:null,
        last_product:null, last_sku:null, cantidad:null, hectareas:null, phone:null,
        last_detail_sku:null, last_detail_ts:0,
        candidate_sku:null,
        catOffset:0,
        cart: [] 
      },
      profileName: null,
      memory: [],
      lastPrompt: null,
      lastPromptTs: 0,
      meta: { origin:null, referral:null, referralHandled:false }
    });
  }
  return sessions.get(id);
}
function clearS(id){ sessions.delete(id); }

// ===== HELPERS =====
const norm  = (t='') => t.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
const title = s => s.replace(/\w\S*/g, w => w[0].toUpperCase()+w.slice(1).toLowerCase());
const clamp = (t, n=20) => (t.length<=n? t : t.slice(0,n-1)+'…');
const upperNoDia = (t='') => t.normalize('NFD').replace(/\p{Diacritic}/gu,'').toUpperCase();

function remember(id, role, content){
  const s=S(id); s.memory.push({role,content,ts:Date.now()});
  if(s.memory.length>12) s.memory=s.memory.slice(-12);
}

// ===== BÚSQUEDA / PARSERS =====
const normalizeCatLabel = (c='')=>{
  const t=norm(c);
  if(t.includes('fungicida')) return 'Fungicida';
  if(t.includes('herbicida')) return 'Herbicida';
  if(t.includes('insecticida')||t.includes('acaricida')) return 'Insecticida';
  return null;
};
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
const parseCantidad = text=>{
  const m = String(text).match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(l|lt|lts|litro?s|kg|kilos?|unid|unidad(?:es)?)/i);
  return m ? `${m[1].replace(',','.') } ${m[2].toLowerCase()}` : null;
};
const parseHectareas = text=>{
  const m = String(text).match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(ha|hect[aá]reas?)/i);
  return m ? m[1].replace(',','.') : null;
};
const parsePhone = text=>{
  const m = String(text).match(/(\+?\d[\d\s\-]{6,17}\d)/);
  return m ? m[1].replace(/[^\d+]/g,'') : null;
};
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
const wantsAgentPlus = t => /asesor(a)?|agente|ejecutiv[oa]|vendedor(a)?|representante|soporte|hablar con (alguien|una persona|humano)|persona real|humano|contact(a|o|arme|en)|que me (llamen|llamen)|llamada|ll[aá]mame|me pueden (contactar|llamar)|comercial/i.test(norm(t));
const wantsAnother  = t => /(otro|agregar|añadir|sumar|incluir).*(producto|art[ií]culo|item)|cotizar otro/i.test(norm(t));
const wantsBotBack = t => /([Aa]sistente [Vv]irtual)/i.test(t);

const CROPS_RE = /\b(soya|soja|ma[ií]z|trigo|girasol|arroz|ca[ñn]a|sorgo|papa|tomate|cebolla|pimiento|chile|man[ií]|fr(i|e)jol|quinua|yuca|citrus|naranja|lim[oó]n|mandarina|uva|pl[aá]tano|banano|palta|aguacate|hortalizas?)\b/i;

function parseMessengerLead(text){
  const t = String(text || '');
  if(!/\b(v[ií]a|via)\s*messenger\b/i.test(t)) return null;
  const pick = (re)=>{ const m=t.match(re); return m? m[1].trim() : null; };
  const name  = pick(/Hola,\s*soy\s*([^(•\n]+?)(?=\s*\(|\s*\.|\s*Me|$)/i);
  const prod  = pick(/Producto:\s*([^•\n]+)/i);
  const qty   = pick(/Cantidad:\s*([^•\n]+)/i);
  const crops = pick(/Cultivos?:\s*([^•\n]+)/i);
  const dptoZ = pick(/Departamento(?:\/Zona)?:\s*([^•\n]+)/i);
  return { name, prod, qty, crops, dptoZ };
}
function productFromReferral(ref){
  try{
    const bits = [ref?.headline, ref?.body, ref?.source_url, ref?.adgroup_name, ref?.campaign_name]
      .filter(Boolean).join(' ');
    let byQS=null;
    try{
      const u = new URL(ref?.source_url||'');
      const q = (k)=>u.searchParams.get(k);
      const sku = q('sku') || q('SKU');
      const pn  = q('product') || q('producto') || q('p') || q('ref');
      if(sku){
        byQS = (CATALOG||[]).find(p=>String(p.sku).toLowerCase()===String(sku).toLowerCase());
      }
      if(!byQS && pn){
        byQS = findProduct(pn) || (fuzzyCandidate(pn)||{}).prod || null;
      }
    }catch{}
    const byText = findProduct(bits) || ((fuzzyCandidate(bits)||{}).prod) || null;
    return byQS || byText || null;
  }catch{ return null; }
}

// ===== RESUMEN =====
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
function summaryText(s){
  const cliente = s.profileName || 'Cliente';
  const base = [
    'Perfecto, enseguida te enviaremos una cotización con estos datos:',
    `• ${cliente}`,
    `• Departamento: ${s.vars.departamento || 'ND'}`,
    `• Zona: ${s.vars.subzona || 'ND'}`,
    `• Cultivos: ${s.vars.cultivos?.length ? s.vars.cultivos.join(', ') : 'ND'}`
  ];
  const items = (s.vars.cart||[]).map(it=>`• ${it.nombre}${it.cantidad ? ` — ${it.cantidad}` : ''}`);
  if(!items.length){
    const single = s.vars.last_product || 'No especificado';
    if(single) items.push(`• ${single}${s.vars.cantidad?` — ${s.vars.cantidad}`:''}`);
  }
  const logi = '**La entrega de tu pedido se realiza en nuestro almacén**. Con gusto podemos ayudarte a coordinar la logística del transporte si lo necesitas, pero ten en cuenta que este servicio no está incluido en el precio final.';
  return `${base.join('\n')}\n${items.join('\n')}\n${s.vars.hectareas?`• Hectáreas: ${s.vars.hectareas}\n`:''}${s.vars.phone?`• Teléfono: ${s.vars.phone}\n`:''}**Compra mínima: US$ 3.000 (puedes combinar productos).*\\n${logi}`;
}

// ===== NUEVO: Resumen extra en tu formato solicitado =====
function summaryTextUser(s){
  const nombre = s.profileName || 'Cliente';
  const dep = s.vars.departamento || 'ND';
  const zona = s.vars.subzona || 'ND';
  const cultivo = s.vars.cultivos?.[0] || (s.vars.cultivos||[]).join(', ') || 'ND';
  const etapa = s.vars.cultivo_etapa || 'ND';
  let producto = s.vars.last_product || null;
  let cantidad = s.vars.cantidad || null;
  if(!producto && (s.vars.cart||[]).length){
    producto = s.vars.cart[0].nombre;
    cantidad = s.vars.cart[0].cantidad;
  }
  return `Este es el resumen de tu solicitud:
• Nombre: ${nombre}
• Departamento: ${dep}
• Zona (si aplica): ${zona}
• Cultivo: ${cultivo}
• Etapa de cultivo: ${etapa}
• Producto: ${producto || 'ND'}
• Cantidad: ${cantidad || 'ND'}`;
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
        if (PUBLIC_BASE_URL) return { url: `${PUBLIC_BASE_URL}/image/${b}${ext}` };
        else return { path: localPath };
      }
    }
  }
  return null;
}

// ===== ENVÍO WA (en cola) =====
const sendQueues = new Map();
const sleep = (ms=350)=>new Promise(r=>setTimeout(r,ms));
async function waSendQ(to, payload){
  const exec = async ()=>{
    const url = `https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`;
    const r = await fetch(url,{ method:'POST', headers:{ 'Authorization':`Bearer ${WA_TOKEN}`, 'Content-Type':'application/json' }, body:JSON.stringify(payload) });
    if(!r.ok) console.error('WA send error', r.status, await r.text());
  };
  const prev = sendQueues.get(to) || Promise.resolve();
  const next = prev.then(exec).then(()=>sleep(350));
  sendQueues.set(to, next);
  return next;
}
const toText = (to, body) => waSendQ(to,{
  messaging_product:'whatsapp', to, type:'text',
  text:{ body: String(body).slice(0,4096), preview_url: true }
});
const toButtons = (to, body, buttons=[]) => waSendQ(to,{
  messaging_product:'whatsapp', to, type:'interactive',
  interactive:{ type:'button', body:{ text: String(body).slice(0,1024) },
    action:{ buttons: buttons.slice(0,3).map(b=>({ type:'reply', reply:{ id:b.payload || b.id, title: clamp(b.title) }})) }
  }
});
const toList = (to, body, title, rows=[]) => waSendQ(to,{
  messaging_product:'whatsapp', to, type:'interactive',
  interactive:{ type:'list', body:{ text:String(body).slice(0,1024) }, action:{
    button: title.slice(0,20),
    sections:[{ title, rows: rows.slice(0,10).map(r=>({ id:r.payload || r.id, title:clamp(r.title,24) })) }]
  }}
});

// Upload local file to WhatsApp Cloud and return media id
async function waUploadMediaFromFile(filePath){
  const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(WA_PHONE_ID)}/media`;
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const mime = ext==='png' ? 'image/png' : (ext==='jpg'||ext==='jpeg') ? 'image/jpeg' : ext==='webp' ? 'image/webp' : 'application/octet-stream';
  const buf = fs.readFileSync(filePath);
  const blob = new Blob([buf], { type: mime });
  const form = new FormData();
  form.append('file', blob, filePath.split(/[\\/]/).pop());
  form.append('type', mime);
  form.append('messaging_product', 'whatsapp');
  const r = await fetch(url,{ method:'POST', headers:{ 'Authorization':`Bearer ${WA_TOKEN}` }, body: form });
  if(!r.ok){ console.error('waUploadMediaFromFile', await r.text()); return null; }
  const j = await r.json();
  return j?.id || null;
}
async function toImage(to, source){
  if(source?.url) return waSendQ(to,{ messaging_product:'whatsapp', to, type:'image', image:{ link: source.url } });
  if(source?.path){
    const id = await waUploadMediaFromFile(source.path);
    if(id) return waSendQ(to,{ messaging_product:'whatsapp', to, type:'image', image:{ id } });
  }
}

// ===== PREGUNTAS ATÓMICAS =====
async function markPrompt(s, key){ s.lastPrompt = key; s.lastPromptTs = Date.now(); }
async function askDepartamento(to){
  const s=S(to); if (s.lastPrompt==='departamento') return;
  await markPrompt(s,'departamento'); s.pending='departamento'; s.asked.departamento=true;
  await toList(to,'¡Perfecto! Para orientarte mejor podrías decirme, ¿en qué *departamento* produces?','Elegir departamento',
    DEPARTAMENTOS.map(d=>({ title:d, payload:`DPTO_${d.toUpperCase().replace(/\s+/g,'_')}` }))
  );
}
async function askSubzona(to){
  const s=S(to); if (s.lastPrompt==='subzona') return;
  await markPrompt(s,'subzona'); s.pending='subzona'; s.asked.subzona=true;
  await toList(to,'Gracias. ¿Qué *zona de Santa Cruz*?','Elegir zona',
    [{title:'Norte',payload:'SUBZ_NORTE'},{title:'Este',payload:'SUBZ_ESTE'},{title:'Sur',payload:'SUBZ_SUR'},{title:'Valles',payload:'SUBZ_VALLES'},{title:'Chiquitania',payload:'SUBZ_CHIQUITANIA'}]
  );
}
async function askCultivo(to){
  const s=S(to); if (s.lastPrompt==='cultivo') return;
  await markPrompt(s,'cultivo'); s.pending='cultivo'; s.asked.cultivo=true;
  await toText(to,'Perfecto 🙌. Para darte una recomendación precisa, cuéntame por favor qué *cultivos* manejas (por ejemplo: soya).');
}
async function askCategory(to){
  const s=S(to); if (s.lastPrompt==='categoria') return;
  s.stage='product'; await markPrompt(s,'categoria'); s.pending='categoria'; s.asked.categoria=true;
  await toButtons(to,'¿Qué tipo de producto te interesa? Te puedo guiar 👇', CAT_QR.map(c=>({ title:c.title, payload:c.payload })));
}

// ===== NUEVO: flujo cultivo para leads de Messenger =====
async function askCultivoStart(to){
  await markPrompt(S(to),'cultivo'); S(to).pending='cultivo';
  await toList(to, '📋 ¿Para qué cultivo necesitas el producto?', 'Elegir cultivo', [
    { title:'Soya',    payload:'CROP_SOYA' },
    { title:'Maíz',    payload:'CROP_MAIZ' },
    { title:'Trigo',   payload:'CROP_TRIGO' },
    { title:'Arroz',   payload:'CROP_ARROZ' },
    { title:'Girasol', payload:'CROP_GIRASOL' },
    { title:'Otro (escribir)', payload:'CROP_OTRO' }
  ]);
}
async function askCultivoLibre(to){
  await markPrompt(S(to),'cultivo_libre'); S(to).pending='cultivo_libre';
  await toText(to,'Escribe el *nombre del cultivo* (por ejemplo: soya, maíz, papa, tomate…).');
}
async function askEtapaCultivo(to){
  await markPrompt(S(to),'etapa_cultivo'); S(to).pending='etapa_cultivo';
  await toText(to,'¿En qué *etapa* se encuentra tu cultivo? (siembra, pre-emergencia, floración, llenado, etc.)');
}

// ===== Listado por categoría (paginado) =====
async function listByCategory(to){
  const s=S(to);
  const all = getProductsByCategory(s.vars.category||'');
  if(!all.length){ await toText(to,'Por ahora no tengo productos en esa categoría. ¿Querés ver el catálogo completo?'); return; }
  const offset = s.vars.catOffset || 0;
  const remaining = all.length - offset;
  const show = remaining > 9 ? 9 : remaining;
  const rows = all.slice(offset, offset+show).map(p=>({ title:p.nombre, payload:`PROD_${p.sku}` }));
  if(remaining > show) rows.push({ title:'Ver más…', payload:`CAT_MORE_${offset+show}` });
  await toList(to, `${s.vars.category} disponibles`, 'Elegir producto', rows);
  if(offset===0) await toText(to, `Decime cuál te interesa y te paso el detalle. *Compra mínima: US$ 3.000*`);
}

const shouldShowDetail = (s, sku) => s.vars.last_detail_sku !== sku || (Date.now() - (s.vars.last_detail_ts||0)) > 60000;
const markDetailShown = (s, sku) => { s.vars.last_detail_sku = sku; s.vars.last_detail_ts = Date.now(); };

async function showProduct(to, prod){
  const s=S(to);
  s.vars.last_product = prod.nombre;
  s.vars.last_sku = prod.sku;
  const catNorm = normalizeCatLabel(prod.categoria||'');
  if(catNorm && !s.vars.category) s.vars.category = catNorm;

  // NUEVO: ficha técnica explícita
  await toText(to, `Aquí tienes la ficha técnica de *${prod.nombre}* 📄\n${prod.link_ficha || CATALOG_URL}`);

  if (!shouldShowDetail(s, prod.sku)) return;
  const src = productImageSource(prod);
  if (src) await toImage(to, src);
  if(!src){
    const plagas=(prod.plaga||[]).slice(0,5).join(', ')||'-';
    const present=(prod.presentaciones||[]).join(', ')||'-';
    await toText(to,`Gracias por la info 🙌. Sobre *${prod.nombre}* (${prod.categoria}):\n• Formulación / acción: ${prod.formulacion}\n• Dosis de referencia: ${prod.dosis}\n• Espectro objetivo: ${plagas}\n• Presentaciones: ${present}\nFicha técnica: ${prod.link_ficha}`);
  }
  markDetailShown(s, prod.sku);
}

// ===== CARRITO =====
function addCurrentToCart(s){
  if(!s.vars.last_sku || !s.vars.last_product || !s.vars.cantidad) return false;
  const exists = (s.vars.cart||[]).find(it=>it.sku===s.vars.last_sku);
  if(exists){ exists.cantidad = s.vars.cantidad; }
  else s.vars.cart.push({ sku:s.vars.last_sku, nombre:s.vars.last_product, cantidad:s.vars.cantidad });
  s.vars.last_product=null; s.vars.last_sku=null; s.vars.cantidad=null;
  return true;
}
async function askAddMore(to){
  await toButtons(to,'¿Deseas añadir otro producto?', [
    { title:'Sí, añadir otro', payload:'ADD_MORE' },
    { title:'No, continuar',  payload:'NO_MORE' }
  ]);
}
async function afterSummary(to, variant='cart'){
  const s=S(to);
  await toText(to, summaryText(s));

  // NUEVO: resumen adicional en tu formato
  await toText(to, summaryTextUser(s));

  if (s.meta?.origin === 'messenger') {
    const quien = s.profileName ? `, ${s.profileName}` : '';
    await toText(to, `¡Excelente${quien}! Tomo estos datos y preparo tu cotización personalizada. Te la enviamos enseguida por este chat.`);
  }

  if (variant === 'help') {
    await toButtons(to,'¿Necesitas ayuda en algo más?', [
      { title:'Sí, continuar', payload:'QR_SEGUIR' },
      { title:'Finalizar',     payload:'QR_FINALIZAR' }
    ]);
  } else {
    await toButtons(to,'¿Deseas añadir otro producto o finalizamos?', [
      { title:'Añadir otro', payload:'ADD_MORE' },
      { title:'Finalizar',   payload:'QR_FINALIZAR' }
    ]);
  }
}

// ===== Orquestador =====
async function nextStep(to){
  const s=S(to);
  const stale = (key)=> s.lastPrompt===key && (Date.now()-s.lastPromptTs>25000);

  if(s.vars.last_product && !s.vars.category){
    const p=(CATALOG||[]).find(pp=>norm(pp.nombre||'')===norm(s.vars.last_product));
    const c=normalizeCatLabel(p?.categoria||''); if(c) s.vars.category=c;
  }

  if(!s.vars.last_product && !s.vars.category){
    if(stale('categoria') || s.lastPrompt!=='categoria') return askCategory(to);
    return;
  }

  if(!s.vars.departamento){
    if(stale('departamento') || s.lastPrompt!=='departamento') return askDepartamento(to);
    return;
  }
  if(s.vars.departamento==='Santa Cruz' && !s.vars.subzona){
    if(stale('subzona') || s.lastPrompt!=='subzona') return askSubzona(to);
    return;
  }

  if(!s.vars.cultivos || s.vars.cultivos.length===0){
    if(stale('cultivo') || s.lastPrompt!=='cultivo') return askCultivo(to);
    return;
  }

  if(!s.vars.last_product) return listByCategory(to);

  if(!s.vars.cantidad && !s.vars.hectareas){
    s.pending='cantidad'; await markPrompt(s,'cantidad');
    return toText(to,'Para poder realizar tu cotización, ¿me podrías decir qué *cantidad* necesitas *(L/KG)*?');
  }
}

// ===== VERIFY =====
router.get('/wa/webhook',(req,res)=>{
  const mode=req.query['hub.mode'];
  const token=req.query['hub.verify_token'];
  const chall=req.query['hub.challenge'];
  if(mode==='subscribe' && token===VERIFY_TOKEN && chall) return res.status(200).send(String(chall));
  return res.sendStatus(403);
});

// ===== RECEIVE =====
router.post('/wa/webhook', async (req,res)=>{
  try{
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    const msg    = value?.messages?.[0];
    const from   = msg?.from;
    if(!msg || !from){ res.sendStatus(200); return; }

    const s = S(from);
    const textRaw = (msg.type==='text' ? (msg.text?.body || '').trim() : '');

    if (isHuman(from)) {
      if (textRaw && wantsBotBack(textRaw)) {
        humanOff(from);
        const quien = s.profileName ? `, ${s.profileName}` : '';
        await toText(from, `Listo${quien} 🙌. Reactivé el *asistente automático*. ¿Seguimos? Puedes decirme el *nombre del producto* o elegir una categoría.`);
        await askCategory(from);
      }
      res.sendStatus(200);
      return;
    }

    const contactName = value?.contacts?.[0]?.profile?.name;
    if(contactName && !s.profileName) s.profileName = contactName;

    const referral = msg?.referral;
    if (referral && !s.meta.referralHandled){
      s.meta.referralHandled = true;
      s.meta.origin = 'facebook';
      s.meta.referral = referral;
      const prod = productFromReferral(referral);
      if (prod){
        s.vars.candidate_sku = prod.sku;
        await toButtons(from, `Gracias por escribirnos desde Facebook. ¿La consulta es sobre *${prod.nombre}*?`, [
          { title:`Sí, ${prod.nombre}`, payload:`REF_YES_${prod.sku}` },
          { title:'No, otro producto',  payload:'REF_NO' }
        ]);
        res.sendStatus(200); return;
      }
    }

    const isLeadMsg = msg.type==='text' && !!parseMessengerLead(msg.text?.body);
    if(!s.greeted){
      if(!isLeadMsg){
        await toText(from, PLAY?.greeting || '¡Qué gusto saludarte!, Soy el asistente virtual de *New Chem*. Dime el nombre del producto, tus cultivos, o elige una categoría y te acompaño paso a paso.');
      }
      s.greeted = true;
    }

    // INTERACTIVOS
    if(msg.type==='interactive'){
      const br = msg.interactive?.button_reply;
      const lr = msg.interactive?.list_reply;
      const id = br?.id || lr?.id;

      if(id==='QR_FINALIZAR'){
        await toText(from,'¡Gracias por escribirnos! Nuestro equipo comercial te enviará la cotización en breve. Si requieres más información, estamos a tu disposición.');
        await toText(from,'Para volver a activar el asistente, por favor, escribe *Asistente Virtual*.');
        humanOn(from, 4); // MODO HUMANO 4h
        clearS(from);
        res.sendStatus(200); return;
      }
      if(id==='QR_SEGUIR'){ await toText(from,'Perfecto, seguimos por aquí 🙌. ¿En qué más te puedo ayudar?'); await askCategory(from); res.sendStatus(200); return; }
      if(id==='ADD_MORE'){ s.vars.catOffset=0; s.vars.last_product=null; s.vars.last_sku=null; s.vars.cantidad=null; await toButtons(from,'Dime el *nombre del otro producto* o elige una categoría 👇', CAT_QR.map(c=>({title:c.title,payload:c.payload}))); res.sendStatus(200); return; }
      if(id==='NO_MORE'){ await afterSummary(from, 'help'); res.sendStatus(200); return; }

      // NUEVO: selección de cultivo (lista)
      if(/^CROP_/.test(id)){
        const map = { SOYA:'Soya', MAIZ:'Maíz', TRIGO:'Trigo', ARROZ:'Arroz', GIRASOL:'Girasol', OTRO:'Otro' };
        const key = id.replace('CROP_','').toUpperCase();
        if(key === 'OTRO'){
          await askCultivoLibre(from);
        }else{
          s.vars.cultivos = Array.from(new Set([...(s.vars.cultivos||[]), map[key]]));
          s.pending=null; s.lastPrompt=null;
          await askEtapaCultivo(from); // etapa (libre)
        }
        res.sendStatus(200); return;
      }

      if(/^REF_YES_/.test(id)){
        const sku = id.replace('REF_YES_','');
        const prod = (CATALOG||[]).find(p=>String(p.sku)===String(sku));
        if(prod){
          s.vars.last_product = prod.nombre; s.vars.last_sku = prod.sku;
          const catNorm = normalizeCatLabel(prod.categoria||''); if(catNorm) s.vars.category = catNorm;
          await showProduct(from, prod);
          await nextStep(from);
        }
        res.sendStatus(200); return;
      }
      if(id==='REF_NO'){
        s.pending='product_name'; s.lastPrompt='product_name'; s.lastPromptTs=Date.now();
        await toText(from,'Claro, indícame por favor el *nombre del producto* que te interesa y te paso el detalle.');
        res.sendStatus(200); return;
      }

      if(/^DPTO_/.test(id)){
        const depRaw = id.replace('DPTO_','').replace(/_/g,' ');
        const dep = (()=>{ const t=norm(depRaw); for(const d of DEPARTAMENTOS) if(norm(d)===t) return d; return title(depRaw); })();
        s.vars.departamento = dep; s.asked.departamento=true; s.pending=null; s.lastPrompt=null;
        s.vars.subzona = (dep==='Santa Cruz') ? s.vars.subzona : null;
        if(dep==='Santa Cruz' && !s.vars.subzona){ await askSubzona(from); } else { await nextStep(from); }
        res.sendStatus(200); return;
      }
      if(/^SUBZ_/.test(id)){
        const z = id.replace('SUBZ_','').toLowerCase();
        const mapa = { norte:'Norte', este:'Este', sur:'Sur', valles:'Valles', chiquitania:'Chiquitania' };
        if (s.vars.departamento==='Santa Cruz') s.vars.subzona = mapa[z] || null;
        s.pending=null; s.lastPrompt=null;
        await nextStep(from); res.sendStatus(200); return;
      }
      if(/^CAT_/.test(id)){
        const key = id.replace('CAT_','').toLowerCase();
        s.vars.category = key==='herbicida' ? 'Herbicida' : key==='insecticida' ? 'Insecticida' : 'Fungicida';
        s.vars.catOffset = 0; s.stage='product'; s.pending=null; s.lastPrompt=null;
        await nextStep(from); res.sendStatus(200); return;
      }
      if(/^CAT_MORE_/.test(id)){
        const next = parseInt(id.replace('CAT_MORE_',''),10) || 0;
        s.vars.catOffset = next;
        await listByCategory(from); res.sendStatus(200); return;
      }
      if(/^PROD_/.test(id)){
        const sku = id.replace('PROD_','');
        const prod = (CATALOG||[]).find(p=>p.sku===sku);
        if(prod){
          s.vars.last_product = prod.nombre; s.vars.last_sku = prod.sku;
          const catNorm = normalizeCatLabel(prod.categoria||''); if(catNorm) s.vars.category = catNorm;
          await showProduct(from, prod);
          if(!s.vars.cantidad){ s.pending='cantidad'; s.lastPrompt='cantidad'; s.lastPromptTs=Date.now(); await toText(from,'¿Qué *cantidad* necesitas *(L/KG)* para este producto?'); }
        }
        res.sendStatus(200); return;
      }
    }

    // TEXTO
    if(msg.type==='text'){
      let text = (msg.text?.body||'').trim();
      if(!text){ res.sendStatus(200); return; }
      remember(from,'user',text);

      // NUEVO: lead desde Messenger (lanza saludo + cultivo)
      const lead = parseMessengerLead(text);
      if (lead){
        s.meta.origin = 'messenger';
        s.greeted = true; // evitar saludo duplicado
        if (lead.name && !s.profileName) s.profileName = title(lead.name);

        if (lead.dptoZ){
          const dep = detectDepartamento(lead.dptoZ) || title(lead.dptoZ.split('/')[0]||'');
          s.vars.departamento = dep || s.vars.departamento;
          if((/santa\s*cruz/i.test(lead.dptoZ)) && detectSubzona(lead.dptoZ)) s.vars.subzona = detectSubzona(lead.dptoZ);
        }
        if (lead.crops){
          const raw = lead.crops.split(/[,\s]+y\s+|,\s*|\s+y\s+/i).map(t=>t.trim()).filter(Boolean);
          const normalized = raw.map(t => title(t.toLowerCase()));
          s.vars.cultivos = Array.from(new Set([...(s.vars.cultivos||[]), ...normalized]));
        }

        const quien = s.profileName ? ` ${s.profileName}` : '';
        await toText(from, `👋 Hola${quien}, gracias por continuar con *New Chem* vía WhatsApp.\nAquí encontrarás los agroquímicos esenciales para tu cultivo, al mejor precio. 🌱`);
        await askCultivoStart(from); // menú cultivo
        res.sendStatus(200); 
        return;
      }

      // === Pedido de ASESOR (modo humano) ===
      if (wantsAgentPlus(text)) {
        const quien = s.profileName ? `, ${s.profileName}` : '';
        await toText(from, `¡Perfecto${quien}! Ya notifiqué a nuestro equipo. Un **asesor comercial** se pondrá en contacto contigo por este chat en unos minutos para ayudarte con tu consulta y la cotización. Desde ahora **pauso el asistente automático** para que te atienda una persona. 🙌`);
        humanOn(from, 4); // silenciar bot 4h
        res.sendStatus(200); return;
      }

      // NUEVO: cultivo libre (tras "Otro")
      if (S(from).pending === 'cultivo_libre'){
        const name = title(text.toLowerCase());
        if(name){
          S(from).vars.cultivos = Array.from(new Set([...(S(from).vars.cultivos||[]), name]));
          S(from).pending=null; S(from).lastPrompt=null;
          await askEtapaCultivo(from);
        }else{
          await toText(from,'Por favor, escribe el *nombre del cultivo*.');
        }
        res.sendStatus(200); 
        return;
      }

      // NUEVO: etapa de cultivo (respuesta libre)
      if (S(from).pending === 'etapa_cultivo'){
        S(from).vars.cultivo_etapa = text;
        S(from).pending=null; S(from).lastPrompt=null;
        await askCategory(from); // continúa con tipo de producto
        res.sendStatus(200); 
        return;
      }

      // Globales
      if(/horario|atienden|abren|cierran/i.test(norm(text))){ await toText(from, `Atendemos ${FAQS?.horarios || 'Lun–Vie 8:00–17:00'} 🙂`); res.sendStatus(200); return; }
      if(wantsLocation(text)){ await toText(from, `Nuestra ubicación en Google Maps 👇\nVer ubicación: ${linkMaps()}`); await toButtons(from,'¿Hay algo más en lo que pueda ayudarte?',[{title:'Seguir',payload:'QR_SEGUIR'},{title:'Finalizar',payload:'QR_FINALIZAR'}]); res.sendStatus(200); return; }
      if(wantsCatalog(text)){
        await toText(from, `Este es nuestro catálogo completo\n${CATALOG_URL}`);
        await toButtons(from,'¿Quieres que te ayude a elegir o añadir un producto ahora?',[{title:'Añadir producto', payload:'ADD_MORE'},{title:'Finalizar', payload:'QR_FINALIZAR'}]);
        res.sendStatus(200); return;
      }
      if(wantsClose(text)){
        await toText(from,'¡Gracias por escribirnos! Si más adelante te surge algo, aquí estoy para ayudarte. 👋');
        humanOn(from, 4); // silenciar bot 4h al cerrar por texto
        clearS(from);
        res.sendStatus(200); return;
      }
      if(wantsAnother(text)){ await askAddMore(from); res.sendStatus(200); return; }

      // CAPTURA PASIVA: cantidad
      let cant = parseCantidad(text);
      if(!cant && (S(from).pending==='cantidad')){
        const mOnly = text.match(/^\s*(\d{1,6}(?:[.,]\d{1,2})?)\s*$/);
        if(mOnly){ const unit = inferUnitFromProduct(S(from)).toLowerCase(); cant = `${mOnly[1].replace(',','.') } ${unit}`; }
      }
      if(cant) S(from).vars.cantidad = cant;

      const ha   = parseHectareas(text); if(ha) S(from).vars.hectareas = ha;
      const phone= parsePhone(text);     if(phone) S(from).vars.phone = phone;

      // Producto exacto
      const prodExact = findProduct(text);
      if (prodExact){
        S(from).vars.last_product = prodExact.nombre;
        S(from).vars.last_sku = prodExact.sku;
        const catFromProd = normalizeCatLabel(prodExact.categoria||''); if (catFromProd) S(from).vars.category = catFromProd;
        S(from).stage='product'; S(from).vars.catOffset=0;
      }

      // Categoría por texto
      const catTyped2 = detectCategory(text);
      if(catTyped2){
        S(from).vars.category=catTyped2; S(from).vars.catOffset=0; S(from).asked.categoria=true; S(from).stage='product';
        if (mentionsAcaricida(text) && catTyped2==='Insecticida') await toText(from,'Te muestro Insecticidas que cubren ácaros.');
      }

      // Ubicación (dpto + subzona)
      const depTyped = detectDepartamento(text);
      const subOnly  = detectSubzona(text);
      if(depTyped){ S(from).vars.departamento = depTyped; if(depTyped!=='Santa Cruz') S(from).vars.subzona=null; }
      if((S(from).vars.departamento==='Santa Cruz' || depTyped==='Santa Cruz') && subOnly){ S(from).vars.subzona = subOnly; }

      // Cultivos por texto libre (soporta flujo original)
      if (S(from).pending==='cultivo' || CROPS_RE.test(text)){
        const raw = text.split(/[,\s]+y\s+|,\s*|\s+y\s+/i).map(t=>t.trim()).filter(Boolean);
        const normalized = raw.map(t => title(t.toLowerCase()));
        S(from).vars.cultivos = Array.from(new Set([...(S(from).vars.cultivos||[]), ...normalized]));
        if (S(from).pending==='cultivo'){ S(from).pending=null; S(from).lastPrompt=null; }
        if(!S(from).vars.category){ await askCategory(from); res.sendStatus(200); return; }
      }

      // COTIZACIÓN
      if(asksPrice(text)){
        if (mentionsAcaricida(text)) await toText(from, 'Te muestro Insecticidas que cubren ácaros.');
        await toText(from,'Con gusto te preparo una *cotización* con un precio a medida. Solo necesito que me compartas unos datos para poder recomendarte la mejor opción para tu zona y cultivo');
      }

      // Si llegó la cantidad y hay producto → carrito + “otro”
      if(S(from).vars.cantidad && S(from).vars.last_sku){
        addCurrentToCart(S(from));
        await askAddMore(from);
        res.sendStatus(200); return;
      }

      const productIntent = prodExact || catTyped2 || asksPrice(text) || wantsBuy(text) || /producto|herbicida|insecticida|fungicida|acaricida|informaci[oó]n/i.test(norm(text));
      if (S(from).stage === 'discovery' && productIntent) S(from).stage = 'product';

      // Fuzzy
      if (S(from).stage==='product' && !prodExact && !S(from).vars.last_product
          && !['departamento','subzona','cultivo','categoria','cantidad','product_name'].includes(S(from).pending||'') ) {
        const cand = fuzzyCandidate(text);
        if (cand) { await toButtons(from, `¿Te referías a *${cand.prod.nombre}*?`, [{ title:`Sí, ${cand.prod.nombre}`, payload:`PROD_${cand.prod.sku}` },{ title:'No, ver categorías', payload:'CAT_HERBICIDA' }]); res.sendStatus(200); return; }
      }

      if (S(from).vars.last_product && S(from).vars.departamento && (S(from).vars.departamento!=='Santa Cruz' || S(from).vars.subzona)){
        const prod = findProduct(S(from).vars.last_product) || prodExact;
        if (prod) {
          await showProduct(from, prod);
          if (!S(from).vars.cantidad) { S(from).pending='cantidad'; S(from).lastPrompt='cantidad'; S(from).lastPromptTs=Date.now(); await toText(from,'¿Qué *cantidad* necesitas *(L/KG)* para este producto?'); }
        }
      }

      await nextStep(from);
      res.sendStatus(200); return;
    }

    await nextStep(from);
    res.sendStatus(200);
  }catch(e){
    console.error('WA webhook error', e);
    res.sendStatus(500);
  }
});

export default router;
