import { useEffect, useState } from 'react';
import { CarFront } from 'lucide-react';
import { cn } from '@tax/ui';
import { api } from '../api/client';

interface VehiculoPermitido {
  id: string;
  plate: string;
  interno: string | null;
}

/**
 * Los vehículos que la oficina le permite manejar, para tocar en vez de
 * escribir la placa (18/11/2026).
 *
 * Solo puede abrir turno o cambiar de carro en estos: el servidor lo exige.
 * Mostrárselos evita el error de dedo y le dice de entrada cuáles son. Sin
 * señal no se muestran y la placa se sigue pudiendo escribir.
 */
export function PlacasPermitidas({
  elegida,
  onElegir,
  excluir,
}: {
  elegida: string;
  onElegir: (placa: string) => void;
  /** La del turno actual, al cambiar de carro: no tiene sentido ofrecerla. */
  excluir?: string;
}) {
  const [vehiculos, setVehiculos] = useState<VehiculoPermitido[] | null>(null);

  useEffect(() => {
    let vigente = true;
    api
      .get<VehiculoPermitido[]>('/v1/driver/vehicles')
      .then((lista) => vigente && setVehiculos(lista))
      .catch(() => vigente && setVehiculos(null));
    return () => {
      vigente = false;
    };
  }, []);

  if (vehiculos === null) return null;

  const visibles = vehiculos.filter((v) => v.plate !== excluir);

  if (vehiculos.length === 0) {
    return (
      <p className="text-base text-[var(--t-warning-ink)]">
        No tienes vehículos asignados. Llama a la oficina para que te asignen uno.
      </p>
    );
  }
  if (visibles.length === 0) {
    return <p className="text-base text-ink-muted">No tienes otro vehículo permitido.</p>;
  }

  return (
    <div>
      <p className="text-micro font-semibold uppercase tracking-[0.07em] text-ink-muted">Tus vehículos</p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {visibles.map((v) => {
          const activa = v.plate === elegida;
          return (
            <button
              key={v.id}
              type="button"
              aria-pressed={activa}
              onClick={() => onElegir(v.plate)}
              className={cn(
                'flex h-12 items-center gap-2 rounded-lg border px-3.5 font-mono text-lg font-semibold',
                activa ? 'border-brand bg-brand text-on-accent' : 'border-line-strong bg-surface text-ink',
              )}
            >
              <CarFront className="size-5 shrink-0" />
              {v.interno ? `${v.interno} · ${v.plate}` : v.plate}
            </button>
          );
        })}
      </div>
    </div>
  );
}
