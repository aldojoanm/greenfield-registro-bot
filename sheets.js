// src/services/sheets.js
import 'dotenv/config';
import { google } from 'googleapis';

let _sheets; // cache del cliente de Sheets

async function getSheets() {
  if (_sheets) return _sheets;

  // Intentamos credenciales inline (GOOGLE_CREDENTIALS_JSON) y caemos a keyFile si no existen
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
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, // ./secrets/gsheets-key.json
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

  // Producto “resumen” (si hay carrito, tomo el primero para columnas simples; el detalle completo va en carrito_json)
  let producto = s?.vars?.last_product || '';
  let presentacion = s?.vars?.last_presentacion || '';
  let cantidad = s?.vars?.cantidad || '';
  let carrito = Array.isArray(s?.vars?.cart) ? s.vars.cart : [];

  if (carrito.length > 0) {
    const first = carrito[0];
    producto = first?.nombre || producto;
    presentacion = first?.presentacion || presentacion;
    cantidad = first?.cantidad || cantidad;
  }
  const carrito_json = carrito.length ? JSON.stringify(carrito) : '';

  // ID simple para trazabilidad (puedes cambiar por UUID si quieres)
  const cotizacion_id = `${Date.now()}-${String(fromPhone || '').slice(-7)}`;

  return [
    nowISO,                 // timestamp
    String(fromPhone || ''),// from_phone
    fullName,               // full_name
    ubicacion,              // ubicacion
    cultivo,                // cultivo
    String(hectareas || ''),// hectareas
    campana,                // campaña
    producto,               // producto
    presentacion,           // presentacion
    cantidad,               // cantidad
    carrito_json,           // carrito_json
    estado,                 // estado
    cotizacion_id           // cotizacion_id
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
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  // Devuelvo el cotizacion_id (columna 13 => índice 12)
  return values[0][12];
}

export { getSheets, buildRowFromSession };
