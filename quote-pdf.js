// quote-pdf.js
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

function pad(n){ return String(n).padStart(2,'0'); }
function fmtDate(d=new Date()){
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
}
function money(n){
  // 1,234.56 (estilo de tu plantilla)
  const x = Number(n || 0);
  const s = x.toFixed(2);
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fileExists(p){ try{ return p && fs.existsSync(p); }catch{ return false; } }

export async function renderQuotePDF(quote, outPath, company = {}){
  const dir = path.dirname(outPath);
  try{ fs.mkdirSync(dir, { recursive:true }); }catch{}

  const doc = new PDFDocument({ size:'A4', margin:36 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  // ====== Config empresa / plantilla ======
  const BRAND   = company.brand || 'New Chem Agroquímicos SRL';
  const RUC     = company.ruc   || '';
  const TEL     = company.tel   || '';
  const ADDR    = company.dir   || '';
  const LOGO    = company.logoPath && fileExists(company.logoPath) ? company.logoPath : null;

  const PAYMENT = quote?.pago || 'Contado';
  const RATE    = Number(quote?.rate || process.env.USD_BOB_RATE || 6.96); // para columnas en Bs

  // Entrega
  const DELIVERY_TITLE    = 'Lugar de entrega';
  const DELIVERY_NAME     = company.delivery_name || 'Almacenes Orange Cargo SRL';
  const DELIVERY_ADDRESS  = company.delivery_addr || 'Km 9, zona norte (lado del surtidor bioceánico)';
  const DELIVERY_SCHEDULE = company.delivery_sched|| 'Horarios: 08:00–12:00 / 13:00–17:00';

  // Condiciones
  const TERMS = company.terms || [
    'Oferta válida por 1 día a partir de la fecha, sujeta a la disponibilidad de productos.',
    'Solicite su cotización de acuerdo al volumen requerido antes de realizar cualquier pago.',
    'La única manera de fijar precio y reservar volumen, es con el pago 100% y facturado.',
    'Una vez facturado, no se aceptan cambios ni devoluciones. Excepto por producto dañado.'
  ];

  // Bancos / QR
  const BANK_TITLE  = 'Datos bancarios y QR';
  const BANK_LINES  = company.bank_lines || [
    `Titular: ${BRAND}`,
    'Moneda: Bolivianos',
    'Banco: (complete aquí)',
    'N° de cuenta: (complete aquí)'
  ];
  const BANK_QR     = company.bank_qr && fileExists(company.bank_qr) ? company.bank_qr : null;

  // ====== HEADER ======
  let y = doc.y;

  if (LOGO){
    try{ doc.image(LOGO, doc.x, y, { width: 120 }); }catch{}
  }else{
    doc.fontSize(18).text(BRAND, { continued:false });
  }

  doc.fontSize(18).text('COTIZACIÓN', 0, y, { align:'right' });
  doc.moveDown(0.2).fontSize(10).fillColor('#666')
     .text(fmtDate(quote.fecha || new Date()), { align:'right' })
     .fillColor('black');

  y = Math.max(y + 60, doc.y + 6);
  doc.moveTo(36, y).lineTo(doc.page.width-36, y).strokeColor('#e5e7eb').stroke().strokeColor('black');
  y += 10;

  // ====== CLIENTE ======
  const c = quote.cliente || {};
  doc.fontSize(11).text(`Cliente: ${c.nombre || '-'}`);
  doc.fontSize(10).text(`Zona: ${c.zona || '-'}`);
  doc.text(`Departamento: ${c.departamento || '-'}`);
  doc.text(`Pago: ${PAYMENT}`);
  doc.moveDown(0.2);
  doc.text(`Cultivo: ${c.cultivo || '-'}`);
  doc.text(`Hectáreas: ${c.hectareas || '-'}`);
  doc.text(`Campaña: ${c.campana || '-'}`);
  doc.moveDown(0.6);

  // ====== TABLA ======
  const x0 = doc.x;
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right; // 523 aprox
  const cols = [
    { key:'nombre',             label:'Producto',           w: 90,  align:'left'  },
    { key:'ingrediente_activo', label:'Ingrediente activo', w: 120, align:'left'  },
    { key:'envase',             label:'Envase',             w: 40,  align:'center'},
    { key:'cantidad',           label:'Cantidad',           w: 45,  align:'right' },
    { key:'precio_usd',         label:'Precio (USD)',       w: 55,  align:'right' },
    { key:'precio_bs',          label:'Precio (Bs)',        w: 60,  align:'right' },
    { key:'subtotal_usd',       label:'Sub total (USD)',    w: 55,  align:'right' },
    { key:'subtotal_bs',        label:'Sub total (Bs)',     w: 58,  align:'right' }
  ];
  // seguridad: suma exacta a ancho de página
  const sumW = cols.reduce((a,b)=>a+b.w,0);
  if (Math.abs(sumW - tableWidth) > 1){
    // reajusta proporcionalmente si cambian márgenes
    const k = tableWidth / sumW;
    cols.forEach(c=> c.w = Math.floor(c.w * k));
  }

  function drawHeader(){
    const hY = doc.y;
    doc.save();
    doc.rect(x0, hY, tableWidth, 20).fill('#0a8e7b');
    doc.fillColor('white').fontSize(9);
    let x = x0 + 6;
    for (const c of cols){
      doc.text(c.label, x, hY + 5, { width: c.w - 12, align: c.align || 'left' });
      x += c.w;
    }
    doc.restore();
    doc.moveDown(1.2);
  }

  function needPage(nextRowHeight = 18){
    const bottom = doc.page.height - doc.page.margins.bottom - 120; // deja espacio para secciones finales
    if (doc.y + nextRowHeight > bottom){
      doc.addPage();
      drawHeader();
    }
  }

  drawHeader();
  doc.fontSize(8.5).fillColor('black');

  const items = (quote.items || []).map(it=>{
    const qty = Number(it.cantidad || 0);
    const pUSD = Number(it.precio_usd || 0);
    const stUSD = Number(it.subtotal_usd || (qty * pUSD));
    return {
      ...it,
      precio_bs:   pUSD * RATE,
      subtotal_bs: stUSD * RATE
    };
  });

  for (const it of items){
    needPage();
    const rowH = 18;

    // zebra
    doc.save();
    doc.rect(x0, doc.y - 2, tableWidth, rowH).fillOpacity(0.06).fill('#0a8e7b').fillOpacity(1);
    doc.restore();

    let x = x0 + 6;
    const cells = [
      String(it.nombre || ''),
      String(it.ingrediente_activo || ''),
      String(it.envase || ''),
      money(it.cantidad || 0),
      money(it.precio_usd || 0),
      money(it.precio_bs || 0),
      money(it.subtotal_usd || 0),
      money(it.subtotal_bs || 0),
    ];
    cols.forEach((c, i)=>{
      doc.text(cells[i], x, doc.y + 4, { width: c.w - 12, align: c.align || 'left' });
      x += c.w;
    });
    doc.moveDown(1.1);
  }

  // Totales
  const subtotalUSD = Number(quote.subtotal_usd || items.reduce((a,b)=>a + Number(b.subtotal_usd||0), 0));
  const totalUSD    = Number(quote.total_usd    || subtotalUSD);
  const subtotalBs  = subtotalUSD * RATE;
  const totalBs     = totalUSD    * RATE;

  doc.moveDown(0.3);
  doc.moveTo(x0, doc.y).lineTo(x0 + tableWidth, doc.y).strokeColor('#d1d5db').stroke().strokeColor('black');
  doc.moveDown(0.4);

  // fila TOTAL resaltada
  const yTot = doc.y;
  const wRight = cols.slice(-2).reduce((a,b)=>a+b.w,0); // ancho de las dos últimas (subtot Bs y usd)-> usaremos toda la fila
  doc.save();
  doc.rect(x0, yTot - 2, tableWidth, 20).fill('#fff59d'); // amarillo suave
  doc.restore();
  doc.fontSize(10).font('Helvetica-Bold');
  doc.text('Total', x0 + tableWidth - 260, yTot + 4, { width: 110, align:'right' });
  doc.text(`$ ${money(totalUSD)}`, x0 + tableWidth - 140, yTot + 4, { width: 70, align:'right' });
  doc.text(`Bs ${money(totalBs)}`, x0 + tableWidth - 60,  yTot + 4, { width: 60, align:'right' });
  doc.font('Helvetica').moveDown(1.6);

  // Nota legal
  doc.fontSize(8.5).fillColor('#444')
    .text('*Nuestros precios incluyen impuestos de ley.')
    .fillColor('black');
  doc.moveDown(0.6);

  // ====== LUGAR DE ENTREGA ======
  function sectionTitle(t){
    doc.font('Helvetica-Bold').fontSize(11).fillColor('black').text(t, { underline: true });
    doc.font('Helvetica').fontSize(9.5);
  }

  sectionTitle(DELIVERY_TITLE);
  doc.text(DELIVERY_NAME);
  doc.text(DELIVERY_ADDRESS);
  doc.text(DELIVERY_SCHEDULE);
  doc.moveDown(0.8);

  // ====== CONDICIONES ======
  sectionTitle('Condiciones y validez de la oferta');
  TERMS.forEach((t, i)=> doc.text(`${i+1}.- ${t}`));
  doc.moveDown(0.8);

  // ====== BANCOS + QR ======
  sectionTitle(BANK_TITLE);
  const xLeft = doc.x;
  const yStart = doc.y;

  BANK_LINES.forEach(l => doc.text(l));

  if (BANK_QR){
    try{
      const imgW = 120;
      const xQR = doc.page.width - doc.page.margins.right - imgW;
      doc.image(BANK_QR, xQR, yStart - 6, { width: imgW });
    }catch{}
  }

  // Firma / pie opcional
  doc.moveDown(1.2);
  if (ADDR || TEL || RUC){
    doc.fontSize(8.5).fillColor('#555');
    if (ADDR) doc.text(ADDR);
    if (TEL)  doc.text(`Tel: ${TEL}`);
    if (RUC)  doc.text(`NIT: ${RUC}`);
    doc.fillColor('black');
  }

  doc.end();
  await new Promise((res, rej)=>{ stream.on('finish', res); stream.on('error', rej); });
  return outPath;
}
