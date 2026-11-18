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
 * El orden en que `jsonb` guarda las claves de un objeto: las más cortas
 * primero y, a igual largo, por bytes.
 *
 * El hash se calculaba con el orden en que el código armó el objeto, y la
 * base lo devuelve en este otro. Al verificar, cualquier fila cuyo `before`
 * o `after` no viniera ya en este orden salía «rota» sin que nadie la
 * hubiera tocado: la primera fue un «Aceptó la carrera» del 21/10/2026.
 * Desde el 17/11/2026 el hash se calcula con este orden.
 */
export function ordenJsonb(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenJsonb);
  if (valor && typeof valor === 'object' && !(valor instanceof Date)) {
    const claves = Object.keys(valor).sort((a, b) => {
      const largo = Buffer.byteLength(a) - Buffer.byteLength(b);
      return largo !== 0 ? largo : Buffer.compare(Buffer.from(a), Buffer.from(b));
    });
    return Object.fromEntries(claves.map((clave) => [clave, ordenJsonb((valor as Record<string, unknown>)[clave])]));
  }
  return valor;
}

export interface Sellable {
  prevHash: string;
  actorName: string;
  role: string;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  at: Date;
}

export function sello(fila: Sellable): string {
  return sha256Hex(
    JSON.stringify({
      prevHash: fila.prevHash,
      actorName: fila.actorName,
      role: fila.role,
      action: fila.action,
      entity: fila.entity,
      entityId: fila.entityId ?? null,
      before: fila.before ?? null,
      after: fila.after ?? null,
      at: fila.at.toISOString(),
    }),
  );
}

/**
 * Si el hash guardado corresponde a la fila: con el orden de `jsonb` (filas
 * desde el 17/11/2026) o, para las de antes, con el orden en que se armó.
 */
export function selloValido(fila: Sellable, hash: string): boolean {
  const ordenada = { ...fila, before: ordenJsonb(fila.before ?? null), after: ordenJsonb(fila.after ?? null) };
  return sello(ordenada) === hash || selloAntiguo(ordenada, hash);
}

/** La «forma» de un objeto: sus claves, sin importar el orden. */
const formaDe = (objeto: object) => Object.keys(objeto).sort().join('\u0000');

/** Las formas distintas de objeto que aparecen en un valor, con sus claves. */
function formas(valor: unknown, encontradas = new Map<string, string[]>()): Map<string, string[]> {
  if (Array.isArray(valor)) {
    for (const v of valor) formas(v, encontradas);
  } else if (valor && typeof valor === 'object') {
    encontradas.set(formaDe(valor), Object.keys(valor));
    for (const v of Object.values(valor)) formas(v, encontradas);
  }
  return encontradas;
}

function permutaciones<T>(lista: T[]): T[][] {
  if (lista.length <= 1) return [lista];
  return lista.flatMap((x, i) => permutaciones([...lista.slice(0, i), ...lista.slice(i + 1)]).map((resto) => [x, ...resto]));
}

/** El valor con las claves de cada forma en el orden que dice `orden`. */
function reordenar(valor: unknown, orden: Map<string, string[]>): unknown {
  if (Array.isArray(valor)) return valor.map((v) => reordenar(v, orden));
  if (valor && typeof valor === 'object') {
    const claves = orden.get(formaDe(valor)) ?? Object.keys(valor);
    return Object.fromEntries(claves.map((c) => [c, reordenar((valor as Record<string, unknown>)[c], orden)]));
  }
  return valor;
}

/** Cuántas combinaciones se prueban como mucho por fila antes de darla por rota. */
const MAX_COMBINACIONES = 200_000;

/**
 * Una fila de antes del arreglo: se busca el orden de claves con que se
 * selló. No se vuelve a sellar nada; si ningún orden da el hash guardado, la
 * fila de verdad fue alterada.
 *
 * Se prueba un orden por FORMA de objeto, el mismo para todos los objetos
 * con las mismas claves: el código arma siempre igual los objetos de una
 * misma forma (las tres oleadas de una zona, «nuevos / sinCambios /
 * actualizados» del listado). Probar cada objeto por separado multiplicaba
 * las combinaciones hasta los millones.
 */
function selloAntiguo(fila: Sellable, hash: string): boolean {
  const todas = formas(fila.after, formas(fila.before));
  const grupos = [...todas.entries()].map(([forma, claves]) => ({ forma, ordenes: permutaciones(claves) }));
  const total = grupos.reduce((n, g) => n * g.ordenes.length, 1);
  if (total > MAX_COMBINACIONES) return false;

  const indices = grupos.map(() => 0);
  for (let n = 0; n < total; n++) {
    const orden = new Map(grupos.map((g, i) => [g.forma, g.ordenes[indices[i]!]!]));
    if (sello({ ...fila, before: reordenar(fila.before, orden), after: reordenar(fila.after, orden) }) === hash) return true;
    for (let i = 0; i < indices.length; i++) {
      indices[i]! += 1;
      if (indices[i]! < grupos[i]!.ordenes.length) break;
      indices[i] = 0;
    }
  }
  return false;
}

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

      const hash = sello({
        prevHash,
        actorName: entry.actorName,
        role: entry.role,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        // En el orden en que `jsonb` las va a guardar: así la verificación,
        // que lee lo guardado, calcula el mismo hash.
        before: ordenJsonb(entry.before ?? null),
        after: ordenJsonb(entry.after ?? null),
        at,
      });

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

      const fila: Sellable = {
        prevHash: row.prevHash,
        actorName: row.actorName,
        role: row.role,
        action: row.action,
        entity: row.entity,
        entityId: row.entityId ?? null,
        before: row.before ?? null,
        after: row.after ?? null,
        at: row.at,
      };

      if (!selloValido(fila, row.hash)) return { ok: false, brokenAtSeq: row.seq };
      expectedPrev = row.hash;
    }

    return { ok: true };
  }
}
