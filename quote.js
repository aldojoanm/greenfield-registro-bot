// quote.js
import fs from 'fs';
import path from 'path';
import { buildQuoteFromSession } from './quote-engine.js';
import { renderQuotePDF } from './quote-pdf.js';

const WA_TOKEN    = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const QUOTES_DIR  = path.resolve('./data/quotes');
try { fs.mkdirSync(QUOTES_DIR, { recursive:true }); } catch {}

async function waUploadMediaFromFile(filePath, mime='application/pdf'){
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

export async function sendAutoQuotePDF(to, session){
  // 1) Datos
  const quote = buildQuoteFromSession(session);

  // 2) PDF
  const fname = `${quote.id}.pdf`;
  const fpath = path.join(QUOTES_DIR, fname);
  await renderQuotePDF(quote, fpath, {
    brand: 'New Chem Agroquímicos',
    tel:   '',
    dir:   ''
  });

  // 3) Subir + enviar
  const mediaId = await waUploadMediaFromFile(fpath, 'application/pdf');
  if (!mediaId) throw new Error('No se pudo subir el PDF a WhatsApp.');
  const ok = await waSendDocument(to, mediaId, fname, 'Tu cotización en PDF');
  if (!ok) throw new Error('No se pudo enviar el PDF por WhatsApp.');

  return { ok:true, file: fpath, id: quote.id };
}
