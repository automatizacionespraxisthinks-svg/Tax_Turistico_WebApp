import { Inject, Injectable, Logger } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { loadEnv } from '../../config/env';
import { eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { ridePhotos, rides } from '../../db/schema';
import { AppError } from '../../common/problem';
import { AuditService } from '../audit/audit.service';
import type { Actor } from './rides.service';

/** Una foto de WhatsApp pesa unos cientos de KB; 5 MB es el techo del §8.2. */
export const MAX_FOTO_BYTES = 5 * 1024 * 1024;

const TIEMPO_DESCARGA_MS = 15_000;

const MAX_REDIRECCIONES = 3;

/** Direcciones a las que nunca se le pide una foto: las del propio servidor y su red. */
const PRIVADAS = new BlockList();
for (const [red, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
] as const) {
  PRIVADAS.addSubnet(red, bits, 'ipv4');
}
for (const [red, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  PRIVADAS.addSubnet(red, bits, 'ipv6');
}

export function esPrivada(direccion: string): boolean {
  // Una IPv4 escrita como IPv6 (::ffff:10.0.0.1) se mira como IPv4.
  const v4 = direccion.toLowerCase().startsWith('::ffff:') ? direccion.slice(7) : null;
  if (v4 && isIP(v4) === 4) return PRIVADAS.check(v4, 'ipv4');
  return PRIVADAS.check(direccion, isIP(direccion) === 6 ? 'ipv6' : 'ipv4');
}

async function destinoPermitido(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError('VALIDATION_FAILED', 'El enlace de la foto tiene que ser http o https');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const permitidos = loadEnv().FOTO_HOSTS_PERMITIDOS;
  if (permitidos.length > 0) {
    if (!permitidos.some((h) => host === h || host.endsWith(`.${h}`))) {
      throw new AppError('VALIDATION_FAILED', 'Ese servidor no está entre los permitidos para fotos');
    }
    return;
  }
  const direcciones = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (direcciones.length === 0 || direcciones.some((d) => esPrivada(d.address))) {
    throw new AppError('VALIDATION_FAILED', 'El enlace de la foto apunta a una dirección no permitida');
  }
}

/** Lee el cuerpo hasta `tope` bytes; si lo pasa, corta la descarga y devuelve nulo. */
async function leerConTope(respuesta: Response, tope: number): Promise<Buffer | null> {
  if (Number(respuesta.headers.get('content-length') ?? 0) > tope) return null;
  if (!respuesta.body) return Buffer.alloc(0);
  const lector = respuesta.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.byteLength;
    if (total > tope) {
      await lector.cancel();
      return null;
    }
    partes.push(value);
  }
  return Buffer.concat(partes);
}

/**
 * El tipo se decide por los primeros bytes, no por lo que diga quien la manda:
 * un `content-type` se escribe a mano, una cabecera JPEG no.
 */
function tipoDeImagen(bytes: Buffer): string | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * La foto del lugar de recogida (§9.3: se borra a los 30 días).
 *
 * El cliente la manda por WhatsApp y n8n la entrega de una de dos formas: el
 * archivo tal cual, o un enlace que la API descarga. Llegue como llegue, se
 * guarda aquí y no se sirve nunca desde el enlace original: el de Chatwoot
 * puede caducar, y el conductor no tiene por qué tocar otro servidor.
 */
@Injectable()
export class FotosService {
  private readonly logger = new Logger(FotosService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Guarda la foto (reemplaza la anterior). Devuelve la carrera para avisar del cambio. */
  async guardar(
    rideId: string,
    bytes: Buffer,
    origen: 'enlace' | 'archivo',
    actor: Actor,
  ): Promise<typeof rides.$inferSelect> {
    if (bytes.length === 0) throw new AppError('VALIDATION_FAILED', 'La foto llegó vacía');
    if (bytes.length > MAX_FOTO_BYTES) {
      throw new AppError('VALIDATION_FAILED', `La foto pesa más de ${MAX_FOTO_BYTES / 1024 / 1024} MB`);
    }
    const mimeType = tipoDeImagen(bytes);
    if (!mimeType) throw new AppError('VALIDATION_FAILED', 'No es una foto JPEG, PNG ni WebP');

    return this.db.transaction(async (tx) => {
      const [ride] = await tx
        .update(rides)
        .set({ pickupPhotoAt: new Date(), updatedAt: new Date() })
        .where(eq(rides.id, rideId))
        .returning();
      if (!ride) throw new AppError('NOT_FOUND', `No existe la carrera ${rideId}`);

      const fila = { content: bytes, mimeType, sizeBytes: bytes.length, source: origen, createdAt: new Date() };
      await tx
        .insert(ridePhotos)
        .values({ rideId, ...fila })
        .onConflictDoUpdate({ target: ridePhotos.rideId, set: fila });

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role ?? actor.kind,
          action: 'Adjuntó la foto del lugar',
          entity: 'rides',
          entityId: ride.code,
          after: { origen, kb: Math.round(bytes.length / 1024), tipo: mimeType },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );

      return ride;
    });
  }

  /**
   * Descarga la foto de un enlace y la guarda.
   *
   * Solo la llama una integración con clave de API (n8n): el enlace no viene
   * de un cliente cualquiera. Aun así se limita a http(s), a 15 s y a 5 MB, y
   * lo que llega tiene que ser de verdad una imagen.
   */
  async desdeEnlace(rideId: string, enlace: string, actor: Actor) {
    /*
     * Endurecido el 17/11/2026. Antes se seguía cualquier redirección y se
     * leía el cuerpo entero: un enlace podía hacer que la API le pidiera
     * cosas a los servicios internos del servidor (WAHA, Redis, Postgres en
     * la red de Docker) o bajara un archivo enorme. Ahora cada salto se
     * comprueba contra la lista de servidores permitidos (o, sin lista,
     * contra las direcciones privadas), se siguen máximo tres, y la descarga
     * se corta al pasar de 5 MB aunque el servidor no diga el tamaño.
     */
    const plazo = AbortSignal.timeout(TIEMPO_DESCARGA_MS);
    let url = new URL(enlace);
    let respuesta: Response | undefined;
    try {
      for (let salto = 0; salto <= MAX_REDIRECCIONES; salto++) {
        await destinoPermitido(url);
        respuesta = await fetch(url, { redirect: 'manual', signal: plazo });
        const destino = respuesta.headers.get('location');
        if (respuesta.status >= 300 && respuesta.status < 400 && destino) {
          url = new URL(destino, url);
          respuesta = undefined;
          continue;
        }
        break;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.logger.warn({ rideId, err: error }, 'No se pudo descargar la foto del lugar');
      throw new AppError('VALIDATION_FAILED', 'No se pudo descargar la foto del enlace');
    }
    if (!respuesta) throw new AppError('VALIDATION_FAILED', 'El enlace de la foto redirige demasiadas veces');
    if (!respuesta.ok) {
      throw new AppError('VALIDATION_FAILED', `El enlace de la foto respondió HTTP ${respuesta.status}`);
    }

    const contenido = await leerConTope(respuesta, MAX_FOTO_BYTES);
    if (!contenido) {
      throw new AppError('VALIDATION_FAILED', `La foto pesa más de ${MAX_FOTO_BYTES / 1024 / 1024} MB`);
    }
    return this.guardar(rideId, contenido, 'enlace', actor);
  }

  async leer(rideId: string): Promise<{ content: Buffer; mimeType: string } | null> {
    const [foto] = await this.db
      .select({ content: ridePhotos.content, mimeType: ridePhotos.mimeType })
      .from(ridePhotos)
      .where(eq(ridePhotos.rideId, rideId))
      .limit(1);
    return foto ?? null;
  }

  /**
   * Para cuando la foto llega con la carrera: se descarga después de crearla
   * y sin esperar. Una foto que no baja no puede dejar a nadie sin taxi.
   */
  enSegundoPlano(rideId: string, enlace: string, actor: Actor, alGuardar: (ride: typeof rides.$inferSelect) => void) {
    void this.desdeEnlace(rideId, enlace, actor)
      .then(alGuardar)
      .catch((error: unknown) => {
        this.logger.warn({ rideId, err: error instanceof Error ? error.message : error }, 'La foto del lugar no se pudo guardar');
      });
  }
}
