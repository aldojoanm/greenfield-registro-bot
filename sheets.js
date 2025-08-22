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

function buildRowFromSession(s, fromPhone, estado = 'nuevo') {
  const nowISO = new Date().toISOString();
  const fullName = s?.fullName || s?.profileName || '';
  const ubicacion = [s?.vars?.departamento, s?.vars?.subzona].filter(Boolean).join(' - ');
  const cultivo = (s?.vars?.cultivos && s.vars.cultivos[0]) || '';
  const hectareas = s?.vars?.hectareas || '';
  const campana = s?.vars?.campana || '';

  // Fuente de items: carrito si existe, si no el “actual”
  const carrito = Array.isArray(s?.vars?.cart) ? s.vars.cart : [];
  const items = (carrito.length > 0)
    ? carrito
    : [{
        nombre: s?.vars?.last_product || '',
        presentacion: s?.vars?.last_presentacion || '',
        cantidad: s?.vars?.cantidad || ''
      }].filter(it => it.nombre); // solo si hay nombre

  // Columnas multilinea (una línea por item)
  const productoCell      = items.map(it => it?.nombre || '').join('\n');
  const presentacionCell  = items.map(it => it?.presentacion || '').join('\n');
  const cantidadCell      = items.map(it => it?.cantidad || '').join('\n');

  // JSON solo si hay carrito real
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
    productoCell,             // producto (solo nombres, multilinea)
    presentacionCell,         // presentacion (multilinea)
    cantidadCell,             // cantidad (multilinea)
    carrito_json,             // carrito_json
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
    valueInputOption: 'RAW',      // conserva los '\n' como saltos de línea en la celda
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  return values[0][12]; // cotizacion_id
}

export { getSheets, buildRowFromSession };
