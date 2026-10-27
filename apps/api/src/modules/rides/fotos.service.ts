import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { ridePhotos, rides } from '../../db/schema';
import { AppError } from '../../common/problem';
import { AuditService } from '../audit/audit.service';
import type { Actor } from './rides.service';

/** Una foto de WhatsApp pesa unos cientos de KB; 5 MB es el techo del §8.2. */
export const MAX_FOTO_BYTES = 5 * 1024 * 1024;

const TIEMPO_DESCARGA_MS = 15_000;

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
    const url = new URL(enlace);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new AppError('VALIDATION_FAILED', 'El enlace de la foto tiene que ser http o https');
    }

    let respuesta: Response;
    try {
      respuesta = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIEMPO_DESCARGA_MS) });
    } catch (error) {
      throw new AppError('VALIDATION_FAILED', `No se pudo descargar la foto: ${error instanceof Error ? error.message : error}`);
    }
    if (!respuesta.ok) {
      throw new AppError('VALIDATION_FAILED', `El enlace de la foto respondió HTTP ${respuesta.status}`);
    }
    const declarado = Number(respuesta.headers.get('content-length') ?? 0);
    if (declarado > MAX_FOTO_BYTES) {
      throw new AppError('VALIDATION_FAILED', `La foto pesa más de ${MAX_FOTO_BYTES / 1024 / 1024} MB`);
    }

    return this.guardar(rideId, Buffer.from(await respuesta.arrayBuffer()), 'enlace', actor);
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
