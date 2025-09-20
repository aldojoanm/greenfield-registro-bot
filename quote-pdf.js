// quote-pdf.js
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

const TZ = process.env.TIMEZONE || 'America/La_Paz';

/* ========= Paleta / Marca =========
   Verde sobrio, gris neutro y acentos suaves
==================================== */
const BRAND = {
  primary:   '#1F7A4C', // verde principal
  dark:      '#145238', // verde oscuro
  accent:    '#6BBF59', // verde claro (acentos)
};

const TINT = {
  headerBG:  '#E9F4EE', // encabezado tabla
  rowBG:     '#F6FBF8', // filas tabla
  totalBG:   '#DDF0E6', // totales
};

const GRID = '#6C7A73';

/* ========= Helpers de color ========= */
function normalizeHex(s, fallback = null) {
  let v = String(s ?? '').trim();
  const m = v.match(/^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/);
  if (!m) return fallback;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
  return `#${hex.toUpperCase()}`;
}
const SAFE = {
  headerBG: normalizeHex(TINT.headerBG, '#E6E9EC'),
  rowBG:    normalizeHex(TINT.rowBG,    '#F7F9FB'),
  totalBG:  normalizeHex(TINT.totalBG,  '#E9C46A'),
  grid:     normalizeHex(GRID,          '#000000'),
};
function fillRect(doc, x, y, w, h, color) {
  doc.save();
  doc.fillColor(color);
  doc.rect(x, y, w, h).fill();
  doc.restore();
}
function strokeRect(doc, x, y, w, h, color = SAFE.grid, width = 0.9) {
  doc.save();
  doc.strokeColor(color).lineWidth(width);
  doc.rect(x, y, w, h).stroke();
  doc.restore();
}

/* ========= Helpers de formato ========= */
function fmtDateTZ(date = new Date(), tz = TZ) {
  try {
    return new Intl.DateTimeFormat('es-BO', {
      timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric'
    }).format(date);
  } catch {
    const d = new Date(date);
    const pad = n => String(n).padStart(2,'0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
  }
}
function money(n){
  const s = (Number(n||0)).toFixed(2);
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function round2(n){ return Math.round((Number(n)||0) * 100) / 100; }
function toCents(n){ return Math.round((Number(n)||0) * 100); }
function ensure(v, def){ return v==null || v==='' ? def : v; }
function findAsset(...relPaths){
  for (const r of relPaths){
    const p = path.resolve(r);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/* ========= Lookup de precios / packs ========= */
function canonSku(s=''){
  return String(s||'')
    .trim()
    .toUpperCase()
    .replace(/\s+/g,'')
    .replace(/LTS?|LT|LITROS?/g,'L')
    .replace(/KGS?|KILOS?/g,'KG');
}
function normName(s=''){
  return String(s||'')
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .replace(/[^A-Z0-9]/gi,'')
    .toUpperCase();
}
function parsePackFromText(t=''){
  const m = String(t||'').match(/(\d+(?:[.,]\d+)?)\s*(L|LT|LTS|LITROS?|KG|KGS?|KILOS?)/i);
  if (!m) return null;
  const size = parseFloat(m[1].replace(',','.'));
  const unit = /KG|KGS?|KILOS?/i.test(m[2]) ? 'KG' : 'L';
  if (!Number.isFinite(size) || size<=0) return null;
  return { size, unit };
}
function splitSku(s=''){
  const raw = String(s||'').trim();
  const i = raw.lastIndexOf('-');
  if (i < 0) return { base: raw, pack: null, canon: canonSku(raw) };
  const base = raw.slice(0, i);
  const tail = raw.slice(i+1);
  const pack = parsePackFromText(tail) || parsePackFromText('-'+tail) || parsePackFromText(tail.replace(/-/g,' '));
  return { base, pack, canon: canonSku(raw) };
}
function lookupFromCatalog(priceList=[], item={}){
  if (!Array.isArray(priceList) || !priceList.length) return 0;
  const cs = canonSku(item.sku||'');
  let row = priceList.find(r => canonSku(r.sku||'') === cs);
  if (!row && item.nombre && item.envase){
    const cs2 = canonSku(`${item.nombre}-${item.envase}`);
    row = priceList.find(r => canonSku(r.sku||'') === cs2);
  }
  if (!row){
    const nm = String(item.nombre||'').trim() || splitSku(String(item.sku||'')).base;
    const pack = parsePackFromText(String(item.envase||'')) || splitSku(String(item.sku||'')).pack;
    if (nm && pack){
      const nn = normName(nm);
      row = priceList.find(r=>{
        const { base, pack: p2 } = splitSku(String(r.sku||''));
        return base && p2 && normName(base)===nn && p2.unit===pack.unit && Math.abs(p2.size-pack.size)<1e-9;
      });
    }
  }
  if (!row) return 0;
  const usd = Number(row?.precio_usd||0);
  return Number.isFinite(usd) ? usd : 0;
}
function detectPackSize(it = {}){
  if (it.envase) {
    const m = String(it.envase).match(/(\d+(?:[.,]\d+)?)\s*(l|lt|lts|litros?|kg|kilos?)/i);
    if (m) {
      const size = parseFloat(m[1].replace(',','.'));
      const unit = /kg/i.test(m[2]) ? 'KG' : 'L';
      if (!isNaN(size) && size > 0) return { size, unit };
    }
  }
  if (it.sku) {
    const m = String(it.sku).match(/-(\d+(?:\.\d+)?)(?:\s?)(l|kg)\b/i);
    if (m) {
      const size = parseFloat(m[1]);
      const unit = m[2].toUpperCase();
      if (!isNaN(size) && size > 0) return { size, unit };
    }
  }
  if (it.nombre) {
    const m = String(it.nombre).match(/(\d+(?:[.,]\d+)?)\s*(l|lt|lts|kg)\b/i);
    if (m) {
      const size = parseFloat(m[1].replace(',','.'));
      const unit = /kg/i.test(m[2]) ? 'KG' : 'L';
      if (!isNaN(size) && size > 0) return { size, unit };
    }
  }
  return null;
}
function roundQuantityByPack(originalQty, pack, itemUnitRaw){
  if (!pack || !(originalQty > 0)) return originalQty;
  const itemUnit = String(itemUnitRaw || '').toUpperCase();
  if (itemUnit && itemUnit !== pack.unit) return originalQty;
  const ratio = originalQty / pack.size;
  if (pack.unit === 'KG' && Math.abs(pack.size - 1) < 1e-9) return originalQty; // 1 Kg no redondea
  if (pack.unit === 'L' && pack.size >= 200) {
    if (ratio < 1) return pack.size;
    const mult = Math.floor(ratio + 1e-9);
    return mult * pack.size;
  }
  const mult = Math.ceil(ratio - 1e-9);
  return mult * pack.size;
}

/* ========= Render PDF ========= */
export async function renderQuotePDF(quote, outPath, company = {}){
  const dir = path.dirname(outPath);
  try{ fs.mkdirSync(dir, { recursive:true }); }catch{}

  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const xMargin = 36;
  const usableW = pageW - xMargin*2;

  // Assets (logo nuevo)
  const logoPath = company.logoPath
    || findAsset('./public/GREENFIELD-REDONDO.png', './GREENFIELD-REDONDO.png', './image/GREENFIELD-REDONDO.png');

  // Marca de agua con el logo
  if (logoPath){
    doc.save();
    doc.opacity(0.08);
    const mw = 420;
    const mx = (pageW - mw) / 2;
    const my = (pageH - mw*0.45) / 2;
    try { doc.image(logoPath, mx, my, { width: mw }); } catch {}
    doc.restore();
  }

  // Header superior
  let y = 32;
  if (logoPath){
    try { doc.image(logoPath, xMargin, y, { width: 120 }); } catch {}
  }
  doc.font('Helvetica-Bold').fontSize(14).fillColor(BRAND.dark).text('COTIZACIÓN', 0, y+10, { align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor('#4B5563')
     .text(fmtDateTZ(quote.fecha || new Date(), TZ), 0, y+14, { align: 'right' })
     .fillColor('black');

  y = 100;

  // Cliente
  const c = quote.cliente || {};
  const L = (label, val) => {
    doc.font('Helvetica-Bold').fillColor(BRAND.dark).text(`${label}: `, xMargin, y, { continued: true });
    doc.font('Helvetica').fillColor('#111').text(ensure(val,'-'));
    y += 16;
  };
  L('Cliente', c.nombre);
  L('Departamento', c.departamento);
  L('Zona', c.zona);
  L('Pago', 'Contado');

  y += 16;

  /* ===== Tabla (sin Ingrediente Activo) ===== */
  const rate = Number(process.env.USD_BOB_RATE || quote.rate || 6.96);

  const cols = [
    { key:'nombre',       label:'Producto',      w:140, align:'left'  },
    { key:'envase',       label:'Envase',        w:70,  align:'left'  },
    { key:'cantidad',     label:'Cantidad',      w:70,  align:'right' },
    { key:'precio_usd',   label:'Precio (USD)',  w:90,  align:'right' },
    { key:'precio_bs',    label:'Precio (Bs)',   w:85,  align:'right' },
    { key:'subtotal_usd', label:'Subtotal (USD)',w:90,  align:'right' },
    { key:'subtotal_bs',  label:'Subtotal (Bs)', w:90,  align:'right' },
  ];
  const tableX = xMargin;
  const tableW = cols.reduce((a,c)=>a+c.w,0);

  // Encabezado
  const headerH = 28;
  fillRect(doc, tableX, y, tableW, headerH, SAFE.headerBG);
  doc.fillColor(BRAND.dark).font('Helvetica-Bold').fontSize(9);
  {
    let cx = tableX;
    for (const cdef of cols){
      const innerX = cx + 6;
      doc.text(cdef.label, innerX, y + (headerH-10)/2, { width: cdef.w-12, align: 'center' });
      strokeRect(doc, cx, y, cdef.w, headerH, SAFE.grid, 0.9);
      cx += cdef.w;
    }
  }
  y += headerH;

  const ensureSpace = (need = 90) => {
    if (y + need > (pageH - 60)){
      doc.addPage();
      y = 42;
      if (logoPath){
        doc.save();
        doc.opacity(0.08);
        const mw = 420;
        const mx = (pageW - mw) / 2;
        const my = (pageH - mw*0.45) / 2;
        try { doc.image(logoPath, mx, my, { width: mw }); } catch {}
        doc.restore();
      }
    }
  };

  const rowPadV = 6;
  const minRowH = 20;

  doc.fontSize(9).fillColor('black');

  // Acumuladores exactos
  let accUsdCents = 0;
  let accBsCents  = 0;

  for (const itRaw of (quote.items || [])){
    // 1) Precio unitario
    let precioUSD = Number(itRaw.precio_usd || 0);
    if (!(precioUSD > 0)) {
      precioUSD = lookupFromCatalog(quote.price_catalog || company.priceList || [], itRaw) || 0;
    }
    precioUSD = round2(precioUSD);
    const precioBsUnit  = round2(precioUSD * rate);

    // 2) Cantidad (con redondeo por pack si aplica)
    const cantOrig  = Number(itRaw.cantidad || 0);
    const pack      = detectPackSize(itRaw);
    let cantidad = cantOrig;
    if (pack) cantidad = roundQuantityByPack(cantOrig, pack, itRaw.unidad);

    // 3) Subtotales
    const subUSD = round2(precioUSD   * cantidad);
    const subBs  = round2(precioBsUnit * cantidad);

    accUsdCents += toCents(subUSD);
    accBsCents  += toCents(subBs);

    const cellTexts = [
      String(itRaw.nombre || ''),
      String(itRaw.envase || ''),
      money(cantidad),
      money(precioUSD),
      money(precioBsUnit),
      money(subUSD),
      money(subBs),
    ];

    // Altura de fila
    const cellHeights = [];
    for (let i=0; i<cols.length; i++){
      const w = cols[i].w - 12;
      const h = doc.heightOfString(cellTexts[i], { width: w, align: cols[i].align || 'left' });
      cellHeights.push(Math.max(h + rowPadV*2, minRowH));
    }
    const rowH = Math.max(...cellHeights);
    ensureSpace(rowH + 10);

    // Fondo fila y bordes
    fillRect(doc, tableX, y, tableW, rowH, SAFE.rowBG);
    let tx = tableX;
    for (let i=0; i<cols.length; i++){
      const cdef = cols[i];
      const innerX = tx + 6;
      const innerW = cdef.w - 12;
      strokeRect(doc, tx, y, cdef.w, rowH, SAFE.grid, 0.8);
      doc.fillColor('#111')
         .font(cdef.key==='nombre' ? 'Helvetica-Bold' : 'Helvetica')
         .text(cellTexts[i], innerX, y + rowPadV, { width: innerW, align: cdef.align || 'left' });
      tx += cdef.w;
    }
    y += rowH;
  }

  // Totales
  const totalUSD = accUsdCents / 100;
  const totalBs  = accBsCents  / 100;

  ensureSpace(56);

  const wUntilCol5 = cols.slice(0,5).reduce((a,c)=>a+c.w,0); // hasta Precio(Bs)
  const wCol6      = cols[5].w; // Subtotal USD
  const wCol7      = cols[6].w; // Subtotal Bs

  // Separador
  doc.save();
  doc.moveTo(tableX, y).lineTo(tableX + tableW, y).strokeColor(SAFE.grid).lineWidth(0.9).stroke();
  doc.restore();

  const totalRowH = 26;

  // Celda "Total"
  strokeRect(doc, tableX, y, wUntilCol5, totalRowH, SAFE.grid, 0.9);
  doc.font('Helvetica-Bold').fillColor(BRAND.dark).text('Total', tableX, y+6, { width: wUntilCol5, align: 'center' });

  fillRect(doc, tableX + wUntilCol5, y, wCol6, totalRowH, SAFE.totalBG);
  fillRect(doc, tableX + wUntilCol5 + wCol6, y, wCol7, totalRowH, SAFE.totalBG);

  // Bordes de totales
  strokeRect(doc, tableX + wUntilCol5, y, wCol6, totalRowH, SAFE.grid, 0.9);
  strokeRect(doc, tableX + wUntilCol5 + wCol6, y, wCol7, totalRowH, SAFE.grid, 0.9);

  // Valores
  doc.font('Helvetica-Bold').fillColor(BRAND.dark)
     .text(`$ ${money(totalUSD)}`, tableX + wUntilCol5, y+6, { width: wCol6-8, align:'right' });
  doc.font('Helvetica-Bold').fillColor(BRAND.dark)
     .text(`${money(totalBs)} Bs`, tableX + wUntilCol5 + wCol6 + 6, y+6, { width: wCol7-12, align:'left' });

  y += totalRowH + 18;

  // Nota precios
  ensureSpace(24);
  doc.font('Helvetica').fontSize(9).fillColor('#374151')
     .text('Precios referenciales, sujetos a confirmación de stock y cierre comercial.', xMargin, y, { width: usableW });
  doc.fillColor('black');
  y += 22;

  /* ===== Lugar de entrega + Ubicación + Horarios ===== */
  const drawH2 = (t)=>{
    ensureSpace(24);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.dark).text(t, xMargin, y);
    doc.font('Helvetica').fontSize(10).fillColor('#111');
    y = doc.y + 12;
  };
  drawH2('Lugar de entrega');
  const entrega = [
    'Almacén Central',
    'Horarios de atención: Lunes a Viernes de 8:30 a 12:30 y de 2:30 a 6:30'
  ];
  for (const line of entrega){ ensureSpace(18); doc.text(line, xMargin, y); y = doc.y; }

  // Link clickeable Google Maps (el que nos pasaste)
  const mapsUrl = 'https://share.google/HOzxeQjoNKAFYUaJY';
  ensureSpace(18);
  doc.fillColor(BRAND.primary)
     .text('Ver ubicación en Google Maps', xMargin, y, { width: usableW, link: mapsUrl, underline: true });
  doc.fillColor('black');
  y = doc.y + 18;

  /* ===== Condiciones y validez (actualizadas) ===== */
  drawH2('Condiciones y validez de la oferta');
  const conds = [
    '1) Oferta válida por 3 días calendario a partir de la fecha de emisión y sujeta a disponibilidad.',
    '2) Los precios pueden variar según volumen y condiciones comerciales acordadas.',
    '3) Para fijar precio y reservar volumen se requiere confirmación de pago y emisión de factura.',
    '4) La entrega se realiza en almacén; podemos apoyar en coordinación logística si el cliente lo requiere.'
  ];
  for (const line of conds){ ensureSpace(18); doc.font('Helvetica').text(line, xMargin, y); y = doc.y; }

  // (Eliminado) aviso “IMPORTANTE” y (Eliminado) sección bancaria/QR

  // Cierre
  doc.end();
  await new Promise((res, rej)=>{ stream.on('finish', res); stream.on('error', rej); });
  return outPath;
}
