// Storage-agnostic load/save. Web passes localStorage; mobile passes AsyncStorage.
import type { AppData } from './types';
import { DEFAULT_ASSUMPTIONS } from './fire';

export const STORAGE_KEY = 'wealthfire.data.v1';

export function emptyData(): AppData {
  return {
    version: 1,
    profile: null,
    riskAnswers: {},
    assets: [],
    liabilities: [],
    expenses: [],
    assumptions: { ...DEFAULT_ASSUMPTIONS },
    buckets: null,
    snapshots: [],
  };
}

/** Parse stored JSON safely. Bad or old data falls back to defaults field by field. */
export function deserialize(json: string | null | undefined): AppData {
  const base = emptyData();
  if (!json) return base;
  try {
    const raw = JSON.parse(json) as Partial<AppData>;
    if (!raw || typeof raw !== 'object') return base;
    return {
      version: 1,
      profile: raw.profile ?? null,
      riskAnswers: raw.riskAnswers && typeof raw.riskAnswers === 'object' ? raw.riskAnswers : {},
      assets: Array.isArray(raw.assets) ? raw.assets : [],
      liabilities: Array.isArray(raw.liabilities) ? raw.liabilities : [],
      expenses: Array.isArray(raw.expenses) ? raw.expenses : [],
      assumptions: { ...DEFAULT_ASSUMPTIONS, ...(raw.assumptions ?? {}) },
      buckets: raw.buckets ?? null,
      snapshots: Array.isArray(raw.snapshots) ? raw.snapshots : [],
    };
  } catch {
    return base;
  }
}

export function serialize(data: AppData): string {
  return JSON.stringify(data);
}
