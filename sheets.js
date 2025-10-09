import "dotenv/config";
import { google } from "googleapis";

let _sheets;

export async function getSheets() {
  if (_sheets) return _sheets;
  let auth;
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (raw && raw.trim()) {
    const creds = JSON.parse(raw);
    auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  } else {
    throw new Error("No hay credenciales de Google. Define GOOGLE_CREDENTIALS_JSON o GOOGLE_APPLICATION_CREDENTIALS.");
  }
  const client = await auth.getClient();
  _sheets = google.sheets({ version: "v4", auth: client });
  return _sheets;
}

const pad2 = (n) => String(n).padStart(2, "0");
const LOCAL_TZ = process.env.LOCAL_TZ || "America/La_Paz";

export function nowDisplay() {
  try {
    const parts = new Intl.DateTimeFormat("es-BO", { timeZone: LOCAL_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
  } catch {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
}

export function todayISODate() {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: LOCAL_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
}

export const HEADERS = ["id","fecha","detalle","factura-recibo","combustible","kilometraje vehiculo","alimentacion","hospedaje","peajes","aceites","llantas","frenos","otros","totales","memo"];

const MONEY_COL_INDEXES = { combustible: 4, alimentacion: 6, hospedaje: 7, peajes: 8, aceites: 9, llantas: 10, frenos: 11, otros: 12 };
const KM_COL_INDEX = 5;
const MEMO_COL_INDEX = 14;

function canonSheetName(name = "") { return String(name || "Empleado").trim().slice(0, 99); }
function num(x) { if (typeof x === "number") return x; const s = String(x ?? "").replace(/\s+/g, "").replace(/,/g, "."); const n = Number(s); return Number.isFinite(n) ? n : 0; }

export async function ensureEmployeeSheet(empleadoNombre) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("Falta SHEETS_SPREADSHEET_ID");
  const title = canonSheetName(empleadoNombre);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title } } }] } });
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `${title}!A1:O1`, valueInputOption: "RAW", requestBody: { values: [HEADERS] } });
  } else {
    await sheets.spreadsheets.values.get({ spreadsheetId, range: `${title}!A1:O1` }).catch(async () => {
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${title}!A1:O1`, valueInputOption: "RAW", requestBody: { values: [HEADERS] } });
    });
  }
  return title;
}

async function getNextId(hoja) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${hoja}!A:A` });
  const rows = r.data.values || [];
  if (rows.length <= 1) return 1;
  const last = rows.slice(1).map(x => Number(x?.[0] || 0)).filter(n => Number.isFinite(n));
  return last.length ? Math.max(...last) + 1 : 1;
}

export async function upsertDailyExpenseRow(hoja, rowObj) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  const today = todayISODate();

  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${hoja}!A2:O100000` });
  const rows = r.data.values || [];

  let rowIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    const fecha = rows[i]?.[1] || "";
    if (String(fecha).slice(0, 10) === today) { rowIndex = i + 2; break; }
  }

  if (rowIndex === -1) {
    const id = await getNextId(hoja);
    const base = new Array(HEADERS.length).fill("");
    base[0] = id;
    base[1] = nowDisplay();
    base[13] = 0;
    base[14] = "{}";
    await sheets.spreadsheets.values.append({ spreadsheetId, range: `${hoja}!A1`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: [base] } });
    rowIndex = rows.length + 2;
  }

  const rowRange = `${hoja}!A${rowIndex}:O${rowIndex}`;
  const current = await sheets.spreadsheets.values.get({ spreadsheetId, range: rowRange });
  const row = current.data.values?.[0] || new Array(HEADERS.length).fill("");

  let memo = {};
  try { memo = JSON.parse(row[MEMO_COL_INDEX] || "{}") || {}; } catch { memo = {}; }

  if (rowObj.categoria === "kilometraje vehiculo") {
    const prev = num(row[KM_COL_INDEX]);
    row[KM_COL_INDEX] = prev + num(rowObj.km || 0);
    memo.kilometraje = memo.kilometraje || [];
    memo.kilometraje.push({ km: num(rowObj.km || 0), ts: nowDisplay() });
  } else {
    const col = MONEY_COL_INDEXES[rowObj.categoria];
    const prev = num(row[col]);
    row[col] = prev + num(rowObj.monto || 0);
    memo[rowObj.categoria] = memo[rowObj.categoria] || [];
    memo[rowObj.categoria].push({ monto: num(rowObj.monto || 0), detalle: rowObj.detalle || "", factura: rowObj.factura || "", ts: nowDisplay() });
  }

  const detallePrev = String(row[2] || "");
  const facturaPrev = String(row[3] || "");
  if (rowObj.detalle) row[2] = detallePrev ? `${detallePrev} | ${rowObj.detalle}` : rowObj.detalle;
  if (rowObj.factura) row[3] = facturaPrev ? `${facturaPrev} | ${rowObj.factura}` : rowObj.factura;

  let total = 0;
  for (const colIdx of Object.values(MONEY_COL_INDEXES)) total += num(row[colIdx]);
  row[13] = total;

  row[MEMO_COL_INDEX] = JSON.stringify(memo);

  await sheets.spreadsheets.values.update({ spreadsheetId, range: rowRange, valueInputOption: "RAW", requestBody: { values: [row] } });

  return { id: row[0], fecha: row[1] };
}

export async function todayTotalFor(hoja) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  const today = todayISODate();
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${hoja}!A2:O100000` });
  const rows = r.data.values || [];
  for (const row of rows) {
    const fecha = row[1] || "";
    if (String(fecha).slice(0, 10) === today) return num(row[13] || 0);
  }
  return 0;
}

export async function todaySummary(hoja) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  const today = todayISODate();
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${hoja}!A2:O100000` });
  const rows = r.data.values || [];
  let row = null;
  for (const x of rows) { if (String(x[1] || "").slice(0, 10) === today) { row = x; break; } }
  if (!row) return "No hay registros hoy.";
  let memo = {};
  try { memo = JSON.parse(row[MEMO_COL_INDEX] || "{}") || {}; } catch { memo = {}; }
  const parts = [];
  if (Array.isArray(memo.kilometraje) && memo.kilometraje.length) {
    const sumKm = memo.kilometraje.reduce((a,b)=>a+num(b.km),0);
    parts.push(`• Kilometraje: ${sumKm} km`);
  }
  for (const k of Object.keys(MONEY_COL_INDEXES)) {
    const arr = memo[k] || [];
    if (!arr.length) continue;
    const total = arr.reduce((a,b)=>a+num(b.monto),0);
    const lines = arr.map(e=>`   - ${e.detalle ? e.detalle+" " : ""}${e.factura ? `(Fac ${e.factura}) ` : ""}Bs ${e.monto.toFixed(2)}`);
    parts.push(`• ${k[0].toUpperCase()+k.slice(1)}: Bs ${total.toFixed(2)}\n${lines.join("\n")}`);
  }
  const tot = num(row[13] || 0);
  parts.push(`• Total del día: Bs ${tot.toFixed(2)}`);
  return parts.join("\n");
}
