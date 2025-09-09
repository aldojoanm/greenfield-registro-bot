// quote-pdf.js
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

function fmtDate(d = new Date()){
  const pad = n => String(n).padStart(2,'0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
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
    || findAsset('./public/qr.png','./public/privacidad.png','./image/qr.png');

  // ===== Marca de agua =====
  if (logoPath){
    doc.save();
    doc.opacity(0.06);
    const mw = 420;
    const mx = (pageW - mw) / 2;
    const my = (pageH - mw*0.45) / 2;
    try { doc.image(logoPath, mx, my, { width: mw }); } catch {}
    doc.restore();
  }

  // ===== Header =====
  let y = 24;
  if (logoPath){
    try { doc.image(logoPath, xMargin, y, { width: 120 }); } catch {}
  }
  doc.font('Helvetica-Bold').fontSize(14).text('COTIZACIÓN', 0, y+8, { align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor('#666')
     .text(fmtDate(quote.fecha), 0, y+12, { align: 'right' })
     .fillColor('black');

  y = 86;

  // ===== Cliente (solo 3 campos) =====
  const c = quote.cliente || {};
  const L = (label, val) => {
    doc.font('Helvetica-Bold').text(`${label}: `, xMargin, y, { continued: true });
    doc.font('Helvetica').text(ensure(val,'-'));
    y += 14;
  };
  L('Cliente', c.nombre);
  L('Departamento', c.departamento);
  L('Zona', c.zona);

  y += 10;

  // ===== Tabla =====
  const rate = Number(process.env.USD_BOB_RATE || quote.rate || 6.96);

  const cols = [
    { key:'nombre',             label:'Producto',            w:122, align:'left'  },
    { key:'ingrediente_activo', label:'Ingrediente activo',  w:122, align:'left'  },
    { key:'envase',             label:'Envase',              w:48,  align:'left'  },
    { key:'cantidad',           label:'Cantidad',            w:52,  align:'right' },
    { key:'precio_usd',         label:'Precio (USD)',        w:62,  align:'right' },
    { key:'precio_bs',          label:'Precio (Bs)',         w:62,  align:'right' },
    { key:'subtotal_usd',       label:'Sub total (USD)',     w:60,  align:'right' },
    { key:'subtotal_bs',        label:'Sub total (Bs)',      w:63,  align:'right' },
  ];
  const tableX = xMargin;
  const tableW = cols.reduce((a,c)=>a+c.w,0);

  // Cabecera
  const headerH = 24;
  doc.save();
  doc.rect(tableX, y, tableW, headerH).fill('#0a8e7b');
  doc.fillColor('white').font('Helvetica-Bold').fontSize(9);
  {
    let cx = tableX + 6;
    for (const cdef of cols){
      const headerAlign = 'center'; // centrado en encabezado
      doc.text(cdef.label, cx, y + (headerH-10)/2, { width: cdef.w-12, align: headerAlign });
      cx += cdef.w;
    }
  }
  doc.restore();
  y += headerH;

  // Filas
  const rowPadV = 6;
  const minRowH = 20;

  const ensureSpace = (need = 80) => {
    if (y + need > (pageH - 60)){
      doc.addPage();
      y = 36;
      if (logoPath){
        doc.save();
        doc.opacity(0.06);
        const mw = 420;
        const mx = (pageW - mw) / 2;
        const my = (pageH - mw*0.45) / 2;
        try { doc.image(logoPath, mx, my, { width: mw }); } catch {}
        doc.restore();
      }
    }
  };

  doc.fontSize(9).fillColor('black');

  let subtotalUSD = 0;
  for (const itRaw of (quote.items || [])){
    const precioUSD = Number(itRaw.precio_usd || 0);
    const precioBs  = precioUSD * rate;
    const cant      = Number(itRaw.cantidad || 0);
    const subUSD    = precioUSD * cant;
    const subBs     = subUSD * rate;
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

    // calcular altura
    const cellHeights = [];
    for (let i=0; i<cols.length; i++){
      const w = cols[i].w - 12;
      const h = doc.heightOfString(cellTexts[i], { width: w, align: cols[i].align || 'left' });
      cellHeights.push(Math.max(h + rowPadV*2, minRowH));
    }
    const rowH = Math.max(...cellHeights);

    ensureSpace(rowH + 6);

    // Fondo cebra
    doc.save();
    doc.rect(tableX, y, tableW, rowH).fillOpacity(0.06).fill('#0a8e7b').fillOpacity(1);
    doc.restore();

    // Contenido + bordes
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

  ensureSpace(42);

  const wUntilCol6 = cols.slice(0,6).reduce((a,c)=>a+c.w,0);
  const wCol7      = cols[6].w;
  const wCol8      = cols[7].w;

  // línea superior
  doc.moveTo(tableX, y).lineTo(tableX + tableW, y).strokeColor('#333').lineWidth(0.8).stroke();

  const totalRowH = 22;
  // caja "Total"
  doc.rect(tableX, y, wUntilCol6, totalRowH).strokeColor('#333').lineWidth(0.8).stroke();
  doc.font('Helvetica-Bold').text('Total', tableX, y+5, { width: wUntilCol6, align: 'center' });

  // montos (fondo amarillo)
  doc.save();
  doc.rect(tableX + wUntilCol6, y, wCol7, totalRowH).fill('#fff59d');
  doc.rect(tableX + wUntilCol6 + wCol7, y, wCol8, totalRowH).fill('#fff59d');
  doc.restore();

  // bordes
  doc.rect(tableX + wUntilCol6, y, wCol7, totalRowH).strokeColor('#333').lineWidth(0.8).stroke();
  doc.rect(tableX + wUntilCol6 + wCol7, y, wCol8, totalRowH).stroke();

  // USD derecha / Bs izquierda (una sola línea)
  doc.font('Helvetica-Bold').text(`$ ${money(totalUSD)}`, tableX + wUntilCol6, y+5, { width: wCol7-8, align:'right' });
  doc.font('Helvetica-Bold').text(`Bs ${money(totalBs)}`, tableX + wUntilCol6 + wCol7 + 6, y+5, { width: wCol8-12, align:'left' });

  y += totalRowH + 12;

  // Nota precios (normal, sin itálica / sin negrita)
  ensureSpace(18);
  doc.font('Helvetica').fontSize(9).fillColor('#333')
     .text('*Nuestros precios incluyen impuestos de ley.');
  doc.fillColor('black');
  y += 10;

  // ===== Lugar de entrega =====
  const drawH2 = (t)=>{ ensureSpace(18); doc.font('Helvetica-Bold').fontSize(11).text(t, xMargin, y); doc.font('Helvetica').fontSize(10); y = doc.y + 6; };
  drawH2('Lugar de entrega');
  const entrega = [
    'Almacenes Orange Cargo SRL., ubicados en el km9 zona norte, lado del surtidor bioceánico.',
    'Horarios de atención: 08:00 - 12:00 / 13:00 - 17:00'
  ];
  for (const line of entrega){ ensureSpace(14); doc.text(line, xMargin, y); y = doc.y; }

  // ===== Condiciones =====
  y += 8;
  drawH2('Condiciones y validez de la oferta');
  const conds = [
    '1.- Oferta válida por 1 día a partir de la fecha, sujeta a la disponibilidad de productos.',
    '2.- Solicite su cotización acorde al volumen requerido antes de realizar cualquier pago.',
    '3.- La única manera de fijar precio y reservar volumen, es con el pago 100% y facturado.',
    '4.- Una vez facturado, no se aceptan cambios ni devoluciones. Excepto por producto dañado.'
  ];
  for (const line of conds){ ensureSpace(14); doc.font('Helvetica').text(line, xMargin, y); y = doc.y; }

  // ===== Aviso de facturación =====
  y += 10;
  ensureSpace(44);
  const warnH = 36;
  doc.save();
  doc.rect(xMargin, y, usableW, warnH).fill('#fdecea');
  doc.restore();
  doc.rect(xMargin, y, usableW, warnH).strokeColor('#c53030').lineWidth(1).stroke();
  doc.font('Helvetica-Bold').fillColor('#a50000').text(
    'IMPORTANTE: LA FACTURACIÓN DEBE EMITIRSE A NOMBRE DE QUIEN REALIZA EL PAGO.',
    xMargin+10, y+10, { width: usableW-20, align:'left' }
  );
  doc.fillColor('black');
  y += warnH + 14;

  // ===== Datos bancarios y QR =====
  drawH2('Datos bancarios y QR');

  const rightBoxW = 170;         // ancho zona QR
  const rightX    = xMargin + usableW - rightBoxW;
  const colW      = rightX - xMargin - 14; // tabla más chica

  const bankBox = (label, value)=>{
    ensureSpace(34);
    doc.font('Helvetica-Bold').text(label, xMargin, y, { width: 100 });
    doc.font('Helvetica').text(value, xMargin+100, y, { width: colW-100 });
    y = doc.y + 6;
    doc.moveTo(xMargin, y-2).lineTo(xMargin+colW, y-2).strokeColor('#bbb').stroke();
  };

  bankBox('Titular:', 'New Chem Agroquímicos SRL');
  bankBox('Moneda:', 'Bolivianos');
  bankBox('Banco:', 'BCP');                bankBox('Cuenta Corriente:', '701-5096500-3-34');
  bankBox('Banco:', 'BANCO UNIÓN');        bankBox('Cuenta Corriente:', '10000047057563');
  bankBox('Banco:', 'BANCO SOL');          bankBox('Cuenta Corriente:', '2784368-000-001');

  // QR a la derecha
  const qrY = y - 160; // mantiene alineado arriba
  if (qrPath){
    try { doc.image(qrPath, rightX, qrY, { width: rightBoxW }); }
    catch {
      doc.rect(rightX, qrY, rightBoxW, rightBoxW).strokeColor('#ccc').dash(4,{space:3}).stroke().undash();
      doc.font('Helvetica').fontSize(9).fillColor('#666')
         .text('QR no disponible', rightX, qrY + rightBoxW/2 - 6, { width: rightBoxW, align:'center' })
         .fillColor('black');
    }
  } else {
    doc.rect(rightX, qrY, rightBoxW, rightBoxW).strokeColor('#ccc').dash(4,{space:3}).stroke().undash();
    doc.font('Helvetica').fontSize(9).fillColor('#666')
       .text('QR aquí', rightX, qrY + rightBoxW/2 - 6, { width: rightBoxW, align:'center' })
       .fillColor('black');
  }

  doc.end();
  await new Promise((res, rej)=>{ stream.on('finish', res); stream.on('error', rej); });
  return outPath;
}
