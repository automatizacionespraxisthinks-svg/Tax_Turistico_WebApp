import type { ReactNode } from 'react';
import { MapPinOff, MapPinned, Navigation2, TriangleAlert } from 'lucide-react';
import type { Point } from '@tax/shared';
import { TONE_CLASS, cn } from '@tax/ui';
import type { OrigenDelPunto } from '../state/session';

/** Lo mismo que le pone el geocodificador de la API a cada dirección. */
const CONTEXTO = 'Paipa, Boyacá, Colombia';

/**
 * Abrir el punto en Google Maps o en Waze, ya con la ruta pedida.
 *
 * Con coordenadas, el enlace lleva al metro exacto. Sin ellas busca la
 * dirección escrita con el pueblo al final, igual que la buscó la API. Las
 * coordenadas de reserva de una carrera sin ubicar nunca llegan aquí: son el
 * centro de Paipa, y mandar al conductor a la plaza es peor que mandarlo a
 * buscar la dirección.
 *
 * Los enlaces abren la aplicación si está instalada y, si no, el navegador.
 * Van en pestaña aparte para que la PWA siga viva detrás con su GPS.
 */
export function IrConMapas({ point, text }: { point?: Point; text?: string }) {
  const enlaces = enlacesDeMapa(point, text);
  if (!enlaces) return null;

  return (
    <div className="grid grid-cols-2 gap-3">
      <BotonDeMapa href={enlaces.maps} icon={<MapPinned className="size-6" />}>
        Ir con Maps
      </BotonDeMapa>
      <BotonDeMapa href={enlaces.waze} icon={<Navigation2 className="size-6" />}>
        Ir con Waze
      </BotonDeMapa>
    </div>
  );
}

export function enlacesDeMapa(point?: Point, text?: string): { maps: string; waze: string } | null {
  if (point) {
    const ll = `${point.lat},${point.lng}`;
    return {
      maps: `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`,
      waze: `https://waze.com/ul?ll=${ll}&navigate=yes`,
    };
  }
  if (text?.trim()) {
    const consulta = encodeURIComponent(`${text.trim()}, ${CONTEXTO}`);
    return {
      maps: `https://www.google.com/maps/dir/?api=1&destination=${consulta}&travelmode=driving`,
      waze: `https://waze.com/ul?q=${consulta}&navigate=yes`,
    };
  }
  return null;
}

function BotonDeMapa({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        TONE_CLASS.info,
        'flex h-14 items-center justify-center gap-2 rounded-lg border border-line bg-surface px-3',
        'text-lg font-bold text-ink',
        'transition-colors duration-150 ease-[var(--ease-standard)] active:bg-surface-sunk',
      )}
    >
      <span className="text-[var(--tone-solid)]">{icon}</span>
      {children}
    </a>
  );
}

/**
 * Qué tan fiable es el punto, dicho antes de que el conductor arranque.
 *
 * La ubicación que compartió el cliente es exacta y no lleva aviso. Una
 * dirección que resolvió el geocodificador puede quedarse en la calle sin el
 * número; una que no resolvió no tiene punto en el mapa.
 */
export function AvisoDeUbicacion({ origen }: { origen?: OrigenDelPunto }) {
  if (origen !== 'geocodificada' && origen !== 'sin_ubicar') return null;

  const sinUbicar = origen === 'sin_ubicar';
  const Icono = sinUbicar ? MapPinOff : TriangleAlert;

  return (
    <div
      className={cn(
        TONE_CLASS.warning,
        'flex items-start gap-3 rounded-lg border border-[var(--tone-line)] bg-[var(--tone-bg)] px-4 py-3',
      )}
    >
      <Icono className="mt-0.5 size-5 shrink-0 text-[var(--tone-ink)]" />
      <div className="min-w-0">
        <p className="text-lg font-semibold text-[var(--tone-ink)]">
          {sinUbicar ? 'Sin punto en el mapa' : 'Punto aproximado'}
        </p>
        <p className="text-base leading-snug text-ink-secondary">
          {sinUbicar
            ? 'El cliente no compartió su ubicación: Maps y Waze buscarán la dirección escrita. Si no la encuentras, llámalo.'
            : 'Salió de la dirección escrita, no de la ubicación del cliente. Guíate también por la referencia.'}
        </p>
      </div>
    </div>
  );
}
