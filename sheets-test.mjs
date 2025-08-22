import 'dotenv/config';
import { google } from 'googleapis';

async function main() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    // googleapis tomará la ruta desde GOOGLE_APPLICATION_CREDENTIALS (.env)
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  const tab = process.env.SHEETS_TAB_NAME || 'Hoja 1';
  const range = `${tab}!A:Z`;

  const nowIso = new Date().toISOString();

  // Rellena 13 columnas según tu estructura
  const row = [
    nowIso,                 // timestamp
    '+59100000000',         // from_phone
    'TEST BOT',             // full_name
    'Santa Cruz - Norte',   // ubicacion (libre)
    'Soya',                 // cultivo
    '50',                   // hectareas
    'Invierno',             // campaña
    'TRENCH 480 SL',        // producto
    '1 L',                  // presentacion
    '20 L',                 // cantidad (texto libre)
    '',                     // carrito_json (vacío en test)
    'nuevo',                // estado
    ''                      // cotizacion_id
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });

  console.log('OK: fila agregada.');
}

main().catch(err => {
  console.error('ERROR:', err?.response?.data || err);
  process.exit(1);
});
