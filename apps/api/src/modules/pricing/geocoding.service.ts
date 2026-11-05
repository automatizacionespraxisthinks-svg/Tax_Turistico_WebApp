import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { ZONA_HORARIA_PAIPA, type Point } from '@tax/shared';
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
 * Por qué una dirección se ubicó o no. Va a los registros de cada carrera:
 * con eso se ve de un vistazo si Google está trabajando o no.
 */
export type MotivoGeocodificacion =
  | 'sin_clave'
  | 'corta'
  | 'cache'
  | 'google'
  | 'sin_resultado'
  | 'descartada'
  | 'rechazada'
  | 'sin_respuesta';

export interface PruebaDelGeocodificador {
  en: string;
  direccion: string;
  ms: number;
  resultado: 'ubicada' | 'descartada' | 'sin_resultado' | 'rechazada' | 'sin_respuesta' | 'sin_clave';
  formatted: string | null;
  exacta: boolean | null;
  /** El mensaje de Google o del error, tal cual. */
  detalle: string | null;
}

/**
 * Cómo está el geocodificador, para el panel: como las líneas de WhatsApp.
 *
 *  - `sin_clave`: falta `GOOGLE_GEOCODING_API_KEY`; ninguna dirección escrita
 *    se ubica.
 *  - `sin_verificar`: hay clave, pero Google todavía no ha respondido.
 *  - `ok`: Google respondió la última vez, con o sin resultado.
 *  - `rechazada`: Google rechazó la clave (restricción de IP, API sin
 *    habilitar, facturación) o se pasó la cuota.
 *  - `sin_respuesta`: no se pudo hablar con Google (red o tiempo).
 */
export interface EstadoGeocodificador {
  estado: 'sin_clave' | 'sin_verificar' | 'ok' | 'rechazada' | 'sin_respuesta';
  detalle: string | null;
  /** La última vez que Google contestó algo, bien o mal. */
  respondioEn: string | null;
  ultimaPrueba: PruebaDelGeocodificador | null;
  /** Lo de hoy en Paipa. Vive en memoria: vuelve a cero al reiniciar la API. */
  hoy: {
    dia: string;
    consultasAGoogle: number;
    ubicadas: number;
    descartadas: number;
    sinResultado: number;
    desdeCache: number;
    sinClave: number;
    fallos: number;
  };
}

/**
 * La dirección con la que se prueba la clave: la de la Alcaldía, que Google
 * y OpenStreetMap ubican en el mismo punto. Cada prueba es una consulta que
 * Google cuenta dentro del cupo.
 */
const DIRECCION_DE_PRUEBA = 'Carrera 22 # 25-14';

const diaEnPaipa = (fecha = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA_PAIPA }).format(fecha);

type Respuesta = { resuelta: DireccionResuelta | null; motivo: MotivoGeocodificacion; detalle?: string };

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
 *
 * Al arrancar prueba la clave con una dirección conocida, y cada consulta
 * deja dicho en los registros si Google trabajó o no y por qué.
 */
@Injectable()
export class GeocodingService implements OnModuleInit {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly env = loadEnv();
  /** Un mes: una dirección no se mueve, y así no se paga dos veces. */
  private static readonly CACHE_SEGUNDOS = 60 * 60 * 24 * 30;
  /** Más de esto y se prefiere pedir la ubicación a hacer esperar al cliente. */
  private static readonly TIEMPO_LIMITE_MS = 4000;

  private actual: Pick<EstadoGeocodificador, 'estado' | 'detalle' | 'respondioEn'>;
  private ultimaPrueba: PruebaDelGeocodificador | null = null;
  private hoy: EstadoGeocodificador['hoy'] = GeocodingService.ceros();

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly zones: ZonesService,
  ) {
    this.actual = {
      estado: this.env.GOOGLE_GEOCODING_API_KEY ? 'sin_verificar' : 'sin_clave',
      detalle: null,
      respondioEn: null,
    };
  }

  /**
   * Al arrancar, una línea que dice si las direcciones escritas se van a
   * ubicar o no. La prueba no se espera: Google lento no puede retrasar el
   * arranque de la API.
   */
  onModuleInit(): void {
    if (!this.env.GOOGLE_GEOCODING_API_KEY) {
      this.logger.warn(
        'Geocodificador APAGADO: falta GOOGLE_GEOCODING_API_KEY. Las direcciones escritas quedan «sin ubicar» y se despachan desde el punto de partida.',
      );
      return;
    }
    void this.probar().catch((error: unknown) => this.logger.error({ error }, 'No se pudo probar el geocodificador'));
  }

  estado(): EstadoGeocodificador {
    return { ...this.actual, ultimaPrueba: this.ultimaPrueba, hoy: this.contadores() };
  }

  /**
   * Prueba la clave con una dirección conocida, sin pasar por la caché.
   * Es lo que hace el botón «Probar ahora» del panel.
   */
  async probar(): Promise<PruebaDelGeocodificador> {
    const en = new Date().toISOString();
    if (!this.env.GOOGLE_GEOCODING_API_KEY) {
      this.ultimaPrueba = {
        en,
        direccion: DIRECCION_DE_PRUEBA,
        ms: 0,
        resultado: 'sin_clave',
        formatted: null,
        exacta: null,
        detalle: 'Falta GOOGLE_GEOCODING_API_KEY en la API',
      };
      return this.ultimaPrueba;
    }

    const inicio = performance.now();
    const r = await this.preguntarAGoogle(DIRECCION_DE_PRUEBA.toLowerCase());
    const ms = Math.round(performance.now() - inicio);
    const resultado: PruebaDelGeocodificador['resultado'] =
      r.motivo === 'google' ? 'ubicada' : (r.motivo as PruebaDelGeocodificador['resultado']);

    this.ultimaPrueba = {
      en,
      direccion: DIRECCION_DE_PRUEBA,
      ms,
      resultado,
      formatted: r.resuelta?.formatted ?? null,
      exacta: r.resuelta?.exacta ?? null,
      detalle: r.detalle ?? null,
    };

    if (r.motivo === 'rechazada' || r.motivo === 'sin_respuesta') {
      this.logger.error(
        { prueba: DIRECCION_DE_PRUEBA, ms, detalle: r.detalle },
        `Geocodificador SIN SERVICIO: ${r.motivo === 'rechazada' ? 'Google rechazó la clave' : 'Google no respondió'}. Las direcciones escritas quedan «sin ubicar».`,
      );
    } else {
      this.logger.log(
        { prueba: DIRECCION_DE_PRUEBA, ms, resultado, formatted: r.resuelta?.formatted },
        `Geocodificador ENCENDIDO: Google respondió en ${ms} ms`,
      );
    }
    return this.ultimaPrueba;
  }

  async resolve(direccion: string): Promise<DireccionResuelta | null> {
    return (await this.resolverConMotivo(direccion)).resuelta;
  }

  /** Como `resolve`, diciendo por qué. Deja una línea en el registro y cuenta. */
  async resolverConMotivo(direccion: string): Promise<Respuesta> {
    const r = await this.resolverSinContar(direccion);
    this.contar(r.motivo);

    const datos = { direccion, motivo: r.motivo, ...(r.detalle ? { detalle: r.detalle } : {}) };
    switch (r.motivo) {
      case 'sin_clave':
        this.logger.log(datos, 'Dirección sin ubicar: no hay clave de Google, no se consultó');
        break;
      case 'cache':
        this.logger.log(
          { ...datos, ubicada: Boolean(r.resuelta) },
          r.resuelta ? 'Dirección ubicada desde la caché (Google no se consultó)' : 'Dirección sin ubicar desde la caché: Google ya no la había encontrado',
        );
        break;
      case 'google':
        this.logger.log(
          { ...datos, formatted: r.resuelta?.formatted, exacta: r.resuelta?.exacta },
          'Dirección ubicada con Google',
        );
        break;
      case 'sin_resultado':
      case 'descartada':
        this.logger.log(datos, r.motivo === 'descartada' ? 'Dirección sin ubicar: Google respondió, pero no con el sitio exacto' : 'Dirección sin ubicar: Google no la encontró');
        break;
      case 'rechazada':
      case 'sin_respuesta':
        this.logger.warn(datos, 'Dirección sin ubicar: Google no está trabajando');
        break;
      case 'corta':
        break;
    }
    return r;
  }

  /* ----------------------------------------------------------- interno */

  private async resolverSinContar(direccion: string): Promise<Respuesta> {
    const consulta = direccion.trim().toLowerCase().replace(/\s+/g, ' ');
    if (consulta.length < 4) return { resuelta: null, motivo: 'corta' };
    if (!this.env.GOOGLE_GEOCODING_API_KEY) return { resuelta: null, motivo: 'sin_clave' };

    const enCache = await this.leerDeCache(consulta);
    if (enCache !== undefined) return { resuelta: enCache, motivo: 'cache' };

    const r = await this.preguntarAGoogle(consulta);

    /*
     * Se guarda lo que Google contestó, también «no existe»: si una dirección
     * no existe hoy, tampoco existirá dentro de un minuto, y el cliente suele
     * reenviarla igual. Pero NO un fallo de Google: con la clave mal puesta,
     * cada dirección de ese rato quedaría un mes como «no existe», aunque la
     * clave se arreglara a los cinco minutos.
     */
    if (r.motivo === 'google' || r.motivo === 'sin_resultado' || r.motivo === 'descartada') {
      await this.guardarEnCache(consulta, r.resuelta);
    }
    return r;
  }

  private async preguntarAGoogle(consulta: string): Promise<Respuesta> {
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
        return this.sinServicio('sin_respuesta', `Google respondió HTTP ${respuesta.status}`);
      }
      cuerpo = (await respuesta.json()) as GoogleRespuesta;
    } catch (error) {
      // Red caída o demasiado lento. No es motivo para que falle la carrera:
      // el agente pedirá la ubicación, que además es más precisa.
      this.logger.warn({ error }, 'No se pudo consultar el geocodificador');
      return this.sinServicio(
        'sin_respuesta',
        control.signal.aborted ? `Sin respuesta en ${GeocodingService.TIEMPO_LIMITE_MS / 1000} s` : String(error),
      );
    } finally {
      clearTimeout(temporizador);
    }

    if (cuerpo.status === 'ZERO_RESULTS') {
      this.respondio();
      return { resuelta: null, motivo: 'sin_resultado' };
    }
    if (cuerpo.status !== 'OK') {
      // REQUEST_DENIED, OVER_QUERY_LIMIT: problemas de configuración o de
      // cuenta que hay que ver en los logs, no «no se encontró».
      this.logger.error(
        { status: cuerpo.status, error: cuerpo.error_message },
        'El geocodificador rechazó la consulta',
      );
      return this.sinServicio('rechazada', `${cuerpo.status}${cuerpo.error_message ? `: ${cuerpo.error_message}` : ''}`);
    }
    this.respondio();

    // El primero que sirva, no el primero a secas: con una dirección a medias
    // Google suele poner delante el municipio entero.
    for (const candidato of cuerpo.results ?? []) {
      const point = this.comprobar(consulta, candidato, caja);
      if (point) {
        return {
          resuelta: {
            point,
            formatted: candidato.formatted_address ?? consulta,
            exacta: candidato.geometry?.location_type === 'ROOFTOP',
          },
          motivo: 'google',
        };
      }
    }
    return { resuelta: null, motivo: 'descartada', detalle: cuerpo.results?.[0]?.formatted_address };
  }

  private respondio(): void {
    this.actual = { estado: 'ok', detalle: null, respondioEn: new Date().toISOString() };
  }

  private sinServicio(motivo: 'rechazada' | 'sin_respuesta', detalle: string): Respuesta {
    this.actual = {
      estado: motivo,
      detalle,
      respondioEn: motivo === 'rechazada' ? new Date().toISOString() : this.actual.respondioEn,
    };
    return { resuelta: null, motivo, detalle };
  }

  private static ceros(): EstadoGeocodificador['hoy'] {
    return {
      dia: diaEnPaipa(),
      consultasAGoogle: 0,
      ubicadas: 0,
      descartadas: 0,
      sinResultado: 0,
      desdeCache: 0,
      sinClave: 0,
      fallos: 0,
    };
  }

  private contadores(): EstadoGeocodificador['hoy'] {
    if (this.hoy.dia !== diaEnPaipa()) this.hoy = GeocodingService.ceros();
    return { ...this.hoy };
  }

  private contar(motivo: MotivoGeocodificacion): void {
    const hoy = (this.hoy = this.contadores());
    switch (motivo) {
      case 'sin_clave':
        hoy.sinClave++;
        break;
      case 'cache':
        hoy.desdeCache++;
        break;
      case 'google':
        hoy.consultasAGoogle++;
        hoy.ubicadas++;
        break;
      case 'sin_resultado':
        hoy.consultasAGoogle++;
        hoy.sinResultado++;
        break;
      case 'descartada':
        hoy.consultasAGoogle++;
        hoy.descartadas++;
        break;
      case 'rechazada':
      case 'sin_respuesta':
        hoy.consultasAGoogle++;
        hoy.fallos++;
        break;
      case 'corta':
        break;
    }
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
