import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Point } from '@tax/shared';
import { REDIS, redisKeys } from '../../redis/redis.module';
import { loadEnv } from '../../config/env';
import { ZonesService } from './zones.service';

export interface DireccionResuelta {
  point: Point;
  /** Lo que el geocodificador entendió, para poder confirmárselo al cliente. */
  formatted: string;
  /** `true` cuando acertó el portal exacto; `false` si se quedó en la calle. */
  exacta: boolean;
}

/**
 * Direcciones a coordenadas.
 *
 * La API no acepta carreras sin punto: sin él no hay radio de oleada ni
 * candidatos, y no se puede despachar. Pero por WhatsApp la gente escribe
 * «Cra. 12 A # 31B-14», no coordenadas, así que alguien tiene que traducir.
 *
 * Ese alguien es la API y no el agente de n8n, a propósito. Un modelo que
 * copia coordenadas de una respuesta a otra puede cambiar un dígito sin que
 * nadie lo note, y un dígito en la cuarta decimal son once metros: el taxi
 * acaba en la otra acera, o en la otra cuadra. Aquí las coordenadas nunca
 * pasan por el modelo: entra texto y sale un punto comprobado.
 *
 * Lo que se comprueba antes de devolverlo:
 *
 *  - que caiga dentro del rectángulo de la cobertura, que se le pide también
 *    a Google como sesgo de búsqueda;
 *  - que caiga dentro de alguna zona con servicio, que es más estricto que
 *    el rectángulo y es lo que de verdad determina si hay taxis cerca.
 *
 * Si algo de eso falla, devuelve `null`. Nunca un punto «aproximado» ni el
 * centro del pueblo: es preferible pedirle la ubicación al cliente que
 * mandarle un taxi a una calle que no es la suya.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly env = loadEnv();
  /** Un mes: una dirección no se mueve, y así no se paga dos veces. */
  private static readonly CACHE_SEGUNDOS = 60 * 60 * 24 * 30;
  /** Más de esto y se prefiere pedir la ubicación a hacer esperar al cliente. */
  private static readonly TIEMPO_LIMITE_MS = 4000;

  private avisoDeClaveDado = false;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly zones: ZonesService,
  ) {}

  async resolve(direccion: string): Promise<DireccionResuelta | null> {
    const consulta = direccion.trim().toLowerCase().replace(/\s+/g, ' ');
    if (consulta.length < 4) return null;

    if (!this.env.GOOGLE_GEOCODING_API_KEY) {
      // Una vez, no en cada carrera: si falta la clave es un problema de
      // configuración, y repetirlo por cada petición solo tapa el resto.
      if (!this.avisoDeClaveDado) {
        this.logger.warn('Sin GOOGLE_GEOCODING_API_KEY: las carreras necesitarán coordenadas');
        this.avisoDeClaveDado = true;
      }
      return null;
    }

    const enCache = await this.leerDeCache(consulta);
    if (enCache !== undefined) return enCache;

    const resuelta = await this.preguntarAGoogle(consulta);

    // También se cachea el fallo. Si una dirección no existe hoy, tampoco
    // existirá dentro de un minuto, y el cliente suele reenviarla igual.
    await this.guardarEnCache(consulta, resuelta);
    return resuelta;
  }

  /* ----------------------------------------------------------- interno */

  private async preguntarAGoogle(consulta: string): Promise<DireccionResuelta | null> {
    const caja = this.zones.boundingBox();

    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', `${consulta}, Paipa, Boyacá, Colombia`);
    url.searchParams.set('components', 'country:CO');
    url.searchParams.set('language', 'es');
    url.searchParams.set('region', 'co');
    if (caja) {
      url.searchParams.set('bounds', `${caja.south},${caja.west}|${caja.north},${caja.east}`);
    }
    url.searchParams.set('key', this.env.GOOGLE_GEOCODING_API_KEY!);

    const control = new AbortController();
    const temporizador = setTimeout(() => control.abort(), GeocodingService.TIEMPO_LIMITE_MS);

    let cuerpo: GoogleRespuesta;
    try {
      const respuesta = await fetch(url, { signal: control.signal });
      if (!respuesta.ok) {
        this.logger.warn({ status: respuesta.status }, 'El geocodificador respondió mal');
        return null;
      }
      cuerpo = (await respuesta.json()) as GoogleRespuesta;
    } catch (error) {
      // Red caída o demasiado lento. No es motivo para que falle la carrera:
      // el agente pedirá la ubicación, que además es más precisa.
      this.logger.warn({ error }, 'No se pudo consultar el geocodificador');
      return null;
    } finally {
      clearTimeout(temporizador);
    }

    if (cuerpo.status === 'ZERO_RESULTS') return null;
    if (cuerpo.status !== 'OK') {
      // REQUEST_DENIED, OVER_QUERY_LIMIT: problemas de configuración o de
      // cuenta que hay que ver en los logs, no «no se encontró».
      this.logger.error(
        { status: cuerpo.status, error: cuerpo.error_message },
        'El geocodificador rechazó la consulta',
      );
      return null;
    }

    // El primero que sirva, no el primero a secas: con una dirección a medias
    // Google suele poner delante el municipio entero.
    for (const candidato of cuerpo.results ?? []) {
      const point = this.comprobar(consulta, candidato, caja);
      if (point) {
        return {
          point,
          formatted: candidato.formatted_address ?? consulta,
          exacta: candidato.geometry?.location_type === 'ROOFTOP',
        };
      }
    }
    return null;
  }

  /**
   * El punto de un resultado de Google, si de verdad es lo que se pidió.
   *
   * Google responde con mucha seguridad a cosas que no son la dirección del
   * cliente. En la prueba de producción del 3 de noviembre, «Carrera 19 #
   * 47 20», que no existe en Paipa, acabó con un punto en el mapa. Lo que no
   * vale, aunque caiga dentro de la cobertura:
   *
   *  - `partial_match`: Google no encontró todo lo pedido y devuelve lo que
   *    se le pareció, casi siempre la calle o el municipio;
   *  - un resultado que es una zona y no un sitio —el municipio, un barrio,
   *    la calle entera—: su punto es el centro de algo que puede medir
   *    kilómetros, y el taxi llegaría a ese centro;
   *  - otra vía: si el cliente escribió «Carrera 19» y Google contesta con la
   *    «Calle 19», es otra dirección.
   *
   * Devolver `null` deja la carrera «sin ubicar» y el agente le pide la
   * ubicación al cliente, que además es más precisa.
   */
  private comprobar(consulta: string, candidato: GoogleResultado, caja: ReturnType<ZonesService['boundingBox']>): Point | null {
    if (!candidato.geometry?.location) return null;
    const point: Point = { lat: candidato.geometry.location.lat, lng: candidato.geometry.location.lng };
    const tipos = candidato.types ?? [];

    if (candidato.partial_match) {
      this.logger.warn({ consulta, tipos }, 'El geocodificador solo encontró una parte de la dirección');
      return null;
    }
    if (!tipos.some((tipo) => TIPOS_PRECISOS.has(tipo))) {
      this.logger.warn({ consulta, tipos }, 'El geocodificador devolvió una zona, no un sitio');
      return null;
    }

    const pedida = viaDe(consulta);
    const ruta = candidato.address_components?.find((c) => c.types?.includes('route'));
    const hallada = ruta ? (viaDe(ruta.long_name ?? '') ?? viaDe(ruta.short_name ?? '')) : null;
    if (pedida && hallada && !mismaVia(pedida, hallada)) {
      this.logger.warn({ consulta, ruta: ruta?.long_name }, 'El geocodificador devolvió otra vía');
      return null;
    }

    if (caja) {
      const dentroDeCaja =
        point.lat >= caja.south && point.lat <= caja.north && point.lng >= caja.west && point.lng <= caja.east;
      if (!dentroDeCaja) {
        // `bounds` solo sesga la búsqueda, no la limita: Google puede
        // devolver una calle del mismo nombre en otro municipio.
        this.logger.warn({ consulta, point }, 'El geocodificador salió de la cobertura');
        return null;
      }
    }

    // Más estricto que el rectángulo: dentro de la caja hay huecos sin zona,
    // y un punto ahí no tendría conductores a los que ofrecerle la carrera.
    if (!this.zones.classify(point)) {
      this.logger.warn({ consulta, point }, 'La dirección cae fuera de toda zona con servicio');
      return null;
    }

    return point;
  }

  private async leerDeCache(consulta: string): Promise<DireccionResuelta | null | undefined> {
    try {
      const crudo = await this.redis.get(redisKeys.geocode(consulta));
      if (crudo === null) return undefined;
      return crudo === 'null' ? null : (JSON.parse(crudo) as DireccionResuelta);
    } catch {
      // Redis caído no puede impedir pedir un taxi.
      return undefined;
    }
  }

  private async guardarEnCache(consulta: string, valor: DireccionResuelta | null): Promise<void> {
    try {
      await this.redis.set(
        redisKeys.geocode(consulta),
        JSON.stringify(valor),
        'EX',
        GeocodingService.CACHE_SEGUNDOS,
      );
    } catch {
      // Igual: no guardar en caché solo cuesta una consulta más.
    }
  }
}

/**
 * Los tipos de resultado que son un sitio y no una zona: una dirección con
 * número, un cruce, un edificio o un lugar con nombre (un hotel, el parque,
 * la terminal). Fuera quedan `route` (la calle entera), `neighborhood`,
 * `locality` y demás divisiones: su punto es el centro de un área.
 */
const TIPOS_PRECISOS = new Set([
  'street_address',
  'premise',
  'subpremise',
  'intersection',
  'establishment',
  'point_of_interest',
]);

interface Via {
  tipo: 'calle' | 'carrera' | 'diagonal' | 'transversal' | 'avenida';
  numero: string;
  letra?: string;
}

const TIPOS_DE_VIA: Record<string, Via['tipo']> = {
  calle: 'calle', cll: 'calle', cl: 'calle', clle: 'calle',
  carrera: 'carrera', carera: 'carrera', cra: 'carrera', kra: 'carrera', kr: 'carrera', cr: 'carrera', crr: 'carrera',
  diagonal: 'diagonal', dg: 'diagonal', diag: 'diagonal',
  transversal: 'transversal', tv: 'transversal', tr: 'transversal', trans: 'transversal',
  avenida: 'avenida', av: 'avenida', avda: 'avenida',
};

/** «Cra. 12A # 31B-14» → carrera 12 A. La primera vía que nombra el texto. */
export function viaDe(texto: string): Via | null {
  const normal = texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const hallada = /\b(calle|clle|cll|cl|carrera|carera|crr|cra|kra|kr|cr|diagonal|diag|dg|transversal|trans|tv|tr|avenida|avda|av)\b\.?\s*(\d+)\s*([a-z])?\b/.exec(
    normal,
  );
  if (!hallada) return null;
  return { tipo: TIPOS_DE_VIA[hallada[1]!]!, numero: hallada[2]!, ...(hallada[3] ? { letra: hallada[3] } : {}) };
}

/** Misma vía: mismo tipo y número, y la misma letra si el cliente la dio. */
function mismaVia(pedida: Via, hallada: Via): boolean {
  if (pedida.tipo !== hallada.tipo || Number(pedida.numero) !== Number(hallada.numero)) return false;
  return !pedida.letra || pedida.letra === hallada.letra;
}

interface GoogleResultado {
  formatted_address?: string;
  types?: string[];
  partial_match?: boolean;
  address_components?: { long_name?: string; short_name?: string; types?: string[] }[];
  geometry?: { location?: { lat: number; lng: number }; location_type?: string };
}

interface GoogleRespuesta {
  status: string;
  error_message?: string;
  results?: GoogleResultado[];
}
