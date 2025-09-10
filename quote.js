// quote.js — generación y envío de cotización en PDF (sin memoria persistente + control de concurrencia)
import fs from 'fs';
import path from 'path';
import { buildQuoteFromSession } from './quote-engine.js';
import { renderQuotePDF } from './quote-pdf.js';

// ===== ENV =====
const WA_TOKEN       = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID    = process.env.WHATSAPP_PHONE_ID || '';
const QUOTES_DIR     = path.resolve('./data/quotes');
const MAX_CONCURRENCY= parseInt(process.env.QUOTE_MAX_CONCURRENCY || '3', 10); // 2–3 simultáneamente
const DELETE_AFTER_MS= parseInt(process.env.QUOTE_DELETE_AFTER_MS || (10 * 60 * 1000), 10); // borrar PDF tras 10 min
const MAX_FILE_AGE_MS= parseInt(process.env.QUOTE_MAX_FILE_AGE_MS || (2 * 60 * 60 * 1000), 10); // limpieza de respaldo: 2h
const MAX_FILES_KEEP = parseInt(process.env.QUOTE_MAX_FILES_KEEP || '200', 10); // límite suave por si acumula

try { fs.mkdirSync(QUOTES_DIR, { recursive:true }); } catch {}

// ===== Util =====
function cleanName(s = '') {
  return String(s)
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// Concurrencia simple (semáforo en memoria)
let _active = 0;
const _waiters = [];
function _acquire() {
  if (_active < MAX_CONCURRENCY) { _active++; return Promise.resolve(); }
  return new Promise(resolve => _waiters.push(resolve));
}
function _release() {
  _active = Math.max(0, _active - 1);
  const next = _waiters.shift();
  if (next) { _active++; next(); }
}

// Limpieza periódica (archivos viejos o exceso de archivos)
function _cleanupOldQuotes() {
  try{
    const files = fs.readdirSync(QUOTES_DIR)
      .filter(f => f.toLowerCase().endsWith('.pdf'))
      .map(f => {
        const p = path.join(QUOTES_DIR, f);
        const st = fs.statSync(p);
        return { p, f, mtime: st.mtimeMs, birth: st.birthtimeMs, size: st.size };
      })
      .sort((a,b)=> (a.mtime - b.mtime)); // más antiguos primero

    const now = Date.now();
    for (const it of files) {
      if (now - (it.mtime || it.birth || now) > MAX_FILE_AGE_MS) {
        try { fs.unlinkSync(it.p); } catch {}
      }
    }

    // Re-listar tras borrar por edad
    const left = fs.readdirSync(QUOTES_DIR).filter(f => f.toLowerCase().endsWith('.pdf')).sort();
    const overflow = left.length - MAX_FILES_KEEP;
    if (overflow > 0) {
      // eliminar los más antiguos extra
      const toDrop = fs.readdirSync(QUOTES_DIR)
        .filter(f => f.toLowerCase().endsWith('.pdf'))
        .map(f => {
          const p = path.join(QUOTES_DIR, f);
          const st = fs.statSync(p);
          return { p, mtime: st.mtimeMs };
        })
        .sort((a,b)=> (a.mtime - b.mtime))
        .slice(0, overflow);
      for (const it of toDrop) { try { fs.unlinkSync(it.p); } catch {} }
    }
  }catch(e){
    // silencioso
  }
}
setInterval(_cleanupOldQuotes, 30 * 60 * 1000).unref(); // cada 30 min

async function waUploadMediaFromFile(filePath, mime='application/pdf'){
  if (!WA_TOKEN || !WA_PHONE_ID) throw new Error('Faltan credenciales de WhatsApp (WHATSAPP_TOKEN / WHATSAPP_PHONE_ID).');

  const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(WA_PHONE_ID)}/media`;
  const buf = fs.readFileSync(filePath);
  const blob = new Blob([buf], { type: mime });

  const form = new FormData();
  form.append('file', blob, path.basename(filePath));
  form.append('type', mime);
  form.append('messaging_product', 'whatsapp');

  const r = await fetch(url, { method:'POST', headers:{ 'Authorization':`Bearer ${WA_TOKEN}` }, body: form });
  if (!r.ok){
    const t = await r.text().catch(()=> '');
    console.error('upload error', r.status, t);
    return null;
  }
  const j = await r.json().catch(()=>null);
  return j?.id || null;
}

async function waSendDocument(to, mediaId, filename, caption=''){
  if (!WA_TOKEN || !WA_PHONE_ID) throw new Error('Faltan credenciales de WhatsApp (WHATSAPP_TOKEN / WHATSAPP_PHONE_ID).');

  const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(WA_PHONE_ID)}/messages`;
  const payload = {
    messaging_product:'whatsapp',
    to,
    type:'document',
    document: { id: mediaId, filename, caption }
  };
  const r = await fetch(url, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${WA_TOKEN}`,'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok){
    console.error('send doc error', r.status, await r.text().catch(()=>''), 'payload=', JSON.stringify(payload).slice(0,400));
    return false;
  }
  return true;
}

/**
 * Genera y envía un PDF de cotización por WhatsApp.
 * - Sin memoria persistente: se programa borrado del archivo y hay limpieza periódica.
 * - Con control de concurrencia: máx. 2–3 procesos simultáneos (configurable).
 *
 * @param {string} to - Número destino (WhatsApp).
 * @param {object} session - Objeto de sesión/estado.
 * @returns {Promise<{ok:boolean, mediaId:string|null, path:string, filename:string, caption:string, quoteId?:string}>}
 */
export async function sendAutoQuotePDF(to, session){
  await _acquire();
  try{
    const quote = buildQuoteFromSession(session);
    const clienteName = cleanName(quote?.cliente?.nombre || session?.profileName || 'Cliente');

    // nombre de archivo seguro y (casi) único
    const stamp = new Date().toISOString().replace(/[:.]/g,'-'); // 2025-09-09T12-34-56-789Z
    const filename = `${cleanName(`COT - ${clienteName} - ${stamp}`)}.pdf`;
    const filePath = path.join(QUOTES_DIR, filename);

    // Render PDF
    await renderQuotePDF(quote, filePath, {
      brand: 'New Chem Agroquímicos',
      tel:   '',
      dir:   ''
    });

    // Subir a WhatsApp
    const mediaId = await waUploadMediaFromFile(filePath, 'application/pdf');
    if (!mediaId) throw new Error('No se pudo subir el PDF a WhatsApp.');

    // Enviar documento
    const caption = `Cotización - ${clienteName}`;
    const ok = await waSendDocument(to, mediaId, filename, caption);
    if (!ok) throw new Error('No se pudo enviar el PDF por WhatsApp.');

    // Programar borrado del archivo local (sin memoria persistente)
    if (DELETE_AFTER_MS > 0) {
      setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, DELETE_AFTER_MS).unref?.();
    }

    return {
      ok: true,
      mediaId,
      path: filePath,
      filename,
      caption,
      quoteId: quote?.id
    };
  } finally {
    _release();
  }
}
