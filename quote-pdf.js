// quote-pdf.js
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

function fmtDate(d=new Date()){
  const pad = n => String(n).padStart(2,'0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
}
function money(n){ return (Number(n||0)).toFixed(2); }

export async function renderQuotePDF(quote, outPath, company={}){
  const dir = path.dirname(outPath);
  try{ fs.mkdirSync(dir, { recursive:true }); }catch{}
  const doc = new PDFDocument({ size:'A4', margin:36 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const brand = company.brand || 'New Chem Agroquímicos';
  const ruc   = company.ruc   || '';
  const tel   = company.tel   || '';
  const dirc  = company.dir   || '';

  // Header
  doc.fontSize(18).text('COTIZACIÓN', { align:'right' });
  doc.moveDown(0.3).fontSize(10).fillColor('#666')
     .text(`Fecha: ${fmtDate(quote.fecha)}`, { align:'right' })
     .fillColor('black');

  doc.fontSize(16).text(brand);
  if (dirc) doc.fontSize(10).fillColor('#444').text(dirc);
  if (tel)  doc.text(`Tel: ${tel}`);
  if (ruc)  doc.text(`NIT: ${ruc}`);
  doc.moveDown(0.6).fillColor('black');

  // Cliente
  const c = quote.cliente || {};
  doc.fontSize(12).text(`Cliente: ${c.nombre || '-'}`);
  doc.fontSize(10).fillColor('#444')
    .text(`Departamento: ${c.departamento || '-'}`)
    .text(`Zona: ${c.zona || '-'}`)
    .text(`Cultivo: ${c.cultivo || '-'}`)
    .text(`Hectáreas: ${c.hectareas || '-'}`)
    .text(`Campaña: ${c.campana || '-'}`)
    .moveDown(0.8).fillColor('black');

  // Tabla
  const cols = [
    { key:'nombre', label:'Producto', w:170 },
    { key:'ingrediente_activo', label:'Ingrediente activo', w:130 },
    { key:'envase', label:'Envase', w:70 },
    { key:'unidad', label:'U.', w:30, align:'center' },
    { key:'cantidad', label:'Cant.', w:50, align:'right' },
    { key:'precio_usd', label:'Precio (USD)', w:80, align:'right' },
    { key:'subtotal_usd', label:'Subtotal (USD)', w:90, align:'right' },
  ];

  const x0 = doc.x, y0 = doc.y;
  doc.fontSize(10).fillColor('white').rect(x0, y0, 523, 20).fill('#0a8e7b');
  let x = x0 + 6, y = y0 + 5;
  for (const ccol of cols){
    const align = ccol.align || 'left';
    doc.fillColor('white').text(ccol.label, x, y, { width: ccol.w-12, align });
    x += ccol.w;
  }
  y += 22; doc.fillColor('black');

  // Filas
  doc.fontSize(9);
  for (const it of (quote.items||[])){
    x = x0 + 6;
    const rowH = 18;
    // zebra
    doc.save();
    doc.rect(x0, y-4, 523, rowH).fillOpacity(0.06).fill('#0a8e7b').fillOpacity(1);
    doc.restore();

    const cells = [
      String(it.nombre||''),
      String(it.ingrediente_activo||''),
      String(it.envase||''),
      String(it.unidad||''),
      String(it.cantidad||0),
      money(it.precio_usd),
      money(it.subtotal_usd),
    ];
    for (let i=0;i<cols.length;i++){
      const ccol = cols[i];
      const align = ccol.align || 'left';
      doc.fillColor('black').text(cells[i], x, y, { width: ccol.w-12, align });
      x += ccol.w;
    }
    y += rowH;
    if (y > 760){ doc.addPage(); y = doc.y; }
  }

  // Totales
  y += 6;
  doc.moveTo(x0, y).lineTo(x0+523, y).strokeColor('#ccc').stroke().strokeColor('black');

  y += 10;
  doc.fontSize(11).text(`Subtotal (USD): ${money(quote.subtotal_usd)}`, x0+340, y, { width: 180, align:'right' });
  y += 16;
  doc.fontSize(12).text(`TOTAL (USD): ${money(quote.total_usd)}`, x0+340, y, { width: 180, align:'right' });

  y += 28;
  doc.fontSize(9).fillColor('#444')
    .text('Notas:', x0, y)
    .text('• Compra mínima: US$ 3.000 (puedes combinar productos).', x0, y+12)
    .text('• La entrega de tu pedido se realiza en nuestro almacén.', x0, y+24)
    .fillColor('black');

  doc.end();
  await new Promise((res, rej)=>{ stream.on('finish', res); stream.on('error', rej); });
  return outPath;
}
