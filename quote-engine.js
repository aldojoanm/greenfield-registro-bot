// quote-engine.js
import fs from 'fs';
import path from 'path';

const PRICE_PATH = path.resolve('./knowledge/prices.json');
const RATE_PATH  = path.resolve('./knowledge/rate.json');
const CATALOG    = readJSON('./knowledge/catalog.json');

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(path.resolve(p),'utf8')); }
  catch { return Array.isArray ? [] : {}; }
}

function loadPricesMap(){
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(PRICE_PATH,'utf8')); } catch {}
  const map = new Map();
  for (const r of arr) map.set(String(r.sku).trim(), r);
  return map;
}

function loadRate(){
  try {
    const j = JSON.parse(fs.readFileSync(RATE_PATH,'utf8'));
    const r = Number(j?.rate);
    if (Number.isFinite(r) && r > 0) return r;
  } catch {}
  // fallback
  return Number(process.env.USD_BOB_RATE || '6.96');
}

function normalizeUnit(u=''){
  const t = String(u).toLowerCase();
  if (/^kg|kilo/.test(t)) return 'KG';
  if (/^l|lt|litro/.test(t)) return 'L';
  if (/^unid|und|unidad/.test(t)) return 'UNID';
  return (t || '').toUpperCase() || '';
}

function parseQtyUnit(qtyText=''){
  const t = String(qtyText||'').toLowerCase();
  const m = t.match(/([\d.,]+)/);
  const q = m ? parseFloat(m[1].replace(',','.')) : 0;
  let u = 'UNID';
  if (/kg|kilo/.test(t)) u = 'KG';
  else if (/\b(l|lt|litro)s?\b/.test(t)) u = 'L';
  else if (/uni|und/.test(t)) u = 'UNID';
  return { qty: Number.isFinite(q) ? q : 0, unit: u };
}

function findCatalogBySKUorName(sku, name){
  const s = String(sku||'');
  let prod = CATALOG.find(p => String(p.sku) === s);
  if (!prod && name){
    const n = String(name).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
    prod = CATALOG.find(p => String(p.nombre||'').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'') === n);
  }
  return prod || {};
}

function asMoney(n){
  const x = Number(n||0);
  return Math.round(x * 100) / 100;
}

export function buildQuoteFromSession(s, opts={}){
  const prices = loadPricesMap();
  const rate   = loadRate(); // <= TC desde archivo (o env)
  const now    = new Date();

  // Datos del cliente
  const nombre   = s.profileName || 'Cliente';
  const dep      = s?.vars?.departamento || 'ND';
  const zona     = s?.vars?.subzona || 'ND';
  const cultivo  = (s?.vars?.cultivos||[])[0] || 'ND';
  const ha       = s?.vars?.hectareas || 'ND';
  const campana  = s?.vars?.campana || 'ND';

  // Productos (carrito o último producto)
  const itemsRaw = (s?.vars?.cart && s.vars.cart.length)
    ? s.vars.cart
    : (s?.vars?.last_sku && s?.vars?.cantidad ? [{
        sku: s.vars.last_sku,
        nombre: s.vars.last_product,
        presentacion: s.vars.last_presentacion,
        cantidad: s.vars.cantidad
      }] : []);

  const items = [];
  for (const it of itemsRaw){
    const sku    = String(it?.sku||'').trim();
    const nombreP= it?.nombre || '';
    const pres   = it?.presentacion || '';
    const qtyInf = parseQtyUnit(it?.cantidad || '');
    const price  = prices.get(sku) || {};
    const prod   = findCatalogBySKUorName(sku, nombreP);

    let unit      = normalizeUnit(price?.unidad || qtyInf.unit || '');
    let pUSD      = Number(price?.precio_usd||0);
    if (!pUSD && Number(price?.precio_bs||0)) pUSD = Number(price.precio_bs)/rate;

    const line = {
      sku,
      nombre: nombreP || prod?.nombre || sku || '-',
      ingrediente_activo: prod?.ingrediente_activo || prod?.formulacion || '',
      envase: pres || (Array.isArray(prod?.presentaciones) ? prod.presentaciones.join(', ') : ''),
      unidad: unit || 'UNID',
      cantidad: qtyInf.qty || 0,
      precio_usd: asMoney(pUSD),
      subtotal_usd: asMoney((qtyInf.qty || 0) * (pUSD || 0))
    };
    items.push(line);
  }

  const subtotal = asMoney(items.reduce((a,b)=>a+(b.subtotal_usd||0),0));
  const total    = subtotal;

  return {
    id: `COT-${Date.now()}`,
    fecha: now,
    rate,                // <= se envía a renderQuotePDF
    cliente: { nombre, departamento:dep, zona, cultivo, hectareas:ha, campana },
    items,
    subtotal_usd: subtotal,
    total_usd: total,
    min_order_usd: 3000,
    moneda: 'USD'
  };
}
