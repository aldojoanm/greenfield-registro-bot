// prices.js
import express from 'express';
import fs from 'fs';
import path from 'path';

const router = express.Router();
router.use(express.json());

const AGENT_TOKEN = process.env.AGENT_TOKEN || '';

function agentAuth(req, res, next){
  const header = req.headers.authorization || '';
  const bearer = header.replace(/^Bearer\s+/i,'').trim();
  const token  = bearer || String(req.query.token||'');
  if(!AGENT_TOKEN || token !== AGENT_TOKEN) return res.sendStatus(401);
  next();
}

const PRICE_PATH = path.resolve('./knowledge/prices.json');
const RATE_PATH  = path.resolve('./knowledge/rate.json');
const BK_DIR     = path.resolve('./knowledge/backups');
fs.mkdirSync(BK_DIR, { recursive: true });

function loadPrices(){
  try { return JSON.parse(fs.readFileSync(PRICE_PATH,'utf8')); }
  catch { return []; }
}
function loadRate(){
  try {
    const j = JSON.parse(fs.readFileSync(RATE_PATH,'utf8'));
    return Number(j?.rate) || 6.96;
  } catch { return 6.96; }
}
function fileVersion(){
  try { return String(fs.statSync(PRICE_PATH).mtimeMs|0); }
  catch { return '0'; }
}
function writeAtomic(p, data){
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}

/* ===== Normalización canónica ===== */
function canonSKU(s=''){
  return String(s||'')
    .trim()
    .toUpperCase()
    .replace(/\s+/g,'')               // "5 L" -> "5L"
    .replace(/LTS?|LT|LITROS?/g,'L')  // LTS/LT/LITROS -> L
    .replace(/KGS?|KILOS?/g,'KG');    // KGS/KILOS -> KG
}
function canonUnidad(u=''){
  const t = String(u||'').trim().toUpperCase();
  if (/^KG|KILO/.test(t)) return 'KG';
  if (/^L|LT|LTS|LITRO/.test(t)) return 'L';
  if (/^UNID|UND|UNIDAD/.test(t)) return 'UNID';
  return t || '';
}
function canonCategoria(c=''){
  const t = String(c||'').toLowerCase();
  return ['herbicida','insecticida','fungicida'].includes(t) ? t : 'herbicida';
}
function to2(n){ return Number.isFinite(n) ? +Number(n).toFixed(2) : 0; }

/* ===== GET: leer precios (con versión) ===== */
router.get('/admin/prices', agentAuth, (_req,res)=>{
  res.json({ prices: loadPrices(), version: fileVersion() });
});

/* ===== PUT: guardar precios (normalizado) ===== */
router.put('/admin/prices', agentAuth, (req,res)=>{
  const { prices, version } = req.body || {};
  if (!Array.isArray(prices)) {
    return res.status(400).json({ error:'bad_request', detail:'prices debe ser array' });
  }

  // control de versión para evitar pisadas
  const current = fileVersion();
  if (version && version !== current){
    return res.status(409).json({ error:'version_conflict', currentVersion: current });
  }

  const orderCat = { herbicida:0, insecticida:1, fungicida:2 };

  // sanitizar + **normalizar**
  const seen = new Set();
  const clean = [];
  for (const row of prices){
    const rawSku = String(row?.sku||'').trim();
    if (!rawSku) return res.status(400).json({ error:'bad_row', detail:'SKU vacío' });

    const sku     = canonSKU(rawSku);                // <— clave
    const unidad  = canonUnidad(row?.unidad || '');  // <— clave
    const usd     = Number(row?.precio_usd ?? 0);
    const bs      = Number(row?.precio_bs  ?? 0);
    if (usd < 0 || bs < 0) {
      return res.status(400).json({ error:'bad_price', detail:`Precios negativos en ${rawSku}` });
    }

    // duplicados después de normalizar
    if (seen.has(sku)) {
      return res.status(400).json({ error:'dup_sku', detail:`SKU duplicado tras normalizar: ${sku}` });
    }
    seen.add(sku);

    const categoria = canonCategoria(row?.categoria);

    clean.push({
      categoria,
      sku,
      unidad,
      precio_usd: to2(usd),
      precio_bs:  to2(bs)     // el editor recalcula en pantalla; guardamos como referencia
    });
  }

  // ordenar por categoría y luego por SKU
  clean.sort((a,b)=>{
    const ca = orderCat[a.categoria] ?? 9;
    const cb = orderCat[b.categoria] ?? 9;
    return ca - cb || a.sku.localeCompare(b.sku);
  });

  // backup antes de escribir
  try{
    if (fs.existsSync(PRICE_PATH)){
      const stamp = new Date().toISOString().replace(/[:\.]/g,'-');
      fs.writeFileSync(path.join(BK_DIR, `prices-${stamp}.json`), fs.readFileSync(PRICE_PATH));
    }
  }catch{}

  writeAtomic(PRICE_PATH, JSON.stringify(clean, null, 2));
  return res.json({ ok:true, version: fileVersion() });
});

/* ===== TC (rate) ===== */
router.get('/admin/rate', agentAuth, (_req,res)=>{
  res.json({ rate: loadRate() });
});
router.put('/admin/rate', agentAuth, (req,res)=>{
  const rate = Number(req.body?.rate);
  if (!Number.isFinite(rate) || rate <= 0) return res.status(400).json({ error:'bad_rate' });
  writeAtomic(RATE_PATH, JSON.stringify({ rate: +rate.toFixed(4) }, null, 2));
  res.json({ ok:true, rate: +rate.toFixed(4) });
});

export default router;
