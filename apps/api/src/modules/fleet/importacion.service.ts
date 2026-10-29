import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DB, type Database } from '../../db/db.module';
import { drivers, vehicleDrivers, vehicles } from '../../db/schema';
import { decryptColumn, documentHash, encryptColumn, hashSecret } from '../../common/crypto';
import { loadEnv } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import type { ListadoLeido, PersonaDelListado } from './listado-maestro';

export interface OpcionesDeImportacion {
  /** Sin esto todo corre igual, pero al final se deshace: es la simulación. */
  aplicar: boolean;
  /** Desactiva a los conductores y móviles que están en la base pero no en el Excel. */
  desactivarAusentes: boolean;
  /** El primer código que se reparte a un conductor nuevo; los usados se saltan. */
  codigoInicial: number;
  /** Para la bitácora: qué archivo se cargó. */
  archivo: string;
}

export interface ConductorNuevo {
  codigo: string;
  nombre: string;
  /** «002», o «059 (relevador)». */
  moviles: string[];
  /** Solo al aplicar: en la simulación no se reparte ninguno. */
  pin: string | null;
  sinCelular: boolean;
}

export interface InformeDeImportacion {
  aplicado: boolean;
  moviles: {
    nuevos: string[];
    actualizados: { interno: string; campos: string[] }[];
    sinCambios: number;
    inactivos: string[];
  };
  conductores: {
    nuevos: ConductorNuevo[];
    actualizados: { codigo: string; nombre: string; campos: string[] }[];
    sinCambios: number;
    /** Ya estaban, creados a mano sin cédula, y se reconocieron por el celular. */
    reconocidosPorCelular: { codigo: string; nombre: string }[];
    /** Están en el Excel pero alguien los desactivó en el panel: siguen desactivados. */
    desactivadosEnElPanel: { codigo: string; nombre: string }[];
  };
  vinculos: { nuevos: number; cambiados: number; quitados: number };
  ausentes: {
    conductores: { codigo: string; nombre: string }[];
    moviles: string[];
    desactivados: boolean;
  };
}

/** Lleva el informe fuera de la transacción de una simulación, que se deshace. */
class Simulacion extends Error {
  constructor(readonly informe: InformeDeImportacion) {
    super('simulación');
  }
}

const igual = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/**
 * Carga el listado maestro de la empresa: móviles, conductores y relevadores.
 *
 * Se puede repetir cada mes con el Excel nuevo. Al móvil se le reconoce por su
 * número interno (o por la placa, si se creó a mano), y a la persona por la
 * huella de su cédula: lo que ya está se actualiza, lo nuevo se crea y nada
 * se duplica. Un conductor que ya existía conserva su código y su PIN.
 *
 * Lo que está en la base pero no en el Excel solo se informa; se desactiva
 * únicamente si se pide, porque una fila borrada por error no debería dejar a
 * nadie sin poder trabajar.
 */
@Injectable()
export class ImportacionService {
  private readonly clave = loadEnv().ENCRYPTION_KEY;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async importar(listado: ListadoLeido, opciones: OpcionesDeImportacion): Promise<InformeDeImportacion> {
    if (listado.errores.length) {
      throw new Error(`El Excel tiene errores que impiden cargarlo:\n- ${listado.errores.join('\n- ')}`);
    }
    try {
      return await this.db.transaction(async (tx) => {
        const informe = await this.cargar(tx as unknown as Database, listado, opciones);
        if (!opciones.aplicar) throw new Simulacion(informe);
        return informe;
      });
    } catch (error) {
      if (error instanceof Simulacion) return error.informe;
      throw error;
    }
  }

  private async cargar(tx: Database, listado: ListadoLeido, opciones: OpcionesDeImportacion) {
    const clave = this.clave;
    const informe: InformeDeImportacion = {
      aplicado: opciones.aplicar,
      moviles: { nuevos: [], actualizados: [], sinCambios: 0, inactivos: [] },
      conductores: { nuevos: [], actualizados: [], sinCambios: 0, reconocidosPorCelular: [], desactivadosEnElPanel: [] },
      vinculos: { nuevos: 0, cambiados: 0, quitados: 0 },
      ausentes: { conductores: [], moviles: [], desactivados: opciones.desactivarAusentes },
    };

    /* --- 1. Los conductores con cédula cifrada pero sin huella, de antes de existir la huella */
    const sinHuella = await tx
      .select({ id: drivers.id, documentEncrypted: drivers.documentEncrypted })
      .from(drivers)
      .where(and(isNull(drivers.documentHash), isNotNull(drivers.documentEncrypted)));
    for (const d of sinHuella) {
      await tx
        .update(drivers)
        .set({ documentHash: documentHash(clave, decryptColumn(clave, d.documentEncrypted!)) })
        .where(eq(drivers.id, d.id));
    }

    /* --- 2. Los móviles */
    const existentes = await tx.select().from(vehicles);
    const porInterno = new Map(existentes.filter((v) => v.internalNumber).map((v) => [v.internalNumber!, v]));
    const porPlaca = new Map(existentes.map((v) => [v.plate, v]));
    const idDeMovil = new Map<string, string>();

    for (const m of [...listado.moviles].sort((a, b) => a.interno.localeCompare(b.interno))) {
      const actual = porInterno.get(m.interno) ?? porPlaca.get(m.placa);
      const duenoDeLaPlaca = porPlaca.get(m.placa);
      if (actual && duenoDeLaPlaca && duenoDeLaPlaca.id !== actual.id) {
        throw new Error(
          `El móvil ${m.interno} (fila ${m.fila}) trae la placa ${m.placa}, que en la base es de otro vehículo` +
            ` (${duenoDeLaPlaca.internalNumber ? `móvil ${duenoDeLaPlaca.internalNumber}` : 'sin número interno'}).` +
            ' Corrige el Excel o el vehículo antes de cargar.',
        );
      }

      const deseado = {
        plate: m.placa,
        internalNumber: m.interno,
        capacity: m.capacidad,
        active: m.activo,
        brand: m.marca,
        modelYear: m.modelo,
        fuel: m.combustible,
        engineNumber: m.motor,
        chassisNumber: m.chasis,
        weightKg: m.pesoKg,
        registeredOn: m.matricula,
        ownerName: m.propietario?.nombre || null,
      };
      const cedulaPropietario = m.propietario?.cedula || null;

      if (!actual) {
        const id = uuidv7();
        await tx.insert(vehicles).values({
          id,
          type: 'sedan',
          ...deseado,
          ownerDocumentEncrypted: cedulaPropietario ? encryptColumn(clave, cedulaPropietario) : null,
        });
        informe.moviles.nuevos.push(m.interno);
        idDeMovil.set(m.interno, id);
      } else {
        const ETIQUETA: Record<keyof typeof deseado, string> = {
          plate: 'placa',
          internalNumber: 'número interno',
          capacity: 'capacidad',
          active: 'estado',
          brand: 'marca',
          modelYear: 'modelo',
          fuel: 'combustible',
          engineNumber: 'motor',
          chassisNumber: 'chasis',
          weightKg: 'peso',
          registeredOn: 'matrícula',
          ownerName: 'propietario',
        };
        const campos = (Object.keys(deseado) as (keyof typeof deseado)[])
          .filter((k) => !igual(actual[k], deseado[k]))
          .map((k) => ETIQUETA[k]);
        const cedulaActual = actual.ownerDocumentEncrypted ? decryptColumn(clave, actual.ownerDocumentEncrypted) : null;
        const cambiaCedula = !igual(cedulaActual, cedulaPropietario);
        if (cambiaCedula) campos.push('cédula del propietario');

        if (campos.length) {
          await tx
            .update(vehicles)
            .set({
              ...deseado,
              ...(cambiaCedula
                ? { ownerDocumentEncrypted: cedulaPropietario ? encryptColumn(clave, cedulaPropietario) : null }
                : {}),
              updatedAt: new Date(),
            })
            .where(eq(vehicles.id, actual.id));
          informe.moviles.actualizados.push({ interno: m.interno, campos });
        } else {
          informe.moviles.sinCambios += 1;
        }
        idDeMovil.set(m.interno, actual.id);
      }
      if (!m.activo) informe.moviles.inactivos.push(m.interno);
    }

    /* --- 3. Las personas: una por cédula, aunque maneje en dos móviles */
    const personas = new Map<string, { datos: PersonaDelListado; moviles: { interno: string; rol: 'conductor' | 'relevador' }[] }>();
    for (const m of [...listado.moviles].sort((a, b) => a.interno.localeCompare(b.interno))) {
      const conRol = [
        ...(m.conductor ? [{ persona: m.conductor, rol: 'conductor' as const }] : []),
        ...m.relevadores.map((persona) => ({ persona, rol: 'relevador' as const })),
      ];
      for (const { persona, rol } of conRol) {
        const ya = personas.get(persona.cedula);
        if (ya) {
          // Lo que falte en una fila lo puede traer otra.
          ya.datos = {
            ...ya.datos,
            celular: ya.datos.celular ?? persona.celular,
            licenciaVence: ya.datos.licenciaVence ?? persona.licenciaVence,
            restriccion: ya.datos.restriccion ?? persona.restriccion,
          };
          ya.moviles.push({ interno: m.interno, rol });
        } else {
          personas.set(persona.cedula, { datos: persona, moviles: [{ interno: m.interno, rol }] });
        }
      }
    }

    const actuales = await tx
      .select({
        id: drivers.id,
        code: drivers.code,
        name: drivers.name,
        phone: drivers.phone,
        documentHash: drivers.documentHash,
        licenseExpiresOn: drivers.licenseExpiresOn,
        licenseRestriction: drivers.licenseRestriction,
        active: drivers.active,
        esPrueba: drivers.esPrueba,
      })
      .from(drivers);
    const porHuella = new Map(actuales.filter((d) => d.documentHash).map((d) => [d.documentHash!, d]));
    const usados = new Set(actuales.map((d) => d.code));
    let siguiente = opciones.codigoInicial;
    const nuevoCodigo = () => {
      while (usados.has(String(siguiente))) siguiente += 1;
      const codigo = String(siguiente);
      usados.add(codigo);
      siguiente += 1;
      return codigo;
    };

    const idDePersona = new Map<string, string>();
    for (const [cedula, { datos, moviles }] of personas) {
      const huella = documentHash(clave, cedula);
      let actual = porHuella.get(huella);
      let adoptado = false;
      if (!actual && datos.celular) {
        // Creado a mano en el panel, sin cédula: el celular dice que es él.
        actual = actuales.find((d) => !d.documentHash && d.phone === datos.celular && ![...idDePersona.values()].includes(d.id));
        adoptado = Boolean(actual);
      }

      if (!actual) {
        const id = uuidv7();
        const codigo = nuevoCodigo();
        // Cuatro dígitos, como el alta desde el panel: lo que protege el PIN es
        // el bloqueo a los cinco intentos, no su largo.
        const pin = String(randomInt(1000, 10000));
        await tx.insert(drivers).values({
          id,
          code: codigo,
          name: datos.nombre,
          phone: datos.celular,
          documentEncrypted: encryptColumn(clave, cedula),
          documentHash: huella,
          licenseExpiresOn: datos.licenciaVence,
          licenseRestriction: datos.restriccion,
          pinHash: await hashSecret(pin),
        });
        informe.conductores.nuevos.push({
          codigo,
          nombre: datos.nombre,
          moviles: moviles.map((v) => (v.rol === 'relevador' ? `${v.interno} (relevador)` : v.interno)),
          pin: opciones.aplicar ? pin : null,
          sinCelular: !datos.celular,
        });
        idDePersona.set(cedula, id);
        continue;
      }

      const campos: string[] = [];
      if (actual.name !== datos.nombre) campos.push('nombre');
      // Un Excel sin celular no borra el que ya se conocía.
      if (datos.celular && actual.phone !== datos.celular) campos.push('celular');
      if (!igual(actual.licenseExpiresOn, datos.licenciaVence)) campos.push('vencimiento de licencia');
      if (!igual(actual.licenseRestriction, datos.restriccion)) campos.push('restricción');
      if (adoptado) campos.push('cédula');

      if (campos.length) {
        await tx
          .update(drivers)
          .set({
            name: datos.nombre,
            ...(datos.celular ? { phone: datos.celular } : {}),
            licenseExpiresOn: datos.licenciaVence,
            licenseRestriction: datos.restriccion,
            ...(adoptado ? { documentEncrypted: encryptColumn(clave, cedula), documentHash: huella } : {}),
            updatedAt: new Date(),
          })
          .where(eq(drivers.id, actual.id));
        informe.conductores.actualizados.push({ codigo: actual.code, nombre: datos.nombre, campos });
      } else {
        informe.conductores.sinCambios += 1;
      }
      if (adoptado) informe.conductores.reconocidosPorCelular.push({ codigo: actual.code, nombre: datos.nombre });
      if (!actual.active) informe.conductores.desactivadosEnElPanel.push({ codigo: actual.code, nombre: datos.nombre });
      idDePersona.set(cedula, actual.id);
    }

    /* --- 4. Quién maneja cada móvil */
    const deseados = new Map<string, 'conductor' | 'relevador'>();
    for (const m of listado.moviles) {
      const vehiculo = idDeMovil.get(m.interno)!;
      if (m.conductor) deseados.set(`${vehiculo}|${idDePersona.get(m.conductor.cedula)}`, 'conductor');
      for (const r of m.relevadores) {
        const par = `${vehiculo}|${idDePersona.get(r.cedula)}`;
        if (!deseados.has(par)) deseados.set(par, 'relevador');
      }
    }
    const vinculosActuales = idDeMovil.size
      ? await tx.select().from(vehicleDrivers).where(inArray(vehicleDrivers.vehicleId, [...idDeMovil.values()]))
      : [];
    for (const v of vinculosActuales) {
      const par = `${v.vehicleId}|${v.driverId}`;
      const rol = deseados.get(par);
      if (!rol) {
        await tx.delete(vehicleDrivers).where(eq(vehicleDrivers.id, v.id));
        informe.vinculos.quitados += 1;
        continue;
      }
      if (rol !== v.role) {
        await tx.update(vehicleDrivers).set({ role: rol }).where(eq(vehicleDrivers.id, v.id));
        informe.vinculos.cambiados += 1;
      }
      deseados.delete(par);
    }
    for (const [par, rol] of deseados) {
      const [vehicleId, driverId] = par.split('|') as [string, string];
      await tx.insert(vehicleDrivers).values({ id: uuidv7(), vehicleId, driverId, role: rol });
      informe.vinculos.nuevos += 1;
    }

    /* --- 5. Lo que está en la base y no en el Excel */
    const delListado = new Set(idDePersona.values());
    const ausentes = actuales.filter((d) => d.active && !d.esPrueba && !delListado.has(d.id));
    const movilesDelListado = new Set(idDeMovil.values());
    const movilesAusentes = existentes.filter((v) => v.active && !movilesDelListado.has(v.id));
    informe.ausentes.conductores = ausentes.map((d) => ({ codigo: d.code, nombre: d.name }));
    informe.ausentes.moviles = movilesAusentes.map((v) => (v.internalNumber ? `${v.internalNumber} (${v.plate})` : v.plate));
    if (opciones.desactivarAusentes) {
      if (ausentes.length) {
        await tx.update(drivers).set({ active: false, updatedAt: new Date() }).where(inArray(drivers.id, ausentes.map((d) => d.id)));
      }
      if (movilesAusentes.length) {
        await tx.update(vehicles).set({ active: false, updatedAt: new Date() }).where(inArray(vehicles.id, movilesAusentes.map((v) => v.id)));
      }
    }

    /* --- 6. La bitácora: una entrada por carga, con lo que hizo */
    await this.audit.record(
      {
        actorName: 'Carga del listado maestro',
        role: 'sistema',
        action: 'Cargó el listado maestro',
        entity: 'drivers',
        entityId: opciones.archivo,
        // Códigos y números internos; ni cédulas ni PIN, que la bitácora se lee.
        after: {
          moviles: {
            nuevos: informe.moviles.nuevos,
            actualizados: informe.moviles.actualizados.map((m) => m.interno),
            sinCambios: informe.moviles.sinCambios,
          },
          conductores: {
            nuevos: informe.conductores.nuevos.map((c) => c.codigo),
            actualizados: informe.conductores.actualizados.map((c) => c.codigo),
            sinCambios: informe.conductores.sinCambios,
          },
          vinculos: informe.vinculos,
          ausentes: { conductores: informe.ausentes.conductores.map((c) => c.codigo), moviles: informe.ausentes.moviles },
          ausentesDesactivados: opciones.desactivarAusentes,
        },
      },
      tx,
    );

    return informe;
  }
}
