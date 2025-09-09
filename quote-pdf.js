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

  // Cliente (3 campos)
  const c = quote.cliente || {};
  const L = (label, val) => {
    doc.font('Helvetica-Bold').text(`${label}: `, xMargin, y, { continued: true });
    doc.font('Helvetica').text(ensure(val,'-'));
    y += 16;
  };
  L('Cliente', c.nombre);
  L('Departamento', c.departamento);
  L('Zona', c.zona);

  y += 16;

  // ===== Tabla =====
  const rate = Number(process.env.USD_BOB_RATE || quote.rate || 6.96);

  // Anchos (suman 523)
  const cols = [
    { key:'nombre',             label:'Producto',           w:90,  align:'left'  },
    { key:'ingrediente_activo', label:'Ingrediente activo', w:104, align:'left'  },
    { key:'envase',             label:'Envase',             w:48,  align:'left'  },  // +8
    { key:'cantidad',           label:'Cantidad',           w:56,  align:'right' },  // +8
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

  // Totales (fila más alta y "Bs" después del número)
  const totalUSD = Number(quote.total_usd ?? subtotalUSD);
  const totalBs  = totalUSD * rate;

  ensureSpace(56);

  const wUntilCol6 = cols.slice(0,6).reduce((a,c)=>a+c.w,0);
  const wCol7      = cols[6].w;
  const wCol8      = cols[7].w;

  doc.moveTo(tableX, y).lineTo(tableX + tableW, y).strokeColor('#333').lineWidth(0.8).stroke();

  const totalRowH = 26; // más alto
  doc.rect(tableX, y, wUntilCol6, totalRowH).strokeColor('#333').lineWidth(0.8).stroke();
  doc.font('Helvetica-Bold').text('Total', tableX, y+6, { width: wUntilCol6, align: 'center' });

  doc.save();
  doc.rect(tableX + wUntilCol6, y, wCol7, totalRowH).fill('#fff59d');
  doc.rect(tableX + wUntilCol6 + wCol7, y, wCol8, totalRowH).fill('#fff59d');
  doc.restore();

  doc.rect(tableX + wUntilCol6, y, wCol7, totalRowH).strokeColor('#333').lineWidth(0.8).stroke();
  doc.rect(tableX + wUntilCol6 + wCol7, y, wCol8, totalRowH).stroke();

  doc.font('Helvetica-Bold').text(`$ ${money(totalUSD)}`, tableX + wUntilCol6, y+6, { width: wCol7-8, align:'right' });
  // "Bs" DESPUÉS del número
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
    'Horarios de atención: 08:00 - 12:00 / 13:00 - 17:00'
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
