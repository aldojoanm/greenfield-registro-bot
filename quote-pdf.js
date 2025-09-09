// quote-pdf.js
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

const TZ = process.env.TIMEZONE || 'America/La_Paz';

function fmtDateTZ(date = new Date(), tz = TZ) {
  try {
    const f = new Intl.DateTimeFormat('es-BO', {
      timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric'
    }).format(date);
    return f; // DD/MM/YYYY
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
function ensure(v, def){ return v==null || v==='' ? def : v; }
function findAsset(...relPaths){
  for (const r of relPaths){
    const p = path.resolve(r);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/* =========================
   Detección de presentación
   ========================= */
function detectPackSize(it = {}){
  // 1) Desde "envase" (ej: "20 L", "1 Kg", "200L")
  if (it.envase) {
    const m = String(it.envase).match(/(\d+(?:[.,]\d+)?)\s*(l|lt|lts|litros?|kg|kilos?)/i);
    if (m) {
      const size = parseFloat(m[1].replace(',','.'));
      const unit = /kg/i.test(m[2]) ? 'KG' : 'L';
      if (!isNaN(size) && size > 0) return { size, unit };
    }
  }
  // 2) Desde el SKU (ej: "GLISATO-200L", "LAYER-25KG")
  if (it.sku) {
    const m = String(it.sku).match(/-(\d+(?:\.\d+)?)(l|kg)\b/i);
    if (m) {
      const size = parseFloat(m[1]);
      const unit = m[2].toUpperCase();
      if (!isNaN(size) && size > 0) return { size, unit };
    }
  }
  // 3) Desde el nombre
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

/* =========================
   Lectura robusta de precios
   ========================= */
const FLEX_KEYS_USD = ['precio_usd','price_usd','usd','precioUSD','PrecioUSD','precio','price'];

function toNumberFlexible(v){
  if (v==null || v==='') return NaN;
  const s = String(v).trim().replace(/\s+/g,'').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// Devuelve el PRIMER valor > 0 que encuentre.
// Si no hay ninguno > 0 pero sí hay algún 0 explícito, retorna 0.
// (Evita que un "usd: 0" tape un "precio_usd: 16.55".)
function readUSDDirectPreferPositive(obj = {}){
  let sawZero = false;
  for (const k of FLEX_KEYS_USD){
    const n = toNumberFlexible(obj[k]);
    if (Number.isFinite(n)) {
      if (n > 0) return n;
      if (n === 0) sawZero = true;
    }
  }
  return sawZero ? 0 : 0;
}

function norm(s=''){
  return String(s)
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .replace(/[^a-z0-9]/gi,'')
    .toUpperCase();
}

function collectCatalog(quote = {}, company = {}){
  const lists = [];
  const candidates = [
    quote.catalog, quote.price_catalog, quote.priceList, quote.pricelist, quote.products, quote.itemsCatalog,
    company.catalog, company.priceList
  ];
  for (const c of candidates){
    if (Array.isArray(c) && c.length) lists.push(c);
  }
  return lists;
}

function detectPackFromCatalogRow(row){
  return detectPackSize({ envase: row?.envase, sku: row?.sku, nombre: row?.nombre });
}

function matchCatalogRow(item, lists){
  if (!lists.length) return null;

  const sku = item?.sku ? norm(item.sku) : '';
  const nameN = item?.nombre ? norm(item.nombre) : '';
  const pack = detectPackSize(item);

  // 1) Por SKU exacto
  if (sku){
    for (const list of lists){
      const hit = list.find(r => r?.sku && norm(r.sku) === sku);
      if (hit) return hit;
    }
  }

  // 2) Por nombre + presentación (cuando no hay SKU)
  if (nameN || pack){
    for (const list of lists){
      const cand = list.find(r => {
        const n2 = r?.nombre ? norm(r.nombre) : (r?.sku ? norm(String(r.sku).split('-')[0]) : '');
        if (nameN && n2 && !n2.includes(nameN) && !nameN.includes(n2)) return false;
        if (pack){
          const p2 = detectPackFromCatalogRow(r);
          if (!p2) return false;
          return p2.unit === pack.unit && Math.abs(p2.size - pack.size) < 1e-9;
        }
        return true;
      });
      if (cand) return cand;
    }
  }

  return null;
}

function lookupPriceUSD(it = {}, quote = {}, company = {}){
  // 1) Preferir precio directo del item (buscando valor > 0)
  const direct = readUSDDirectPreferPositive(it);
  if (direct > 0 || direct === 0) return direct;

  // 2) Buscar en catálogos opcionales si existen
  const lists = collectCatalog(quote, company);
  if (lists.length){
    const row = matchCatalogRow(it, lists);
    if (row){
      const fromCat = readUSDDirectPreferPositive(row);
      if (Number.isFinite(fromCat)) return fromCat;
    }
  }

  // 3) Nada
  return 0;
}

/* =========================
   Redondeo por presentación
   ========================= */
function roundQuantityByPack(originalQty, pack, itemUnitRaw){
  if (!pack || !(originalQty > 0)) return originalQty;

  const itemUnit = String(itemUnitRaw || '').toUpperCase();
  if (itemUnit && itemUnit !== pack.unit) {
    return originalQty; // unidades distintas -> no tocamos
  }

  const ratio = originalQty / pack.size;

  // 1 Kg -> no redondear
  if (pack.unit === 'KG' && Math.abs(pack.size - 1) < 1e-9) {
    return originalQty;
  }

  // Packs grandes >=200 L -> floor si piden >=1; si <1, mínimo 1 pack
  if (pack.unit === 'L' && pack.size >= 200) {
    if (ratio < 1) return pack.size;
    const mult = Math.floor(ratio + 1e-9);
    return mult * pack.size;
  }

  // Resto -> ceil
  const mult = Math.ceil(ratio - 1e-9);
  return mult * pack.size;
}

/* =========================
   Render PDF
   ========================= */
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

  // Assets
  const logoPath = company.logoPath
    || findAsset('./public/logo_newchem.png','./logo_newchem.png','./image/logo_newchem.png');
  const qrPath = company.qrPath
    || findAsset('./public/qr-pagos.png','./public/qr.png','./public/privacidad.png','./image/qr.png');

  // Membrete
  if (logoPath){
    doc.save();
    doc.opacity(0.12);
    const mw = 420;
    const mx = (pageW - mw) / 2;
    const my = (pageH - mw*0.45) / 2;
    try { doc.image(logoPath, mx, my, { width: mw }); } catch {}
    doc.restore();
  }

  // Header
  let y = 32;
  if (logoPath){
    try { doc.image(logoPath, xMargin, y, { width: 120 }); } catch {}
  }
  doc.font('Helvetica-Bold').fontSize(14).text('COTIZACIÓN', 0, y+10, { align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor('#666')
     .text(fmtDateTZ(quote.fecha || new Date(), TZ), 0, y+14, { align: 'right' })
     .fillColor('black');

  y = 100;

  // Cliente
  const c = quote.cliente || {};
  const L = (label, val) => {
    doc.font('Helvetica-Bold').text(`${label}: `, xMargin, y, { continued: true });
    doc.font('Helvetica').text(ensure(val,'-'));
    y += 16;
  };
  L('Cliente', c.nombre);
  L('Departamento', c.departamento);
  L('Zona', c.zona);
  L('Pago', 'Contado');

  y += 16;

  // ===== Tabla =====
  const rate = Number(process.env.USD_BOB_RATE || quote.rate || 6.96);

  // Anchos (suman 523)
  const cols = [
    { key:'nombre',             label:'Producto',           w:90,  align:'left'  },
    { key:'ingrediente_activo', label:'Ingrediente activo', w:104, align:'left'  },
    { key:'envase',             label:'Envase',             w:48,  align:'left'  },
    { key:'cantidad',           label:'Cantidad',           w:56,  align:'right' },
    { key:'precio_usd',         label:'Precio (USD)',       w:55,  align:'right' },
    { key:'precio_bs',          label:'Precio (Bs)',        w:50,  align:'right' },
    { key:'subtotal_usd',       label:'Subtotal (USD)',     w:60,  align:'right' },
    { key:'subtotal_bs',        label:'Subtotal (Bs)',      w:60,  align:'right' },
  ];
  const tableX = xMargin;
  const tableW = cols.reduce((a,c)=>a+c.w,0);

  // Cabecera un poco más alta
  const headerH = 28;
  doc.save();
  doc.rect(tableX, y, tableW, headerH).fill('#0a8e7b');
  doc.fillColor('white').font('Helvetica-Bold').fontSize(9);
  {
    let cx = tableX + 6;
    for (const cdef of cols){
      doc.text(cdef.label, cx, y + (headerH-10)/2, { width: cdef.w-12, align: 'center' });
      cx += cdef.w;
    }
  }
  doc.restore();
  y += headerH;

  const ensureSpace = (need = 90) => {
    if (y + need > (pageH - 60)){
      doc.addPage();
      y = 42;
      if (logoPath){
        doc.save();
        doc.opacity(0.12);
        const mw = 420;
        const mx = (pageW - mw) / 2;
        const my = (pageH - mw*0.45) / 2;
        try { doc.image(logoPath, mx, my, { width: mw }); } catch {}
        doc.restore();
      }
    }
  };

  // Filas
  const rowPadV = 6;
  const minRowH = 20;

  doc.fontSize(9).fillColor('black');

  let subtotalUSD = 0;
  for (const itRaw of (quote.items || [])){
    // Precio (lee del item; si viene 0 o vacío, busca en catálogos opcionales)
    const precioUSD = lookupPriceUSD(itRaw, quote, company);
    const precioBs  = precioUSD * rate;

    // Cantidad con redondeo por presentación
    const cantOrig  = Number(itRaw.cantidad || 0);
    const pack      = detectPackSize(itRaw);
    let cant = cantOrig;
    if (pack) {
      cant = roundQuantityByPack(cantOrig, pack, itRaw.unidad);
    }

    // Subtotales
    const subUSD = precioUSD * cant;
    const subBs  = subUSD * rate;
    subtotalUSD += subUSD;

    const cellTexts = [
      String(itRaw.nombre || ''),
      String(itRaw.ingrediente_activo || ''),
      String(itRaw.envase || ''),
      money(cant),
      money(precioUSD),
      money(precioBs),
      money(subUSD),
      money(subBs),
    ];

    const cellHeights = [];
    for (let i=0; i<cols.length; i++){
      const w = cols[i].w - 12;
      const h = doc.heightOfString(cellTexts[i], { width: w, align: cols[i].align || 'left' });
      cellHeights.push(Math.max(h + rowPadV*2, minRowH));
    }
    const rowH = Math.max(...cellHeights);

    ensureSpace(rowH + 10);

    // zebra
    doc.save();
    doc.rect(tableX, y, tableW, rowH).fillOpacity(0.06).fill('#0a8e7b').fillOpacity(1);
    doc.restore();

    // contenido + bordes
    let tx = tableX;
    for (let i=0; i<cols.length; i++){
      const cdef = cols[i];
      const innerX = tx + 6;
      const innerW = cdef.w - 12;
      doc.rect(tx, y, cdef.w, rowH).strokeColor('#333').lineWidth(0.6).stroke();
      doc.fillColor('black')
         .font(cdef.key==='nombre' ? 'Helvetica-Bold' : 'Helvetica')
         .text(cellTexts[i], innerX, y + rowPadV, { width: innerW, align: cdef.align || 'left' });
      tx += cdef.w;
    }
    y += rowH;
  }

  // Totales
  const totalUSD = Number(quote.total_usd ?? subtotalUSD);
  const totalBs  = totalUSD * rate;

  ensureSpace(56);

  const wUntilCol6 = cols.slice(0,6).reduce((a,c)=>a+c.w,0);
  const wCol7      = cols[6].w;
  const wCol8      = cols[7].w;

  doc.moveTo(tableX, y).lineTo(tableX + tableW, y).strokeColor('#333').lineWidth(0.8).stroke();

  const totalRowH = 26;
  doc.rect(tableX, y, wUntilCol6, totalRowH).strokeColor('#333').lineWidth(0.8).stroke();
  doc.font('Helvetica-Bold').text('Total', tableX, y+6, { width: wUntilCol6, align: 'center' });

  doc.save();
  doc.rect(tableX + wUntilCol6, y, wCol7, totalRowH).fill('#fff59d');
  doc.rect(tableX + wUntilCol6 + wCol7, y, wCol8, totalRowH).fill('#fff59d');
  doc.restore();

  doc.rect(tableX + wUntilCol6, y, wCol7, totalRowH).strokeColor('#333').lineWidth(0.8).stroke();
  doc.rect(tableX + wUntilCol6 + wCol7, y, wCol8, totalRowH).stroke();

  doc.font('Helvetica-Bold').text(`$ ${money(totalUSD)}`, tableX + wUntilCol6, y+6, { width: wCol7-8, align:'right' });
  doc.font('Helvetica-Bold').text(`${money(totalBs)} Bs`, tableX + wUntilCol6 + wCol7 + 6, y+6, { width: wCol8-12, align:'left' });

  y += totalRowH + 18;

  // Nota precios
  ensureSpace(24);
  doc.font('Helvetica').fontSize(9).fillColor('#333')
     .text('*Nuestros precios incluyen impuestos de ley.', xMargin, y, { width: usableW });
  doc.fillColor('black');
  y += 22;

  // Lugar de entrega
  const drawH2 = (t)=>{ ensureSpace(24); doc.font('Helvetica-Bold').fontSize(11).text(t, xMargin, y); doc.font('Helvetica').fontSize(10); y = doc.y + 12; };
  drawH2('Lugar de entrega');
  const entrega = [
    'Almacenes Orange Cargo SRL., ubicados en el km9 zona norte, lado del surtidor bioceánico.',
    'Horarios de atención: 08:00 - 17:00'
  ];
  for (const line of entrega){ ensureSpace(18); doc.text(line, xMargin, y); y = doc.y; }

  // Condiciones
  y += 18;
  drawH2('Condiciones y validez de la oferta');
  const conds = [
    '1.- Oferta válida por 1 día a partir de la fecha, sujeta a la disponibilidad de productos.',
    '2.- Solicite su cotización acorde al volumen requerido antes de realizar cualquier pago.',
    '3.- La única manera de fijar precio y reservar volumen, es con el pago 100% y facturado.',
    '4.- Una vez facturado, no se aceptan cambios ni devoluciones. Excepto por producto dañado.'
  ];
  for (const line of conds){ ensureSpace(18); doc.font('Helvetica').text(line, xMargin, y); y = doc.y; }

  // Aviso de facturación
  y += 18;
  ensureSpace(20);
  doc.font('Helvetica-Bold').fillColor('#000')
     .text('IMPORTANTE: LA FACTURACIÓN DEBE EMITIRSE A NOMBRE DE QUIEN REALIZA EL PAGO.', xMargin, y, { width: usableW });
  doc.fillColor('black');
  y = doc.y + 18;

  // Datos bancarios y QR
  drawH2('Datos bancarios y QR');

  const rightBoxW = 150;
  const rightX    = xMargin + usableW - rightBoxW;
  const colW      = rightX - xMargin - 16;
  const bankTopY  = y;

  if (qrPath){
    try { doc.image(qrPath, rightX, bankTopY, { width: rightBoxW }); }
    catch {
      doc.rect(rightX, bankTopY, rightBoxW, rightBoxW).strokeColor('#ccc').dash(4,{space:3}).stroke().undash();
      doc.font('Helvetica').fontSize(9).fillColor('#666')
         .text('QR no disponible', rightX, bankTopY + rightBoxW/2 - 6, { width: rightBoxW, align:'center' })
         .fillColor('black');
    }
  } else {
    doc.rect(rightX, bankTopY, rightBoxW, rightBoxW).strokeColor('#ccc').dash(4,{space:3}).stroke().undash();
    doc.font('Helvetica').fontSize(9).fillColor('#666')
       .text('QR aquí', rightX, bankTopY + rightBoxW/2 - 6, { width: rightBoxW, align:'center' })
       .fillColor('black');
  }

  // Tabla bancaria
  y = bankTopY;
  const bankBox = (label, value)=>{
    ensureSpace(36);
    doc.font('Helvetica-Bold').text(label, xMargin, y, { width: 100 });
    doc.font('Helvetica').text(value, xMargin+100, y, { width: colW-100 });
    y = doc.y + 8;
    doc.moveTo(xMargin, y-2).lineTo(xMargin+colW, y-2).strokeColor('#bbb').stroke();
  };

  bankBox('Titular:', 'New Chem Agroquímicos SRL');
  bankBox('Moneda:', 'Bolivianos');
  bankBox('Banco:', 'BCP');                bankBox('Cuenta Corriente:', '701-5096500-3-34');
  bankBox('Banco:', 'BANCO UNIÓN');        bankBox('Cuenta Corriente:', '10000047057563');
  bankBox('Banco:', 'BANCO SOL');          bankBox('Cuenta Corriente:', '2784368-000-001');

  doc.end();
  await new Promise((res, rej)=>{ stream.on('finish', res); stream.on('error', rej); });
  return outPath;
}
