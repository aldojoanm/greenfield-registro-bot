// src/sheets.js
import 'dotenv/config';
import { google } from 'googleapis';
let _sheets;

/* ===========================
   Autorización / cliente API
   =========================== */
async function getSheets() {
  if (_sheets) return _sheets;

  // 1) Credenciales
  let auth;
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;

  try {
    if (raw && raw.trim()) {
      const creds = JSON.parse(raw);
      auth = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      auth = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } else {
      throw new Error('No hay credenciales de Google. Define GOOGLE_CREDENTIALS_JSON o GOOGLE_APPLICATION_CREDENTIALS.');
    }
  } catch (e) {
    console.error('[sheets] Error leyendo GOOGLE_CREDENTIALS_JSON:', e?.message || e);
    throw e;
  }

  const client = await auth.getClient();
  _sheets = google.sheets({ version: 'v4', auth: client });
  return _sheets;
}

/* ===============
   Helpers comunes
   =============== */
const onlyDigits = (s='') => String(s).replace(/[^\d]/g, '');
const pad2 = n => String(n).padStart(2, '0');
const LOCAL_TZ = process.env.LOCAL_TZ || 'America/La_Paz';

function formatDisplayDate(d){
  try{
    const parts = new Intl.DateTimeFormat('es-BO', {
      timeZone: LOCAL_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d);
    const get = t => parts.find(p => p.type === t)?.value || '';
    const yyyy = get('year'), mm = get('month'), dd = get('day');
    const hh = get('hour'), mi = get('minute');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }catch{
    const yy = d.getFullYear();
    const mm = pad2(d.getMonth()+1);
    const dd = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mi = pad2(d.getMinutes());
    return `${yy}-${mm}-${dd} ${hh}:${mi}`;
  }
}

/* =====================================
   Construcción de filas para "Hoja 1"
   (NO TOCAR lo existente)
   ===================================== */
function buildSummaryBullets(s, fechaDisplay) {
  const nombre = s?.profileName || s?.fullName || 'Cliente';
  const dep    = s?.vars?.departamento || 'ND';
  const zona   = s?.vars?.subzona || 'ND';
  const cultivo= (s?.vars?.cultivos && s.vars.cultivos[0]) || 'ND';
  const ha     = s?.vars?.hectareas || 'ND';
  const camp   = s?.vars?.campana || 'ND';
  const carrito = Array.isArray(s?.vars?.cart) ? s.vars.cart : [];
  const items = (carrito.length > 0) ? carrito : [{
    nombre: s?.vars?.last_product || '',
    presentacion: s?.vars?.last_presentacion || '',
    cantidad: s?.vars?.cantidad || ''
  }].filter(it => it.nombre);

  const linesProductos = items.map(it => {
    const pres = it.presentacion ? ` (${it.presentacion})` : '';
    const cant = it.cantidad ? ` — ${it.cantidad}` : '';
    return `* ${it.nombre}${pres}${cant}`;
  });

  const base = [
    `* Fecha: ${fechaDisplay}`,
    `* ${nombre}`,
    `* Departamento: ${dep}`,
    `* Zona: ${zona}`,
    `* Cultivo: ${cultivo}`,
    `* Hectáreas: ${ha}`,
    `* Campaña: ${camp}`,
    ...linesProductos
  ];

  return base.join('\n');
}

function buildClientMessage({ nombre, items }) {
  const quien = nombre || 'Hola';
  const lines = items.map(it => {
    const pres = it.presentacion ? ` (${it.presentacion})` : '';
    const cant = it.cantidad ? ` — ${it.cantidad}` : '';
    return `• ${it.nombre}${pres}${cant}`;
  });
  return [
    `Hola ${quien}, soy Jonathan Arteaga, Encargado de Negocios de New Chem Agroquímicos.`,
    `Te escribo por tu cotización con los siguientes productos:`,
    ...lines
  ].join('\n');
}

function buildWaLinkTo(numberDigits, message) {
  const to = onlyDigits(numberDigits);
  const text = encodeURIComponent(message);
  return to ? `https://wa.me/${to}?text=${text}` : '';
}

function buildShareLink(message) {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

function buildGroupShareMessage({ resumen, linkClienteConMensaje }) {
  return [
    `Resumen de solicitud:`,
    resumen,
    ``,
    `Contacto del cliente: ${linkClienteConMensaje}`
  ].join('\n');
}

function buildRowFromSession(s, fromPhone, estado = 'NUEVO') {
  const now = new Date();
  const fechaDisplay = formatDisplayDate(now);

  const fullName = s?.fullName || s?.profileName || '';
  const dep = s?.vars?.departamento || '';
  const zona = s?.vars?.subzona || '';
  const ubicacion = [dep, zona].filter(Boolean).join(' - ');
  const cultivo = (s?.vars?.cultivos && s.vars.cultivos[0]) || '';
  const hectareas = s?.vars?.hectareas || '';
  const campana = s?.vars?.campana || '';

  const carrito = Array.isArray(s?.vars?.cart) ? s.vars.cart : [];
  const items = (carrito.length > 0)
    ? carrito
    : [{
        nombre: s?.vars?.last_product || '',
        presentacion: s?.vars?.last_presentacion || '',
        cantidad: s?.vars?.cantidad || ''
      }].filter(it => it.nombre);

  const productoCell     = items.map(it => it?.nombre || '').join('\n');
  const presentacionCell = items.map(it => it?.presentacion || '').join('\n');
  const cantidadCell     = items.map(it => it?.cantidad || '').join('\n');

  const cotizacion_id = `${Date.now()}-${String(fromPhone || '').slice(-7)}`;
  const resumenTxt = buildSummaryBullets(s, fechaDisplay);
  const clientMsg   = buildClientMessage({ nombre: fullName, items });
  const linkCliente = buildWaLinkTo(fromPhone, clientMsg);
  const groupMsg = buildGroupShareMessage({ resumen: resumenTxt, linkClienteConMensaje: linkCliente });
  const resumenPedidoLink = buildShareLink(groupMsg);

  const EST = String(estado || '').toUpperCase();
  const estadoFinal = (EST === 'NUEVO' || EST === 'PENDIENTE' || EST === 'CERRADO') ? EST : 'NUEVO';
  const seguimiento = '';
  const calId = '';
  const phoneDigitsOnly = onlyDigits(fromPhone);

  return [
    fechaDisplay,         // 0 Fecha (legible local)
    phoneDigitsOnly,      // 1 Teléfono
    fullName,             // 2 Nombre Completo
    ubicacion,            // 3 Ubicación
    cultivo,              // 4 Cultivo
    String(hectareas||''),// 5 Hectáreas
    campana,              // 6 Campaña
    productoCell,         // 7 Producto
    presentacionCell,     // 8 Presentacion
    cantidadCell,         // 9 Cantidad
    estadoFinal,          // 10 Estado
    linkCliente,          // 11 Contacto Cliente (link con saludo)
    resumenPedidoLink,    // 12 Resumen Pedido (link para compartir)
    seguimiento,          // 13 Seguimiento
    cotizacion_id,        // 14 cotizacion_id
    calId                 // 15 calendar_event_id
  ];
}

/* =========================
   Hoja 1 – append existente
   ========================= */
export async function appendFromSession(s, fromPhone, estado = 'NUEVO') {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  const tab = process.env.SHEETS_TAB_NAME || 'Hoja 1';

  if (!spreadsheetId) {
    throw new Error('Falta SHEETS_SPREADSHEET_ID en el entorno.');
  }

  const values = [buildRowFromSession(s, fromPhone, estado)];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  return values[0][14]; // cotizacion_id
}

const TAB2_DEFAULT = process.env.SHEETS_TAB2_NAME || 'Hoja 2';

// Normaliza fechas dd/mm/aaaa o dd-mm-aaaa -> dd/mm/aaaa
function normalizeDateDMY(s=''){
  const t = String(s).trim();
  const m = t.match(/^([0-3]?\d)[\/\-]([0-1]?\d)[\/\-](\d{2,4})$/);
  if (!m) return t;
  let [_, d, mo, y] = m;
  if (y.length === 2) y = Number(y) >= 70 ? `19${y}` : `20${y}`;
  return `${pad2(d)}/${pad2(mo)}/${y}`;
}
const MONTH_MAP = {
  'enero':1,'ene':1,
  'febrero':2,'feb':2,
  'marzo':3,'mar':3,
  'abril':4,'abr':4,
  'mayo':5,'may':5,
  'junio':6,'jun':6,
  'julio':7,'jul':7,
  'agosto':8,'ago':8,
  'septiembre':9,'setiembre':9,'sep':9,'set':9,
  'octubre':10,'oct':10,
  'noviembre':11,'nov':11,
  'diciembre':12,'dic':12
};

const WEEKDAY_MAP = {
  'domingo':0,
  'lunes':1,
  'martes':2,
  'miercoles':3, 'miércoles':3,
  'jueves':4,
  'viernes':5,
  'sabado':6, 'sábado':6
};

const NORM = (s='') => s.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim();

function todayYMD(){
  try{
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: LOCAL_TZ, year:'numeric', month:'2-digit', day:'2-digit'
    }).formatToParts(new Date());
    const get = t => parts.find(p=>p.type===t)?.value || '';
    return { y: +get('year'), m: +get('month'), d: +get('day') };
  }catch{
    const d = new Date();
    return { y:d.getFullYear(), m:d.getMonth()+1, d:d.getDate() };
  }
}

function dmyFromOffset(days){
  const { y, m, d } = todayYMD();
  const base = new Date(Date.UTC(y, m-1, d));
  const tgt  = new Date(base.getTime() + days*24*60*60*1000);
  return `${pad2(tgt.getUTCDate())}/${pad2(tgt.getUTCMonth()+1)}/${tgt.getUTCFullYear()}`;
}

function nextWeekdayDMY(targetDow, forceNextWeek=false){
  const { y, m, d } = todayYMD();
  const base = new Date(Date.UTC(y, m-1, d));
  const todayDow = base.getUTCDay(); // 0..6
  let delta = (targetDow - todayDow + 7) % 7;
  if (delta === 0 && (forceNextWeek || true)) delta = 7;
  const tgt = new Date(base.getTime() + delta*24*60*60*1000);
  return `${pad2(tgt.getUTCDate())}/${pad2(tgt.getUTCMonth()+1)}/${tgt.getUTCFullYear()}`;
}

function dateFromDayMonthWords(text){
  const t = NORM(text).replace(/-/g,' ');
  const m = t.match(/\b([0-3]?\d)\s*(?:de\s*)?([a-záéíóúñ]{3,12})\.?(?:\s*de\s*(\d{2,4}))?\b/);
  if (!m) return '';
  const d = parseInt(m[1],10);
  const monName = m[2];
  const yRaw = m[3];

  let mo = MONTH_MAP[monName];
  if (!mo) return '';
  let y;
  if (yRaw) {
    y = String(yRaw).length===2 ? (Number(yRaw)>=70 ? 1900+Number(yRaw) : 2000+Number(yRaw)) : Number(yRaw);
  } else {
    const { y:cy, m:cm, d:cd } = todayYMD();
    y = (mo < cm || (mo===cm && d < cd)) ? cy + 1 : cy;
  }
  return `${pad2(d)}/${pad2(mo)}/${y}`;
}

// Normaliza placas y CI
function normalizePlate(s=''){
  return String(s).toUpperCase().replace(/\s+/g,'').replace(/[^A-Z0-9\-]/g,'');
}
function normalizeCI(s=''){
  return String(s).toUpperCase().replace(/\s+/g,' ').trim();
}

// helper para comparar nombres sin tildes/ruido
const normName = (s='') => String(s)
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu,'')
  .replace(/[^a-z0-9 ]/gi,'')
  .trim()
  .toLowerCase();

/* ===========================
   Parser de datos del cliente
   =========================== */
export function parseClientResponse(text = '', fallbackName = '') {
  const out = {
    nombreCliente: (fallbackName || '').trim(),
    razonSocial: '',
    nit: '',
    nombreChofer: '',
    ciChofer: '',          // NUEVO
    placa: '',
    fechaRecojo: ''
  };

  const lines = String(text || '')
    .split(/\r?\n|,|;/)
    .map(s => s.trim())
    .filter(Boolean);

  const tryMatch = (regex, line) => {
    const m = line.match(regex);
    return m ? m[m.length - 1].trim() : '';
  };

  const reNombre = /(nombre\s+del\s+cliente|cliente)\s*[:\-]\s*(.+)/i;
  const reRazon  = /(raz[oó]n(?:\s+social)?|rs)\s*[:\-]\s*(.+)/i;
  const reNIT    = /\b(nit)\s*[:\-]\s*([A-Za-z0-9.\-\/]+)/i;
  const reChofer = /(nombre\s+del\s+chofer|chofer|conductor)\s*[:\-]\s*(.+)/i;

  // CI del chofer: "Carnet de Identidad Chofer:", "CI Chofer:", "C.I.:"
  const reCI     = /(c(?:arnet)?\.?\s*(?:de\s*)?identidad|ci|c\.?\s*i\.?)\s*(?:\s*del?\s*chofer|\s*chofer)?\s*[:\-]\s*([A-Za-z0-9.\-\/ ]{3,})/i;

  const rePlaca  = /(placa(?:\s+del\s+veh[ií]culo)?|placa)\s*[:\-]\s*([A-Za-z0-9\-\s]{4,})/i;
  const reFecha  = /(fecha(?:\s+de)?\s*(recojo|retiro)?)(?:\s*\([^)]*\))?\s*[:\-]\s*([0-3]?\d[\/\-][01]?\d[\/\-]\d{2,4})/i;

  // 1) Con títulos línea a línea
  for (const line of lines) {
    if (!out.nombreCliente) {
      const v = tryMatch(reNombre, line); if (v) out.nombreCliente = v;
    }
    if (!out.razonSocial) {
      const v = tryMatch(reRazon,  line); if (v) out.razonSocial = v;
    }
    if (!out.nit) {
      const m = line.match(reNIT);   if (m) out.nit = m[2].trim();
    }
    if (!out.nombreChofer) {
      const v = tryMatch(reChofer, line); if (v) out.nombreChofer = v;
    }
    if (!out.ciChofer) {
      const m = line.match(reCI); if (m) out.ciChofer = normalizeCI(m[2]);
    }
    if (!out.placa) {
      const m = line.match(rePlaca); if (m) out.placa = normalizePlate(m[2]);
    }
    if (!out.fechaRecojo) {
      const m = line.match(reFecha); if (m) out.fechaRecojo = normalizeDateDMY(m[3]);
    }
  }

  // === Fallbacks de FECHA (sin título / formatos flexibles) ===

  // 2) dd/mm(/aa|aaaa) o dd-mm(/aa|aaaa) en todo el texto
  if (!out.fechaRecojo) {
    const m0 = String(text).match(/([0-3]?\d)[\/\-]([01]?\d)(?:[\/\-](\d{2,4}))?/);
    if (m0) {
      const d  = (+m0[1]);
      const mo = (+m0[2]);
      let y;
      if (m0[3]) {
        const yy = m0[3];
        y = yy.length === 2 ? (Number(yy) >= 70 ? 1900 + Number(yy) : 2000 + Number(yy)) : Number(yy);
      } else {
        const { y:cy, m:cm, d:cd } = todayYMD();
        y = (mo < cm || (mo === cm && d < cd)) ? cy + 1 : cy;
      }
      out.fechaRecojo = `${pad2(d)}/${pad2(mo)}/${y}`;
    }
  }

  // 3) "11 de octubre (2025)" | "11 oct"
  if (!out.fechaRecojo) {
    const dm = dateFromDayMonthWords(text);
    if (dm) out.fechaRecojo = dm;
  }

  // 4) "hoy / mañana / pasado mañana" o "viernes / este viernes / próximo viernes"
  if (!out.fechaRecojo) {
    const w = nextDateFromWords(text);
    if (w) out.fechaRecojo = w;
  }

  if (!out.fechaRecojo) {
    const m1 = String(text).match(/fecha(?:\s+de)?\s*(?:recojo|retiro)?(?:\s*\([^)]*\))?\s*-\s*([0-3]?\d[\/\-][01]?\d[\/\-]\d{2,4})/i);
    if (m1) out.fechaRecojo = normalizeDateDMY(m1[1]);
  }

  const fbNorm = normName(fallbackName);
  const labeledHints = /(raz[oó]n|rs|nit|chofer|conductor|placa|fecha|cliente|carnet|ci)\s*[:\-]/i;
  const bare = lines.filter(l => !labeledHints.test(l));

  if (!out.razonSocial && bare.length) {
    const hit = bare.find(l => normName(l) === fbNorm);
    if (hit) out.razonSocial = hit.trim();
  }
  if (!out.nit) {
    const m = bare.map(l => l.match(/^\s*([0-9.\-\/]{5,})\s*$/)).find(Boolean);
    if (m) out.nit = m[1].trim();
  }

  if (!out.razonSocial) {
    const m = text.match(/rs\s*[:\-]\s*([^\n;]+)/i) || text.match(/raz[oó]n\s*social\s*[:\-]\s*([^\n;]+)/i);
    if (m) out.razonSocial = m[1].trim();
  }
  if (!out.nit) {
    const m = text.match(/\bnit\s*[:\-]\s*([A-Za-z0-9.\-\/]+)/i);
    if (m) out.nit = m[1].trim();
  }
  if (!out.ciChofer) {
    const m = text.match(/\b(carnet(?:\s+de)?\s+identidad|ci|c\.?\s*i\.?)\s*[:\-]?\s*([A-Za-z0-9.\-\/ ]{3,})/i);
    if (m) out.ciChofer = normalizeCI(m[2]);
  }

  out.razonSocial   = out.razonSocial.replace(/\s+/g, ' ').trim();
  out.nombreChofer  = out.nombreChofer.replace(/\s+/g, ' ').trim();
  out.nombreCliente = out.nombreCliente.replace(/\s+/g, ' ').trim();

  return out;
}

export async function appendBillingPickupRow({ nombreCliente, razonSocial, nit, nombreChofer, ciChofer, placa, fechaRecojo }){
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  const tab2 = TAB2_DEFAULT;

  if (!spreadsheetId) {
    throw new Error('Falta SHEETS_SPREADSHEET_ID en el entorno.');
  }

  const values = [[
    nombreCliente || '',
    razonSocial   || '',
    nit           || '',
    nombreChofer  || '',
    ciChofer      || '', 
    placa         || '',
    fechaRecojo   || ''
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab2}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  return true;
}

export async function parseAndAppendClientResponse({ text, clientName }){
  const parsed = parseClientResponse(text || '', clientName || '');
  await appendBillingPickupRow(parsed);
  return parsed;
}

export { getSheets, buildRowFromSession };
