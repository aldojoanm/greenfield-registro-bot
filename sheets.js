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
const title = s => String(s||'').replace(/\w\S*/g, w => w[0].toUpperCase()+w.slice(1).toLowerCase());

function buildSummaryBullets(s) {
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

// Link para “compartir” (elige contacto o grupo al abrir)
function buildShareLink(message) {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

// Mensaje para compartir en grupo vacío del vendedor
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
  const nowISO = new Date().toISOString();
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

  // Resumen (texto)
  const resumenTxt = buildSummaryBullets(s);

  // Mensaje y Link de WhatsApp para el vendedor → cliente
  const msgForClient = buildWhatsAppMessageToClient({ nombre: fullName, cotId: cotizacion_id, resumen: resumenTxt });
  const linkClient   = buildWaLinkTo(fromPhone, msgForClient);

  // “Resumen” ahora será LINK DE COMPARTIR a grupo (con resumen + link cliente)
  const phoneDigits = onlyDigits(fromPhone);
  const groupMsg = buildGroupShareMessage({ resumen: resumenTxt, phoneDigits });
  const resumenShareLink = buildShareLink(groupMsg);

  // Normaliza estado a 3 valores
  const EST = String(estado || '').toUpperCase();
  const estadoFinal = (EST === 'NUEVO' || EST === 'PENDIENTE' || EST === 'CERRADO') ? EST : 'NUEVO';

  // Seguimiento: vacío (lo calculará Apps Script si no lo llenan)
  const seguimiento = '';

  // calendar_event_id: vacío (lo llenará Apps Script al crear evento)
  const calId = '';

  // Teléfono: solo dígitos
  const phoneDigitsOnly = phoneDigits;

  return [
    nowISO,                 // Fecha
    phoneDigitsOnly,        // Teléfono
    fullName,               // Nombre Completo
    ubicacion,              // Ubicación
    cultivo,                // Cultivo
    String(hectareas||''),  // Hectáreas
    campana,                // Campaña
    productoCell,           // Producto
    presentacionCell,       // Presentacion
    cantidadCell,           // Cantidad
    estadoFinal,            // Estado
    msgForClient,           // Mensaje Whatsapp (para cliente)
    linkClient,             // Link Whatsapp (directo al cliente)
    resumenShareLink,       // Resumen (LINK de compartir a grupo)
    seguimiento,            // Seguimiento
    cotizacion_id,          // cotizacion_id
    calId                   // calendar_event_id
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

  // devuelve cotizacion_id (columna 16, índice 15)
  return values[0][15];
}

export { getSheets, buildRowFromSession };
