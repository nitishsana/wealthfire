import type { Asset, AssetType, Liability } from './types';

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  equity_mf: 'Equity mutual funds',
  debt_mf: 'Debt mutual funds',
  stocks: 'Stocks',
  fd: 'Fixed deposits',
  epf: 'EPF',
  ppf: 'PPF',
  nps: 'NPS',
  gold: 'Gold',
  cash: 'Cash / savings',
  real_estate: 'Real estate',
  other: 'Other',
};

/** Which bucket-style class each asset type counts as. Real estate is not counted toward FIRE corpus. */
export const ASSET_CLASS_OF: Record<AssetType, 'equity' | 'debt' | 'gold' | 'cash' | 'illiquid'> = {
  equity_mf: 'equity',
  stocks: 'equity',
  nps: 'equity',
  debt_mf: 'debt',
  fd: 'debt',
  epf: 'debt',
  ppf: 'debt',
  gold: 'gold',
  cash: 'cash',
  real_estate: 'illiquid',
  other: 'illiquid',
};

export interface NetWorthSummary {
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  /** Assets that can fund FIRE (excludes real estate / other) */
  investable: number;
  byClass: { equity: number; debt: number; gold: number; cash: number; illiquid: number };
  monthlyEmi: number;
}

export function summarizeNetWorth(assets: Asset[], liabilities: Liability[]): NetWorthSummary {
  const byClass = { equity: 0, debt: 0, gold: 0, cash: 0, illiquid: 0 };
  for (const a of assets) byClass[ASSET_CLASS_OF[a.type]] += a.value;
  const totalAssets = assets.reduce((s, a) => s + a.value, 0);
  const totalLiabilities = liabilities.reduce((s, l) => s + l.outstanding, 0);
  const investable = byClass.equity + byClass.debt + byClass.gold + byClass.cash;
  const monthlyEmi = liabilities.reduce((s, l) => s + l.monthlyEmi, 0);
  return { totalAssets, totalLiabilities, netWorth: totalAssets - totalLiabilities, investable, byClass, monthlyEmi };
}
