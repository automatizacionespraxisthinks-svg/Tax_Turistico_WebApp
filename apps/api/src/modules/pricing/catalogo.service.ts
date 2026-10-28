import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { CambiosLugar, CambiosZona, NuevaZona, NuevoLugar, Point } from '@tax/shared';
import {
  ZONA_POR_DEFECTO,
  buscarLugar,
  normalizarParaBuscar,
  poligonoCircular,
  poligonosSeTocan,
} from '@tax/shared';
import { DB, type Database } from '../../db/db.module';
import { places, zones } from '../../db/schema';
import { RURAL_WAVES, URBAN_WAVES } from '../../db/datos-base';
import { AppError } from '../../common/problem';
import { isUniqueViolation } from '../../common/pg-errors';
import { AuditService } from '../audit/audit.service';
import { ZonesService } from './zones.service';

export interface ActorDelPanel {
  id?: string;
  name: string;
  role: string;
  ip?: string;
}

const comoPuntos = (anillo: [number, number][]): Point[] => anillo.map(([lng, lat]) => ({ lat, lng }));

/** Sin repetidas, contando «La Terminal» y «la terminal» como la misma. */
function sinRepetidas(palabras: string[]): string[] {
  const vistas = new Set<string>();
  return palabras
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .filter((p) => {
      const clave = normalizarParaBuscar(p);
      if (!clave || vistas.has(clave)) return false;
      vistas.add(clave);
      return true;
    });
}

/**
 * Zonas y lugares que se crean y editan desde el panel.
 *
 * Las zonas se crean como círculos, igual que las sembradas, y no pueden
 * montarse sobre otra: un punto en dos zonas no sabría con qué oleadas
 * despacharse. Los lugares llevan sus palabras clave, que son como los
 * nombran los clientes; con ellas `reconocer()` ubica un pedido que llega sin
 * ubicación y sin dirección («frente a la terminal»).
 *
 * Cada cambio queda en la bitácora, y las zonas se recargan en memoria en el
 * acto: la próxima carrera ya se clasifica con ellas.
 */
@Injectable()
export class CatalogoService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ZonesService) private readonly zonas: ZonesService,
  ) {}

  /* -------------------------------------------------------------- zonas --- */

  async crearZona(entrada: NuevaZona, actor: ActorDelPanel) {
    const poligono = poligonoCircular(entrada.center.lat, entrada.center.lng, entrada.radiusKm);
    const nueva = comoPuntos(poligono.coordinates[0]!);
    const encima = this.zonas.all().find((z) => poligonosSeTocan(nueva, comoPuntos(z.polygon.coordinates[0] ?? [])));
    if (encima) {
      throw new AppError(
        'ZONE_OVERLAP',
        `Se monta sobre «${encima.name}». Mueve el centro o achica el radio.`,
      );
    }

    const id = uuidv7();
    const valores = {
      id,
      name: entrada.name.trim(),
      kind: entrada.kind,
      polygon: poligono,
      tortuosity: entrada.tortuosity ?? ZONA_POR_DEFECTO[entrada.kind].tortuosity,
      waves: entrada.kind === 'urbano' ? URBAN_WAVES : RURAL_WAVES,
    };

    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(zones).values(valores);
        await this.audit.record(
          {
            actorId: actor.id,
            actorName: actor.name,
            role: actor.role,
            action: 'Creó una zona',
            entity: 'zones',
            entityId: valores.name,
            after: { kind: valores.kind, center: entrada.center, radiusKm: entrada.radiusKm, tortuosity: valores.tortuosity },
            ip: actor.ip,
          },
          tx as unknown as Database,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error, 'zones_name_key')) {
        throw new AppError('NAME_TAKEN', `Ya hay una zona que se llama «${valores.name}»`);
      }
      throw error;
    }

    await this.zonas.reload();
    return { id, name: valores.name };
  }

  /** Las oleadas y el factor de tortuosidad de una zona. */
  async cambiarZona(zoneId: string, cambios: CambiosZona, actor: ActorDelPanel) {
    const [antes] = await this.db
      .select({ name: zones.name, tortuosity: zones.tortuosity, waves: zones.waves })
      .from(zones)
      .where(eq(zones.id, zoneId))
      .limit(1);
    if (!antes) throw new AppError('NOT_FOUND', 'Esa zona no existe');

    const despues = {
      tortuosity: cambios.tortuosity ?? antes.tortuosity,
      waves: cambios.waves ? [...cambios.waves].sort((a, b) => a.wave - b.wave) : antes.waves,
    };

    await this.db.transaction(async (tx) => {
      await tx.update(zones).set({ ...despues, updatedAt: new Date() }).where(eq(zones.id, zoneId));
      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role,
          action: 'Cambió las oleadas de una zona',
          entity: 'zones',
          entityId: antes.name,
          before: { tortuosity: antes.tortuosity, waves: antes.waves },
          after: despues,
          ip: actor.ip,
        },
        tx as unknown as Database,
      );
    });

    await this.zonas.reload();
    return { id: zoneId, ...despues };
  }

  /* ------------------------------------------------------------ lugares --- */

  async crearLugar(entrada: NuevoLugar, actor: ActorDelPanel) {
    const zona = this.zonaDelPunto(entrada.point);
    const aliases = sinRepetidas(entrada.aliases);
    await this.comprobarPalabras(entrada.name, aliases);

    const id = uuidv7();
    await this.db.transaction(async (tx) => {
      await tx.insert(places).values({
        id,
        name: entrada.name.trim(),
        kind: zona.kind,
        zoneId: zona.id,
        lat: entrada.point.lat,
        lng: entrada.point.lng,
        aliases,
      });
      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role,
          action: 'Agregó un lugar al catálogo',
          entity: 'places',
          entityId: entrada.name.trim(),
          after: { zona: zona.name, aliases, point: entrada.point },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );
    });
    return { id };
  }

  async cambiarLugar(placeId: string, cambios: CambiosLugar, actor: ActorDelPanel) {
    const [antes] = await this.db.select().from(places).where(eq(places.id, placeId)).limit(1);
    if (!antes) throw new AppError('NOT_FOUND', 'Ese lugar no existe');

    const name = cambios.name?.trim() ?? antes.name;
    const aliases = cambios.aliases ? sinRepetidas(cambios.aliases) : antes.aliases;
    const point = cambios.point ?? { lat: antes.lat, lng: antes.lng };
    const active = cambios.active ?? antes.active;
    const zona = cambios.point ? this.zonaDelPunto(point) : null;
    if (active) await this.comprobarPalabras(name, aliases, placeId);

    await this.db.transaction(async (tx) => {
      await tx
        .update(places)
        .set({
          name,
          aliases,
          lat: point.lat,
          lng: point.lng,
          active,
          ...(zona ? { zoneId: zona.id, kind: zona.kind } : {}),
        })
        .where(eq(places.id, placeId));
      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role,
          action: active ? 'Editó un lugar del catálogo' : 'Quitó un lugar del catálogo',
          entity: 'places',
          entityId: antes.name,
          before: { name: antes.name, aliases: antes.aliases, point: { lat: antes.lat, lng: antes.lng }, active: antes.active },
          after: { name, aliases, point, active },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );
    });
    return { id: placeId };
  }

  /**
   * El lugar del catálogo que nombra el texto de un pedido, si alguno, y
   * cuenta el uso: los más usados ganan los empates y salen primero en el
   * panel.
   */
  async reconocer(texto: string): Promise<{ id: string; name: string; point: Point; palabra: string } | null> {
    if (!texto.trim()) return null;
    const activos = await this.db
      .select({
        id: places.id,
        name: places.name,
        aliases: places.aliases,
        uses: places.uses,
        lat: places.lat,
        lng: places.lng,
      })
      .from(places)
      .where(eq(places.active, true));

    const hallado = buscarLugar(texto, activos);
    if (!hallado) return null;

    await this.db.update(places).set({ uses: sql`${places.uses} + 1` }).where(eq(places.id, hallado.lugar.id));
    return {
      id: hallado.lugar.id,
      name: hallado.lugar.name,
      point: { lat: hallado.lugar.lat, lng: hallado.lugar.lng },
      palabra: hallado.palabra,
    };
  }

  /* ------------------------------------------------------------- apoyo --- */

  private zonaDelPunto(point: Point) {
    const zona = this.zonas.classify(point);
    if (!zona) {
      throw new AppError('OUT_OF_COVERAGE', 'El punto queda fuera de las zonas con servicio: allí no se despacha');
    }
    return zona;
  }

  /**
   * Ningún nombre ni palabra clave puede ser de dos lugares a la vez: «el
   * parque» en dos sitios haría que el taxi fuera a uno al azar.
   */
  private async comprobarPalabras(nombre: string, aliases: string[], excepto?: string) {
    const otros = await this.db
      .select({ name: places.name, aliases: places.aliases })
      .from(places)
      .where(excepto ? and(eq(places.active, true), ne(places.id, excepto)) : eq(places.active, true));

    const ocupadas = new Map<string, string>();
    for (const otro of otros) {
      for (const palabra of [otro.name, ...otro.aliases]) ocupadas.set(normalizarParaBuscar(palabra), otro.name);
    }

    const duenoDelNombre = ocupadas.get(normalizarParaBuscar(nombre));
    if (duenoDelNombre) {
      throw new AppError('NAME_TAKEN', `«${nombre.trim()}» ya está en el catálogo como «${duenoDelNombre}»`);
    }
    for (const palabra of aliases) {
      const dueno = ocupadas.get(normalizarParaBuscar(palabra));
      if (dueno) throw new AppError('KEYWORD_TAKEN', `«${palabra}» ya es palabra clave de «${dueno}»`);
    }
  }
}
