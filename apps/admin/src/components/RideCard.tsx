import { motion } from 'motion/react';
import { Clock, MapPin, User } from 'lucide-react';
import type { Driver, Ride } from '@tax/shared';
import { RIDE_STATUS_LABEL, RIDE_STATUS_TONE, formatRelative } from '@tax/shared';
import { StatusPill, cn, spring, staggerItem } from '@tax/ui';

export function RideCard({
  ride,
  driver,
  selected,
  pulse,
  onClick,
}: {
  ride: Ride;
  driver?: Driver;
  selected?: boolean;
  pulse?: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      layout
      layoutId={`ride-${ride.id}`}
      variants={staggerItem}
      transition={spring.gentle}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.99 }}
      onClick={onClick}
      className={cn(
        'w-full rounded-md border bg-surface p-2.5 text-left',
        'transition-[border-color,box-shadow] duration-150 ease-[var(--ease-standard)]',
        selected ? 'border-accent shadow-sm ring-[3px] ring-accent-soft' : 'border-line hover:border-line-strong',
        pulse && 'animate-flash',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-caption font-medium text-ink-secondary">{ride.code}</span>
        <StatusPill tone={RIDE_STATUS_TONE[ride.status]} live={ride.status === 'NOTIFIED'}>
          {RIDE_STATUS_LABEL[ride.status]}
        </StatusPill>
      </div>

      <p className="mt-1.5 flex items-start gap-1.5 text-base leading-snug text-ink">
        <MapPin className="mt-0.5 size-3.5 shrink-0 text-ink-muted" />
        <span className="line-clamp-2">{ride.pickup.text}</span>
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-muted">
        <span className="inline-flex items-center gap-1">
          <Clock className="size-3" />
          <time>{formatRelative(ride.createdAt)}</time>
        </span>
        {driver ? (
          <span className="inline-flex items-center gap-1 truncate">
            <User className="size-3" />
            {driver.code} · {driver.vehicle.plate}
          </span>
        ) : null}
      </div>
    </motion.button>
  );
}
