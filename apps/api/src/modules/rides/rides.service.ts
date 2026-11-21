import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { CreateRideInput, Point, RideStatus, TransitionActor } from '@tax/shared';
import {
  MAX_CARRERAS_ACTIVAS,
  OPEN_RIDE_STATUSES,
  canTransition,
  enlaceDeMapaValido,
  formatRideCode,
  haversineKm,
  nombreClaro,
  normalizarParaBuscar,
  puntoDeEnlace,
  recogidaSinSentido,
  tieneNomenclatura,
} from '@tax/shared';
import { DB, type Database, type Tx } from '../../db/db.module';
import {
  customers,
  drivers,
  rideAddressEdits,
  rideOffers,
  rideStatusHistory,
  rides,
  vehicles,
  wahaSessions,
} from '../../db/schema';
import { AppError } from '../../common/problem';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../integrations/outbox.service';
import { TrayectosService } from '../pricing/trayectos.service';
import { GeocodingService, MUNICIPIO, type MotivoGeocodificacion } from '../pricing/geocoding.service';
import { ZonesService } from '../pricing/zones.service';
import { CatalogoService } from '../pricing/catalogo.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { isUniqueViolation } from '../../common/pg-errors';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { FotosService } from './fotos.service';

/** Cómo se dice en el registro de dónde salió el punto de recogida. */
const ORIGEN_EN_PALABRAS = {
  compartida: 'que compartió el cliente',
  catalogo: 'de un lugar del catálogo',
  geocodificada: 'ubicada con Google',
} as const;

export interface Actor {
  kind: TransitionActor;
  name: string;
  id?: string;
  role?: string;
  ip?: string;
}

export interface TransitionOptions {
  note?: string;
  at?: Point;
  /** Cambios adicionales sobre la fila de la carrera. */
  patch?: Partial<typeof rides.$inferInsert>;
  /** Evento que se publica hacia n8n dentro de la misma transacción. */
  event?: { type: Parameters<OutboxService['enqueue']>[1]['type']; payload?: Record<string, unknown> };
}

/**
 * Carreras.
 *
 * Es dueño del ciclo de vida, de la edición de dirección (RF-11) y del
 * historial de estados (§4.1).
 *
 * TODO cambio de estado pasa por `transition()`. Es a propósito: la tabla de
 * transiciones de `@tax/shared` se comprueba en un único sitio, y en la misma
 * transacción se escriben el historial, la auditoría y el evento del outbox.
 * Un atajo que actualice `rides.status` por fuera se saltaría las tres cosas.
 */
@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);

  /**
   * Mas alla de esto, la lectura del GPS no se cree. Paipa-Bogota son unos
   * 180 km, asi que un intermunicipal largo sigue cabiendo; lo que no cabe
   * es un (0, 0), que da la vuelta al mundo.
   */
  private static readonly DISTANCIA_MAXIMA_KM = 300;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly trayectos: TrayectosService,
    private readonly geocoding: GeocodingService,
    private readonly zones: ZonesService,
    @Inject(CatalogoService) private readonly catalogo: CatalogoService,
    private readonly realtime: RealtimeGateway,
    private readonly fotos: FotosService,
    @Inject(forwardRef(() => DispatchService))
    private readonly dispatch: DispatchService,
  ) {}

  /**
   * Rechaza un punto que no es de Paipa. Que no caiga en una zona no es
   * motivo: las zonas son para las estadísticas, y un rincón del municipio
   * sin dibujar no puede dejar a un cliente sin taxi.
   */
  private async exigirPaipa(point: Point): Promise<void> {
    const { dentro, municipio } = await this.geocoding.cobertura(point);
    if (!dentro) {
      throw new AppError(
        'OUT_OF_COVERAGE',
        municipio
          ? `El punto de recogida queda en ${municipio}, fuera de ${MUNICIPIO}`
          : `El punto de recogida está fuera de ${MUNICIPIO}`,
      );
    }
  }

  /**
   * La línea por la que entró el pedido, con el nombre que se ve en el panel.
   *
   * n8n puede mandar el nombre de la sesión de WAHA, el número de la línea
   * o su nombre: los tres llevan a la misma fila, y se guarda siempre el
   * nombre, para que en Reportes una línea no salga tres veces escrita de
   * tres formas. Si no coincide con ninguna, se guarda tal cual llegó: mejor
   * un nombre raro que perder de dónde vino la carrera.
   */
  private async lineaRegistrada(dicha: string | undefined): Promise<string | null> {
    if (!dicha) return null;
    const digitos = (texto: string | null) => (texto ?? '').replace(/\D/g, '').slice(-10);
    const buscada = dicha.trim();
    try {
      const lineas = await this.db
        .select({ id: wahaSessions.id, label: wahaSessions.label, phone: wahaSessions.phone })
        .from(wahaSessions);
      const hallada =
        lineas.find((l) => l.id === buscada) ??
        lineas.find((l) => l.label.trim().toLowerCase() === buscada.toLowerCase()) ??
        (digitos(buscada).length >= 7
          ? lineas.find((l) => digitos(l.phone) === digitos(buscada) || digitos(l.label) === digitos(buscada))
          : undefined);
      if (hallada) return hallada.label;
      this.logger.warn({ line: buscada }, 'La línea del pedido no coincide con ninguna registrada: se guarda tal cual');
    } catch (error) {
      this.logger.warn({ error, line: buscada }, 'No se pudieron leer las líneas: se guarda la línea tal cual');
    }
    return buscada;
  }

  /* ------------------------------------------------------------- creación */

  async create(input: CreateRideInput, actor: Actor) {
    /*
     * El punto de recogida, por orden de confianza.
     *
     * Si el cliente compartio su ubicacion, esa manda: es exacta al metro y
     * no hay nada que adivinar. Si solo escribio una direccion, la resuelve
     * el geocodificador —aqui, nunca el agente de n8n, que podria cambiarle
     * un digito sin que se note— y lo que devuelve ya viene comprobado
     * contra las zonas con servicio.
     */
    // El enlace de ubicación del cliente cuenta como compartida: si n8n no
    // mandó el punto aparte, se lee del propio enlace.
    const pickupLink = enlaceDeMapaValido(input.pickup.link);
    let point = input.pickup.point ?? puntoDeEnlace(pickupLink) ?? undefined;

    /*
     * Datos que no sirven (21/11/2026). Una recogida «disponible» sin
     * ubicación compartida no la encuentra ningún conductor: se le devuelve
     * al agente MISSING_LOCATION, que ya sabe pedir la ubicación. Y si n8n
     * avisó que el nombre de WhatsApp no sirve, sin un nombre claro no se crea.
     */
    if (!point && recogidaSinSentido(input.pickup.text) && recogidaSinSentido(input.pickup.reference)) {
      throw new AppError(
        'MISSING_LOCATION',
        `«${input.pickup.text}» no es una dirección: pídele al cliente la dirección exacta o que comparta su ubicación por WhatsApp`,
      );
    }
    if (input.nombreObligatorio && !nombreClaro(input.customerName)) {
      throw new AppError(
        'MISSING_CUSTOMER_NAME',
        'El nombre de WhatsApp no sirve para identificar al cliente: pregúntale a nombre de quién va el taxi y vuelve a pedirlo con ese nombre',
      );
    }
    let pickupSource: 'compartida' | 'catalogo' | 'geocodificada' | 'sin_ubicar' = 'compartida';
    let direccionResuelta: string | undefined;
    let pickupText = input.pickup.text;

    /*
     * Sin ubicación compartida hay dos ayudas, y el orden depende de cómo lo
     * dijo el cliente. Con nomenclatura («Calle 25 #18-40») manda el
     * geocodificador, que llega a la puerta. Sin ella («frente a la
     * terminal») manda el catálogo de lugares: sus palabras clave son como
     * la gente de Paipa nombra los sitios, y el geocodificador no las conoce.
     * La referencia también cuenta, porque es donde el cliente suele nombrar
     * el lugar.
     */
    type Hallazgo = { point: Point; source: 'catalogo' | 'geocodificada'; direccion: string };
    // Para el registro: por qué Google no la ubicó, si no la ubicó.
    let motivoDeGoogle: MotivoGeocodificacion | undefined;
    const delCatalogo = async (): Promise<Hallazgo | null> => {
      const texto = [input.pickup.text, input.pickup.reference].filter(Boolean).join('. ');
      const lugar = await this.catalogo.reconocer(texto);
      return lugar ? { point: lugar.point, source: 'catalogo', direccion: lugar.name } : null;
    };
    const delGeocodificador = async (): Promise<Hallazgo | null> => {
      const { resuelta: hallada, motivo } = await this.geocoding.resolverConMotivo(input.pickup.text);
      motivoDeGoogle = motivo;
      return hallada ? { point: hallada.point, source: 'geocodificada', direccion: hallada.formatted } : null;
    };

    if (!point) {
      const ayudas = tieneNomenclatura(input.pickup.text)
        ? [delGeocodificador, delCatalogo]
        : [delCatalogo, delGeocodificador];
      for (const ayuda of ayudas) {
        const hallazgo = await ayuda();
        if (hallazgo) {
          point = hallazgo.point;
          pickupSource = hallazgo.source;
          direccionResuelta = hallazgo.direccion;
          break;
        }
      }
    }

    /*
     * Si no se pudo ubicar, la carrera se crea igual.
     *
     * El cliente da una direccion y el conductor la lee: asi se ha despachado
     * toda la vida y no hace falta un mapa para eso. Lo unico que necesita
     * coordenadas es el despacho, porque las oleadas son radios y un radio
     * necesita un centro; para eso basta el centro del pueblo.
     *
     * Rechazar la carrera seria lo peor de los dos mundos: el cliente se
     * queda sin taxi por un geocodificador que no entendio una nomenclatura
     * que el conductor habria leido sin problema. Queda marcada como
     * `sin_ubicar` para que en el panel se vea que ese punto del mapa es el
     * del pueblo y no el del cliente.
     */
    if (!point) {
      point = this.zones.puntoDeReferencia();
      pickupSource = 'sin_ubicar';
    }

    if (!point) {
      // Solo si no hay ni una zona configurada: eso es un sistema sin montar.
      throw new AppError('MISSING_LOCATION', 'No hay zonas configuradas para despachar');
    }

    // La ubicación compartida es la única que llega sin comprobar: las de
    // Google y el catálogo ya vienen comprobadas, y la de «sin ubicar» es la
    // del pueblo.
    if (pickupSource === 'compartida') await this.exigirPaipa(point);

    /*
     * Una ubicación compartida que cae en un lugar del catálogo lleva su
     * nombre delante: «Terminal de Transportes. Cra. 21 #24-18» se reconoce
     * de un vistazo, y es como la oficina y los clientes llaman ese sitio.
     */
    if (pickupSource === 'compartida') {
      const lugar = await this.catalogo.cercano(point);
      if (lugar && !normalizarParaBuscar(pickupText).includes(normalizarParaBuscar(lugar.name))) {
        pickupText = `${lugar.name}. ${pickupText}`;
        direccionResuelta = lugar.name;
      }
    }

    const trayecto = this.trayectos.medir(point, input.dropoff?.point);
    const pendingEvents: string[] = [];

    /*
     * Cuántos taxis van a este punto.
     *
     * «Necesito 5 taxis en la terminal» es UN pedido de cinco carreras, y se
     * crea de una vez: antes el agente tenía que llamar cinco veces a
     * `crear_carrera` y numerarlas bien, y en producción una vez llamó una
     * sola y el cliente quedó esperando cinco. Ahora las cinco salen en la
     * misma transacción —o ninguna—, cada una con su código, su despacho y
     * sus avisos, y numeradas desde `numeroEnPedido`.
     */
    const cantidad = input.cantidad;
    const numeros = Array.from({ length: cantidad }, (_, i) => input.numeroEnPedido + i);
    const notasDe = (numero: number) => {
      if (cantidad === 1) return input.notes;
      // La nota del grupo la pone la API: la del agente puede traer otra
      // cuenta («Taxi 1 de 5…») que aquí ya no vale.
      const propia = (input.notes ?? '').replace(/taxi\s+\d+\s+de\s+\d+[^.;\n]*[.;]?\s*/gi, '').trim();
      const grupo = `Taxi ${numero - input.numeroEnPedido + 1} de ${cantidad} en el mismo punto.`;
      return `${grupo}${propia ? ` ${propia}` : ''}`.slice(0, 280);
    };

    const line = await this.lineaRegistrada(input.line);

    const creadas = await this.db
      .transaction(async (tx) => {
        const customerId = await this.upsertCustomer(tx, input.customerPhone, input.customerName, input.consent);

        /*
         * Tope de taxis por teléfono.
         *
         * Se cuenta aquí dentro, con la fila del cliente ya bloqueada por
         * `upsertCustomer`, así que dos pedidos del mismo número a la vez se
         * ponen en fila en vez de contar los dos sobre el mismo estado y
         * pasar los dos. Antes el tope solo existía como una línea en el
         * prompt del agente, y una instrucción de texto no frena nada.
         *
         * Un pedido de varios que no cabe entero no se crea a medias: el
         * agente recibe cuántos caben y le pregunta al cliente.
         */
        const [activas] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(rides)
          .where(and(eq(rides.customerId, customerId), inArray(rides.status, OPEN_RIDE_STATUSES)));

        const cupo = Math.max(0, MAX_CARRERAS_ACTIVAS - (activas?.n ?? 0));
        if (cantidad > cupo) {
          throw new AppError(
            'MAX_ACTIVE_RIDES',
            cupo === 0
              ? `Este teléfono ya tiene ${MAX_CARRERAS_ACTIVAS} taxis activos`
              : `Este teléfono tiene cupo para ${cupo} taxi${cupo === 1 ? '' : 's'} más, no para ${cantidad}`,
            [{ path: 'cantidad', message: `cupo: ${cupo}` }],
          );
        }

        const filas: (typeof rides.$inferSelect)[] = [];
        for (const numero of numeros) {
          const rideId = uuidv7();

          // El código legible sale de una secuencia de la base: dos peticiones
          // simultáneas no pueden obtener el mismo número.
          // `execute` devuelve el QueryResult de pg, no un array de filas.
          const sequence = await tx.execute<{ next: string }>(
            sql`select nextval('ride_code_seq') as next`,
          );
          const code = formatRideCode(
            new Date().getFullYear(),
            Number(sequence.rows[0]?.next ?? 0),
          );

          const [ride] = await tx
            .insert(rides)
            .values({
              id: rideId,
              code,
              status: 'PENDING',
              version: 1,
              customerId,
              pickupText,
              pickupReference: input.pickup.reference,
              pickupLat: point.lat,
              pickupLng: point.lng,
              pickupSource,
              // Solo con ubicación compartida: un enlace que no llevó al punto
              // no tiene por qué abrirse en el teléfono del conductor.
              pickupLink: pickupSource === 'compartida' ? pickupLink : null,
              dropoffText: input.dropoff?.text,
              dropoffLat: input.dropoff?.point?.lat,
              dropoffLng: input.dropoff?.point?.lng,
              // Solo cuenta como dicho por el cliente si trae coordenadas: un
              // destino en palabras no sirve para medir nada.
              dropoffSource: input.dropoff?.point ? 'cliente' : undefined,
              zoneId: trayecto.originZoneId,
              line,
              vehicleType: input.vehicleType,
              passengers: input.passengers,
              /*
               * Del 2 en adelante el pedido es de varios taxis a la vez, así que
               * la carrera se marca para que el índice
               * `one_active_ride_per_customer` no la rechace. El taxi 1 nunca
               * lleva la marca: por eso un cliente que repite el pedido sigue
               * chocando contra el índice y recibe «ya tiene taxi pedido».
               */
              allowsConcurrent: numero > 1,
              pagoElectronico: input.pagoElectronico,
              etaMinutes: trayecto.etaMinutes,
              notes: notasDe(numero),
            })
            .returning();

          await tx.insert(rideStatusHistory).values({
            id: uuidv7(),
            rideId,
            fromStatus: null,
            toStatus: 'PENDING',
            actor: actor.kind,
            actorName: actor.name,
            actorId: actor.id,
          });

          pendingEvents.push(
            await this.outbox.enqueue(tx, {
              type: 'ride.created',
              rideId,
              rideCode: code,
              rideVersion: 1,
              payload: {
                code,
                pickup: { ...input.pickup, text: pickupText, point },
                pickupSource,
                pagoElectronico: input.pagoElectronico,
                // Para que el agente pueda confirmarle al cliente lo que se
                // entendio, sin tener que geocodificar el por su cuenta.
                direccionResuelta,
                dropoff: input.dropoff,
                zone: trayecto.originZoneName,
                ...(cantidad > 1 ? { pedido: { numero: numero - input.numeroEnPedido + 1, de: cantidad } } : {}),
              },
            }),
          );

          await this.audit.record(
            {
              actorId: actor.id,
              actorName: actor.name,
              role: actor.role ?? actor.kind,
              action: 'Creó carrera',
              entity: 'rides',
              entityId: code,
              after: { code, status: 'PENDING', ...(cantidad > 1 ? { pedido: `${numero - input.numeroEnPedido + 1} de ${cantidad}` } : {}) },
              ip: actor.ip,
            },
            tx as unknown as Database,
          );

          filas.push(ride!);
        }
        return filas;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error, 'one_active_ride_per_customer')) {
          throw new AppError(
            'RIDE_ALREADY_ACTIVE',
            'Este teléfono ya tiene una carrera activa. El operador puede autorizar otra.',
          );
        }
        throw error;
      });

    /*
     * Una línea por carrera con de dónde salió el punto. Es lo que permite
     * ver en los registros la diferencia entre tener la clave de Google o
     * no: sin ella, toda dirección escrita sale «sin_ubicar» con
     * `google: sin_clave`.
     */
    this.logger.log(
      {
        code: creadas.map((c) => c.code).join(', '),
        pickupSource,
        ...(cantidad > 1 ? { cantidad } : {}),
        ...(motivoDeGoogle ? { google: motivoDeGoogle } : {}),
        ...(direccionResuelta ? { ubicadaComo: direccionResuelta } : {}),
      },
      pickupSource === 'sin_ubicar'
        ? 'Carrera creada sin ubicar: se despacha desde el punto de partida'
        : `Carrera creada con la recogida ${ORIGEN_EN_PALABRAS[pickupSource]}`,
    );

    // Fuera de la transacción: antes del commit el trabajador no vería la fila.
    await this.outbox.notify(pendingEvents);
    for (const ride of creadas) {
      this.realtime.rideChanged(ride);

      // La foto del lugar baja después, sin que nadie la espere. Con varios
      // taxis en el mismo punto, cada conductor ve la misma foto.
      if (input.pickupPhotoUrl) {
        this.fotos.enSegundoPlano(ride.id, input.pickupPhotoUrl, actor, (r) => this.realtime.rideChanged(r));
      }

      // El despacho arranca en segundo plano; crear la carrera no debe esperar
      // a que se resuelva la primera oleada (objetivo: oferta visible < 3 s).
      void this.dispatch.startWave(ride.id, 1).catch((error: unknown) => {
        this.logger.error({ err: error, rideId: ride.id }, 'No se pudo lanzar la oleada 1');
      });
    }

    /*
     * Un taxi: la carrera, como siempre. Varios: la primera, para que quien
     * lea `id` y `code` siga funcionando, más `rides` con todas en orden.
     */
    const [primera] = creadas;
    return cantidad === 1 ? primera! : { ...primera!, cantidad, rides: creadas };
  }

  private async upsertCustomer(
    tx: Tx,
    phone: string,
    name?: string,
    consent?: { version: string; channel: string },
  ): Promise<string> {
    /*
     * Primero se asegura que la fila exista, y después se bloquea.
     *
     * Un cliente nuevo que pide varios taxis en un mensaje llega con varias
     * peticiones a la vez (el agente llama a `crear_carrera` en paralelo).
     * Antes se buscaba y, si no estaba, se insertaba: todas lo buscaban a la
     * vez, ninguna lo encontraba, todas insertaban y solo una ganaba; las
     * demás reventaban con `customers_phone_key` y un 500, y de cinco taxis
     * se creaban dos o tres. Con `on conflict do nothing` la segunda espera a
     * que la primera confirme y no hace nada; el `select` que sigue ya la ve.
     *
     * `for update` bloquea la fila del cliente hasta el final de la
     * transacción, y es lo que hace exacta la cuenta del tope: sin él, dos
     * pedidos simultáneos del mismo número cuentan los dos sobre el mismo
     * estado y los dos se creen con cupo.
     */
    await tx
      .insert(customers)
      .values({ id: uuidv7(), phone, name })
      .onConflictDoNothing({ target: customers.phone });

    const [cliente] = await tx
      .select({ id: customers.id, name: customers.name, consentVersion: customers.consentVersion })
      .from(customers)
      .where(eq(customers.phone, phone))
      .for('update')
      .limit(1);

    if (!cliente) throw new Error('No se pudo registrar el cliente');
    /*
     * La autorización (Ley 1581, art. 9): la primera vez, o cuando la empresa
     * publica una versión nueva de la política. La hora es la del servidor:
     * es la prueba, no la puede poner quien llama.
     */
    const cambios: Partial<typeof customers.$inferInsert> = {};
    if (name && cliente.name !== name) cambios.name = name;
    if (consent && cliente.consentVersion !== consent.version) {
      cambios.consentVersion = consent.version;
      cambios.consentChannel = consent.channel;
      cambios.consentAt = new Date();
    }
    if (Object.keys(cambios).length > 0) {
      await tx.update(customers).set(cambios).where(eq(customers.id, cliente.id));
    }
    return cliente.id;
  }

  /* ---------------------------------------------------------- transición */

  /**
   * Único camino para cambiar el estado de una carrera.
   *
   * Comprueba la transición contra la tabla del dominio, escribe historial y
   * auditoría, publica el evento y avisa por socket. Devuelve la carrera ya
   * actualizada.
   */
  /**
   * Lo que se guarda al finalizar: destino y distancia.
   *
   * Casi nadie dice a donde va por WhatsApp; lo dice ya montado en el carro.
   * Por eso el destino se da por conocido cuando el taxi para: la posicion
   * del conductor al marcar finalizada es el destino. Si el cliente si lo
   * habia dicho, ese manda y la posicion del conductor no lo pisa.
   *
   * Nada de esto puede impedir cerrar una carrera. Sin GPS, con una lectura
   * absurda o con las zonas cambiadas, el conductor cierra igual y la
   * carrera queda sin distancia: un informe incompleto es mucho menos malo
   * que un taxista atrapado en una pantalla con el cliente ya bajandose.
   */
  async cierreDeCarrera(
    ride: typeof rides.$inferSelect,
    at: Point | undefined,
  ): Promise<{ patch: Partial<typeof rides.$inferInsert>; note?: string }> {
    const loDijoElCliente = ride.dropoffLat != null && ride.dropoffLng != null;
    const destino = loDijoElCliente
      ? { lat: ride.dropoffLat!, lng: ride.dropoffLng! }
      : at;

    if (!destino || ride.pickupLat == null || ride.pickupLng == null) {
      return {
        patch: {},
        note: loDijoElCliente ? undefined : 'Finalizó sin ubicación: queda sin distancia',
      };
    }

    /*
     * Si la recogida nunca se ubico, su punto es el centro del pueblo, no
     * donde estaba el cliente. Medir desde ahi daria una distancia falsa, y
     * una distancia falsa en un informe es peor que una casilla vacia.
     */
    if (ride.pickupSource === 'sin_ubicar') {
      return { patch: {}, note: 'Sin distancia: la recogida nunca se ubicó en el mapa' };
    }

    const origen = { lat: ride.pickupLat, lng: ride.pickupLng };

    /*
     * Guarda contra lecturas basura. Un GPS que devuelve (0, 0) pone el
     * destino en el golfo de Guinea: serian miles de kilometros, y ese numero
     * acabaria en un informe como si fuera cierto.
     */
    const enLineaRecta = haversineKm(origen, destino);
    if (enLineaRecta > RidesService.DISTANCIA_MAXIMA_KM) {
      return {
        patch: {},
        note: `Ubicación descartada: ${Math.round(enLineaRecta)} km del origen`,
      };
    }

    let trayecto;
    try {
      trayecto = this.trayectos.medir(origen, destino);
    } catch (error) {
      // La zona de origen ya no existe o cambió: se cierra igual.
      this.logger.warn({ rideId: ride.id, error }, 'No se pudo medir la carrera al finalizar');
      return { patch: {}, note: 'No se pudo calcular la distancia al finalizar' };
    }

    const patch: Partial<typeof rides.$inferInsert> = { distanceKm: trayecto.distanceKm };

    if (loDijoElCliente) return { patch };

    patch.dropoffLat = destino.lat;
    patch.dropoffLng = destino.lng;
    patch.dropoffSource = 'conductor';
    patch.dropoffText = ride.dropoffText ?? 'Donde terminó la carrera';

    return { patch, note: 'Destino tomado de donde finalizó el conductor' };
  }

  async transition(
    rideId: string,
    to: RideStatus,
    actor: Actor,
    options: TransitionOptions = {},
  ) {
    const eventIds: string[] = [];

    const updated = await this.db.transaction(async (tx) => {
      // `for update` serializa dos cambios simultáneos sobre la misma carrera:
      // el segundo espera y vuelve a leer el estado ya cambiado.
      const [current] = await tx
        .select()
        .from(rides)
        .where(eq(rides.id, rideId))
        .for('update')
        .limit(1);

      if (!current) throw new AppError('NOT_FOUND', `No existe la carrera ${rideId}`);

      if (!canTransition(current.status, to, actor.kind)) {
        throw new AppError(
          'INVALID_TRANSITION',
          `${actor.kind} no puede pasar de ${current.status} a ${to}`,
        );
      }

      const version = current.version + 1;
      const [next] = await tx
        .update(rides)
        .set({ ...options.patch, status: to, version, updatedAt: new Date() })
        .where(eq(rides.id, rideId))
        .returning();

      await tx.insert(rideStatusHistory).values({
        id: uuidv7(),
        rideId,
        fromStatus: current.status,
        toStatus: to,
        actor: actor.kind,
        actorName: actor.name,
        actorId: actor.id,
        lat: options.at?.lat,
        lng: options.at?.lng,
        note: options.note,
      });

      if (options.event) {
        eventIds.push(
          await this.outbox.enqueue(tx, {
            type: options.event.type,
            rideId,
            rideCode: current.code,
            rideVersion: version,
            payload: { code: current.code, status: to, ...options.event.payload },
          }),
        );
      }

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role ?? actor.kind,
          action: `Cambió estado a ${to}`,
          entity: 'rides',
          entityId: current.code,
          before: { status: current.status, version: current.version },
          after: { status: to, version },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );

      return next;
    });

    await this.outbox.notify(eventIds);
    this.realtime.rideChanged(updated);
    return updated;
  }

  /* ------------------------------------------------------------ consultas */

  async byId(rideId: string) {
    const [ride] = await this.db.select().from(rides).where(eq(rides.id, rideId)).limit(1);
    if (!ride) throw new AppError('NOT_FOUND', `No existe la carrera ${rideId}`);
    return ride;
  }

  /**
   * Carrera con el cliente incorporado.
   *
   * El panel necesita el nombre en cada fila; sin el join tendría que pedir
   * el cliente de cada carrera por separado, que con doscientas filas son
   * doscientas peticiones.
   */
  private withCustomer() {
    return this.db
      .select({
        ride: rides,
        customerName: customers.name,
        customerPhone: customers.phone,
        customerEsPrueba: customers.esPrueba,
      })
      .from(rides)
      .innerJoin(customers, eq(customers.id, rides.customerId));
  }

  private static flatten(row: {
    ride: typeof rides.$inferSelect;
    customerName: string | null;
    customerPhone: string;
    customerEsPrueba: boolean;
  }) {
    return {
      ...row.ride,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      customerEsPrueba: row.customerEsPrueba,
    };
  }

  /**
   * Marca un teléfono como del equipo de pruebas. Vale para todas sus
   * carreras, también las de antes: Reportes las saca al contar.
   */
  async marcarClienteDePrueba(customerId: string, esPrueba: boolean, actor: Actor) {
    const [antes] = await this.db
      .select({ phone: customers.phone, esPrueba: customers.esPrueba })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    if (!antes) throw new AppError('NOT_FOUND', 'Ese cliente no existe');
    if (antes.esPrueba === esPrueba) return { esPrueba };

    await this.db.transaction(async (tx) => {
      await tx.update(customers).set({ esPrueba }).where(eq(customers.id, customerId));
      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role ?? actor.kind,
          action: esPrueba ? 'Marcó un teléfono como de prueba' : 'Quitó la marca de prueba a un teléfono',
          entity: 'customers',
          entityId: antes.phone,
          before: { esPrueba: antes.esPrueba },
          after: { esPrueba },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );
    });
    return { esPrueba };
  }

  async detail(rideId: string) {
    const [row] = await this.withCustomer().where(eq(rides.id, rideId)).limit(1);
    if (!row) throw new AppError('NOT_FOUND', `No existe la carrera ${rideId}`);

    const [history, offers] = await Promise.all([
      this.db
        .select()
        .from(rideStatusHistory)
        .where(eq(rideStatusHistory.rideId, rideId))
        .orderBy(rideStatusHistory.at),
      this.db
        .select({
          driverId: rideOffers.driverId,
          driverName: drivers.name,
          wave: rideOffers.wave,
          intento: rideOffers.intento,
          sentAt: rideOffers.sentAt,
          expiresAt: rideOffers.expiresAt,
          etaMinutes: rideOffers.etaMinutes,
          distanceKm: rideOffers.distanceKm,
          response: rideOffers.response,
          aviso: rideOffers.aviso,
          recibidaAt: rideOffers.recibidaAt,
        })
        .from(rideOffers)
        .innerJoin(drivers, eq(drivers.id, rideOffers.driverId))
        .where(eq(rideOffers.rideId, rideId))
        .orderBy(rideOffers.sentAt),
    ]);

    /*
     * Quién la lleva, con lo que el cliente necesita para reconocer el taxi:
     * nombre, código interno y placa. El flujo de avisos de n8n lo lee de
     * aquí; antes tenía que buscarlo entre las ofertas, y la placa no estaba.
     */
    const [driver] = row.ride.driverId
      ? await this.db
          .select({
            id: drivers.id,
            code: drivers.code,
            name: drivers.name,
            plate: vehicles.plate,
            movil: vehicles.internalNumber,
          })
          .from(drivers)
          .leftJoin(vehicles, eq(vehicles.id, sql`${row.ride.vehicleId}::uuid`))
          .where(eq(drivers.id, row.ride.driverId))
          .limit(1)
      : [];

    return { ...RidesService.flatten(row), driver: driver ?? null, history, offers };
  }

  async list(status?: RideStatus[], limit = 100) {
    const query = this.withCustomer().orderBy(desc(rides.createdAt)).limit(limit);
    const rows = await (status?.length ? query.where(inArray(rides.status, status)) : query);
    return rows.map(RidesService.flatten);
  }

  /**
   * Estado del conductor al abrir o recargar la PWA.
   *
   * Sin esto, un conductor que recarga en mitad de una carrera vería la
   * pantalla de espera: el socket solo trae lo que pasa de ahora en adelante,
   * no lo que ya estaba pasando.
   */
  async driverSession(driverId: string) {
    // Con la carrera ya aceptada, el conductor sí ve el teléfono del cliente:
    // lo necesita para avisar que llegó. Antes de aceptar, no (§8.1).
    const [active] = await this.withCustomer()
      .where(
        and(
          eq(rides.driverId, driverId),
          inArray(rides.status, ['ASSIGNED', 'DRIVER_ARRIVED', 'IN_PROGRESS']),
        ),
      )
      .limit(1);

    if (active) {
      return { activeRide: RidesService.flatten(active), pendingOffer: null };
    }

    // Una oferta viva que el conductor no vio porque estaba sin cobertura.
    // La oferta NO lleva cliente: el conductor decide con la dirección, la
    // distancia y la tarifa, no con quién es.
    const [offer] = await this.db
      .select({
        rideId: rideOffers.rideId,
        wave: rideOffers.wave,
        distanceKm: rideOffers.distanceKm,
        etaMinutes: rideOffers.etaMinutes,
        expiresAt: rideOffers.expiresAt,
        ride: rides,
      })
      .from(rideOffers)
      .innerJoin(rides, eq(rides.id, rideOffers.rideId))
      .where(
        and(
          eq(rideOffers.driverId, driverId),
          eq(rideOffers.response, 'pending'),
          isNull(rideOffers.revokedAt),
          gt(rideOffers.expiresAt, new Date()),
          eq(rides.status, 'NOTIFIED'),
        ),
      )
      .orderBy(desc(rideOffers.sentAt))
      .limit(1);

    return { activeRide: null, pendingOffer: offer ?? null };
  }

  /* ----------------------------------------------- edición de dirección */

  /**
   * RF-11. Cambiar el punto puede cambiar la zona y el tiempo estimado; por
   * eso se recalcula y se avisa a n8n con `ride.eta_updated`.
   */
  async updateAddress(
    rideId: string,
    update: { text: string; reference?: string; point?: Point; link?: string },
    actor: Actor,
  ) {
    const ride = await this.byId(rideId);

    if (ride.status === 'COMPLETED' || ride.status === 'CANCELLED') {
      throw new AppError('INVALID_TRANSITION', 'La carrera ya terminó');
    }

    /*
     * Una ubicación nueva (punto o enlace) reemplaza la anterior entera: el
     * enlace viejo apuntaría al sitio de antes. Sin ubicación nueva —solo se
     * agregó una referencia— se conservan el punto, su origen y el enlace.
     * Y una ubicación compartida después de crear la carrera la deja como
     * `compartida`: si seguía `sin_ubicar`, la PWA no mostraba el punto.
     */
    const link = enlaceDeMapaValido(update.link);
    const puntoNuevo = update.point ?? puntoDeEnlace(link) ?? undefined;
    const point = puntoNuevo ?? { lat: ride.pickupLat!, lng: ride.pickupLng! };
    const ubicacion = puntoNuevo
      ? { pickupSource: 'compartida' as const, pickupLink: link }
      : {};
    if (puntoNuevo) await this.exigirPaipa(puntoNuevo);
    const trayecto = this.trayectos.medir(
      point,
      ride.dropoffLat && ride.dropoffLng ? { lat: ride.dropoffLat, lng: ride.dropoffLng } : undefined,
    );

    const eventIds: string[] = [];

    const updated = await this.db.transaction(async (tx) => {
      const [next] = await tx
        .update(rides)
        .set({
          pickupText: update.text,
          pickupReference: update.reference,
          pickupLat: point.lat,
          pickupLng: point.lng,
          ...ubicacion,
          zoneId: trayecto.originZoneId,
          etaMinutes: trayecto.etaMinutes,
          version: ride.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(rides.id, rideId))
        .returning();

      await tx.insert(rideAddressEdits).values({
        id: uuidv7(),
        rideId,
        field: 'pickup',
        previousValue: ride.pickupText,
        newValue: update.text,
        actor: actor.kind,
        actorName: actor.name,
      });

      eventIds.push(
        await this.outbox.enqueue(tx, {
          type: 'ride.eta_updated',
          rideId,
          rideCode: ride.code,
          rideVersion: ride.version + 1,
          payload: {
            code: ride.code,
            pickup: { text: update.text, reference: update.reference, point },
            etaMinutes: trayecto.etaMinutes,
          },
        }),
      );

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role ?? actor.kind,
          action: 'Editó dirección de recogida',
          entity: 'rides',
          entityId: ride.code,
          before: { pickupText: ride.pickupText },
          after: { pickupText: update.text },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );

      return next;
    });

    await this.outbox.notify(eventIds);
    this.realtime.rideChanged(updated);
    return updated;
  }

  /* ------------------------------------------------- medio de pago */

  /**
   * Cambia el medio de pago de una carrera sin asignar.
   *
   * El caso que lo pide: nadie con pago electrónico la tomó, se le pregunta
   * al cliente si puede pagar en efectivo, y si dice que sí se cambia y se
   * relanza. Solo sin asignar a propósito: con ofertas ya repartidas, o con
   * conductor, cambiarlo dejaría la carrera en manos de alguien que no se
   * eligió con esta regla.
   */
  async cambiarMedioDePago(rideId: string, pagoElectronico: boolean, actor: Actor) {
    const ride = await this.byId(rideId);

    if (ride.status !== 'UNASSIGNED') {
      throw new AppError(
        'INVALID_TRANSITION',
        `El medio de pago solo se cambia con la carrera sin asignar; esta está en ${ride.status}`,
      );
    }
    if (ride.pagoElectronico === pagoElectronico) return ride;

    const updated = await this.db.transaction(async (tx) => {
      const [next] = await tx
        .update(rides)
        .set({ pagoElectronico, version: ride.version + 1, updatedAt: new Date() })
        .where(eq(rides.id, rideId))
        .returning();

      await this.audit.record(
        {
          actorId: actor.id,
          actorName: actor.name,
          role: actor.role ?? actor.kind,
          action: 'Cambió el medio de pago',
          entity: 'rides',
          entityId: ride.code,
          before: { pagoElectronico: ride.pagoElectronico },
          after: { pagoElectronico },
          ip: actor.ip,
        },
        tx as unknown as Database,
      );

      return next!;
    });

    this.realtime.rideChanged(updated);
    return updated;
  }

  /**
   * Cancela la carrera. Queda dicho quién lo hizo (`cancelledBy`) y, si fue
   * el conductor, la clave del motivo (`cancelCode`): Reportes cuenta con
   * eso. El evento a n8n lleva lo mismo, para que el aviso al cliente pueda
   * distinguir quién la canceló.
   */
  async cancel(
    rideId: string,
    reason: string,
    actor: Actor,
    /**
     * `cierre`: por qué la cerró el sistema (`sin_conductor`, `caducada`), para
     * que n8n le diga al cliente lo que corresponde. Va aparte de `code`, que
     * es el motivo del conductor y cuentan los reportes.
     */
    opciones: { code?: string; at?: Point; cierre?: string } = {},
  ) {
    const ride = await this.byId(rideId);

    const updated = await this.transition(rideId, 'CANCELLED', actor, {
      note: reason,
      at: opciones.at,
      patch: {
        cancelReason: reason,
        cancelledBy: actor.kind,
        // La causa del cierre del sistema también se guarda: Reportes la
        // cuenta como «se quedó sin taxi», no como una cancelación más.
        cancelCode: opciones.code ?? opciones.cierre ?? null,
        finishedAt: new Date(),
      },
      event: {
        type: 'ride.cancelled',
        payload: {
          reason,
          cancelledBy: actor.kind,
          ...(opciones.code ? { code: opciones.code } : {}),
          ...(opciones.cierre ? { cierre: opciones.cierre } : {}),
        },
      },
    });

    // Las ofertas vivas dejan de tener sentido y el conductor queda libre.
    await this.dispatch.revokeOffers(rideId);
    if (ride.driverId) await this.dispatch.releaseDriver(ride.driverId);

    return updated;
  }
}
