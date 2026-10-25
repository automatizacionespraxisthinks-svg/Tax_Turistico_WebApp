import PDFDocument from 'pdfkit';
import { formatMoney } from '@tax/shared';
import { formatoFechaHora, resumir, type Periodo } from './exports.data';

/*
 * El PDF del resumen del periodo.
 *
 * Con las fuentes estándar de PDF (Helvetica): no hay que empaquetar ninguna
 * y cubren el español entero —tildes, eñes, «comillas»—. Lo que no cubren
 * son flechas y emojis, así que aquí no se usa ninguno.
 */

const ANCHO = 515; // A4 menos 40 de margen a cada lado.
const IZQ = 40;
const TINTA = '#1F2328';
const SECUNDARIA = '#4B5563';
const APAGADA = '#6B7280';
const LINEA = '#E3E6EA';
const FONDO = '#F4F5F7';
const CABECERA = '#EEF0F3';
const SERIE = '#3B6FD8';

type Doc = PDFKit.PDFDocument;

interface Col {
  titulo: string;
  ancho: number;
  derecha?: boolean;
}

const fondoDePagina = (doc: Doc) => doc.page.height - doc.page.margins.bottom;

/** Si no cabe `alto` en lo que queda de página, salta a la siguiente. */
function asegurar(doc: Doc, alto: number): void {
  if (doc.y + alto > fondoDePagina(doc)) doc.addPage();
}

function tituloDeSeccion(doc: Doc, texto: string, nota?: string): void {
  asegurar(doc, 60);
  doc.moveDown(1.2);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(TINTA).text(texto, IZQ, doc.y);
  if (nota) doc.font('Helvetica').fontSize(8).fillColor(APAGADA).text(nota);
  doc.moveDown(0.4);
}

/** Tabla con cabecera que se repite al saltar de página. */
function tabla(doc: Doc, columnas: Col[], filas: string[][]): void {
  const ALTO = 16;

  const cabecera = () => {
    const y = doc.y;
    doc.rect(IZQ, y, ANCHO, ALTO).fill(CABECERA);
    let x = IZQ;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(SECUNDARIA);
    for (const c of columnas) {
      doc.text(c.titulo, x + 5, y + 4.5, { width: c.ancho - 10, align: c.derecha ? 'right' : 'left', lineBreak: false });
      x += c.ancho;
    }
    doc.y = y + ALTO;
  };

  asegurar(doc, ALTO * 2);
  cabecera();

  if (filas.length === 0) {
    doc.font('Helvetica').fontSize(8.5).fillColor(APAGADA).text('Sin datos en el periodo.', IZQ + 5, doc.y + 5);
    doc.y += 6;
    return;
  }

  filas.forEach((fila, i) => {
    if (doc.y + ALTO > fondoDePagina(doc)) {
      doc.addPage();
      cabecera();
    }
    const y = doc.y;
    if (i % 2 === 1) doc.rect(IZQ, y, ANCHO, ALTO).fill(FONDO);
    let x = IZQ;
    doc.font('Helvetica').fontSize(8.5).fillColor(TINTA);
    fila.forEach((valor, j) => {
      const c = columnas[j]!;
      doc.text(valor, x + 5, y + 4.5, {
        width: c.ancho - 10,
        align: c.derecha ? 'right' : 'left',
        lineBreak: false,
        ellipsis: true,
        height: ALTO - 4,
      });
      x += c.ancho;
    });
    doc.y = y + ALTO;
  });
  doc.moveTo(IZQ, doc.y).lineTo(IZQ + ANCHO, doc.y).lineWidth(0.5).strokeColor(LINEA).stroke();
}

/** Cifras grandes del periodo, en cajas de cuatro por fila. */
function cifras(doc: Doc, items: { etiqueta: string; valor: string; nota?: string }[]): void {
  const SEP = 8;
  const ancho = (ANCHO - SEP * 3) / 4;
  const alto = 54;

  for (let i = 0; i < items.length; i += 4) {
    asegurar(doc, alto + SEP);
    const y = doc.y;
    items.slice(i, i + 4).forEach((item, j) => {
      const x = IZQ + j * (ancho + SEP);
      doc.roundedRect(x, y, ancho, alto, 4).fill(FONDO);
      doc.font('Helvetica').fontSize(7.5).fillColor(APAGADA)
        .text(item.etiqueta.toUpperCase(), x + 8, y + 8, { width: ancho - 16, lineBreak: false, characterSpacing: 0.3 });
      doc.font('Helvetica-Bold').fontSize(15).fillColor(TINTA)
        .text(item.valor, x + 8, y + 21, { width: ancho - 16, lineBreak: false });
      if (item.nota) {
        doc.font('Helvetica').fontSize(7).fillColor(APAGADA)
          .text(item.nota, x + 8, y + 40, { width: ancho - 16, lineBreak: false, ellipsis: true });
      }
    });
    doc.y = y + alto + SEP;
  }
}

/** Barras verticales de las 24 horas, sobre una línea base y con su valor encima. */
function barrasPorHora(doc: Doc, horas: { hora: string; carreras: number }[]): void {
  const ALTO = 110;
  asegurar(doc, ALTO + 30);
  const base = doc.y + ALTO;
  const maximo = Math.max(1, ...horas.map((h) => h.carreras));
  const paso = ANCHO / horas.length;
  const ancho = paso - 4;

  horas.forEach((h, i) => {
    const x = IZQ + i * paso + 2;
    const alto = (h.carreras / maximo) * (ALTO - 14);
    if (alto > 0) {
      doc.rect(x, base - alto, ancho, alto).fill(SERIE);
      doc.font('Helvetica').fontSize(6.5).fillColor(SECUNDARIA)
        .text(String(h.carreras), x - 4, base - alto - 9, { width: ancho + 8, align: 'center', lineBreak: false });
    }
    if (i % 3 === 0) {
      doc.font('Helvetica').fontSize(7).fillColor(APAGADA)
        .text(`${h.hora}h`, x - 4, base + 4, { width: ancho + 8, align: 'center', lineBreak: false });
    }
  });
  doc.moveTo(IZQ, base).lineTo(IZQ + ANCHO, base).lineWidth(0.75).strokeColor(LINEA).stroke();
  doc.y = base + 18;
}

const pesos = (n: number | null) => (n === null ? '—' : formatMoney(n));
const segundos = (n: number | null) => (n === null ? '—' : `${n} s`);

export function generarPdf(periodo: Periodo, opciones: { titulo: string; pedidoPor: string }): Promise<Buffer> {
  const r = resumir(periodo.filas);
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    bufferPages: true,
    info: { Title: opciones.titulo, Author: 'Tax Turístico' },
  });

  const partes: Buffer[] = [];
  doc.on('data', (parte: Buffer) => partes.push(parte));
  const listo = new Promise<Buffer>((resolver, rechazar) => {
    doc.on('end', () => resolver(Buffer.concat(partes)));
    doc.on('error', rechazar);
  });

  /* ---------------------------------------------------------- portada --- */
  doc.font('Helvetica').fontSize(9).fillColor(APAGADA).text('TAX TURÍSTICO · PAIPA', { characterSpacing: 0.6 });
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(18).fillColor(TINTA).text(opciones.titulo);
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(9).fillColor(SECUNDARIA)
    .text(`Del ${formatoFechaHora(periodo.desde)} al ${formatoFechaHora(periodo.hasta)}, hora de Paipa.`)
    .text(`Generado por ${opciones.pedidoPor}.`);
  if (periodo.recortado) {
    doc.fillColor('#B45309').text(`Recortado a las ${periodo.filas.length} carreras más recientes.`);
  }
  doc.moveDown(1);

  cifras(doc, [
    { etiqueta: 'Carreras creadas', valor: String(r.creadas) },
    { etiqueta: 'Finalizadas', valor: String(r.finalizadas) },
    { etiqueta: 'Canceladas', valor: String(r.canceladas) },
    { etiqueta: 'Sin asignar', valor: String(r.sinAsignar), nota: r.enCurso ? `${r.enCurso} en curso al generar` : undefined },
    { etiqueta: 'Facturado', valor: pesos(r.facturado), nota: 'Carreras finalizadas' },
    { etiqueta: 'Tarifa media', valor: pesos(r.tarifaMedia) },
    {
      etiqueta: 'Asignación',
      valor: segundos(r.asignacionP50),
      nota: r.asignacionP95 === null ? 'Mediana' : `Mediana · p95 ${r.asignacionP95} s`,
    },
    {
      etiqueta: 'Sin intervención',
      valor: r.sinIntervencion === null ? '—' : `${Math.round(r.sinIntervencion * 100)} %`,
      nota: 'Meta inicial 80 %',
    },
  ]);

  /* -------------------------------------------------------- secciones --- */
  tituloDeSeccion(doc, 'Carreras por hora', 'Hora de creación, en hora de Paipa.');
  barrasPorHora(doc, r.porHora);

  tituloDeSeccion(doc, 'Demanda por zona');
  tabla(
    doc,
    [
      { titulo: 'Zona', ancho: 170 },
      { titulo: 'Tipo', ancho: 65 },
      { titulo: 'Carreras', ancho: 65, derecha: true },
      { titulo: 'Finalizadas', ancho: 70, derecha: true },
      { titulo: 'Canceladas', ancho: 70, derecha: true },
      { titulo: 'Facturado', ancho: 75, derecha: true },
    ],
    r.porZona.map((z) => [z.zona, z.tipo, String(z.carreras), String(z.finalizadas), String(z.canceladas), pesos(z.facturado)]),
  );

  tituloDeSeccion(doc, 'Por día', 'Tiempo hasta la asignación: segundos entre crear la carrera y que un conductor la acepte.');
  tabla(
    doc,
    [
      { titulo: 'Día', ancho: 125 },
      { titulo: 'Carreras', ancho: 95, derecha: true },
      { titulo: 'Finalizadas', ancho: 95, derecha: true },
      { titulo: 'Asignación p50', ancho: 100, derecha: true },
      { titulo: 'Asignación p95', ancho: 100, derecha: true },
    ],
    r.porDia.map((d) => [d.dia, String(d.carreras), String(d.finalizadas), segundos(d.p50), segundos(d.p95)]),
  );

  tituloDeSeccion(doc, 'Por conductor', 'Carreras finalizadas. Facturado: la tarifa final, o la estimada si no la hubo.');
  tabla(
    doc,
    [
      { titulo: 'Código', ancho: 60 },
      { titulo: 'Conductor', ancho: 215 },
      { titulo: 'Finalizadas', ancho: 75, derecha: true },
      { titulo: 'Facturado', ancho: 90, derecha: true },
      { titulo: 'Km', ancho: 75, derecha: true },
    ],
    r.porConductor.map((c) => [c.codigo, c.nombre, String(c.finalizadas), pesos(c.facturado), c.km.toFixed(1)]),
  );

  /* -------------------------------------------------------- pie de página --- */
  const paginas = doc.bufferedPageRange();
  for (let i = 0; i < paginas.count; i++) {
    doc.switchToPage(paginas.start + i);
    // Sin margen inferior un momento: escribir por debajo de él abriría otra página.
    const margen = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(APAGADA)
      .text(`${opciones.titulo} · página ${i + 1} de ${paginas.count}`, IZQ, doc.page.height - 28, {
        width: ANCHO,
        align: 'center',
        lineBreak: false,
      });
    doc.page.margins.bottom = margen;
  }

  doc.end();
  return listo;
}
