import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MotionConfig, motion } from 'motion/react';
import { Wifi, WifiOff } from 'lucide-react';
import { screenTransition } from '@tax/ui';
import { TopStatus } from './components/Chrome';
import { Acceso } from './screens/Acceso';
import { Turno } from './screens/Turno';
import { Oferta } from './screens/Oferta';
import { Carrera } from './screens/Carrera';
import { Resumen } from './screens/Resumen';
import { ApiError, api, installId, storeToken, storedToken } from './api/client';
import { connectDriverSocket, type OfferPush } from './api/socket';
import { onQueueChange, send, watchConnection } from './api/queue';
import { watchPosition, type PositionWatcher } from './api/position';
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
  shift: { shiftId: string; plate: string; startedAt: string } | null;
  totals: { rides: number; earned: number };
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
          offer: {
            ...offer,
            distanceKm: me.pendingOffer.distanceKm,
            etaMinutes: me.pendingOffer.etaMinutes,
            expiresAt: new Date(me.pendingOffer.expiresAt).getTime(),
            wave: Math.min(3, Math.max(1, me.pendingOffer.wave)) as 1 | 2 | 3,
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
      dispatch({
        type: 'restore',
        phase: me.shift ? 'available' : 'off_shift',
        offer: null,
        shiftStartedAt,
        totals: me.totals,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        storeToken(null);
        dispatch({ type: 'logged_out' });
      }
    }
  }, []);

  useEffect(() => {
    void restore();
  }, [restore]);

  /* --- socket: ofertas y cambios de la carrera propia ---------------------- */
  useEffect(() => {
    if (session.phase === 'login') return;

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
        if (session.phase === 'offer' && session.offer?.rideId === rideId) {
          dispatch({ type: 'offer_rejected' });
          setNotice('Otro conductor tomó la carrera.');
        }
      },

      onRideChanged: () => {
        void restore();
      },
    });

    return disconnect;
  }, [session.phase, session.offer?.rideId, restore]);

  /* --- posición: solo con turno abierto ------------------------------------ */
  useEffect(() => {
    const onShift =
      session.phase === 'available' || session.phase === 'paused' || session.phase === 'ride';

    if (!onShift) {
      positionWatcher.current?.stop();
      positionWatcher.current = undefined;
      return;
    }

    positionWatcher.current ??= watchPosition({ onError: setNotice });
    positionWatcher.current.setRideId(session.phase === 'ride' ? session.offer?.rideId : undefined);

    return () => {
      if (session.phase === 'off_shift' || session.phase === 'login') {
        positionWatcher.current?.stop();
        positionWatcher.current = undefined;
      }
    };
  }, [session.phase, session.offer?.rideId]);

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

  /* --- la pantalla no se apaga durante una carrera (Wake Lock API) --------- */
  useEffect(() => {
    if (session.phase !== 'ride') return;
    let sentinel: WakeLockSentinel | undefined;
    let cancelled = false;

    navigator.wakeLock
      ?.request('screen')
      .then((lock) => {
        if (cancelled) void lock.release();
        else sentinel = lock;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      void sentinel?.release();
    };
  }, [session.phase]);

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
        return 'Código, placa o PIN incorrectos.';
      }
    },
    [restore],
  );

  const rideId = session.offer?.rideId;

  const chrome = (children: ReactNode) => (
    <MotionConfig reducedMotion="user">
      <div className="relative mx-auto flex h-dvh max-w-md flex-col overflow-hidden bg-canvas">
        <TopStatus
          online={session.online}
          queued={session.queued}
          notice={notice}
          onDismissNotice={() => setNotice(undefined)}
          right={
            session.online ? (
              <Wifi className="size-3.5 text-ink-muted" />
            ) : (
              <WifiOff className="size-3.5 text-[var(--t-warning-ink)]" />
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
      <motion.div
          key={session.phase}
          variants={screenTransition(direction)}
          initial="hidden"
          animate="visible"
          className="flex min-h-0 flex-1 flex-col"
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
                onPause={() => dispatch({ type: 'pause' })}
                onResume={() => dispatch({ type: 'resume' })}
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
