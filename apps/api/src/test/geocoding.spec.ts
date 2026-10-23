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

const UN_RESULTADO = (lat: number, lng: number, tipo = 'ROOFTOP') => ({
  status: 'OK',
  results: [
    {
      formatted_address: 'Cra. 12 A # 31B-14, Paipa, Boyacá, Colombia',
      geometry: { location: { lat, lng }, location_type: tipo },
    },
  ],
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

  it('marca como no exacta la que se queda en la calle, sin el número', async () => {
    globalThis.fetch = respuestaDeGoogle(
      UN_RESULTADO(EN_EL_CENTRO.lat, EN_EL_CENTRO.lng, 'GEOMETRIC_CENTER'),
    );
    const servicio = new GeocodingService(hacerRedis(), hacerZonas());

    const r = await servicio.resolve('Carrera 21');

    expect(r!.exacta).toBe(false);
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
});
