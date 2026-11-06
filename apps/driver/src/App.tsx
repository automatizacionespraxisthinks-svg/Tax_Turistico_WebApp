import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MotionConfig, motion } from 'motion/react';
import { Wifi, WifiOff } from 'lucide-react';
import type { Oleada, Point } from '@tax/shared';
import { haversineKm } from '@tax/shared';
import { cn, screenTransition } from '@tax/ui';
import { TopStatus } from './components/Chrome';
import { Acceso } from './screens/Acceso';
import { Turno } from './screens/Turno';
import { Oferta } from './screens/Oferta';
import { Carrera } from './screens/Carrera';
import { Resumen } from './screens/Resumen';
import { ApiError, api, installId, storeToken, storedToken } from './api/client';
import { connectDriverSocket, type OfferPush } from './api/socket';
import { onQueueChange, send, watchConnection } from './api/queue';
import {
  CADENCIA_POR_DEFECTO,
  watchPosition,
  type PositionIntervals,
  type PositionWatcher,
} from './api/position';
import { disablePush, enablePush, pushSupport, type PushState } from './api/push';
import {
  initialSession,
  offerFromRide,
  offerFromSocket,
  sessionReducer,
  type ApiRide,
  type Phase,
} from './state/session';

/** Orden de avance: decide si la pantalla entra por la derecha o por la izquierda. */
const ORDER: Record<Phase, number> = {
  login: 0,
  off_shift: 1,
  available: 2,
  paused: 2,
  offer: 3,
  ride: 4,
  summary: 5,
};

interface DriverSessionResponse {
  driver: { id: string; code: string; name: string };
  /** Turno abierto, si lo hay: decide si la PWA arranca en espera o fuera. */
  shift: { shiftId: string; plate: string; startedAt: string; paused: boolean } | null;
  totals: { rides: number };
  rules?: {
    minRideMinutes: number;
    /** Cada cuánto mandar la posición, en segundos, en carrera y en espera. */
    positionSeconds?: { ride: number; idle: number };
  };
  activeRide: ApiRide | null;
  pendingOffer: {
    rideId: string;
    wave: number;
    distanceKm: number;
    etaMinutes: number;
    expiresAt: string;
    ride: ApiRide;
  } | null;
}

export function App() {
  const [session, dispatch] = useReducer(sessionReducer, initialSession);
  const [notice, setNotice] = useState<string>();
  const [push, setPush] = useState<PushState>(() => pushSupport());
  const previousPhase = useRef<Phase>(session.phase);
  const positionWatcher = useRef<PositionWatcher>(undefined);
  /**
   * Cada cuánto manda la posición, según la API. En una referencia y no en el
   * estado porque solo la lee el vigilante del GPS: meterla en el reducer
   * volvería a pintar la pantalla cada vez que `/me` la confirma, sin que
   * nada de lo que se ve haya cambiado.
   */
  const cadencia = useRef<PositionIntervals>(CADENCIA_POR_DEFECTO);
  /**
   * El punto del cliente mientras el conductor va a recogerlo. Con él se mide
   * la distancia en cada lectura del GPS: el aviso de «a 300 m del punto» y
   * el «Llegué» habilitado bajo 150 m dependen de ella.
   */
  const puntoDeRecogida = useRef<Point | undefined>(undefined);

  const direction: 1 | -1 = ORDER[session.phase] >= ORDER[previousPhase.current] ? 1 : -1;
  useEffect(() => {
    previousPhase.current = session.phase;
  }, [session.phase]);

  /* --- estado al abrir: el socket solo trae lo que pase de ahora en adelante */
  const restore = useCallback(async () => {
    if (!storedToken()) return;

    try {
      const me = await api.get<DriverSessionResponse>('/v1/driver/rides/me');
      const shiftStartedAt = me.shift ? new Date(me.shift.startedAt).getTime() : null;

      // Antes de cualquier `dispatch`: el efecto del GPS puede crear el
      // vigilante en ese mismo ciclo y tiene que leer ya la cadencia buena.
      if (me.rules?.positionSeconds) cadencia.current = me.rules.positionSeconds;

      // La placa del turno abierto manda sobre la recordada: es la que de
      // verdad está asociada en la base.
      if (me.shift) {
        try {
          window.localStorage.setItem('tax.driver.plate', me.shift.plate);
        } catch {
          // Sin almacenamiento, el conductor la escribe de nuevo.
        }
      }

      if (me.activeRide) {
        dispatch({
          type: 'restore',
          phase: 'ride',
          offer: offerFromRide(me.activeRide),
          rideStatus: me.activeRide.status as 'ASSIGNED' | 'DRIVER_ARRIVED' | 'IN_PROGRESS',
          shiftStartedAt,
          totals: me.totals,
          minRideMinutes: me.rules?.minRideMinutes,
        });
        return;
      }

      if (me.pendingOffer) {
        const offer = offerFromRide(me.pendingOffer.ride);
        dispatch({
          type: 'restore',
          phase: 'offer',
          shiftStartedAt,
          totals: me.totals,
          minRideMinutes: me.rules?.minRideMinutes,
          offer: {
            ...offer,
            distanceKm: me.pendingOffer.distanceKm,
            etaMinutes: me.pendingOffer.etaMinutes,
            expiresAt: new Date(me.pendingOffer.expiresAt).getTime(),
            wave: Math.min(4, Math.max(1, me.pendingOffer.wave)) as Oleada,
            // Una oferta no lleva cliente aunque venga de la carrera.
            customerName: undefined,
            customerPhone: undefined,
          },
        });
        return;
      }

      // Con turno abierto se vuelve a la espera, no a «fuera de turno»:
      // ofrecer «iniciar turno» cuando ya hay uno deja al conductor
      // chocando contra el índice único sin forma de salir.
      //
      // Y si estaba en pausa, se vuelve a la pausa. Esta línea decía
      // 'available' a secas: cualquier recuperación —reconectar el socket,
      // reabrir la aplicación— le quitaba la pausa al conductor sin que él
      // tocara nada.
      dispatch({
        type: 'restore',
        phase: me.shift ? (me.shift.paused ? 'paused' : 'available') : 'off_shift',
        offer: null,
        shiftStartedAt,
        totals: me.totals,
        minRideMinutes: me.rules?.minRideMinutes,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        /*
         * El token NO se borra.
         *
         * Un 401 aquí casi nunca quiere decir «esta credencial ya no existe».
         * Quiere decir que la oficina suspendió al conductor o lo desactivó, y
         * el servidor deja de resolver su token mientras eso dure; el token
         * sigue siendo bueno y vuelve a servir en cuanto lo habiliten.
         *
         * Borrándolo, una suspensión de media hora le costaba al conductor
         * volver a entrar con código, placa y PIN. Y si de verdad le
         * revocaron el celular, guardarlo no le da nada: el servidor no lo
         * acepta nunca más y va a ver esta misma pantalla.
         */
        dispatch({ type: 'logged_out' });
        setNotice('Tu acceso está en pausa. Si ya te habilitaron, vuelve a abrir la aplicación.');
      }
    }
  }, []);

  useEffect(() => {
    void restore();
  }, [restore]);

  /*
   * Red del navegador, que es lo único que se puede saber antes de entrar.
   *
   * El socket solo se conecta con sesión abierta —sin token el servidor lo
   * cierra—, así que en la pantalla de acceso su estado es «desconectado»
   * siempre. Usarlo ahí hacía que la aplicación saludara con «Sin conexión»
   * a un conductor que tenía internet perfectamente, y encima le ofreciera
   * guardar acciones para reenviarlas, cosa que no existe antes de entrar.
   *
   * `navigator.onLine` no es infalible —da verdadero conectado a un router
   * sin salida— pero distingue el caso que importa: el celular sin señal en
   * una vereda frente al celular que sí tiene datos.
   */
  const [redDelNavegador, setRedDelNavegador] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const marcar = () => setRedDelNavegador(navigator.onLine);
    window.addEventListener('online', marcar);
    window.addEventListener('offline', marcar);
    return () => {
      window.removeEventListener('online', marcar);
      window.removeEventListener('offline', marcar);
    };
  }, []);

  /* --- acceso en pausa: se vuelve a intentar al volver a la aplicación ---- */
  /*
   * Token guardado y la pantalla de acceso delante significa suspendido o
   * desactivado, no sin credencial. Se vuelve a preguntar cada vez que el
   * conductor trae la aplicación al frente: así, en cuanto la oficina lo
   * habilita, entra solo sin escribir nada.
   */
  useEffect(() => {
    if (session.phase !== 'login' || !storedToken()) return;

    const alVolver = () => {
      if (document.visibilityState === 'visible') void restore();
    };

    document.addEventListener('visibilitychange', alVolver);
    return () => document.removeEventListener('visibilitychange', alVolver);
  }, [session.phase, restore]);

  /* --- socket: ofertas y cambios de la carrera propia ---------------------- */

  /*
   * La sesión viva, para los manejadores del socket.
   *
   * El efecto de abajo dependía de `session.phase` y del identificador de la
   * oferta, así que *cualquier* cambio de fase desmontaba el socket y lo
   * volvía a montar. Al reconectar se pide el estado, y eso devolvía al
   * conductor a «esperando carrera»: tomar una pausa la deshacía sola un
   * segundo después. Con la referencia los manejadores siguen viendo el
   * valor último sin que el socket se entere de nada.
   */
  const sesionViva = useRef(session);
  useEffect(() => {
    sesionViva.current = session;
  }, [session]);

  const conSesion = session.phase !== 'login';

  useEffect(() => {
    if (!conSesion) return;

    const disconnect = connectDriverSocket({
      onConnectionChange: (connected) => {
        dispatch({ type: 'set_online', online: connected });
        // Al reconectar puede haber una oferta o una carrera que no se vio.
        if (connected) void restore();
      },

      onOffer: (push: OfferPush) => {
        dispatch({ type: 'offer_received', offer: offerFromSocket(push) });
      },

      onOfferRevoked: (rideId) => {
        // Llega a todos los conductores; solo importa si es la que se está
        // mirando ahora mismo.
        const actual = sesionViva.current;
        if (actual.phase === 'offer' && actual.offer?.rideId === rideId) {
          dispatch({ type: 'offer_rejected' });
          setNotice('Otro conductor tomó la carrera.');
        }
      },

      onRideChanged: () => {
        void restore();
      },

      // Le cerraron el turno: otro tomó su móvil o la oficina lo suspendió.
      // Se dice por qué y se vuelve a preguntar el estado, que lo lleva a
      // «fuera de turno» o, si está suspendido, a la pantalla de acceso.
      onShiftClosed: (motivo) => {
        setNotice(motivo);
        void restore();
      },
    });

    return disconnect;
  }, [conSesion, restore]);

  /* --- posición: solo con turno abierto ------------------------------------ */
  useEffect(() => {
    const onShift =
      session.phase === 'available' || session.phase === 'paused' || session.phase === 'ride';

    if (!onShift) {
      positionWatcher.current?.stop();
      positionWatcher.current = undefined;
      return;
    }

    positionWatcher.current ??= watchPosition({
      onError: setNotice,
      intervals: () => cadencia.current,
      onPosition: (punto) => {
        const destino = puntoDeRecogida.current;
        if (destino) dispatch({ type: 'approach', meters: haversineKm(punto, destino) * 1000 });
      },
    });
    positionWatcher.current.setRideId(session.phase === 'ride' ? session.offer?.rideId : undefined);

    return () => {
      if (session.phase === 'off_shift' || session.phase === 'login') {
        positionWatcher.current?.stop();
        positionWatcher.current = undefined;
      }
    };
  }, [session.phase, session.offer?.rideId]);

  const yendoAlPunto =
    session.phase === 'ride' &&
    (session.rideStatus === 'ASSIGNED' || session.rideStatus === 'DRIVER_ARRIVED');
  const pickupLat = yendoAlPunto ? session.offer?.pickupPoint?.lat : undefined;
  const pickupLng = yendoAlPunto ? session.offer?.pickupPoint?.lng : undefined;
  useEffect(() => {
    puntoDeRecogida.current =
      pickupLat !== undefined && pickupLng !== undefined ? { lat: pickupLat, lng: pickupLng } : undefined;
    // Si el GPS ya tiene posición, la distancia se pone al día sin esperar
    // a la próxima lectura: al reabrir la aplicación, por ejemplo.
    const ultima = positionWatcher.current?.last();
    if (ultima && puntoDeRecogida.current) {
      dispatch({ type: 'approach', meters: haversineKm(ultima, puntoDeRecogida.current) * 1000 });
    }
  }, [pickupLat, pickupLng]);

  /* --- cola sin conexión --------------------------------------------------- */
  useEffect(() => {
    const unwatchQueue = onQueueChange((pending) => {
      dispatch({ type: pending.length > 0 ? 'queued' : 'flush_queue' });
    });
    const unwatchConnection = watchConnection();
    return () => {
      unwatchQueue();
      unwatchConnection();
    };
  }, []);

  /* --- la pantalla no se apaga mientras haya turno (Wake Lock API) -------- */

  const enTurno =
    session.phase === 'available' || session.phase === 'paused' || session.phase === 'ride';

  /*
   * Antes solo durante la carrera; ahora todo el turno, y es lo que sostiene
   * el mapa de la oficina.
   *
   * Una PWA no puede leer el GPS con la aplicación cerrada: la API de
   * geolocalización no existe dentro del service worker, así que sin página
   * viva no hay posición que mandar —ni con permiso «siempre», que en la web
   * no existe—. Y en segundo plano Android congela la pestaña a los pocos
   * minutos de taparla. Lo único que sí está en nuestra mano es que la
   * pantalla no se apague sola mientras el conductor tiene turno abierto.
   *
   * El navegador suelta el bloqueo él mismo cada vez que la página se
   * oculta, y NO lo devuelve al volver: de ahí que se vuelva a pedir en cada
   * `visibilitychange`. Sin eso, bloquear el teléfono una sola vez dejaba la
   * pantalla libre para apagarse el resto del turno, que es justo el caso
   * por el que la oficina dejaba de ver al taxi.
   */
  useEffect(() => {
    if (!enTurno) return;
    let sentinel: WakeLockSentinel | undefined;
    let cancelled = false;

    const pedir = () => {
      if (cancelled || sentinel !== undefined || document.visibilityState !== 'visible') return;
      void navigator.wakeLock
        ?.request('screen')
        .then((lock) => {
          if (cancelled) return void lock.release();
          sentinel = lock;
          // Soltado por el navegador al taparse la página: se olvida para
          // poder volver a pedirlo cuando el conductor vuelva.
          lock.addEventListener('release', () => {
            if (sentinel === lock) sentinel = undefined;
          });
        })
        .catch(() => undefined);
    };

    const alVolver = () => {
      if (document.visibilityState !== 'visible') return;
      pedir();
      /*
       * Volver a la vista es el momento en que la oficina lleva más tiempo
       * sin saber nada de este taxi: mientras la página estuvo tapada el
       * navegador pudo congelarla. La posición sale ya, sin esperar a que
       * venza la cadencia.
       */
      positionWatcher.current?.flush();
    };

    pedir();
    document.addEventListener('visibilitychange', alVolver);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', alVolver);
      void sentinel?.release();
    };
  }, [enTurno]);

  /* --- comandos ------------------------------------------------------------ */

  const command = useCallback(
    async (path: string, optimistic: () => void, body?: unknown) => {
      try {
        const result = await send(path, body);
        optimistic();
        if (result.status === 'queued') {
          setNotice('Guardado: se enviará al volver la señal.');
        }
      } catch (error) {
        const message =
          error instanceof ApiError
            ? error.code === 'RIDE_ALREADY_TAKEN'
              ? 'Otro conductor la tomó primero.'
              : error.message
            : 'No se pudo completar la acción.';
        setNotice(message);
        void restore();
      }
    },
    [restore],
  );

  const login = useCallback(
    async (code: string, plate: string, pin: string): Promise<string | null> => {
      try {
        const response = await api.login<{ token: string }>('/v1/auth/driver', {
          code,
          plate,
          pin,
          device: navigator.userAgent.slice(0, 100),
          install: installId(),
        });
        storeToken(response.token);
        dispatch({ type: 'login' });
        await restore();
        return null;
      } catch (error) {
        if (error instanceof ApiError && error.isOffline) {
          return 'Sin conexión con el servidor.';
        }
        // Con el PIN correcto la API dice hasta cuándo: «PIN incorrecto» lo
        // mandaría a pedir otro a la oficina sin necesidad.
        if (error instanceof ApiError && error.code === 'DRIVER_SUSPENDED') {
          return error.message;
        }
        return 'Código, placa o PIN incorrectos.';
      }
    },
    [restore],
  );

  const rideId = session.offer?.rideId;

  /*
   * Antes de entrar, el indicador habla de la red del teléfono; después, del
   * socket, que es lo que de verdad determina si llegarán las ofertas.
   */
  const enLinea = session.phase === 'login' ? redDelNavegador : session.online;

  const chrome = (children: ReactNode) => (
    <MotionConfig reducedMotion="user">
      <div className="relative mx-auto flex h-dvh max-w-md flex-col overflow-hidden bg-canvas">
        <TopStatus
          online={enLinea}
          queued={session.queued}
          notice={notice}
          onDismissNotice={() => setNotice(undefined)}
          offlineHint={
            session.phase === 'login' ? 'revisa los datos del celular para entrar' : undefined
          }
          right={
            enLinea ? (
              <Wifi className="size-3.5 text-on-ink-muted" />
            ) : (
              <WifiOff className="size-3.5 text-legend-warning" />
            )
          }
        />
        {children}
      </div>
    </MotionConfig>
  );

  /*
   * El acceso es otro modo de la aplicación, no un paso del flujo de la
   * carrera: queda fuera del `AnimatePresence` que encadena las pantallas.
   * Mezclarlos hacía que la transición de salida del acceso no terminara
   * nunca y la aplicación se quedara en la pantalla de entrada con la sesión
   * ya abierta por debajo.
   */
  if (session.phase === 'login') {
    return chrome(<Acceso onSubmit={login} />);
  }

  return chrome(
    <>
      {/*
        * Sin `AnimatePresence`: la pantalla saliente no aporta nada aquí —el
        * conductor mira la que llega— y encadenar salida y entrada deja la
        * puerta abierta a que un render a destiempo congele la transición y
        * el conductor se quede viendo la pantalla anterior con el estado ya
        * cambiado. La dirección de entrada basta para decir si la carrera
        * avanza o retrocede.
        */}
      {/* Con el turno abierto y esperando, la pantalla va sobre el azul de
          marca (HU-UI-01), también detrás de las esquinas del pie. */}
      <motion.div
          key={session.phase}
          variants={screenTransition(direction)}
          initial="hidden"
          animate="visible"
          className={cn(
            'flex min-h-0 flex-1 flex-col',
            (session.phase === 'available' || session.phase === 'paused') && 'bg-brand',
          )}
        >
            {session.phase === 'off_shift' || session.phase === 'available' || session.phase === 'paused' ? (
              <Turno
                session={session}
                push={push}
                onEnablePush={() => void enablePush().then(setPush).catch(() => undefined)}
                onStartShift={(plate) =>
                  void command('/v1/driver/shift/open', () => {
                    dispatch({ type: 'shift_opened' });
                    /*
                     * El permiso se pide aquí y no al abrir la aplicación:
                     * preguntarlo nada más entrar es la forma más rápida de
                     * que lo denieguen, y denegado no se puede volver a
                     * preguntar desde la web.
                     */
                    void enablePush().then(setPush).catch(() => undefined);
                  }, { plate })
                }
                onEndShift={() =>
                  void command('/v1/driver/shift/close', () => {
                    dispatch({ type: 'end_shift' });
                    // Fuera de turno no llegan ofertas: tampoco avisos.
                    void disablePush().catch(() => undefined);
                  })
                }
                onPause={() =>
                  void command('/v1/driver/shift/pause', () => dispatch({ type: 'pause' }))
                }
                onResume={() =>
                  void command('/v1/driver/shift/resume', () => dispatch({ type: 'resume' }))
                }
              />
            ) : null}

            {session.phase === 'offer' && session.offer ? (
              <Oferta
                offer={session.offer}
                onAccept={() =>
                  void command(`/v1/driver/rides/${rideId}/accept`, () =>
                    dispatch({ type: 'offer_accepted' }),
                  )
                }
                onReject={() =>
                  void command(`/v1/driver/rides/${rideId}/reject`, () =>
                    dispatch({ type: 'offer_rejected' }),
                  )
                }
                onExpire={() => dispatch({ type: 'offer_expired' })}
              />
            ) : null}

            {session.phase === 'ride' && session.offer ? (
              <Carrera
                offer={session.offer}
                status={session.rideStatus}
                metersToPickup={session.metersToPickup}
                minRideMinutes={session.minRideMinutes}
                onArrived={() =>
                  void command(
                    `/v1/driver/rides/${rideId}/arrived`,
                    () => dispatch({ type: 'arrived' }),
                    { at: positionWatcher.current?.last() },
                  )
                }
                onBoard={() =>
                  void command(
                    `/v1/driver/rides/${rideId}/board`,
                    () => dispatch({ type: 'passenger_on_board' }),
                    { at: positionWatcher.current?.last() },
                  )
                }
                onFinish={() =>
                  void command(
                    `/v1/driver/rides/${rideId}/finish`,
                    () => dispatch({ type: 'finish' }),
                    { at: positionWatcher.current?.last() },
                  )
                }
                onCancel={async (motivo, detalle) => {
                  /*
                   * Directo, sin la cola de sin conexión: cancelar más tarde,
                   * cuando vuelva la señal, podría caer sobre una carrera que
                   * ya cambió. Sin señal se le dice, y que llame a la oficina.
                   */
                  try {
                    await api.post(`/v1/driver/rides/${rideId}/cancel`, {
                      motivo,
                      detalle,
                      at: positionWatcher.current?.last(),
                    });
                    const code = session.offer?.code;
                    dispatch({ type: 'back_to_available' });
                    setNotice(`Cancelaste la carrera ${code ?? ''}. La oficina ya tiene el motivo.`);
                    return null;
                  } catch (error) {
                    if (error instanceof ApiError && error.isOffline) {
                      return 'Sin señal: no se pudo cancelar. Si es urgente, llama a la oficina.';
                    }
                    void restore();
                    return error instanceof ApiError ? error.message : 'No se pudo cancelar. Inténtalo de nuevo.';
                  }
                }}
              />
            ) : null}

            {session.phase === 'summary' ? (
              <Resumen
                offer={session.offer}
                session={session}
                onContinue={() => dispatch({ type: 'back_to_available' })}
              />
            ) : null}
        </motion.div>
    </>,
  );
}
