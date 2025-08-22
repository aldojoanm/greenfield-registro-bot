// src/sheets.js  (o src/services/sheets.js si usas carpeta services)
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

// ---------- helpers ----------
function lineProducto({ nombre, presentacion, cantidad }) {
  if (!nombre) return '';
  let s = String(nombre);
  if (presentacion) s += ` (${presentacion})`;
  if (cantidad) s += ` — ${cantidad}`;
  return s;
}

function buildRowFromSession(s, fromPhone, estado = 'nuevo') {
  const nowISO = new Date().toISOString();
  const fullName = s?.fullName || s?.profileName || '';
  const ubicacion = [s?.vars?.departamento, s?.vars?.subzona].filter(Boolean).join(' - ');
  const cultivo = (s?.vars?.cultivos && s.vars.cultivos[0]) || '';
  const hectareas = s?.vars?.hectareas || '';
  const campana = s?.vars?.campana || '';

  const carrito = Array.isArray(s?.vars?.cart) ? s.vars.cart : [];

  // ① Columna "producto": todas las líneas (una por producto) si hay carrito
  let productoCell = '';
  if (carrito.length > 0) {
    productoCell = carrito
      .map(it => lineProducto({ nombre: it?.nombre, presentacion: it?.presentacion, cantidad: it?.cantidad }))
      .filter(Boolean)
      .join('\n');               // ← salto de línea dentro de la celda
  } else {
    // Si no hay carrito, uso el “actual”
    productoCell = lineProducto({
      nombre: s?.vars?.last_product,
      presentacion: s?.vars?.last_presentacion,
      cantidad: s?.vars?.cantidad
    });
  }

  // ② Para "presentacion" y "cantidad" mostramos el PRIMER item (como referencia rápida)
  let presentacion = s?.vars?.last_presentacion || '';
  let cantidad = s?.vars?.cantidad || '';
  if (carrito.length > 0) {
    presentacion = carrito[0]?.presentacion || presentacion;
    cantidad = carrito[0]?.cantidad || cantidad;
  }

  const carrito_json = carrito.length ? JSON.stringify(carrito) : '';

  // ID simple para trazabilidad
  const cotizacion_id = `${Date.now()}-${String(fromPhone || '').slice(-7)}`;

  return [
    nowISO,                   // timestamp
    String(fromPhone || ''),  // from_phone
    fullName,                 // full_name
    ubicacion,                // ubicacion
    cultivo,                  // cultivo
    String(hectareas || ''),  // hectareas
    campana,                  // campaña
    productoCell,             // producto  ← ahora multilinea si hay varios
    presentacion,             // presentacion (del 1er item)
    cantidad,                 // cantidad (del 1er item)
    carrito_json,             // carrito_json (todo el detalle)
    estado,                   // estado
    cotizacion_id             // cotizacion_id
  ];
}

export async function appendFromSession(s, fromPhone, estado = 'nuevo') {
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
    valueInputOption: 'RAW',          // '\n' se conserva tal cual en la celda
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  return values[0][12]; // cotizacion_id
}

export { getSheets, buildRowFromSession };
