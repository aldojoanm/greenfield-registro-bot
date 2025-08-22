// src/services/sheets.js
import 'dotenv/config';
import { google } from 'googleapis';

let _auth; // cache

async function getSheets() {
  if (!_auth) {
    _auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, // ./secrets/gsheets-key.json
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  const auth = await _auth.getClient();
  return google.sheets({ version: 'v4', auth });
}

function buildRowFromSession(s, fromPhone, estado = 'nuevo') {
  const nowISO = new Date().toISOString();
  const fullName = s?.fullName || s?.profileName || '';
  const ubicacion = [s?.vars?.departamento, s?.vars?.subzona].filter(Boolean).join(' - ');
  const cultivo = (s?.vars?.cultivos && s.vars.cultivos[0]) || '';
  const hectareas = s?.vars?.hectareas || '';
  const campana = s?.vars?.campana || '';

  // Producto “resumen” (si hay carrito, pongo el primero solo para visual; todo el detalle va en carrito_json)
  let producto = s?.vars?.last_product || '';
  let presentacion = s?.vars?.last_presentacion || '';
  let cantidad = s?.vars?.cantidad || '';
  let carrito = s?.vars?.cart || [];
  if (Array.isArray(carrito) && carrito.length > 0) {
    const first = carrito[0];
    producto = first?.nombre || producto;
    presentacion = first?.presentacion || presentacion;
    cantidad = first?.cantidad || cantidad;
  }
  const carrito_json = carrito?.length ? JSON.stringify(carrito) : '';

  // ID simple para trazabilidad (puedes cambiarlo por UUID si quieres)
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

  const values = [buildRowFromSession(s, fromPhone, estado)];
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  // Devuelve el cotizacion_id para que lo guardes en sesión si quieres
  return values[0][12];
}
