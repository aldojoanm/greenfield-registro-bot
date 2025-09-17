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

/** A1-escape para nombres de hoja con espacios/apóstrofes */
function a1Tab(tab='') {
  const t = String(tab);
  if (/^'.*'$/.test(t)) return t;           // ya citado
  const safe = t.replace(/'/g, "''");       // duplicar apóstrofes internos
  return /[ \t!:,']/.test(safe) ? `'${safe}'` : safe;
}

/** Normalización simple para comparar títulos de pestañas */
const norm = (s='') => String(s)
  .normalize('NFD').replace(/\p{Diacritic}/gu,'')
  .replace(/[^a-z0-9]/gi,'')
  .toUpperCase();

/** Cache de pestañas resueltas por spreadsheet */
let _resolvedTabsCache = null;

/**
 * Detecta automáticamente los nombres reales de pestañas.
 * Prioriza .env si existen; si no, busca por alias modernos y viejos.
 */
async function getResolvedTabs(spreadsheetId) {
  if (_resolvedTabsCache?.ssId === spreadsheetId) return _resolvedTabsCache;

  const envTabs = {
    main: process.env.SHEETS_TAB_NAME,
    oe:   process.env.SHEETS_TAB2_NAME,
    precios: process.env.SHEETS_TAB3_NAME,
    hist: process.env.SHEETS_TAB4_NAME,
    verCell: process.env.SHEETS_PRICES_VERSION_CELL,
    rateCell: process.env.SHEETS_PRICES_RATE_CELL,
  };

  // Si TODO viene de env, devolver directo
  if (envTabs.main && envTabs.oe && envTabs.precios && envTabs.hist) {
    const out = {
      ssId: spreadsheetId,
      main: envTabs.main,
      oe: envTabs.oe,
      precios: envTabs.precios,
      hist: envTabs.hist,
      versionCell: envTabs.verCell || `${a1Tab(envTabs.precios)}!J1`,
      rateCell:    envTabs.rateCell || `${a1Tab(envTabs.precios)}!J2`,
    };
    _resolvedTabsCache = out;
    return out;
  }

  const sheets = await getSheets();
  let titles = [];
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: false,
    });
    titles = (meta.data.sheets || [])
      .map(s => s?.properties?.title)
      .filter(Boolean);
  } catch (e) {
    // Si falla leer metadatos, usar defaults "nuevos" y listo.
    const fallback = {
      ssId: spreadsheetId,
      main: 'BD GRAL',
      oe: 'OE',
      precios: 'PRECIOS',
      hist: 'Hoja 4',
      versionCell: `PRECIOS!J1`,
      rateCell:    `PRECIOS!J2`,
    };
    _resolvedTabsCache = fallback;
    return fallback;
  }

  const ntitles = titles.map(t => ({ raw: t, n: norm(t) }));

  // Alias por rol
  const CANDIDATES = {
    main:    ['BDGRAL','BDGENERAL','BD','DATOS','HOJA1'],
    oe:      ['OE','ORDENES','OPERACIONES','HOJA2'],
    precios: ['PRECIOS','LISTAPRECIOS','PRICES','HOJA3'],
    hist:    ['HISTORIAL','HIST','CHAT','MENSAJES','HOJA4'],
  };

  // También considerar exactamente estos nombres modernos
  const EXACT = {
    main: 'BD GRAL',
    oe: 'OE',
    precios: 'PRECIOS',
    hist: 'Hoja 4',
  };

  const pick = (role, exact, cands, legacy) => {
    // 1) exacto moderno
    const e = ntitles.find(x => x.raw === exact);
    if (e) return e.raw;
    // 2) por candidatos normalizados
    const set = new Set(cands);
    const hit = ntitles.find(x => set.has(x.n));
    if (hit) return hit.raw;
    // 3) nombre legacy por defecto
    const leg = ntitles.find(x => x.raw === legacy);
    if (leg) return leg.raw;
    // 4) fallback final
    return exact;
  };

  const main = envTabs.main || pick('main', EXACT.main, CANDIDATES.main, 'Hoja 1');
  const oe   = envTabs.oe   || pick('oe',   EXACT.oe,   CANDIDATES.oe,   'Hoja 2');
  const precios = envTabs.precios || pick('precios', EXACT.precios, CANDIDATES.precios, 'Hoja 3');
  const hist    = envTabs.hist    || pick('hist',    EXACT.hist,    CANDIDATES.hist,    'Hoja 4');

  const versionCell = envTabs.verCell || `${a1Tab(precios)}!J1`;
  const rateCell    = envTabs.rateCell|| `${a1Tab(precios)}!J2`;

  const resolved = { ssId: spreadsheetId, main, oe, precios, hist, versionCell, rateCell };
  _resolvedTabsCache = resolved;
  return resolved;
}

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
    const dd = d.getDate().toString().padStart(2,'0');
    const hh = d.getHours().toString().padStart(2,'0');
    const mi = d.getMinutes().toString().padStart(2,'0');
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
  if (!spreadsheetId) throw new Error('Falta SHEETS_SPREADSHEET_ID en el entorno.');

  const tabs = await getResolvedTabs(spreadsheetId);
  const values = [buildRowFromSession(s, fromPhone, estado)];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${a1Tab(tabs.main)}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  return values[0][14]; // cotizacion_id
}

/* =========================
   Hoja 2 – OE / Datos retiro
   ========================= */
export async function appendBillingPickupRow({ nombreCliente, razonSocial, nit, nombreChofer, ciChofer, placa, fechaRecojo }){
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('Falta SHEETS_SPREADSHEET_ID en el entorno.');

  const tabs = await getResolvedTabs(spreadsheetId);

  const values = [[
    nombreCliente || '',
    razonSocial   || '',
    nit           || '',
    nombreChofer  || '',
    onlyDigits(ciChofer || ''), // normalizado a dígitos
    placa         || '',
    fechaRecojo   || ''
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${a1Tab(tabs.oe)}!A1`,
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

/* =========================================================
   Hoja 3 (PRECIOS) y Hoja 4 (HISTORIAL) — MISMA PLANILLA
   ========================================================= */
const SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID;

/**
 * Lee precios desde PRECIOS:
 * A: TIPO | B: PRODUCTO | C: PRESENTACION | D: UNIDAD | E: PRECIO (USD) | F: PRECIO (BS)
 */
export async function readPrices() {
  const sheets = await getSheets();
  const spreadsheetId = SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('Falta SHEETS_SPREADSHEET_ID en el entorno.');
  const tabs = await getResolvedTabs(spreadsheetId);

  // 1) Leer versión y TC (si no existen, defaults)
  let version = 1;
  let rate = 6.96;

  try {
    const meta = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [tabs.versionCell, tabs.rateCell],
    });
    const vRaw = meta.data.valueRanges?.[0]?.values?.[0]?.[0];
    const rRaw = meta.data.valueRanges?.[1]?.values?.[0]?.[0];
    version = Number(vRaw || 1);
    rate = Number(rRaw || 6.96);
  } catch {
    // sin romper si no existen
  }

  // 2) Leer tabla (desde fila 2 porque fila 1 son encabezados)
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${a1Tab(tabs.precios)}!A2:F`,
  });

  const rows = r.data.values || [];
  const prices = rows
    .filter(row => (row[0] || row[1] || row[2] || row[3] || row[4] || row[5]))
    .map(row => {
      const tipo = row[0] || '';
      const producto = row[1] || '';
      const presentacion = row[2] || '';
      const unidad = row[3] || '';
      const pUsd = Number((row[4] || '').toString().replace(',', '.')) || 0;
      const pBs  = Number((row[5] || '').toString().replace(',', '.')) || 0;
      const sku = presentacion ? `${producto}-${presentacion}` : producto;
      return { categoria: tipo, sku, unidad, precio_usd: pUsd, precio_bs: pBs };
    });

  return { prices, version, rate };
}

/**
 * Escribe precios en PRECIOS (A2:F) con control de versión.
 */
export async function writePrices(prices, expectedVersion) {
  const sheets = await getSheets();
  const spreadsheetId = SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('Falta SHEETS_SPREADSHEET_ID en el entorno.');
  const tabs = await getResolvedTabs(spreadsheetId);

  // 1) Chequear versión actual
  let currentVersion = 1;
  try {
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: tabs.versionCell,
    });
    currentVersion = Number(cur.data.values?.[0]?.[0] || 1);
  } catch {}

  if (Number(expectedVersion) !== Number(currentVersion)) {
    const err = new Error('VERSION_MISMATCH');
    err.code = 409;
    throw err;
  }

  // 2) Preparar valores para A2:F
  const body = {
    values: (prices || []).map(p => {
      let producto = '';
      let presentacion = '';
      const sku = String(p.sku || '').trim();
      if (sku.includes('-')) {
        const parts = sku.split('-');
        producto = parts.shift() || '';
        presentacion = parts.join('-') || '';
      } else {
        producto = sku;
        presentacion = '';
      }
      return [
        p.categoria || '',         // A: TIPO
        producto || '',            // B: PRODUCTO
        presentacion || '',        // C: PRESENTACION
        p.unidad || '',            // D: UNIDAD
        Number(p.precio_usd || 0), // E: PRECIO (USD)
        Number(p.precio_bs || 0)   // F: PRECIO (BS)
      ];
    }),
  };

  // 3) Limpiar rango y reescribir
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${a1Tab(tabs.precios)}!A2:F`,
  });

  if (body.values.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${a1Tab(tabs.precios)}!A2`,
      valueInputOption: 'RAW',
      requestBody: body,
    });
  }

  // 4) Incrementar versión
  const nextVersion = Number(currentVersion) + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: tabs.versionCell,
    valueInputOption: 'RAW',
    requestBody: { values: [[ nextVersion ]] },
  });

  return nextVersion;
}

/** Lee el tipo de cambio (TC) desde PRECIOS (J2 por defecto). */
export async function readRate() {
  const sheets = await getSheets();
  const spreadsheetId = SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('Falta SHEETS_SPREADSHEET_ID en el entorno.');
  const tabs = await getResolvedTabs(spreadsheetId);
  try {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: tabs.rateCell,
    });
    return Number(r.data.values?.[0]?.[0] || 6.96);
  } catch {
    return 6.96;
  }
}

/** Escribe el tipo de cambio (TC) en PRECIOS (J2 por defecto). */
export async function writeRate(rate) {
  const sheets = await getSheets();
  const spreadsheetId = SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('Falta SHEETS_SPREADSHEET_ID en el entorno.');
  const tabs = await getResolvedTabs(spreadsheetId);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: tabs.rateCell,
    valueInputOption: 'RAW',
    requestBody: { values: [[ Number(rate || 0) ]] },
  });
  return true;
}

/* =============================
   Hoja 4: HISTORIAL de mensajes
   ============================= */

/**
 * Append de mensaje:
 * Columnas: wa_id | nombre | ts_iso | role | content
 */
export async function appendMessage({ waId, name, ts, role, content }) {
  const sheets = await getSheets();
  const spreadsheetId = SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('Falta SHEETS_SPREADSHEET_ID en el entorno.');
  const tabs = await getResolvedTabs(spreadsheetId);

  const row = [
    String(waId || ''),
    String(name || ''),
    new Date(ts || Date.now()).toISOString(),
    String(role || ''),
    String(content || ''),
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${a1Tab(tabs.hist)}!A1:E`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

/**
 * Lee historial (últimos N días) para un wa_id.
 */
export async function historyForIdLastNDays(waId, days = 7) {
  const sheets = await getSheets();
  const spreadsheetId = SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('Falta SHEETS_SPREADSHEET_ID en el entorno.');
  const tabs = await getResolvedTabs(spreadsheetId);

  const r = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${a1Tab(tabs.hist)}!A1:E`,
  });
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = r.data.values || [];
  const data = rows.slice(1); // salta encabezado

  return data
    .map(row => ({
      wa_id: row[0],
      name: row[1],
      ts: Date.parse(row[2]),
      role: row[3],
      content: row[4],
    }))
    .filter(x =>
      x.wa_id === String(waId) &&
      Number.isFinite(x.ts) &&
      x.ts >= since
    )
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Resúmenes para Inbox (últimos N días).
 */
export async function summariesLastNDays(days = 7) {
  const sheets = await getSheets();
  const spreadsheetId = SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('Falta SHEETS_SPREADSHEET_ID en el entorno.');
  const tabs = await getResolvedTabs(spreadsheetId);

  const r = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${a1Tab(tabs.hist)}!A1:E`,
  });
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = r.data.values || [];
  const data = rows.slice(1);

  const map = new Map(); // wa_id -> { id, name, last, lastTs }
  for (const row of data) {
    const wa_id = row[0];
    const name  = row[1] || '';
    const ts    = Date.parse(row[2]);
    const role  = row[3] || '';
    const content = row[4] || '';
    if (!wa_id || !Number.isFinite(ts) || ts < since) continue;
    const cur = map.get(wa_id) || { id: wa_id, name: name || wa_id, last: '', lastTs: 0 };
    if (ts >= cur.lastTs) {
      cur.name = name || wa_id;
      cur.last = content || (role ? `[${role}]` : '');
      cur.lastTs = ts;
    }
    map.set(wa_id, cur);
  }
  return [...map.values()];
}

/**
 * Purga por chat (Hoja 4).
 */
export async function pruneExpiredConversations(days = 7) {
  const sheets = await getSheets();
  const spreadsheetId = SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('Falta SHEETS_SPREADSHEET_ID en el entorno.');
  const tabs = await getResolvedTabs(spreadsheetId);

  const r = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${a1Tab(tabs.hist)}!A1:E`,
  });
  const rows = r.data.values || [];
  if (!rows.length) return { kept: 0, removed: 0 };

  const header = rows[0] || ['wa_id','nombre','ts_iso','role','content'];
  const data = rows.slice(1);

  // agrupar por wa_id
  const byId = new Map();
  for (const row of data) {
    const wa = row[0];
    const ts = Date.parse(row[2]);
    if (!wa || !Number.isFinite(ts)) continue;
    const arr = byId.get(wa) || [];
    arr.push({ row, ts });
    byId.set(wa, arr);
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const keepRows = [];
  let removed = 0;
  for (const [, arr] of byId.entries()) {
    const lastTs = Math.max(...arr.map(x => x.ts));
    if (lastTs >= cutoff) {
      for (const x of arr) keepRows.push(x.row);
    } else {
      removed += arr.length;
    }
  }

  // reescribir la hoja completa
  const all = [header, ...keepRows];
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${a1Tab(tabs.hist)}!A1:E`,
  });
  if (all.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${a1Tab(tabs.hist)}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: all },
    });
  }
  return { kept: keepRows.length, removed };
}

// Atajos finales
export async function appendChatHistoryRow({ wa_id, nombre, ts_iso, role, content }) {
  return appendMessage({ waId: wa_id, name: nombre, ts: ts_iso, role, content });
}

export async function purgeOldChatHistory(days = 7) {
  return pruneExpiredConversations(days);
}

export { getSheets, buildRowFromSession };
