import { Banknote, CreditCard } from 'lucide-react';
import { cn } from '@tax/ui';

/**
 * Cómo paga el cliente: efectivo o pago electrónico.
 *
 * El pago electrónico va resaltado en azul, porque es lo que el conductor
 * tiene que tener listo (el datáfono, el QR de Nequi); el efectivo, en gris,
 * es lo de siempre. Ícono y texto, nunca solo el color.
 */
export function MedioDePago({ electronico, grande = false }: { electronico: boolean; grande?: boolean }) {
  const Icono = electronico ? CreditCard : Banknote;
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border px-4',
        grande ? 'py-4' : 'py-3',
        electronico ? 'tone-info border-[var(--tone-line)] bg-[var(--tone-bg)]' : 'border-line bg-surface-sunk',
      )}
    >
      <Icono
        className={cn('shrink-0', grande ? 'size-7' : 'size-5', electronico ? 'text-[var(--tone-ink)]' : 'text-ink-muted')}
      />
      <div className="min-w-0">
        <p className="text-micro font-semibold uppercase tracking-[0.07em] text-ink-muted">El cliente paga con</p>
        <p
          className={cn(
            'font-semibold leading-tight',
            grande ? 'text-2xl' : 'text-xl',
            electronico ? 'text-[var(--tone-ink)]' : 'text-ink',
          )}
        >
          {electronico ? 'Pago electrónico' : 'Efectivo'}
        </p>
      </div>
    </div>
  );
}
