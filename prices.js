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
const BK_DIR     = path.resolve('./knowledge/backups');
fs.mkdirSync(BK_DIR, { recursive: true });

function loadPrices(){
  try { return JSON.parse(fs.readFileSync(PRICE_PATH,'utf8')); }
  catch { return []; }
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

// ===== GET: leer precios (con versión) =====
router.get('/admin/prices', agentAuth, (_req,res)=>{
  res.json({ prices: loadPrices(), version: fileVersion() });
});

// ===== PUT: guardar precios =====
router.put('/admin/prices', agentAuth, (req,res)=>{
  const { prices, version } = req.body || {};
  if (!Array.isArray(prices)) return res.status(400).json({ error:'bad_request', detail:'prices debe ser array' });

  // control de versión para evitar pisadas
  const current = fileVersion();
  if (version && version !== current){
    return res.status(409).json({ error:'version_conflict', currentVersion: current });
  }

  // sanitizar + validar
  const seen = new Set();
  const clean = [];
  for (const row of prices){
    const sku = String(row?.sku||'').trim();
    if (!sku) return res.status(400).json({ error:'bad_row', detail:'SKU vacío' });
    if (seen.has(sku)) return res.status(400).json({ error:'dup_sku', detail:`SKU duplicado: ${sku}` });
    seen.add(sku);

    const unidad = String(row?.unidad||'').trim(); // libre (L, KG, UNID, etc.)
    const usd = Number(row?.precio_usd ?? 0);
    const bs  = Number(row?.precio_bs  ?? 0);
    if (usd < 0 || bs < 0) return res.status(400).json({ error:'bad_price', detail:`Precios negativos en ${sku}` });

    clean.push({
      sku,
      unidad,
      precio_usd: Number.isFinite(usd) ? +usd.toFixed(2) : 0,
      precio_bs:  Number.isFinite(bs)  ? +bs.toFixed(2)  : 0
    });
  }

  // ordenar por SKU para consistencia
  clean.sort((a,b)=> a.sku.localeCompare(b.sku));

  // backup antes de escribir (si existe archivo previo)
  try{
    if (fs.existsSync(PRICE_PATH)){
      const stamp = new Date().toISOString().replace(/[:\.]/g,'-');
      fs.writeFileSync(path.join(BK_DIR, `prices-${stamp}.json`), fs.readFileSync(PRICE_PATH));
    }
  }catch{}

  // escritura atómica
  writeAtomic(PRICE_PATH, JSON.stringify(clean, null, 2));
  return res.json({ ok:true, version: fileVersion() });
});

export default router;
