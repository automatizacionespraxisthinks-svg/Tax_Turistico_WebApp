const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const TIME = new Intl.DateTimeFormat('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });

const DATE_TIME = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatMoney(value: number): string {
  return COP.format(value);
}

export function formatTime(iso: string | Date): string {
  return TIME.format(typeof iso === 'string' ? new Date(iso) : iso);
}

export function formatDateTime(iso: string | Date): string {
  return DATE_TIME.format(typeof iso === 'string' ? new Date(iso) : iso);
}

export function formatDistance(km: number): string {
  // Con coma decimal: en Colombia el punto separa miles, y «1.5 km» junto a
  // un «$ 7.600» se lee por un momento como mil quinientos.
  return km < 1
    ? `${Math.round(km * 1000)} m`
    : `${km.toLocaleString('es-CO', { maximumFractionDigits: 1 })} km`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** "hace 2 min" — para listas en vivo donde la hora exacta estorba. */
export function formatRelative(iso: string | Date, now = Date.now()): string {
  const then = (typeof iso === 'string' ? new Date(iso) : iso).getTime();
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 10) return 'ahora';
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return formatDateTime(iso);
}

/** Enmascara el teléfono: el conductor no lo ve hasta aceptar (§8.1). */
export function maskPhone(phone: string): string {
  return phone.length <= 4 ? '••••' : `${'•'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`;
}
