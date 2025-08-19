// index.js (Messenger Router) — aperturas listas + captura de nombre con prioridad + filtro de muletillas + envíos
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

// ===== DATA =====
function loadJSON(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return {}; } }
let FAQS    = loadJSON('./knowledge/faqs.json');
let CATALOG = loadJSON('./knowledge/catalog.json');
if (!Array.isArray(CATALOG)) CATALOG = [];  // seguridad

// ===== CONSTANTES =====
const DEPARTAMENTOS = ['Santa Cruz','Cochabamba','La Paz','Chuquisaca','Tarija','Oruro','Potosí','Beni','Pando'];
const SUBZONAS_SCZ  = ['Norte','Este','Sur','Valles','Chiquitania'];

// sinónimos para texto libre
const DPTO_SYNONYMS = {
  'Santa Cruz' : ['scz','sta cruz','santa cruz de la sierra','santa-cruz','santacruz'],
  'Cochabamba' : ['cbba','cbb','cba'],
  'La Paz'     : ['lp','lapaz','la-paz','el alto','alto'],
  'Chuquisaca' : ['sucre'],
  'Tarija'     : ['tja'],
  'Oruro'      : [],
  'Potosí'     : ['potosi','ptsi'],
  'Beni'       : [],
  'Pando'      : []
};

// ===== SESIONES =====
const sessions = new Map();
function getSession(psid){
  if(!sessions.has(psid)){
    sessions.set(psid,{
      pending: null,  // 'nombre' | 'departamento' | 'subzona' | 'subzona_free' | 'prod_from_catalog'
      vars: {
        departamento:null, subzona:null,
        hectareas:null, phone:null,
        productIntent:null, // producto de interés (texto libre o del catálogo)
        intent:null
      },
      profileName: null,
      flags: { greeted:false, finalShown:false, finalShownAt:0, lastHelpAt:0 },
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
  for(const d of DEPARTAMENTOS) if (t.includes(norm(d))) return d;
  for(const [name, arr] of Object.entries(DPTO_SYNONYMS)){
    if (arr.some(alias => t.includes(norm(alias)))) return name;
  }
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

// Intenciones globales
const wantsCatalog  = t => /cat[aá]logo|portafolio|lista de precios/i.test(t) || /portafolio[- _]?newchem/i.test(norm(t));
const wantsLocation = t => /(ubicaci[oó]n|direcci[oó]n|mapa|d[oó]nde est[aá]n|donde estan)/i.test(t);
const wantsClose    = t => /(no gracias|gracias|eso es todo|listo|nada m[aá]s|ok gracias|est[aá] bien|finalizar)/i.test(norm(t));
const asksPrice     = t => /(precio|cu[aá]nto vale|cu[aá]nto cuesta|cotizar|costo|proforma|cotizaci[oó]n)/i.test(t);
const wantsAgent    = t => /asesor|humano|ejecutivo|vendedor|representante|agente|contact(a|o|arme)|whats?app|wasap|wsp|wpp|n[uú]mero|telefono|tel[eé]fono|celular/i.test(norm(t));
const isGreeting    = t => /(hola|buen[oa]s (d[ií]as|tardes|noches)|hey|hello)/i.test(t);
const asksProducts  = t => /(qu[eé] productos tienen|que venden|productos disponibles|l[ií]nea de productos)/i.test(t);
const asksShipping  = t => /(env[ií]os?|env[ií]an|hacen env[ií]os|delivery|entrega|env[ií]an hasta|mandan|env[ií]o a)/i.test(norm(t));

// ===== Muletillas / acks para no confundir con producto
function isAckOrFiller(text){
  const t = norm(text).trim();
  return /^(ok(ay|ey)?\.?|oki|okey|dale|listo|perfecto|gracias( muchas)?|si|sí|ya|de acuerdo|entendido|claro|vale|mmmm*|aj+a|bueno|que datos|qué datos)$/.test(t);
}

// Reconocer producto (catálogo) + aceptar libre si no está
function findProduct(text){
  const q = norm(text).replace(/[^a-z0-9\s.%/-]/g,' ').replace(/\s+/g,' ').trim();
  let best=null, bestScore=0;
  for(const p of CATALOG){
    const name = norm(p.nombre||'').trim(); if(!name) continue;
    if (q.includes(name)) return p; // contains
    const qTok = new Set(q.split(' '));
    const nTok = new Set(name.split(' '));
    const inter = [...qTok].filter(x=>nTok.has(x)).length;
    const score = inter / Math.max(1,[...nTok].length);
    if(score>bestScore){ best=p; bestScore=score; }
  }
  return bestScore>=0.6 ? best : null;
}
const cleanProductText = t => title(String(t).replace(/[^a-zA-Z0-9áéíóúñü.%/\-\s]/g,'').replace(/\s+/g,' ').trim());
function looksLikeProductName(text){
  if (isAckOrFiller(text)) return false;
  const t = norm(text);
  if (!t || t.length < 3 || t.length > 50) return false;
  if (wantsCatalog(t) || wantsLocation(t) || isGreeting(t) || asksShipping(t) || wantsAgent(t) || wantsClose(t)) return false;
  return /[a-z]/i.test(text); // tiene letras
}

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

// ===== RESUMEN / WHATSAPP / AYUDA =====
function summaryTextForFinal(s){
  const nombre = s.profileName || 'Cliente';
  const dep = s.vars.departamento || 'ND';
  const zona = s.vars.subzona || 'ND';
  const extraLines = [
    s.vars.productIntent ? `• Producto de interés: ${s.vars.productIntent}` : null,
    s.vars.hectareas ? `• Hectáreas: ${s.vars.hectareas}` : null,
    s.vars.phone ? `• Teléfono: ${s.vars.phone}` : null
  ].filter(Boolean).join('\n');

  return `¡Excelente, ${nombre}! 🚜 
• Departamento: ${dep}
• Zona: ${zona}
${extraLines ? extraLines + '\n' : ''}Ten en cuenta que nuestra compra mínima es de USD 3.000 y la entrega del producto se realiza en nuestro almacén de Santa Cruz.
Continuemos en WhatsApp para coordinar tu cotización.`;
}
function whatsappLinkFromSession(s){
  if(!WA_SELLER_NUMBER) return null;
  const nombre = s.profileName || 'Cliente';
  const txt = [
    `Hola, soy ${nombre} (vía Messenger). Me gustaría realizar una cotización con New Chem:`,
    s.vars.productIntent ? `• Producto: ${s.vars.productIntent}` : null,
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
  if (s.flags.finalShown && Date.now()-s.flags.finalShownAt < 60000) return; // anti-duplicados
  s.flags.finalShown = true; s.flags.finalShownAt = Date.now();
  await sendText(psid, summaryTextForFinal(s));
  const wa = whatsappLinkFromSession(s);
  if (wa){
    await sendButtons(psid, ' ', [{ type:'web_url', url: wa, title:'Enviar a WhatsApp' }]);
  }else{
    await sendText(psid, 'Comparte un número de contacto y te escribimos por WhatsApp.');
  }
  await sendQR(psid, '¿Necesitas ayuda en algo más?', [
    { title:'Sí, tengo otra duda', payload:'QR_CONTINUAR' },
    { title:'Finalizar', payload:'QR_FINALIZAR' }
  ]);
}
async function showHelp(psid){
  const s=getSession(psid);
  const now = Date.now();
  if (now - (s.flags.lastHelpAt||0) < 20000) return; // antispam ayuda (20s)
  s.flags.lastHelpAt = now;
  await sendQR(psid, '¿En qué más te puedo ayudar?', [
    { title:'Catálogo',  payload:'OPEN_CATALOG'  },
    { title:'Ubicación', payload:'OPEN_LOCATION' },
    { title:'Horario',   payload:'OPEN_HORARIOS' },
    { title:'Hablar con asesor', payload:'OPEN_WHATSAPP' },
    { title:'Finalizar', payload:'QR_FINALIZAR' }
  ]);
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

// ===== Aperturas inteligentes (antes de pedir nombre) =====
async function handleOpeningIntent(psid, text){
  const s = getSession(psid);

  // si estamos pidiendo NOMBRE, no detectar producto todavía
  if (s.pending === 'nombre') return false;

  const prod = findProduct(text);
  if (prod){
    s.vars.productIntent = prod.nombre;
    s.vars.intent = asksPrice(text) ? 'quote' : 'product';
    await sendText(psid,
      `¡Excelente! Sobre *${prod.nombre}* puedo ayudarte con **precios, disponibilidad y dosis**. ` +
      `Para enviarte una **cotización sin compromiso**, primero te ubico con unos datos rápidos.`
    );
    await askName(psid);
    return true;
  }

  if (asksPrice(text)){
    const hit = findProduct(text);
    if (hit) s.vars.productIntent = hit.nombre;
    else if (looksLikeProductName(text)) s.vars.productIntent = cleanProductText(text);
    s.vars.intent = 'quote';
    await sendText(psid, '¡Con gusto te preparo una **cotización personalizada**! Primero te ubico con unos datos rápidos.');
    await askName(psid);
    return true;
  }

  if (asksProducts(text)){
    await sendButtons(psid,
      'Contamos con **herbicidas, insecticidas y fungicidas** de alta eficacia. ' +
      'Puedes abrir el catálogo o, si me dices el producto, te preparo una cotización.',
      [{ type:'web_url', url: CATALOG_URL, title:'Ver catálogo' }]
    );
    await sendText(psid, 'Si algo del catálogo te llamó la atención, cuéntame el *nombre del producto* y lo avanzamos de inmediato. 🙂');
    getSession(psid).pending = 'prod_from_catalog';
    await askName(psid);
    return true;
  }

  if (wantsCatalog(text)){
    await sendButtons(psid, 'Aquí tienes nuestro catálogo digital 👇', [
      { type:'web_url', url: CATALOG_URL, title:'Ver catálogo' }
    ]);
    await sendText(psid, '¿Qué *producto* te interesó del catálogo? Si me dices el nombre, te ayudo con precio y disponibilidad. 🙂');
    getSession(psid).pending = 'prod_from_catalog';
    await askName(psid);
    return true;
  }

  // Si parece un nombre de producto aunque no esté en el catálogo (y no es muletilla)
  if (looksLikeProductName(text)){
    s.vars.productIntent = cleanProductText(text);
    await sendText(psid, `Perfecto, tomo *${s.vars.productIntent}* como tu producto de interés. Te pido unos datos rápidos para cotizar.`);
    await askName(psid);
    return true;
  }

  return false;
}

// ===== RECEIVE =====
router.post('/webhook', async (req,res)=>{
  try{
    if(req.body.object!=='page') return res.sendStatus(404);

    for(const entry of req.body.entry||[]){
      for(const ev of entry.messaging||[]){
        const psid = ev?.sender?.id; if(!psid) continue;
        if(ev.message?.is_echo) continue;

        const s = getSession(psid);

        // GET_STARTED
        if(ev.postback?.payload === 'GET_STARTED'){
          s.flags.greeted = true;
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
          if(qr==='QR_CONTINUAR'){ await showHelp(psid); continue; }

          if(qr==='OPEN_CATALOG'){
            await sendButtons(psid, 'Abrir catálogo completo', [{type:'web_url', url: CATALOG_URL, title:'Ver catálogo'}]);
            await sendText(psid, '¿Qué *producto* del catálogo te interesó? Escríbeme el nombre para poder cotizar. 🙂');
            s.pending = 'prod_from_catalog';
            await showHelp(psid); continue;
          }
          if(qr==='OPEN_LOCATION'){
            await sendButtons(psid, 'Nuestra ubicación en Google Maps 👇', [{type:'web_url', url: linkMaps(), title:'Ver ubicación'}]);
            await showHelp(psid); continue;
          }
          if(qr==='OPEN_HORARIOS'){
            await sendText(psid, `Nuestro horario: ${FAQS?.horarios || 'Lun–Vie 8:00–17:00'} 🙂`);
            await showHelp(psid); continue;
          }
          if(qr==='OPEN_WHATSAPP'){
            const wa = whatsappLinkFromSession(s);
            if (wa) await sendButtons(psid,'Te atiende un asesor por WhatsApp 👇',[{type:'web_url', url: wa, title:'📲 Abrir WhatsApp'}]);
            else await sendText(psid,'Compártenos un número de contacto y seguimos por WhatsApp.');
            await showHelp(psid); continue;
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
            s.pending=null; await nextStep(psid); continue;
          }

          text = qr.replace(/^QR_/,'').replace(/_/g,' ').trim() || text;
        }

        if(!text) continue;
        remember(psid,'user',text);

        // Saludo si el usuario escribió sin tocar “Empezar”
        if(!s.flags.greeted && isGreeting(text)){
          s.flags.greeted = true;
          await sendText(psid, '👋 ¡Hola! Bienvenido(a) a New Chem.\nTenemos agroquímicos al mejor precio y calidad para tu campaña. 🌱');
          // nombre tiene prioridad
          await askName(psid);
          continue;
        }

        // ======== 1) CAPTURA DE NOMBRE — PRIORIDAD TOTAL ========
        if (s.pending === 'nombre'){
          const cleaned = title(text.replace(/\s+/g,' ').trim());
          if (cleaned.length >= 2){
            s.profileName = cleaned; s.pending=null;
            await askDepartamento(psid);
          }else{
            await sendText(psid,'¿Me repites tu *nombre completo* por favor? ✍️');
          }
          continue;
        }

        // ======== 2) PRODUCTO desde catálogo (si se pidió) ========
        if(s.pending==='prod_from_catalog'){
          const hit = findProduct(text);
          if (hit){
            s.vars.productIntent = hit.nombre; s.pending=null;
          }else if (!isAckOrFiller(text)){
            s.vars.productIntent = cleanProductText(text); s.pending=null;
          }else{
            // Muletilla; mantenemos la pregunta
            await sendText(psid,'¿Cuál es el *nombre del producto* que te interesó del catálogo?');
            continue;
          }
          if(!s.profileName) await askName(psid);
          else await nextStep(psid);
          continue;
        }

        // ======== 3) APERTURA INTELIGENTE — SOLO si aún no hay nombre ========
        if(!s.profileName){
          const handled = await handleOpeningIntent(psid, text);
          if(handled) continue;
          // si no se manejó, pedimos nombre
          await askName(psid);
          continue;
        }

        // Captura pasiva
        const ha   = parseHectareas(text); if(ha) s.vars.hectareas = ha;
        const phone= parsePhone(text);     if(phone) s.vars.phone = phone;

        // === PREGUNTAS DE ENVÍO (en cualquier etapa)
        if(asksShipping(text)){
          await sendText(psid,
            'Realizamos la **entrega en nuestro almacén de Santa Cruz de la Sierra**. ' +
            'Si lo necesitas, **podemos ayudarte a coordinar la logística del transporte** hasta tu zona, ' +
            'pero este servicio **no está incluido** en el precio. 🙂'
          );
          await nextStep(psid);
          continue;
        }

        // === DEPARTAMENTO (acepta texto aunque espere QR) ===
        if(!s.vars.departamento || s.pending==='departamento'){
          const depTyped = canonicalizeDepartamento(text);
          if(depTyped){
            s.vars.departamento = depTyped; s.vars.subzona=null; s.pending=null;
            if(depTyped==='Santa Cruz') await askSubzonaSCZ(psid); else await askSubzonaLibre(psid);
            continue;
          }else if(s.pending==='departamento'){
            await sendQR(psid,'No logré reconocer el *departamento*. Elige de la lista o escríbelo de nuevo 😊',
              DEPARTAMENTOS.map(d => ({title:d, payload:`DPTO_${d.toUpperCase().replace(/\s+/g,'_')}`})));
            continue;
          }
        }

        // === SUBZONA SCZ (texto o QR) ===
        if(s.vars.departamento==='Santa Cruz' && (!s.vars.subzona || s.pending==='subzona')){
          const z = detectSubzonaSCZ(text);
          if(z){ s.vars.subzona = z; s.pending=null; await nextStep(psid); continue; }
          if(s.pending==='subzona'){ await askSubzonaSCZ(psid); continue; }
        }

        // === SUBZONA libre para otros dptos ===
        if(s.pending==='subzona_free' && !s.vars.subzona){
          const z = title(text.trim());
          if (z){ s.vars.subzona = z; s.pending=null; await nextStep(psid); }
          else { await sendText(psid,'¿Podrías escribir el *nombre de tu zona o municipio*?'); }
          continue;
        }

        // === Detección tardía de “nombre de producto” (evita muletillas)
        const lateHit = isAckOrFiller(text) ? null : findProduct(text);
        if (lateHit || (!isAckOrFiller(text) && looksLikeProductName(text))){
          s.vars.productIntent = lateHit ? lateHit.nombre : cleanProductText(text);
          await nextStep(psid);
          continue;
        }

        // Intenciones globales (responden siempre)
        if(wantsLocation(text)){ await sendButtons(psid, 'Nuestra ubicación en Google Maps 👇', [{type:'web_url', url: linkMaps(), title:'Ver ubicación'}]); await showHelp(psid); continue; }
        if(wantsCatalog(text)){  await sendButtons(psid, 'Abrir catálogo completo', [{type:'web_url', url: CATALOG_URL, title:'Ver catálogo'}]); await sendText(psid,'¿Qué *producto* te interesó del catálogo?'); s.pending='prod_from_catalog'; await showHelp(psid); continue; }
        if(asksPrice(text)){     const hit2 = findProduct(text); if (hit2) s.vars.productIntent = hit2.nombre; else if (!isAckOrFiller(text) && looksLikeProductName(text)) s.vars.productIntent = cleanProductText(text); await sendText(psid, 'Con gusto te preparamos una *cotización*. Primero confirmemos tu ubicación para asignarte el asesor correcto.'); await nextStep(psid); continue; }
        if(wantsAgent(text)){    const wa = whatsappLinkFromSession(s); if (wa) await sendButtons(psid,'Te atiende un asesor por WhatsApp 👇',[{type:'web_url', url: wa, title:'📲 Abrir WhatsApp'}]); else await sendText(psid,'Compártenos un número de contacto y seguimos por WhatsApp.'); await showHelp(psid); continue; }
        if(wantsClose(text)){    await sendText(psid, '¡Gracias por escribirnos! Si más adelante te surge algo, aquí estoy para ayudarte. 👋'); clearSession(psid); continue; }

        // Si hay etapa pendiente, re-pregunta (no quedarse callado)
        if(s.pending==='departamento'){ await askDepartamento(psid); continue; }
        if(s.pending==='subzona'){ await askSubzonaSCZ(psid); continue; }
        if(s.pending==='subzona_free'){ await askSubzonaLibre(psid); continue; }

        // Ayuda amable (con antispam)
        await sendText(psid, 'Puedo ayudarte con *cotizaciones, catálogo, horarios, ubicación y envíos*.');
        await showHelp(psid);
      }
    }

    res.sendStatus(200);
  }catch(e){
    console.error('❌ /webhook', e);
    res.sendStatus(500);
  }
});

export default router;
