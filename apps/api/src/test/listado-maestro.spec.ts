import { describe, expect, it } from 'vitest';
import {
  leerListadoMaestro,
  limpiarCelular,
  limpiarFecha,
  limpiarNombre,
  limpiarRestriccion,
  normalizarEncabezado,
} from '../modules/fleet/listado-maestro';
import { listadoDePrueba } from './listado-de-prueba';

describe('limpieza del listado maestro', () => {
  it('reconoce los encabezados aunque vengan con tildes raras y corchetes', () => {
    expect(normalizarEncabezado('Cedúla [C]')).toBe('cedula c');
    expect(normalizarEncabezado('Restricciòn2')).toBe('restriccion2');
    expect(normalizarEncabezado('# Celular [R1]')).toBe('celular r1');
    expect(normalizarEncabezado('N° Interno')).toBe('n interno');
  });

  it('arregla mayúsculas y espacios del nombre sin cambiar el orden', () => {
    expect(limpiarNombre('  TRIANA pedraza   felix  DE jesus ')).toBe('Triana Pedraza Felix de Jesus');
    expect(limpiarNombre(' William Andres Jurado García ')).toBe('William Andres Jurado García');
  });

  it('pasa los celulares colombianos a E.164 y descarta lo que no lo es', () => {
    expect(limpiarCelular(3148705926)).toBe('+573148705926');
    expect(limpiarCelular('314 8705926')).toBe('+573148705926');
    expect(limpiarCelular('573148705926')).toBe('+573148705926');
    expect(limpiarCelular('7851234')).toBeNull();
    expect(limpiarCelular(null)).toBeNull();
  });

  it('lee las fechas en UTC, que es como las entrega Excel', () => {
    expect(limpiarFecha(new Date(Date.UTC(2028, 9, 15)))).toBe('2028-10-15');
    expect(limpiarFecha('15/10/2028')).toBe('2028-10-15');
    expect(limpiarFecha('')).toBeNull();
  });

  it('«NINGUNA» no es una restricción', () => {
    expect(limpiarRestriccion('NINGUNA')).toBeNull();
    expect(limpiarRestriccion('\tCONDUCIR CON LENTES')).toBe('Conducir con lentes');
  });
});

describe('lectura del Excel', () => {
  it('lee móviles, propietarios, conductores y relevadores', async () => {
    const listado = await leerListadoMaestro(
      await listadoDePrueba([
        { interno: 2, placa: 'abc 123', propietario: ['Dueña Uno', 1000001], conductor: ['Conductor Uno', 2000001, 3001112233], relevador: ['Relevo Uno', 3000001, 3104445566] },
        { interno: '005', placa: 'ABC124', estado: 'INACTIVO', capacidad: '4+C', conductor: ['Conductor Dos', 2000002, '', 'CONDUCIR CON LENTES'] },
        { interno: '006', placa: 'ABC125' },
      ]),
    );

    expect(listado.hoja).toBe('Taxis');
    expect(listado.errores).toEqual([]);
    expect(listado.moviles).toHaveLength(3);

    const [uno, dos, tres] = listado.moviles;
    expect(uno).toMatchObject({ interno: '002', placa: 'ABC123', activo: true, marca: 'KIA', modelo: 2018, capacidad: 4 });
    expect(uno!.propietario).toEqual({ nombre: 'Dueña Uno', cedula: '1000001' });
    expect(uno!.conductor).toMatchObject({ cedula: '2000001', celular: '+573001112233', licenciaVence: '2028-06-01', restriccion: null });
    expect(uno!.relevadores).toEqual([
      expect.objectContaining({ nombre: 'Relevo Uno', cedula: '3000001', restriccion: 'Conducir con lentes' }),
    ]);
    expect(dos).toMatchObject({ activo: false, capacidad: 4 });
    expect(dos!.conductor).toMatchObject({ celular: null, restriccion: 'Conducir con lentes' });
    expect(tres!.conductor).toBeNull();
    expect(tres!.relevadores).toEqual([]);
  });

  it('junta en un solo móvil las filas con la misma placa, con todos sus conductores', async () => {
    const listado = await leerListadoMaestro(
      await listadoDePrueba([
        { interno: '010', placa: 'XYZ001', conductor: ['Titular Diez', 2000010], relevador: ['Relevo Diez', 3000010] },
        // El mismo carro otra vez, con otro conductor y repitiendo al relevador.
        { interno: '10', placa: 'xyz 001', conductor: ['Otro Diez', 2000011], relevador: ['Relevo Diez', 3000010] },
      ]),
    );
    expect(listado.errores).toEqual([]);
    expect(listado.moviles).toHaveLength(1);
    expect(listado.moviles[0]!.conductor).toMatchObject({ cedula: '2000010' });
    expect(listado.moviles[0]!.relevadores.map((p) => p.cedula)).toEqual(['3000010', '2000011']);
    expect(listado.avisos.some((a) => a.includes('ya venía en la fila'))).toBe(true);
  });

  it('no deja cargar una placa con dos internos ni un interno con dos placas', async () => {
    const listado = await leerListadoMaestro(
      await listadoDePrueba([
        { interno: '010', placa: 'XYZ001' },
        { interno: '012', placa: 'XYZ001' },
        { interno: '013', placa: 'XYZ003' },
        { interno: '013', placa: 'XYZ004' },
      ]),
    );
    expect(listado.errores).toEqual([
      'La placa XYZ001 aparece con dos números internos: 010 (fila 3) y 012 (fila 4).',
      'El número interno 013 aparece con placas distintas.',
    ]);
  });

  it('avisa del conductor sin cédula y no lo carga', async () => {
    const listado = await leerListadoMaestro(
      await listadoDePrueba([{ interno: '011', placa: 'XYZ002', conductor: ['Sin Cedula', 0] }]),
    );
    expect(listado.moviles[0]!.conductor).toBeNull();
    expect(listado.avisos.some((a) => a.includes('sin cédula válida'))).toBe(true);
  });
});
