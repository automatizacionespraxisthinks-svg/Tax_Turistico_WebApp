import { METAS, duracionCorta, type Fragmento } from '@tax/shared';
import type { Resumen } from './exports.data';

/*
 * El resumen en palabras del tablero de Reportes y del PDF.
 *
 * Lo que diría alguien de la oficina que miró las cifras: cuántas carreras,
 * si se cumplieron las metas y a qué hora se llenó el servicio. Sale de las
 * mismas cifras que las tarjetas, así que nunca las contradice.
 */

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function partes(fecha: string) {
  const [a, m, d] = fecha.split('-').map(Number);
  return { ano: a!, mes: MESES[m! - 1]!, dia: d! };
}

/** «Del 22 al 28 de octubre», «Del 28 de septiembre al 4 de octubre», «El 28 de octubre». */
export function frasePeriodo(desde: string, hasta: string): string {
  const a = partes(desde);
  const b = partes(hasta);
  if (desde === hasta) return `El ${b.dia} de ${b.mes}`;
  if (a.ano !== b.ano) return `Del ${a.dia} de ${a.mes} de ${a.ano} al ${b.dia} de ${b.mes} de ${b.ano}`;
  if (a.mes !== b.mes) return `Del ${a.dia} de ${a.mes} al ${b.dia} de ${b.mes}`;
  return `Del ${a.dia} al ${b.dia} de ${b.mes}`;
}

/** «45 s», «1 min 11 s», «6 min»: el mismo formato que las tarjetas del panel. */
export const comoDuracion = duracionCorta;

/** Espacio que no parte la línea: «11 a. m.» no puede quedar en «11 a.» y «m.». */
const NBSP = ' ';

/** Las horas como se dicen en Colombia: «8 a. m.», «12 m.», «1 p. m.». */
function hora12(h: number): { n: number; sufijo: string } {
  const hora = ((h % 24) + 24) % 24;
  if (hora === 12) return { n: 12, sufijo: 'm.' };
  return { n: hora % 12 || 12, sufijo: hora < 12 ? `a.${NBSP}m.` : `p.${NBSP}m.` };
}

/** «de 8 a 9 a. m.», «de 11 a. m. a 12 m.»; `hasta` es la hora en que termina. */
export function rangoHorario(desde: number, hasta: number): string {
  const a = hora12(desde);
  const b = hora12(hasta);
  return a.sufijo === b.sufijo
    ? `de ${a.n} a ${b.n}${NBSP}${b.sufijo}`
    : `de ${a.n}${NBSP}${a.sufijo} a ${b.n}${NBSP}${b.sufijo}`;
}

/**
 * Las dos horas con más pedidos, juntas si son seguidas: un pico de 8 a 10
 * se lee mejor así que como dos picos de una hora pegados.
 */
export function horasPico(porHora: Resumen['porHora']): { desde: number; hasta: number }[] {
  const mejores = porHora
    .map((h) => ({ hora: Number(h.hora), carreras: h.carreras }))
    .filter((h) => h.carreras > 0)
    .sort((a, b) => b.carreras - a.carreras || a.hora - b.hora)
    .slice(0, 2)
    .map((h) => h.hora)
    .sort((a, b) => a - b);

  const rangos: { desde: number; hasta: number }[] = [];
  for (const hora of mejores) {
    const ultimo = rangos[rangos.length - 1];
    if (ultimo && ultimo.hasta === hora) ultimo.hasta = hora + 1;
    else rangos.push({ desde: hora, hasta: hora + 1 });
  }
  return rangos;
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** «a, b y c». */
function enumerar(cosas: string[]): string {
  if (cosas.length <= 1) return cosas.join('');
  return `${cosas.slice(0, -1).join(', ')} y ${cosas[cosas.length - 1]}`;
}

const deCadaDiez = (tasa: number) => Math.round(tasa * 10);

export interface DatosIndividuales {
  nombre: string;
  codigo: string;
  ofertas: number;
  tasaAceptacion: number | null;
  grupo: { tasaAceptacion: number | null; llegadaP50: number | null };
}

/**
 * El párrafo de «En pocas palabras». Con un conductor elegido habla de él y
 * lo compara con el resto; sin conductor, de la operación entera.
 */
export function enPalabras(
  r: Resumen,
  periodo: { desde: string; hasta: string },
  individual?: DatosIndividuales,
): Fragmento[] {
  const texto: Fragmento[] = [];
  const decir = (t: string, fuerte = false) => texto.push(fuerte ? { texto: t, fuerte } : { texto: t });
  const cuando = frasePeriodo(periodo.desde, periodo.hasta);

  if (r.creadas === 0) {
    decir(
      individual
        ? `${cuando}, ${individual.nombre} no tuvo carreras con estos filtros.`
        : `${cuando} no hubo carreras con estos filtros.`,
    );
    return texto;
  }

  /* --- cuántas y cómo terminaron */
  const abiertas = r.enCurso;
  const desglose = [
    r.finalizadas ? plural(r.finalizadas, 'terminada', 'terminadas') : '',
    r.canceladas ? plural(r.canceladas, 'cancelada', 'canceladas') : '',
    r.sinAsignar ? `${r.sinAsignar} ${r.sinAsignar === 1 ? 'se quedó' : 'se quedaron'} sin taxi` : '',
    abiertas ? `${abiertas} ${abiertas === 1 ? 'sigue abierta' : 'siguen abiertas'}` : '',
  ].filter(Boolean);

  if (individual) {
    decir(`${cuando}, ${individual.nombre} (${individual.codigo}) tomó `);
  } else {
    decir(`${cuando} hubo `);
  }
  decir(plural(r.creadas, 'carrera', 'carreras'), true);
  decir(`: ${enumerar(desglose)}.`);

  /* --- conseguir taxi: no depende de un conductor, solo se dice del grupo */
  if (!individual && r.asignacionP50 !== null) {
    const meta = METAS.asignacionSegundos;
    const comparado =
      r.asignacionP50 <= meta ? 'dentro de' : r.asignacionP50 <= meta * 1.5 ? 'un poco más que' : 'bastante más que';
    decir(' El taxi se consiguió normalmente en ');
    decir(comoDuracion(r.asignacionP50), true);
    decir(`, ${comparado} la meta de ${meta === 60 ? '1 minuto' : comoDuracion(meta)}.`);
  }

  /* --- llegar al cliente */
  if (r.llegadaP50 !== null) {
    decir(individual ? ' Llegó al cliente en ' : ' El conductor llegó al cliente en ');
    decir(comoDuracion(r.llegadaP50), true);
    if (individual?.grupo.llegadaP50 != null) {
      decir(`, frente a ${comoDuracion(individual.grupo.llegadaP50)} del grupo.`);
    } else {
      const meta = METAS.llegadaMinutos * 60;
      decir(r.llegadaP50 <= meta ? `, dentro del objetivo de ${METAS.llegadaMinutos} min.` : `, por encima del objetivo de ${METAS.llegadaMinutos} min.`);
    }
  }

  /* --- el asistente, o cuánto acepta el conductor */
  if (individual) {
    if (individual.ofertas > 0 && individual.tasaAceptacion !== null) {
      decir(' Aceptó ');
      decir(`${deCadaDiez(individual.tasaAceptacion)} de cada 10 ofertas`, true);
      decir(
        individual.grupo.tasaAceptacion !== null
          ? ` que le llegaron; el grupo, ${deCadaDiez(individual.grupo.tasaAceptacion)} de cada 10.`
          : ' que le llegaron.',
      );
    }
  } else if (r.sinIntervencion !== null) {
    const n = deCadaDiez(r.sinIntervencion);
    const meta = deCadaDiez(METAS.sinIntervencion);
    decir(n < meta ? ' El asistente atendió solo ' : ' El asistente atendió ');
    decir(`${n} de cada 10 pedidos`, true);
    decir(
      ` sin ayuda, ${n < meta ? 'por debajo de' : n === meta ? 'justo en' : 'por encima de'} la meta de ${meta} de 10.`,
    );
  }

  /* --- los picos */
  const picos = horasPico(r.porHora);
  if (picos.length > 0) {
    decir(picos.length === 1 ? ' El momento con más pedidos fue ' : ' Los momentos con más pedidos fueron ');
    picos.forEach((p, i) => {
      if (i > 0) decir(' y ');
      decir(rangoHorario(p.desde, p.hasta), true);
    });
    // Sin punto final: «p. m.» ya lo trae, y uno más se leería «p. m..».
  }

  return texto;
}

export const comoTextoPlano = (fragmentos: Fragmento[]) => fragmentos.map((f) => f.texto).join('');
