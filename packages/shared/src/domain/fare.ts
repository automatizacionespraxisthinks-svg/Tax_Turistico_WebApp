import type { ZoneKind } from './geo';

/**
 * Regla tarifaria versionada: una carrera guarda la versión con la que se
 * calculó, y la versión referencia el acto administrativo de la alcaldía (§9.2).
 */
export interface FareRule {
  version: string;
  effectiveFrom: string;
  effectiveTo?: string;
  /** Acto administrativo que autoriza estas tarifas. */
  legalReference: string;
  originKind: Exclude<ZoneKind, 'referencia'>;
  destinationKind: Exclude<ZoneKind, 'referencia'>;
  baseFare: number;
  perKm: number;
  minimumFare: number;
  surcharges: FareSurcharge[];
}

export interface FareSurcharge {
  id: string;
  label: string;
  amount: number;
  /** Franja horaria en la que aplica, en hora local. */
  fromHour?: number;
  toHour?: number;
}

export interface FareQuote {
  amount: number;
  ruleVersion: string;
  breakdown: { label: string; amount: number }[];
  /** Siempre verdadero: al cliente se le informa "tarifa estimada" (Ley 1480). */
  approximate: true;
}

export function quoteFare(rule: FareRule, distanceKm: number, hour: number): FareQuote {
  const breakdown: { label: string; amount: number }[] = [
    { label: 'Banderazo', amount: rule.baseFare },
    { label: `Recorrido ${distanceKm.toFixed(1)} km`, amount: Math.round(distanceKm * rule.perKm) },
  ];

  for (const s of rule.surcharges) {
    const applies =
      s.fromHour === undefined ||
      s.toHour === undefined ||
      (s.fromHour <= s.toHour ? hour >= s.fromHour && hour < s.toHour : hour >= s.fromHour || hour < s.toHour);
    if (applies) breakdown.push({ label: s.label, amount: s.amount });
  }

  const sum = breakdown.reduce((total, line) => total + line.amount, 0);
  const amount = Math.max(sum, rule.minimumFare);
  if (amount !== sum) {
    breakdown.push({ label: 'Ajuste a tarifa mínima', amount: amount - sum });
  }

  return { amount: roundTo100(amount), ruleVersion: rule.version, breakdown, approximate: true };
}

function roundTo100(value: number): number {
  return Math.round(value / 100) * 100;
}
