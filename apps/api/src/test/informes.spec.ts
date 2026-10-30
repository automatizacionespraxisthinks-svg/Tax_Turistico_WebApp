import { describe, expect, it } from 'vitest';
import {
  diasDelRango,
  fechasDelRango,
  filtrosDeInformeSchema,
  periodoDelRango,
  rangoDePeriodo,
  textoDelRango,
} from '@tax/shared';
import { resumir, type FilaCarrera } from '../modules/reports/exports.data';
import {
  comoDuracion,
  comoTextoPlano,
  enPalabras,
  frasePeriodo,
  horasPico,
  rangoHorario,
} from '../modules/reports/informes.texto';

/** Las horas llevan espacios que no parten la línea; aquí se comparan como espacios. */
const plano = (s: string) => s.replace(/ /g, ' ');

/** Una carrera de prueba: finalizada, urbana, sin operador. */
function carrera(cambios: Partial<FilaCarrera> = {}): FilaCarrera {
  return {
    codigo: 'R-2026-000001',
    // 13:00 UTC son las 8 de la mañana en Paipa.
    creada: new Date('2026-10-22T13:10:00Z'),
    estado: 'COMPLETED',
    estadoTexto: 'Finalizada',
    zona: 'Centro',
    zonaTipo: 'urbano',
    recogida: 'Calle 25 #18-40',
    referencia: null,
    destino: null,
    pasajeros: 1,
    pagoElectronico: false,
    vehiculo: 'sedan',
    cliente: 'Cliente',
    telefono: '+573001112233',
    conductorId: 'c1',
    conductorCodigo: '101',
    conductor: 'Jairo',
    placa: 'UBP472',
    distanciaKm: 3,
    asignacionSegundos: 71,
    llegadaSegundos: 360,
    duracionMinutos: 12,
    linea: 'Línea 1',
    intentos: 1,
    motivoCancelacion: null,
    finalizada: new Date('2026-10-22T13:40:00Z'),
    intervenida: false,
    ...cambios,
  };
}

describe('periodos del tablero', () => {
  const hoy = '2026-10-28';

  it('arma los periodos rápidos en días de Paipa', () => {
    expect(rangoDePeriodo('hoy', hoy)).toEqual({ desde: hoy, hasta: hoy });
    expect(rangoDePeriodo('ayer', hoy)).toEqual({ desde: '2026-10-27', hasta: '2026-10-27' });
    expect(rangoDePeriodo('7d', hoy)).toEqual({ desde: '2026-10-22', hasta: hoy });
    expect(rangoDePeriodo('30d', hoy)).toEqual({ desde: '2026-09-29', hasta: hoy });
    expect(rangoDePeriodo('mes', hoy)).toEqual({ desde: '2026-10-01', hasta: hoy });
    expect(rangoDePeriodo('mes_pasado', hoy)).toEqual({ desde: '2026-09-01', hasta: '2026-09-30' });
    // Enero: el mes pasado es diciembre del año anterior.
    expect(rangoDePeriodo('mes_pasado', '2027-01-15')).toEqual({ desde: '2026-12-01', hasta: '2026-12-31' });
  });

  it('reconoce el periodo rápido de un rango y cuenta sus días', () => {
    expect(periodoDelRango('2026-10-22', hoy, hoy)).toBe('7d');
    expect(periodoDelRango('2026-10-20', hoy, hoy)).toBeNull();
    expect(diasDelRango('2026-10-22', hoy)).toBe(7);
    expect(fechasDelRango('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('escribe el rango corto como en la barra de filtros', () => {
    expect(textoDelRango('2026-10-22', hoy)).toBe('22 oct – 28 oct 2026');
    expect(textoDelRango(hoy, hoy)).toBe('28 oct 2026');
    expect(textoDelRango('2025-12-29', '2026-01-04')).toBe('29 dic 2025 – 4 ene 2026');
  });

  it('valida los filtros que llegan por la dirección', () => {
    const ok = filtrosDeInformeSchema.parse({
      desde: '2026-10-22',
      hasta: hoy,
      zonas: '0190f6a0-0000-7000-8000-000000000001,0190f6a0-0000-7000-8000-000000000002',
      lineas: 'Línea 1',
      sinPruebas: 'false',
    });
    expect(ok.zonas).toHaveLength(2);
    expect(ok.lineas).toEqual(['Línea 1']);
    expect(ok.sinPruebas).toBe(false);
    expect(filtrosDeInformeSchema.parse({ desde: hoy, hasta: hoy }).sinPruebas).toBe(true);

    expect(filtrosDeInformeSchema.safeParse({ desde: hoy, hasta: '2026-10-01' }).success).toBe(false);
    expect(filtrosDeInformeSchema.safeParse({ desde: '2026-01-01', hasta: hoy }).success).toBe(false);
  });
});

describe('resumen en palabras', () => {
  it('dice la duración como se habla', () => {
    expect(comoDuracion(45)).toBe('45 s');
    expect(comoDuracion(71)).toBe('1 min 11 s');
    expect(comoDuracion(120)).toBe('2 min');
    expect(comoDuracion(372)).toBe('6 min 12 s');
    expect(comoDuracion(725)).toBe('12 min');
  });

  it('dice las horas con a. m., m. y p. m.', () => {
    expect(plano(rangoHorario(8, 9))).toBe('de 8 a 9 a. m.');
    expect(plano(rangoHorario(13, 14))).toBe('de 1 a 2 p. m.');
    expect(plano(rangoHorario(11, 12))).toBe('de 11 a. m. a 12 m.');
    expect(plano(rangoHorario(12, 13))).toBe('de 12 m. a 1 p. m.');
  });

  it('escribe el periodo según caiga en el mismo mes o no', () => {
    expect(frasePeriodo('2026-10-22', '2026-10-28')).toBe('Del 22 al 28 de octubre');
    expect(frasePeriodo('2026-09-28', '2026-10-04')).toBe('Del 28 de septiembre al 4 de octubre');
    expect(frasePeriodo('2026-10-28', '2026-10-28')).toBe('El 28 de octubre');
  });

  it('junta dos horas pico seguidas en un solo tramo', () => {
    const porHora = Array.from({ length: 24 }, (_, h) => ({
      hora: String(h).padStart(2, '0'),
      carreras: h === 8 ? 5 : h === 9 ? 4 : h === 13 ? 3 : 0,
      urbano: 0,
      rural: 0,
    }));
    expect(horasPico(porHora)).toEqual([{ desde: 8, hasta: 10 }]);
  });

  it('cuenta el periodo como en la imagen guía', () => {
    // 13 carreras: 9 terminadas, 3 canceladas y 1 abierta; 7 con operador,
    // así que el asistente resolvió solo 6 de 13, unas 5 de cada 10.
    const filas: FilaCarrera[] = [
      ...Array.from({ length: 9 }, (_, i) =>
        carrera({ intervenida: i < 4, creada: new Date(`2026-10-2${2 + (i % 5)}T${i % 2 ? '18' : '13'}:05:00Z`) }),
      ),
      ...Array.from({ length: 3 }, () =>
        carrera({ estado: 'CANCELLED', intervenida: true, creada: new Date('2026-10-23T18:30:00Z') }),
      ),
      carrera({ estado: 'IN_PROGRESS', creada: new Date('2026-10-28T13:20:00Z') }),
    ];
    const texto = plano(comoTextoPlano(enPalabras(resumir(filas), { desde: '2026-10-22', hasta: '2026-10-28' })));

    expect(texto).toContain('Del 22 al 28 de octubre hubo 13 carreras: 9 terminadas, 3 canceladas y 1 sigue abierta.');
    expect(texto).toContain('El taxi se consiguió normalmente en 1 min 11 s, un poco más que la meta de 1 minuto.');
    expect(texto).toContain('El asistente atendió solo 5 de cada 10 pedidos sin ayuda, por debajo de la meta de 8 de 10.');
    expect(texto.endsWith('Los momentos con más pedidos fueron de 8 a 9 a. m. y de 1 a 2 p. m.')).toBe(true);
  });

  it('pone en negrita las cifras, no el texto que las rodea', () => {
    const fragmentos = enPalabras(resumir([carrera()]), { desde: '2026-10-22', hasta: '2026-10-22' });
    expect(fragmentos.filter((f) => f.fuerte).map((f) => f.texto)).toContain('1 carrera');
    expect(fragmentos[0]).toEqual({ texto: 'El 22 de octubre hubo ' });
  });

  it('habla del conductor elegido y lo compara con el grupo', () => {
    const texto = comoTextoPlano(
      enPalabras(
        resumir([carrera(), carrera({ estado: 'CANCELLED' })]),
        { desde: '2026-10-22', hasta: '2026-10-28' },
        {
          nombre: 'Jairo',
          codigo: '101',
          ofertas: 10,
          tasaAceptacion: 0.9,
          grupo: { tasaAceptacion: 0.7, llegadaP50: 480 },
        },
      ),
    );
    expect(texto).toContain('Del 22 al 28 de octubre, Jairo (101) tomó 2 carreras: 1 terminada y 1 cancelada.');
    expect(texto).toContain('Llegó al cliente en 6 min, frente a 8 min del grupo.');
    expect(texto).toContain('Aceptó 9 de cada 10 ofertas que le llegaron; el grupo, 7 de cada 10.');
    // La asignación no depende de un conductor: no se le atribuye.
    expect(texto).not.toContain('El taxi se consiguió');
  });

  it('lo dice claro cuando no hubo nada', () => {
    expect(comoTextoPlano(enPalabras(resumir([]), { desde: '2026-10-28', hasta: '2026-10-28' }))).toBe(
      'El 28 de octubre no hubo carreras con estos filtros.',
    );
  });
});

describe('agregados del tablero', () => {
  it('llena con ceros los días sin carreras y ubica el calor en hora de Paipa', () => {
    const r = resumir([carrera()], fechasDelRango('2026-10-21', '2026-10-23'));
    expect(r.porDia.map((d) => [d.dia, d.carreras])).toEqual([
      ['2026-10-21', 0],
      ['2026-10-22', 1],
      ['2026-10-23', 0],
    ]);
    // El 22 de octubre de 2026 es jueves (fila 3, lunes primero), a las 8.
    expect(r.calor[3]![8]).toBe(1);
    expect(r.porHora[8]).toMatchObject({ carreras: 1, urbano: 1, rural: 0 });
  });

  it('cuenta por conductor lo que tomó, lo que terminó y lo que se le canceló', () => {
    const r = resumir([carrera(), carrera({ estado: 'CANCELLED', duracionMinutos: null }), carrera({ conductorId: null })]);
    expect(r.porConductor).toEqual([
      expect.objectContaining({ id: 'c1', asignadas: 2, finalizadas: 1, canceladas: 1, km: 3 }),
    ]);
    expect(r.cancelaciones).toEqual([{ motivo: 'Sin motivo escrito', carreras: 1 }]);
  });
});
