import { useId, type ReactNode } from 'react';
import { ChevronRight, MapPinOff, TriangleAlert } from 'lucide-react';
import type { Point } from '@tax/shared';
import { enlaceDeMapaValido } from '@tax/shared';
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
 * Si el cliente compartió su ubicación, «Ir con Maps» abre el mismo enlace
 * que él mandó, con su pin y el nombre del sitio si eligió uno; «Ir con
 * Waze» va al mismo punto, leído de ese enlace (Waze no abre enlaces de
 * Google).
 *
 * Los enlaces abren la aplicación si está instalada y, si no, el navegador.
 * Van en pestaña aparte para que la PWA siga viva detrás con su GPS.
 */
export function IrConMapas({ point, text, enlace }: { point?: Point; text?: string; enlace?: string }) {
  const enlaces = enlacesDeMapa(point, text, enlace);
  if (!enlaces) return null;

  // Uno debajo del otro: con el ícono, la raya y la flecha, dos en la misma
  // fila no caben en un teléfono sin achicar la letra.
  return (
    <div className="grid gap-3">
      <BotonDeMapa href={enlaces.maps} icon={<PinDeMaps />} estilo="maps">
        Ir con Maps
      </BotonDeMapa>
      <BotonDeMapa href={enlaces.waze} icon={<CaraDeWaze />} estilo="waze">
        Ir con Waze
      </BotonDeMapa>
    </div>
  );
}

export function enlacesDeMapa(
  point?: Point,
  text?: string,
  enlace?: string,
): { maps: string; waze: string } | null {
  if (point) {
    const ll = `${point.lat},${point.lng}`;
    return {
      // La API ya lo filtró; se vuelve a mirar porque es lo que se abre.
      maps: enlaceDeMapaValido(enlace) ?? `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`,
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

/**
 * Los colores de cada aplicación, como en la guía de la empresa: Maps en
 * blanco y Waze en su celeste, los dos con texto casi negro. Son colores de
 * marca, fijos: no cambian con el tema de la PWA. El borde y la altura son
 * los de siempre.
 */
const ESTILO_DE_MAPA = {
  maps: { fondo: '#FFFFFF', presionado: '#F1F3F4', texto: '#202124', raya: '#DADCE0', flecha: '#5F6368' },
  waze: { fondo: '#33CCFF', presionado: '#1FB8EC', texto: '#0B1B26', raya: '#1E8DB5', flecha: '#0B1B26' },
} as const;

function BotonDeMapa({
  href,
  icon,
  estilo,
  children,
}: {
  href: string;
  icon: ReactNode;
  estilo: keyof typeof ESTILO_DE_MAPA;
  children: ReactNode;
}) {
  const c = ESTILO_DE_MAPA[estilo];
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ ['--fondo' as string]: c.fondo, ['--presionado' as string]: c.presionado, color: c.texto }}
      className={cn(
        'flex h-14 items-center gap-4 rounded-lg border border-line bg-[var(--fondo)] pl-5 pr-4',
        'text-lg font-bold',
        'transition-colors duration-150 ease-[var(--ease-standard)] active:bg-[var(--presionado)]',
      )}
    >
      <span className="flex w-8 shrink-0 justify-center">{icon}</span>
      <span aria-hidden="true" className="h-8 w-px shrink-0" style={{ backgroundColor: c.raya }} />
      <span className="flex-1">{children}</span>
      <ChevronRight aria-hidden="true" className="size-6 shrink-0" style={{ color: c.flecha }} strokeWidth={2.5} />
    </a>
  );
}

/** El pin de Google Maps, en sus cuatro colores. */
function PinDeMaps() {
  const id = useId();
  return (
    <svg viewBox="0 0 92 132" className="h-8 w-auto" aria-hidden="true">
      <clipPath id={`${id}-pin`}>
        <path d="M46 0C20.6 0 0 20.6 0 46c0 34.5 46 86 46 86s46-51.5 46-86C92 20.6 71.4 0 46 0z" />
      </clipPath>
      <g clipPath={`url(#${id}-pin)`}>
        <rect width="92" height="132" fill="#34A853" />
        <path d="M0 0h92v22L46 46z" fill="#4285F4" />
        <path d="M0 0l46 46L0 92z" fill="#EA4335" />
        <path d="M0 92l46-46 18 18L20 132H0z" fill="#FBBC04" />
      </g>
      <circle cx="46" cy="46" r="16" fill="#FFFFFF" />
    </svg>
  );
}

/** La carita de Waze: blanca con contorno negro, ojos, sonrisa y ruedas. */
function CaraDeWaze() {
  return (
    <svg viewBox="0 0 32 30" className="h-8 w-auto" aria-hidden="true">
      <path
        d="M17 3c6.6 0 12 4.9 12 11 0 4-2.4 7.4-6 9.4H11.5c-1.6 0-2.9-.8-3.6-2C5.7 20.9 4 19.5 3.6 17.4c1.7-.1 2.6-1 2.8-2.6C6.7 8.3 11.2 3 17 3z"
        fill="#FFFFFF"
        stroke="#000000"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <circle cx="14" cy="11.5" r="1.6" fill="#000000" />
      <circle cx="21.5" cy="11.5" r="1.6" fill="#000000" />
      <path d="M12.8 15.6c1.8 2.6 6.9 2.6 8.7 0" fill="none" stroke="#000000" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="11" cy="25.5" r="3" fill="#000000" />
      <circle cx="21.5" cy="25.5" r="3" fill="#000000" />
    </svg>
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
