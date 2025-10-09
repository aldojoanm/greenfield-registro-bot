// sheets.js
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

export const HEADERS = ["id", "fecha", "detalle", "factura-recibo", "combustible", "kilometraje vehiculo", "alimentacion", "hospedaje", "peajes", "aceites", "llantas", "frenos", "otros", "totales"];

const MONEY_COL_INDEXES = { combustible: 4, alimentacion: 6, hospedaje: 7, peajes: 8, aceites: 9, llantas: 10, frenos: 11, otros: 12 };
const KM_COL_INDEX = 5;

function canonSheetName(name = "") { return String(name || "Empleado").trim().slice(0, 99); }

export async function ensureEmployeeSheet(empleadoNombre) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("Falta SHEETS_SPREADSHEET_ID");
  const title = canonSheetName(empleadoNombre);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title } } }] } });
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `${title}!A1:N1`, valueInputOption: "RAW", requestBody: { values: [HEADERS] } });
  }
  return title;
}

export async function getNextId(hoja) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${hoja}!A:A` });
  const rows = r.data.values || [];
  if (rows.length <= 1) return 1;
  const last = rows.slice(1).map((x) => Number(x?.[0] || 0)).filter((n) => Number.isFinite(n));
  return last.length ? Math.max(...last) + 1 : 1;
}

export async function appendExpenseRow(hoja, rowObj) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  const id = await getNextId(hoja);
  const fecha = nowDisplay();
  const row = new Array(HEADERS.length).fill("");
  row[0] = id;
  row[1] = fecha;
  row[2] = rowObj.detalle || "";
  row[3] = rowObj.factura || "";
  if (rowObj.categoria === "kilometraje vehiculo") {
    row[KM_COL_INDEX] = Number(rowObj.km || 0);
  } else {
    const key = rowObj.categoria;
    const colIndex = MONEY_COL_INDEXES[key] ?? null;
    if (colIndex !== null) row[colIndex] = Number(rowObj.monto || 0);
  }
  const moneyCols = Object.values(MONEY_COL_INDEXES);
  const total = moneyCols.reduce((sum, colIdx) => sum + (Number(row[colIdx] || 0)), 0);
  row[13] = total;
  await sheets.spreadsheets.values.append({ spreadsheetId, range: `${hoja}!A1`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: [row] } });
  return { id, fecha, totalFila: total };
}

export async function todayTotalFor(hoja) {
  const sheets = await getSheets();
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  const today = todayISODate();
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${hoja}!A2:N100000` });
  const rows = r.data.values || [];
  let total = 0;
  for (const row of rows) {
    const fecha = row[1] || "";
    const isToday = String(fecha).slice(0, 10) === today;
    if (!isToday) continue;
    for (const colIdx of Object.values(MONEY_COL_INDEXES)) {
      const v = row[colIdx];
      const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/\s+/g, "").replace(/,/g, "."));
      total += Number.isFinite(n) ? n : 0;
    }
  }
  return total;
}
