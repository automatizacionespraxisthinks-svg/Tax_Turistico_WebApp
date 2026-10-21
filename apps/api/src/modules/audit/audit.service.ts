import { Inject, Injectable } from '@nestjs/common';
import { desc, sql } from 'drizzle-orm';
import { DB, type Database } from '../../db/db.module';
import { auditLog } from '../../db/schema';
import { sha256Hex } from '../../common/crypto';

export interface AuditEntryInput {
  actorId?: string;
  actorName: string;
  role: string;
  action: string;
  entity: string;
  entityId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string;
}

/** Hash de la primera fila: la cadena tiene que empezar en algo conocido. */
const GENESIS = '0'.repeat(64);

/**
 * Bitácora de auditoría (§5, §6).
 *
 * Solo inserción y con hash encadenado: cada fila incluye el hash de la
 * anterior, así que borrar o editar una rompe la verificación.
 *
 * El encadenado obliga a serializar las escrituras: dos inserciones a la vez
 * leerían el mismo «último hash» y producirían una bifurcación. Se resuelve
 * con un lock de asesoramiento de PostgreSQL dentro de la transacción, que se
 * libera solo al terminar y no deja bloqueos huérfanos si el proceso muere.
 */
@Injectable()
export class AuditService {
  /** Identificador arbitrario pero fijo del lock de la cadena. */
  private static readonly LOCK_KEY = 4713_0001;

  constructor(@Inject(DB) private readonly db: Database) {}

  async record(entry: AuditEntryInput, tx?: Database): Promise<void> {
    const run = async (database: Database) => {
      await database.execute(sql`select pg_advisory_xact_lock(${AuditService.LOCK_KEY})`);

      const [last] = await database
        .select({ hash: auditLog.hash })
        .from(auditLog)
        .orderBy(desc(auditLog.seq))
        .limit(1);

      const prevHash = last?.hash ?? GENESIS;
      const at = new Date();

      const hash = sha256Hex(
        JSON.stringify({
          prevHash,
          actorName: entry.actorName,
          role: entry.role,
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId ?? null,
          before: entry.before ?? null,
          after: entry.after ?? null,
          at: at.toISOString(),
        }),
      );

      await database.insert(auditLog).values({
        actorId: entry.actorId,
        actorName: entry.actorName,
        role: entry.role,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        before: entry.before ?? null,
        after: entry.after ?? null,
        ip: entry.ip,
        at,
        prevHash,
        hash,
      });
    };

    // Si ya hay una transacción en curso, se escribe dentro: la auditoría de
    // un cambio no puede sobrevivir a un rollback de ese cambio.
    if (tx) {
      await run(tx);
      return;
    }
    await this.db.transaction(async (inner) => run(inner as unknown as Database));
  }

  /**
   * Recorre la cadena y devuelve la primera fila que no cuadra.
   * Lo usa el administrador para demostrar que la bitácora no se ha tocado.
   */
  async verifyChain(limit = 5000): Promise<{ ok: true } | { ok: false; brokenAtSeq: number }> {
    const rows = await this.db
      .select()
      .from(auditLog)
      .orderBy(auditLog.seq)
      .limit(limit);

    let expectedPrev = GENESIS;
    for (const row of rows) {
      if (row.prevHash !== expectedPrev) return { ok: false, brokenAtSeq: row.seq };

      const recomputed = sha256Hex(
        JSON.stringify({
          prevHash: row.prevHash,
          actorName: row.actorName,
          role: row.role,
          action: row.action,
          entity: row.entity,
          entityId: row.entityId ?? null,
          before: row.before ?? null,
          after: row.after ?? null,
          at: row.at.toISOString(),
        }),
      );

      if (recomputed !== row.hash) return { ok: false, brokenAtSeq: row.seq };
      expectedPrev = row.hash;
    }

    return { ok: true };
  }
}
