// inbox-backup.js
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';

// Estructura en memoria
export const STORE = {
  convos: new Map(),   // id -> { id, name, last, unread, human }
  messages: new Map(), // id -> [ { role, content, ts } ]
};

// Normalizadores
const normId = v => String(v ?? '').trim();
const normStr = v => (v==null ? '' : String(v)).trim();

// Elige la Hoja 3: por nombre “Hoja 3” / “Hoja3” (case/espacios-insensible) o índice 2
function pickSheetName(workbook){
  const names = workbook.SheetNames || [];
  if (!names.length) return null;

  const target = names.find(n => normStr(n).replace(/\s+/g,'').toLowerCase() === 'hoja3');
  if (target) return target;

  // Si hay >= 3 hojas, toma índice 2
  if (names.length >= 3) return names[2];

  // fallback: la única hoja
  return names[0];
}

// Convierte Excel date (Date / serial) o string a timestamp ms
function toTs(v){
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number'){
    // ¿Es serial de Excel?
    // 25569 es epoch 1970-01-01 en Excel 1900-date system
    if (v > 20000 && v < 60000) {
      const utcDays = Math.floor(v - 25569);
      const utcValue = utcDays * 86400; // seg
      const fract = v - Math.floor(v);
      const secs = Math.round(fract * 86400);
      return (utcValue + secs) * 1000;
    }
    // ¿ya es epoch ms?
    if (v > 1e11) return v;
    // ¿epoch s?
    if (v > 1e9) return v*1000;
  }
  if (typeof v === 'string'){
    const s = v.trim();
    // Formato típico dd/mm/yyyy hh:mm (o solo fecha)
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m){
      const d = parseInt(m[1],10), mo = parseInt(m[2],10)-1, y = parseInt(m[3].length===2 ? '20'+m[3] : m[3], 10);
      const hh = parseInt(m[4]||'0',10), mm = parseInt(m[5]||'0',10), ss=parseInt(m[6]||'0',10);
      return new Date(y, mo, d, hh, mm, ss).getTime();
    }
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

// Determina columnas posibles (flexibles)
function detectColumns(headerRow){
  const H = headerRow.map(h => normStr(h).toLowerCase());

  const find = (...alts) => {
    const idx = H.findIndex(h => alts.some(a => h === a || h.includes(a)));
    return idx >= 0 ? idx : -1;
  };

  return {
    id:       find('id','chat_id','whatsapp','telefono','nro','num'),
    name:     find('name','nombre','contacto','cliente'),
    role:     find('role','rol','tipo'),
    content:  find('content','mensaje','msg','texto','text'),
    ts:       find('ts','fecha','timestamp','hora','date','datetime'),
    human:    find('human','humano','atendido_por_humano'),
    unread:   find('unread','no_leidos','pendientes'),
    last:     find('last','ultimo','resumen'),
  };
}

function massageRole(v){
  const s = normStr(v).toLowerCase();
  if (s === 'usuario' || s === 'user' || s === 'cliente') return 'user';
  if (s === 'bot' || s === 'assistant' || s === 'ia') return 'bot';
  if (s === 'agente' || s === 'asesor' || s === 'agent' || s === 'humano') return 'agent';
  if (s === 'sistema' || s === 'system' || s === 'sys') return 'sys';
  return s || 'user';
}

function pushMsg(id, role, content, ts){
  const k = normId(id); if (!k) return;
  const arr = STORE.messages.get(k) || [];
  arr.push({ role: massageRole(role), content: normStr(content), ts: toTs(ts) });
  STORE.messages.set(k, arr);
}

function upsertConvo(id, name, human=false, unread=0, last=''){
  const k = normId(id); if (!k) return;
  const prev = STORE.convos.get(k) || { id:k, name:k, last:'', unread:0, human:false };
  const c = {
    id: k,
    name: normStr(name) || prev.name || k,
    human: !!(human ?? prev.human),
    unread: Number.isFinite(unread) ? unread : (prev.unread||0),
    last: normStr(last) || prev.last || '',
  };
  STORE.convos.set(k, c);
}

export function importFromExcel(filePath){
  const fp = path.resolve(filePath);
  if (!fs.existsSync(fp)) throw new Error(`No existe: ${fp}`);

  const wb = XLSX.readFile(fp, { cellDates: true });
  const sheetName = pickSheetName(wb);
  if (!sheetName) throw new Error('No pude encontrar Hoja 3 en el archivo.');

  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });

  if (!rows.length) return { convos: [] };

  const header = rows[0];
  const idx = detectColumns(header);

  // Si faltan columnas clave, igual intentamos mapear con lo disponible
  const body = rows.slice(1);

  // Limpia actuales (opcional). Aquí MERGEA: borra y repuebla
  STORE.convos.clear();
  STORE.messages.clear();

  for (const r of body){
    // tolera filas cortas
    const get = i => (i>=0 && i<r.length) ? r[i] : '';

    const id   = get(idx.id);
    const name = get(idx.name);
    const role = get(idx.role);
    const text = get(idx.content);
    const tsv  = get(idx.ts);
    const human = String(get(idx.human)||'').toLowerCase() === 'true';
    const unread = Number(get(idx.unread)||0);
    const last   = get(idx.last);

    if (!id && !text) continue; // fila vacía

    upsertConvo(id, name, human, unread, last);
    if (text) pushMsg(id, role||'user', text, tsv||Date.now());
  }

  // Post-proceso: ordenar mensajes y setear "last"
  for (const [id, arr] of STORE.messages.entries()){
    arr.sort((a,b)=> (a.ts||0)-(b.ts||0));
    STORE.messages.set(id, arr);

    const lastMsg = arr[arr.length-1];
    const convo = STORE.convos.get(id) || { id, name:id, human:false, unread:0, last:'' };
    if (!convo.last && lastMsg) convo.last = lastMsg.content || '';
    STORE.convos.set(id, convo);
  }

  return { convos: Array.from(STORE.convos.values()) };
}

export function seedFromExcelIfEmpty(){
  if (STORE.convos.size || STORE.messages.size) return; // ya hay datos
  const fromEnv = process.env.INBOX_XLSX;
  const def = path.resolve('./backups/inbox.xlsx');

  const candidate = fromEnv ? path.resolve(fromEnv) : def;
  if (!fs.existsSync(candidate)){
    console.warn('[inbox-backup] No hay archivo para seed:', candidate);
    return;
    }
  try{
    const { convos } = importFromExcel(candidate);
    console.log(`[inbox-backup] Seed OK desde ${candidate} — ${convos.length} chats.`);
  }catch(err){
    console.error('[inbox-backup] Error seed:', err?.message||err);
  }
}
