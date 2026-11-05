import type { Assumptions, RiskProfileName } from './types';
import { blendedReturn } from './finance';

export type AssetClass = 'equity' | 'debt' | 'gold' | 'cash';

export interface FundCategory {
  id: string;
  name: string;
  assetClass: AssetClass;
  note: string;
}

/** Mutual fund categories (SEBI-style). We suggest categories, not named schemes. */
export const FUND_CATEGORIES: FundCategory[] = [
  { id: 'nifty50', name: 'Nifty 50 Index Fund', assetClass: 'equity', note: 'Low-cost core of large companies' },
  { id: 'flexi', name: 'Flexi Cap Fund', assetClass: 'equity', note: 'Mix of large, mid and small' },
  { id: 'midcap', name: 'Mid Cap Fund', assetClass: 'equity', note: 'Higher growth, bigger swings' },
  { id: 'smallcap', name: 'Small Cap Fund', assetClass: 'equity', note: 'Highest growth and risk' },
  { id: 'intl', name: 'International (US) Fund of Funds', assetClass: 'equity', note: 'Spread outside India' },
  { id: 'shortdebt', name: 'Short Duration Debt Fund', assetClass: 'debt', note: 'Stable, 1-3 yr money' },
  { id: 'corpbond', name: 'Corporate Bond Fund', assetClass: 'debt', note: 'Stable, 3-5 yr money' },
  { id: 'gold', name: 'Gold ETF / Gold FoF', assetClass: 'gold', note: 'Hedge for bad years' },
  { id: 'liquid', name: 'Liquid Fund', assetClass: 'cash', note: 'Emergency and near-term cash' },
];

/** Base weights (%) per risk profile. Each row sums to 100. */
const BASE_ALLOCATION: Record<RiskProfileName, Record<string, number>> = {
  Conservative: { nifty50: 20, flexi: 5, midcap: 0, smallcap: 0, intl: 0, shortdebt: 35, corpbond: 20, gold: 10, liquid: 10 },
  Moderate: { nifty50: 30, flexi: 10, midcap: 0, smallcap: 0, intl: 0, shortdebt: 25, corpbond: 15, gold: 10, liquid: 10 },
  Balanced: { nifty50: 30, flexi: 15, midcap: 10, smallcap: 0, intl: 5, shortdebt: 15, corpbond: 10, gold: 10, liquid: 5 },
  Growth: { nifty50: 30, flexi: 20, midcap: 15, smallcap: 5, intl: 10, shortdebt: 10, corpbond: 0, gold: 5, liquid: 5 },
  Aggressive: { nifty50: 25, flexi: 20, midcap: 20, smallcap: 15, intl: 10, shortdebt: 5, corpbond: 0, gold: 5, liquid: 0 },
};

export interface AllocationLine {
  category: FundCategory;
  weight: number; // %
  monthlyAmount: number; // INR, of the SIP
}

export interface PortfolioSuggestion {
  profile: RiskProfileName;
  equityPct: number;
  lines: AllocationLine[];
  expectedReturn: number; // % per year
  glideNote: string;
}

/**
 * Cap equity as FIRE gets close (glide path), so the user is not all-equity on retirement day.
 * yearsToFire >= 10: no cap. 5-10: max 70%. 2-5: max 55%. <2: max 40%.
 */
export function equityCap(yearsToFire: number): number {
  if (yearsToFire >= 10) return 100;
  if (yearsToFire >= 5) return 70;
  if (yearsToFire >= 2) return 55;
  return 40;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function classReturn(cls: AssetClass, a: Assumptions): number {
  if (cls === 'equity') return a.equityReturn;
  if (cls === 'debt') return a.debtReturn;
  if (cls === 'gold') return (a.equityReturn + a.debtReturn) / 2 - 1;
  return a.cashReturn;
}

export function suggestPortfolio(
  profile: RiskProfileName,
  yearsToFire: number,
  monthlySip: number,
  a: Assumptions,
): PortfolioSuggestion {
  const base = { ...BASE_ALLOCATION[profile] };
  const cap = equityCap(yearsToFire);
  const equityIds = FUND_CATEGORIES.filter((c) => c.assetClass === 'equity').map((c) => c.id);
  const equityNow = equityIds.reduce((s, id) => s + (base[id] ?? 0), 0);
  let glideNote = 'Far from FIRE: full growth mix.';

  if (equityNow > cap) {
    // Scale equity down evenly, move the excess to short debt and liquid (2:1).
    const scale = cap / equityNow;
    for (const id of equityIds) base[id] = round1((base[id] ?? 0) * scale);
    const newEq = equityIds.reduce((s, id) => s + (base[id] ?? 0), 0);
    const freed = equityNow - newEq;
    const toDebt = round1((freed * 2) / 3);
    base.shortdebt = round1((base.shortdebt ?? 0) + toDebt);
    base.liquid = round1((base.liquid ?? 0) + freed - toDebt);
    glideNote = `FIRE in ~${Math.max(0, Math.round(yearsToFire))} yrs: equity capped at ${cap}% to protect gains.`;
  }

  const lines: AllocationLine[] = FUND_CATEGORIES.map((category) => {
    const weight = base[category.id] ?? 0;
    return { category, weight, monthlyAmount: Math.round((monthlySip * weight) / 100) };
  }).filter((l) => l.weight > 0);

  const equityPct = Math.round(lines.filter((l) => l.category.assetClass === 'equity').reduce((s, l) => s + l.weight, 0));
  const expectedReturn = blendedReturn(lines.map((l) => ({ weight: l.weight, ret: classReturn(l.category.assetClass, a) })));

  return { profile, equityPct, lines, expectedReturn, glideNote };
}
