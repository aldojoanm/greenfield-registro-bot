// src/sheets.js
import 'dotenv/config';
import { google } from 'googleapis';

let _sheets; // cache del cliente de Sheets

async function getSheets() {
  if (_sheets) return _sheets;

  // 1) Credenciales inline (GOOGLE_CREDENTIALS_JSON)  2) keyFile (GOOGLE_APPLICATION_CREDENTIALS)
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

// ===== Helpers =====
const onlyDigits = (s='') => String(s).replace(/[^\d]/g, '');
const pad2 = n => String(n).padStart(2, '0');

// Fecha legible (usa la zona horaria del servidor)
function formatDisplayDate(d){
  const yy = d.getFullYear();
  const mm = pad2(d.getMonth()+1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yy}-${mm}-${dd} ${hh}:${mi}`;
}

function buildSummaryBullets(s, fechaDisplay) {
  const nombre = s?.profileName || s?.fullName || 'Cliente';
  const dep    = s?.vars?.departamento || 'ND';
  const zona   = s?.vars?.subzona || 'ND';
  const cultivo= (s?.vars?.cultivos && s.vars.cultivos[0]) || 'ND';
  const ha     = s?.vars?.hectareas || 'ND';
  const camp   = s?.vars?.campana || 'ND';

  // productos: carrito o último producto
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

function buildWhatsAppMessageToClient({ nombre, cotId, resumen }) {
  const quien = nombre || 'Hola';
  return [
    `Hola ${quien}, soy del equipo de New Chem. Te contacto por tu cotización ${cotId}.`,
    ``,
    `Resumen:`,
    resumen,
    ``,
    `¿Te queda bien si te envío la propuesta por aquí?`
  ].join('\n');
}

function buildWaLinkTo(numberDigits, message) {
  const to = onlyDigits(numberDigits);
  const text = encodeURIComponent(message);
  return to ? `https://wa.me/${to}?text=${text}` : '';
}

// Link “compartir” (elige contacto o grupo al abrir)
function buildShareLink(message) {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

// Mensaje para compartir en el grupo (incluye link al cliente)
function buildGroupShareMessage({ resumen, phoneDigits }) {
  const clienteLink = phoneDigits ? `https://wa.me/${phoneDigits}` : '';
  return [
    `Resumen de solicitud:`,
    resumen,
    ``,
    `Contacto del cliente: ${clienteLink}`
  ].join('\n');
}

function buildRowFromSession(s, fromPhone, estado = 'NUEVO') {
  const now = new Date();
  const nowISO = now.toISOString();
  const fechaDisplay = formatDisplayDate(now);

  const fullName = s?.fullName || s?.profileName || '';
  const dep = s?.vars?.departamento || '';
  const zona = s?.vars?.subzona || '';
  const ubicacion = [dep, zona].filter(Boolean).join(' - ');
  const cultivo = (s?.vars?.cultivos && s.vars.cultivos[0]) || '';
  const hectareas = s?.vars?.hectareas || '';
  const campana = s?.vars?.campana || '';

  // carrito o último producto
  const carrito = Array.isArray(s?.vars?.cart) ? s.vars.cart : [];
  const items = (carrito.length > 0)
    ? carrito
    : [{
        nombre: s?.vars?.last_product || '',
        presentacion: s?.vars?.last_presentacion || '',
        cantidad: s?.vars?.cantidad || ''
      }].filter(it => it.nombre);

  // Multilínea
  const productoCell     = items.map(it => it?.nombre || '').join('\n');
  const presentacionCell = items.map(it => it?.presentacion || '').join('\n');
  const cantidadCell     = items.map(it => it?.cantidad || '').join('\n');

  // ID de cotización
  const cotizacion_id = `${Date.now()}-${String(fromPhone || '').slice(-7)}`;

  // Resumen (texto) — incluye la fecha
  const resumenTxt = buildSummaryBullets(s, fechaDisplay);

  // Link de WhatsApp directo al cliente (con mensaje prellenado)
  const msgForClient = buildWhatsAppMessageToClient({ nombre: fullName, cotId: cotizacion_id, resumen: resumenTxt });
  const linkClient   = buildWaLinkTo(fromPhone, msgForClient);

  // “Resumen” como LINK de compartir (para pegar en el grupo)
  const phoneDigits = onlyDigits(fromPhone);
  const groupMsg = buildGroupShareMessage({ resumen: resumenTxt, phoneDigits });
  const resumenShareLink = buildShareLink(groupMsg);

  // Estado a 3 valores
  const EST = String(estado || '').toUpperCase();
  const estadoFinal = (EST === 'NUEVO' || EST === 'PENDIENTE' || EST === 'CERRADO') ? EST : 'NUEVO';

  // Seguimiento (lo llenará Apps Script si está vacío)
  const seguimiento = '';

  // calendar_event_id (lo llenará Apps Script)
  const calId = '';

  // Teléfono: solo dígitos
  const phoneDigitsOnly = phoneDigits;

  // === ORDEN EXACTO DE COLUMNAS (SIN “Mensaje Whatsapp”) ===
  return [
    nowISO,               // 0  Fecha
    phoneDigitsOnly,      // 1  Teléfono
    fullName,             // 2  Nombre Completo
    ubicacion,            // 3  Ubicación
    cultivo,              // 4  Cultivo
    String(hectareas||''),// 5  Hectáreas
    campana,              // 6  Campaña
    productoCell,         // 7  Producto
    presentacionCell,     // 8  Presentacion
    cantidadCell,         // 9  Cantidad
    estadoFinal,          // 10 Estado
    linkClient,           // 11 Link Whatsapp (cliente)
    resumenShareLink,     // 12 Resumen (link para compartir)
    seguimiento,          // 13 Seguimiento
    cotizacion_id,        // 14 cotizacion_id
    calId                 // 15 calendar_event_id
  ];
}

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

  // devuelve cotizacion_id (columna 15, índice 14)
  return values[0][14];
}

export { getSheets, buildRowFromSession };
