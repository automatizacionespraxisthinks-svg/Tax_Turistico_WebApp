import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { loadEnv } from '../config/env';
import * as schema from './schema';

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

export type Database = NodePgDatabase<typeof schema>;

/**
 * Tipo de la transacción de Drizzle.
 *
 * Todo lo que deba confirmarse junto —cambio de estado y evento del outbox,
 * sobre todo— recibe un `Tx`, no la base: así la firma del método dice si
 * puede participar en una transacción ajena o si abre la suya.
 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Acceso a la base `tax`.
 *
 * Drizzle con SQL explícito donde hace falta control fino de transacciones y
 * bloqueos (ADR-04): la exclusividad de la carrera se juega en una sentencia
 * concreta, no en una abstracción.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => {
        const env = loadEnv();
        return new Pool({
          connectionString: env.DATABASE_URL,
          max: env.DATABASE_POOL_MAX,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
          // El despacho no puede quedarse colgado esperando a la base.
          statement_timeout: 10_000,
          application_name: 'tax-api',
        });
      },
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema, casing: 'snake_case' }),
    },
  ],
  exports: [DB, PG_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Cierra el pool al apagar, para que Dokploy no deje conexiones colgadas. */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

export { schema };
