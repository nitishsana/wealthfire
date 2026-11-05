// Small, pure money formulas. Rates are % per year.

/** Future value of a lump sum. */
export function fvLump(present: number, ratePct: number, years: number): number {
  return present * Math.pow(1 + ratePct / 100, years);
}

/**
 * Future value of a monthly SIP that steps up once a year.
 * Paid at the start of each month.
 */
export function fvSip(monthly: number, ratePct: number, years: number, stepUpPct = 0): number {
  const r = Math.pow(1 + ratePct / 100, 1 / 12) - 1; // effective monthly rate
  const months = Math.round(years * 12);
  let total = 0;
  let sip = monthly;
  for (let m = 0; m < months; m++) {
    if (m > 0 && m % 12 === 0) sip *= 1 + stepUpPct / 100;
    total = (total + sip) * (1 + r);
  }
  return total;
}

/** Monthly SIP needed (first year amount) to reach a target. Uses bisection so step-up is handled. */
export function requiredSip(target: number, ratePct: number, years: number, stepUpPct = 0): number {
  if (target <= 0) return 0;
  if (years <= 0) return Infinity;
  let lo = 0;
  let hi = target; // paying the full target every month surely overshoots
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (fvSip(mid, ratePct, years, stepUpPct) >= target) hi = mid;
    else lo = mid;
  }
  return Math.ceil(hi);
}

/** Weighted return of a mix, weights in % summing to ~100. */
export function blendedReturn(parts: { weight: number; ret: number }[]): number {
  const w = parts.reduce((s, p) => s + p.weight, 0);
  if (w === 0) return 0;
  return parts.reduce((s, p) => s + p.weight * p.ret, 0) / w;
}
