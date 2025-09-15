// quote-pdf.js
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

const TZ = process.env.TIMEZONE || 'America/La_Paz';

/* ===== Paleta =====
   Colores corporativos:
   - Morado:  #8364a2
   - Índigo:  #5a66ac
   - Celeste: #46acc4
   Ajustes sutiles solicitados:
*/
const BRAND = {
  purple: '#8364a2',
  indigo: '#5a66ac',
  cyan:   '#46acc4',
};
const TINT = {
  headerPurple: '#C9B3E0', // morado un poco más fuerte para títulos de tabla
  rowPurple:    '#E6DBF1', // morado más notorio (sutil pero visible) para filas
  totalYellow:  '#FFF6C7', // amarillo sutil para celdas de totales (USD/Bs)
};
const GRID = '#000000';     // líneas negras en toda la tabla

function fmtDateTZ(date = new Date(), tz = TZ) {
  try {
    const f = new Intl.DateTimeFormat('es-BO', {
      timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric'
    }).format(date);
    return f;
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

// — Redondeo contable a 2 decimales (half-away-from-zero de Math.round) —
function round2(n){ return Math.round((Number(n)||0) * 100) / 100; }
// — Acumular en centavos para evitar drift —
function toCents(n){ return Math.round((Number(n)||0) * 100); }

function ensure(v, def){ return v==null || v==='' ? def : v; }
function findAsset(...relPaths){
  for (const r of relPaths){
    const p = path.resolve(r);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

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

/* ===== Redondeo por pack (tus reglas) ===== */
function roundQuantityByPack(originalQty, pack, itemUnitRaw){
  if (!pack || !(originalQty > 0)) return originalQty;

  const itemUnit = String(itemUnitRaw || '').toUpperCase();
  if (itemUnit && itemUnit !== pack.unit) return originalQty;

  const ratio = originalQty / pack.size;

  // 1 Kg -> no redondear
  if (pack.unit === 'KG' && Math.abs(pack.size - 1) < 1e-9) return originalQty;

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

  // Marca de agua sutil
  if (logoPath){
    doc.save();
    doc.opacity(0.10);
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

  /* ===== Tabla ===== */
  const rate = Number(process.env.USD_BOB_RATE || quote.rate || 6.96);

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

  // Encabezado: morado un poco más fuerte
  const headerH = 28;
  doc.save();
  doc.rect(tableX, y, tableW, headerH).fill(TINT.headerPurple);
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(9);
  {
    let cx = tableX;
    for (const cdef of cols){
      const innerX = cx + 6;
      doc.text(cdef.label, innerX, y + (headerH-10)/2, { width: cdef.w-12, align: 'center' });
      // Bordes negros del header
      doc.rect(cx, y, cdef.w, headerH).strokeColor(GRID).lineWidth(0.9).stroke();
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
        doc.opacity(0.10);
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

  let rowIndex = 0;

  for (const itRaw of (quote.items || [])){
    // 1) Precio unitario
    let precioUSD = Number(itRaw.precio_usd || 0);
    if (!(precioUSD > 0)) {
      precioUSD = lookupFromCatalog(quote.price_catalog || company.priceList || [], itRaw) || 0;
    }
    precioUSD = round2(precioUSD);
    const precioBsUnit  = round2(precioUSD * rate); // 2 decimales estrictos

    // 2) Cantidad (respeta redondeo por pack)
    const cantOrig  = Number(itRaw.cantidad || 0);
    const pack      = detectPackSize(itRaw);
    let cantidad = cantOrig;
    if (pack) cantidad = roundQuantityByPack(cantOrig, pack, itRaw.unidad);

    // 3) Subtotales a 2 decimales exactos
    const subUSD = round2(precioUSD   * cantidad);
    const subBs  = round2(precioBsUnit * cantidad);

    accUsdCents += toCents(subUSD);
    accBsCents  += toCents(subBs);

    const cellTexts = [
      String(itRaw.nombre || ''),
      String(itRaw.ingrediente_activo || ''),
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

    // Fondo morado más notorio en alternancia
    if (rowIndex % 2 === 1){
      doc.save();
      doc.rect(tableX, y, tableW, rowH).fill(TINT.rowPurple);
      doc.restore();
    }

    // Contenido + bordes negros
    let tx = tableX;
    for (let i=0; i<cols.length; i++){
      const cdef = cols[i];
      const innerX = tx + 6;
      const innerW = cdef.w - 12;
      doc.rect(tx, y, cdef.w, rowH).strokeColor(GRID).lineWidth(0.8).stroke();
      doc.fillColor('black')
         .font(cdef.key==='nombre' ? 'Helvetica-Bold' : 'Helvetica')
         .text(cellTexts[i], innerX, y + rowPadV, { width: innerW, align: cdef.align || 'left' });
      tx += cdef.w;
    }
    y += rowH;
    rowIndex++;
  }

  // Totales (suma de subtotales)
  const totalUSD = accUsdCents / 100;
  const totalBs  = accBsCents  / 100;

  ensureSpace(56);

  const wUntilCol6 = cols.slice(0,6).reduce((a,c)=>a+c.w,0);
  const wCol7      = cols[6].w;
  const wCol8      = cols[7].w;

  // Línea superior separadora
  doc.moveTo(tableX, y).lineTo(tableX + tableW, y).strokeColor(GRID).lineWidth(0.9).stroke();

  const totalRowH = 26;

  // Celda "Total" — EN BLANCO (solo bordes)
  doc.rect(tableX, y, wUntilCol6, totalRowH).strokeColor(GRID).lineWidth(0.9).stroke();
  doc.font('Helvetica-Bold').fillColor('#111').text('Total', tableX, y+6, { width: wUntilCol6, align: 'center' });

  // Celdas de montos USD y Bs — AMARILLO sutil
  doc.save();
  doc.rect(tableX + wUntilCol6, y, wCol7, totalRowH).fill(TINT.totalYellow);
  doc.rect(tableX + wUntilCol6 + wCol7, y, wCol8, totalRowH).fill(TINT.totalYellow);
  doc.restore();

  // Bordes negros
  doc.rect(tableX + wUntilCol6, y, wCol7, totalRowH).strokeColor(GRID).lineWidth(0.9).stroke();
  doc.rect(tableX + wUntilCol6 + wCol7, y, wCol8, totalRowH).strokeColor(GRID).lineWidth(0.9).stroke();

  // Valores
  doc.font('Helvetica-Bold').fillColor('#111')
     .text(`$ ${money(totalUSD)}`, tableX + wUntilCol6, y+6, { width: wCol7-8, align:'right' });
  doc.font('Helvetica-Bold').fillColor('#111')
     .text(`${money(totalBs)} Bs`, tableX + wUntilCol6 + wCol7 + 6, y+6, { width: wCol8-12, align:'left' });

  y += totalRowH + 18;

  // Nota precios
  ensureSpace(24);
  doc.font('Helvetica').fontSize(9).fillColor('#333')
     .text('*Nuestros precios incluyen impuestos de ley.', xMargin, y, { width: usableW });
  doc.fillColor('black');
  y += 22;

  // Lugar de entrega (con el botón/link ENTRE Almacén y Horario)
  const drawH2 = (t)=>{ ensureSpace(24); doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text(t, xMargin, y); doc.font('Helvetica').fontSize(10).fillColor('#000'); y = doc.y + 12; };
  drawH2('Lugar de entrega');

  // 1) Almacén
  ensureSpace(18);
  doc.text('Almacén Central', xMargin, y);
  y = doc.y + 6;

  // 2) Botón/Link Google Maps (clickeable)
  const mapsUrl = 'https://maps.app.goo.gl/UPSh75QbWpfWccgz9';
  const btnLabel = 'Ver ubicación en Google Maps';
  const savedFont = doc._font;
  const savedSize = doc._fontSize;

  doc.font('Helvetica-Bold').fontSize(10);
  const tw = doc.widthOfString(btnLabel);
  const th = doc.currentLineHeight();
  const padX = 10, padY = 6;
  const btnW = tw + padX*2;
  const btnH = th + padY*2;
  const bx = xMargin;
  const by = y;

  ensureSpace(btnH + 10);
  doc.save();
  // chip sutil
  doc.roundedRect(bx, by, btnW, btnH, 8).fill('#EAF7FA');
  doc.roundedRect(bx, by, btnW, btnH, 8).strokeColor(BRAND.cyan).lineWidth(1).stroke();
  doc.fillColor('#075E69').text(btnLabel, bx + padX, by + padY - 1, { width: btnW - padX*2, align: 'center', link: mapsUrl });
  // clickable sobre todo el rectángulo
  doc.link(bx, by, btnW, btnH, mapsUrl);
  doc.restore();
  // restaurar fuente
  doc.font(savedFont ? savedFont.font ? savedFont.font : 'Helvetica' : 'Helvetica').fontSize(savedSize || 10);

  y += btnH + 8;

  // 3) Horario
  ensureSpace(18);
  doc.text('Horarios de atención: 08:00 - 17:00', xMargin, y);
  y = doc.y + 12;

  // Condiciones
  drawH2('Condiciones y validez de la oferta');
  const conds = [
    '1.- Oferta válida por 1 día a partir de la fecha, sujeta a la disponibilidad de productos.',
    '2.- Solicite su cotización acorde al volumen requerido antes de realizar cualquier pago.',
    '3.- La única manera de fijar precio y reservar volumen, es con el pago 100% y facturado.',
    '4.- Una vez facturado, no se aceptan cambios ni devoluciones. Excepto por producto dañado.'
  ];
  for (const line of conds){ ensureSpace(18); doc.font('Helvetica').text(line, xMargin, y); y = doc.y; }

  // Aviso de facturación — centrado vertical y horizontal dentro del recuadro
  y += 18;
  ensureSpace(36);
  const important = 'IMPORTANTE: LA FACTURACIÓN DEBE EMITIRSE A NOMBRE DE QUIEN REALIZA EL PAGO.';
  const pad = 12;
  const maxW = usableW;
  const textH = doc.heightOfString(important, { width: maxW - pad*2, align: 'center' });
  const boxH = Math.max(28, textH + pad*2);
  doc.save();
  doc.roundedRect(xMargin, y, maxW, boxH, 10).fill('#EAF7FA'); // suave
  doc.roundedRect(xMargin, y, maxW, boxH, 10).strokeColor(BRAND.cyan).lineWidth(1.2).stroke();
  doc.font('Helvetica-Bold').fillColor('#062b33')
     .text(important, xMargin + pad, y + (boxH - textH)/2, { width: maxW - pad*2, align: 'center' });
  doc.restore();
  y += boxH + 18;

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

  // Tabla bancaria — nombres de bancos en NEGRITA (mismo color)
  y = bankTopY;
  const bankBox = (label, value)=>{
    ensureSpace(36);
    doc.font('Helvetica-Bold').fillColor('#000').text(label, xMargin, y, { width: 100 });
    if (label.toLowerCase().startsWith('banco')) {
      doc.font('Helvetica-Bold').fillColor('#000').text(value, xMargin+100, y, { width: colW-100 });
    } else {
      doc.font('Helvetica').fillColor('#000').text(value, xMargin+100, y, { width: colW-100 });
    }
    y = doc.y + 8;
    doc.moveTo(xMargin, y-2).lineTo(xMargin+colW, y-2).strokeColor('#bbb').stroke();
  };

  bankBox('Titular:', 'New Chem Agroquímicos SRL');
  bankBox('Moneda:', 'Bolivianos');
  bankBox('Banco:', 'BCP');                bankBox('Cuenta Corriente:', '701-5096500-3-34');
  bankBox('Banco:', 'BANCO UNIÓN');        bankBox('Cuenta Corriente:', '10000047057563');
  bankBox('Banco:', 'BANCO SOL');          bankBox('Cuenta Corriente:', '2784368-000-001');


  y += 14;
  ensureSpace(28);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#222')
     .text('New Chem Agroquímicos SRL', xMargin, y, { width: usableW, align: 'left' });
  y = doc.y + 2;
  doc.font('Helvetica').fontSize(10).fillColor('#333')
     .text('NIT: 154920027', xMargin, y, { width: usableW, align: 'left' });
  y = doc.y + 6;

  doc.end();
  await new Promise((res, rej)=>{ stream.on('finish', res); stream.on('error', rej); });
  return outPath;
}
