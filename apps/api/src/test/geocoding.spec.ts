import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { GeocodingService } from '../modules/pricing/geocoding.service';
import type { ZonesService } from '../modules/pricing/zones.service';

/**
 * El filtro que separa una dirección resuelta de un taxi mal mandado.
 *
 * La llamada a Google no se prueba aquí —eso solo probaría a Google—, sino
 * lo que se hace con su respuesta, que es donde está el riesgo: Google
 * responde con mucha seguridad a cosas que no son lo que se le pidió. El
 * parámetro `bounds` solo sesga la búsqueda, no la limita, así que una
 * «Carrera 21» puede llegar perfectamente desde Tunja o desde Bogotá.
 *
 * Aceptar uno de esos puntos manda un taxi a otro municipio. Devolver `null`
 * solo hace que el agente pida la ubicación, que además es más precisa.
 */

/** Rectángulo real de la cobertura de Paipa, de las zonas sembradas. */
const CAJA = { south: 5.703, west: -73.205, north: 5.837, east: -73.046 };
const EN_EL_CENTRO = { lat: 5.7803, lng: -73.1142 };

function hacerZonas(opciones: { clasifica?: boolean; caja?: typeof CAJA | undefined } = {}) {
  return {
    boundingBox: () => ('caja' in opciones ? opciones.caja : CAJA),
    classify: () => (opciones.clasifica === false ? undefined : { id: 'z1', name: 'Centro' }),
  } as unknown as ZonesService;
}

/** Redis que no guarda nada: cada prueba parte de cero. */
function hacerRedis(almacen = new Map<string, string>()) {
  return {
    get: async (k: string) => almacen.get(k) ?? null,
    set: async (k: string, v: string) => {
      almacen.set(k, v);
      return 'OK';
    },
  } as unknown as Redis;
}

function respuestaDeGoogle(cuerpo: unknown, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => cuerpo })) as never;
}

interface Extra {
  types?: string[];
  partial_match?: boolean;
  /** La vía que Google dice haber encontrado («Carrera 19»). */
  ruta?: string;
}

const RESULTADO = (lat: number, lng: number, tipo = 'ROOFTOP', extra: Extra = {}) => ({
  formatted_address: 'Cra. 12 A # 31B-14, Paipa, Boyacá, Colombia',
  types: extra.types ?? ['street_address'],
  ...(extra.partial_match ? { partial_match: true } : {}),
  ...(extra.ruta ? { address_components: [{ long_name: extra.ruta, short_name: extra.ruta, types: ['route'] }] } : {}),
  geometry: { location: { lat, lng }, location_type: tipo },
});

const UN_RESULTADO = (lat: number, lng: number, tipo = 'ROOFTOP', extra: Extra = {}) => ({
  status: 'OK',
  results: [RESULTADO(lat, lng, tipo, extra)],
});

const fetchOriginal = globalThis.fetch;

describe('GeocodingService', () => {
  beforeEach(() => {
    process.env.GOOGLE_GEOCODING_API_KEY = 'clave-de-prueba-suficientemente-larga';
  });

  afterEach(() => {
    globalThis.fetch = fetchOriginal;
    vi.restoreAllMocks();
  });

  it('acepta una dirección que cae dentro de la cobertura', async () => {
    globalThis.fetch = respuestaDeGoogle(UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng));
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    const r = await servicio.resolve('Cra. 12 A # 31B-14');

    expect(r).not.toBeNull();
    expect(r!.point).toEqual(EN_EL_CENTRO);
    expect(r!.exacta).toBe(true);
  });

  it('marca como no exacta la que Google interpola entre dos números', async () => {
    globalThis.fetch = respuestaDeGoogle(
      UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng, 'RANGE_INTERPOLATED'),
    );
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    const r = await servicio.resolve('Carrera 21 # 24-18');

    expect(r!.exacta).toBe(false);
  });

  /*
   * Lo que pasó en producción el 3/11/2026: una dirección que no existe
   * acabó con un punto en el mapa. Google no dice «no existe»: devuelve lo
   * que se le parece y lo marca como coincidencia parcial.
   */
  it('rechaza una coincidencia parcial: la dirección no existe tal cual', async () => {
    globalThis.fetch = respuestaDeGoogle(
      UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng, 'GEOMETRIC_CENTER', {
        types: ['route'],
        partial_match: true,
        ruta: 'Carrera 19',
      }),
    );
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    expect(await servicio.resolve('Carrera 19 # 47 20')).toBeNull();
  });

  it('rechaza la calle entera: su punto es el centro de varios kilómetros de vía', async () => {
    globalThis.fetch = respuestaDeGoogle(
      UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng, 'GEOMETRIC_CENTER', { types: ['route'], ruta: 'Carrera 21' }),
    );
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    expect(await servicio.resolve('Carrera 21')).toBeNull();
  });

  it('rechaza el municipio o un barrio entero', async () => {
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    globalThis.fetch = respuestaDeGoogle(
      UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng, 'APPROXIMATE', { types: ['locality', 'political'] }),
    );
    expect(await servicio.resolve('donde la señora Rosa')).toBeNull();

    globalThis.fetch = respuestaDeGoogle(
      UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng, 'APPROXIMATE', { types: ['neighborhood', 'political'] }),
    );
    expect(await servicio.resolve('barrio el carmen')).toBeNull();
  });

  it('rechaza otra vía: «Carrera 19» no es la «Calle 19»', async () => {
    globalThis.fetch = respuestaDeGoogle(
      UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng, 'ROOFTOP', { ruta: 'Calle 19' }),
    );
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    expect(await servicio.resolve('Carrera 19 # 47-20')).toBeNull();
  });

  it('acepta la misma vía escrita de otra forma', async () => {
    globalThis.fetch = respuestaDeGoogle(
      UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng, 'ROOFTOP', { ruta: 'Carrera 12A' }),
    );
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    expect(await servicio.resolve('Kra 12 a # 31B-14')).not.toBeNull();
  });

  it('acepta un sitio con nombre aunque no tenga nomenclatura', async () => {
    globalThis.fetch = respuestaDeGoogle(
      UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng, 'GEOMETRIC_CENTER', {
        types: ['lodging', 'establishment', 'point_of_interest'],
      }),
    );
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    expect(await servicio.resolve('Hotel Lanceros')).not.toBeNull();
  });

  it('se queda con el primer resultado que sirva, no con el primero', async () => {
    globalThis.fetch = respuestaDeGoogle({
      status: 'OK',
      results: [
        RESULTADO(5.7787, -73.1171, 'APPROXIMATE', { types: ['locality', 'political'] }),
        RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng, 'ROOFTOP'),
      ],
    });
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    expect((await servicio.resolve('Carrera 21 # 24-18'))!.point).toEqual(EN_EL_CENTRO);
  });

  it('rechaza un punto de otro municipio aunque Google lo dé por bueno', async () => {
    // Tunja, a 40 km. `bounds` sesga la búsqueda pero no la limita.
    globalThis.fetch = respuestaDeGoogle(UN_RESULTADO(5.5353, -73.3678));
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    expect(await servicio.resolve('Carrera 21')).toBeNull();
  });

  it('rechaza un punto que cae en un hueco sin zona con servicio', async () => {
    // Dentro del rectángulo, pero fuera de todo polígono: ahí no hay taxis
    // a los que ofrecerle la carrera.
    globalThis.fetch = respuestaDeGoogle(UN_RESULTADO(5.72, -73.09));
    const servicio = new GeocodingService(hacerRedis(), hacerZonas({ clasifica: false }));

    expect(await servicio.resolve('Una finca lejos')).toBeNull();
  });

  it('devuelve null cuando Google no encuentra nada', async () => {
    globalThis.fetch = respuestaDeGoogle({ status: 'ZERO_RESULTS', results: [] });
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    expect(await servicio.resolve('asdfgh qwerty')).toBeNull();
  });

  it('devuelve null si la clave está mal, sin tumbar la carrera', async () => {
    globalThis.fetch = respuestaDeGoogle({ status: 'REQUEST_DENIED', error_message: 'clave inválida' });
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    expect(await servicio.resolve('Carrera 21')).toBeNull();
  });

  it('devuelve null si el geocodificador no responde', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as never;
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    expect(await servicio.resolve('Carrera 21')).toBeNull();
  });

  it('sin clave configurada no inventa nada', async () => {
    /*
     * La configuración se lee una vez al arrancar y se memoriza, que es lo
     * correcto en producción. Para probar el arranque sin clave hay que
     * volver a cargar los módulos, no basta con borrar la variable: si solo
     * se borrara, esta prueba pasaría por la clave que puso la de antes y no
     * estaría comprobando nada.
     */
    vi.resetModules();
    delete process.env.GOOGLE_GEOCODING_API_KEY;
    const { GeocodingService: SinClave } = await import('../modules/pricing/geocoding.service');

    const llamadas = respuestaDeGoogle(UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng));
    globalThis.fetch = llamadas;

    expect(await new SinClave(hacerRedis(), hacerZonas()).resolve('Carrera 21')).toBeNull();
    expect(llamadas).not.toHaveBeenCalled();
  });

  it('no vuelve a preguntar por una dirección que ya resolvió', async () => {
    const llamadas = respuestaDeGoogle(UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng));
    globalThis.fetch = llamadas;
    const redis = hacerRedis();

    const primera = new GeocodingService(redis, hacerZonas());
    await primera.resolve('Carrera 21 # 24-18');
    // Mismo texto con otro espaciado y otras mayúsculas: es la misma dirección.
    const segunda = new GeocodingService(redis, hacerZonas());
    const r = await segunda.resolve('  CARRERA 21  #   24-18 ');

    expect(llamadas).toHaveBeenCalledTimes(1);
    expect(r!.point).toEqual(EN_EL_CENTRO);
  });

  it('tampoco vuelve a preguntar por una que no existe', async () => {
    const llamadas = respuestaDeGoogle({ status: 'ZERO_RESULTS', results: [] });
    globalThis.fetch = llamadas;
    const redis = hacerRedis();

    await new GeocodingService(redis, hacerZonas()).resolve('direccion que no existe');
    const r = await new GeocodingService(redis, hacerZonas()).resolve('direccion que no existe');

    expect(llamadas).toHaveBeenCalledTimes(1);
    expect(r).toBeNull();
  });

  it('ignora un texto demasiado corto para ser una dirección', async () => {
    const llamadas = respuestaDeGoogle(UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng));
    globalThis.fetch = llamadas;
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    expect(await servicio.resolve('ahí')).toBeNull();
    expect(llamadas).not.toHaveBeenCalled();
  });

  it('con Redis caído resuelve igual, solo sin caché', async () => {
    globalThis.fetch = respuestaDeGoogle(UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng));
    const redisRoto = {
      get: async () => {
        throw new Error('Redis caído');
      },
      set: async () => {
        throw new Error('Redis caído');
      },
    } as unknown as Redis;

    const r = await new GeocodingService(redisRoto, hacerZonas()).resolve('Carrera 21 # 24-18');

    expect(r!.point).toEqual(EN_EL_CENTRO);
  });

  /*
   * Con la clave mal restringida, Google responde REQUEST_DENIED. Si eso se
   * guardara como «no existe», cada dirección de ese rato quedaría un mes sin
   * ubicarse aunque la clave se arreglara enseguida.
   */
  it('no guarda en la caché un rechazo de Google: arreglada la clave, se vuelve a buscar', async () => {
    const redis = hacerRedis();
    globalThis.fetch = respuestaDeGoogle({ status: 'REQUEST_DENIED', error_message: 'This IP is not authorized' });
    expect(await new GeocodingService(redis, hacerZonas()).resolve('Carrera 21 # 24-18')).toBeNull();

    const llamadas = respuestaDeGoogle(UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng));
    globalThis.fetch = llamadas;
    const r = await new GeocodingService(redis, hacerZonas()).resolve('Carrera 21 # 24-18');

    expect(llamadas).toHaveBeenCalledTimes(1);
    expect(r!.point).toEqual(EN_EL_CENTRO);
  });

  it('el estado dice si Google trabaja, y por qué no', async () => {
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());
    expect(servicio.estado().estado).toBe('sin_verificar');

    globalThis.fetch = respuestaDeGoogle({ status: 'REQUEST_DENIED', error_message: 'This IP is not authorized' });
    await servicio.resolve('Carrera 21 # 24-18');
    expect(servicio.estado().estado).toBe('rechazada');
    expect(servicio.estado().detalle).toContain('This IP is not authorized');

    globalThis.fetch = respuestaDeGoogle(UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng));
    await servicio.resolve('Carrera 22 # 25-14');
    expect(servicio.estado().estado).toBe('ok');
  });

  it('cuenta lo de hoy: lo que fue a Google y lo que salió de la caché', async () => {
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());
    globalThis.fetch = respuestaDeGoogle(UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng));

    expect((await servicio.resolverConMotivo('Carrera 21 # 24-18')).motivo).toBe('google');
    expect((await servicio.resolverConMotivo('carrera 21 # 24-18')).motivo).toBe('cache');

    const hoy = servicio.estado().hoy;
    expect(hoy.consultasAGoogle).toBe(1);
    expect(hoy.ubicadas).toBe(1);
    expect(hoy.desdeCache).toBe(1);
  });

  it('la prueba de la clave va a Google aunque la dirección esté en la caché', async () => {
    const llamadas = respuestaDeGoogle(UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng));
    globalThis.fetch = llamadas;
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    await servicio.resolve('Carrera 22 # 25-14');
    const prueba = await servicio.probar();

    expect(llamadas).toHaveBeenCalledTimes(2);
    expect(prueba.resultado).toBe('ubicada');
    expect(servicio.estado().ultimaPrueba?.resultado).toBe('ubicada');
  });
});
