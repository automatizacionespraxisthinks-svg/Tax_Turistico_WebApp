import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { loadEnv } from '../config/env';

export const REDIS = Symbol('REDIS');

/**
 * Redis 7 existente, con usuario ACL propio y todas las claves bajo el
 * prefijo `tax:` (ADR-05): un fallo de seguridad en otro sistema del VPS no
 * alcanza estos datos.
 *
 * Guarda tres cosas: la última posición de cada conductor (GEO), las colas de
 * BullMQ y las claves de limitación de tasa.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () => {
        const env = loadEnv();
        return new Redis(env.REDIS_URL, {
          keyPrefix: env.REDIS_PREFIX,
          // BullMQ exige null; aquí también evita que un bloqueo deje la
          // petición esperando para siempre.
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
          lazyConnect: false,
        });
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}

/** Claves de Redis en un solo sitio, para no escribirlas sueltas por ahí. */
export const redisKeys = {
  /** Conjunto GEO con la última posición de cada conductor en turno. */
  driverPositions: 'geo:drivers',
  /** Hash con la antigüedad y el estado de cada posición. */
  driverMeta: (driverId: string) => `driver:${driverId}:meta`,
  /** Limitación de tasa por sujeto. */
  rateLimit: (subject: string, window: number) => `rl:${subject}:${window}`,
  /** Marca de oleada en curso, para no lanzar dos a la vez. */
  dispatchLock: (rideId: string) => `dispatch:${rideId}:lock`,
} as const;
