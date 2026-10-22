import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Download, Plus, Share } from 'lucide-react';
import { Button, transition } from '@tax/ui';
import {
  estadoInstalacion,
  pedirInstalacion,
  suscribirInstalacion,
  type EstadoInstalacion,
} from '../api/instalacion';

/**
 * Invitación a instalar la aplicación en la pantalla de inicio.
 *
 * No es cosmética. En iOS, Web Push **solo** funciona con la aplicación
 * instalada (iOS 16.4+): un conductor en iPhone que la use desde Safari no
 * recibirá ofertas con el teléfono bloqueado, y la oleada 1 dura 45 segundos.
 *
 * Android da un diálogo nativo; iOS no tiene nada programático, así que ahí lo
 * único honesto es explicar los tres toques.
 */

function useEstadoInstalacion(): EstadoInstalacion {
  const [estado, setEstado] = useState(estadoInstalacion);

  useEffect(() => {
    const actualizar = () => setEstado(estadoInstalacion());
    const cancelar = suscribirInstalacion(actualizar);

    // Instalar no recarga la página: el modo de visualización cambia en vivo.
    const medio = window.matchMedia('(display-mode: standalone)');
    medio.addEventListener('change', actualizar);

    return () => {
      cancelar();
      medio.removeEventListener('change', actualizar);
    };
  }, []);

  return estado;
}

export function Instalar({ compacto = false }: { compacto?: boolean }) {
  const estado = useEstadoInstalacion();
  const [instalando, setInstalando] = useState(false);

  if (estado === 'instalada' || estado === 'no-aplica') return null;

  const instalar = async () => {
    setInstalando(true);
    try {
      await pedirInstalacion();
    } finally {
      setInstalando(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition.enter}
      className="tone-info rounded-lg border border-[var(--tone-line)] bg-[var(--tone-bg)] px-4 py-3"
    >
      {estado === 'puede-instalarse' ? (
        <div className="space-y-2.5">
          <p className="text-base text-[var(--tone-ink)]">
            Instala la aplicación para recibir las carreras aunque la cierres.
          </p>
          <Button
            size="lg"
            className="w-full"
            icon={<Download className="size-4" />}
            loading={instalando}
            onClick={() => void instalar()}
          >
            Instalar aplicación
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-base text-[var(--tone-ink)]">
            {compacto
              ? 'Añádela a tu pantalla de inicio para recibir avisos.'
              : 'En iPhone, los avisos solo llegan si la añades a la pantalla de inicio.'}
          </p>

          {/* Tres pasos y no un parrafo: se sigue con el pulgar, no se lee. */}
          <ol className="space-y-1.5 text-caption text-[var(--tone-ink)]">
            <li className="flex items-center gap-2">
              <Share className="size-4 shrink-0" />
              Toca Compartir, abajo en Safari
            </li>
            <li className="flex items-center gap-2">
              <Plus className="size-4 shrink-0" />
              Elige «Añadir a pantalla de inicio»
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden="true" className="w-4 shrink-0 text-center">
                ✓
              </span>
              Ábrela desde el icono, no desde Safari
            </li>
          </ol>

          {/*
            En iPhone la aplicación instalada tiene su propio almacenamiento,
            separado del de Safari. Quien entre aquí y luego la instale tendrá
            que escribir su código otra vez, y sin avisar parece un error.
          */}
          {!compacto ? (
            <p className="text-micro text-[var(--tone-ink)] opacity-80">
              Instálala antes de entrar: dentro de la aplicación tendrás que escribir tu código una
              vez más.
            </p>
          ) : null}
        </div>
      )}
    </motion.div>
  );
}
