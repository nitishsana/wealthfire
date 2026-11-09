import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { analyze, deserialize, serialize, STORAGE_KEY as BASE_KEY, type Analysis, type AppData } from '@wealthfire/core';
import { previewData } from './preview';
import { storageKey } from './localTest';

/** `wealthfire.data.v1`, or `wf.persona.<id>.wealthfire.data.v1` for a test user (localkyc build, ?persona=). */
const STORAGE_KEY = storageKey(BASE_KEY);

interface Store {
  data: AppData;
  analysis: Analysis;
  update: (fn: (d: AppData) => AppData) => void;
  replace: (d: AppData) => void;
}

const Ctx = createContext<Store | null>(null);

/** Data lives only in this browser (localStorage). Nothing is sent to a server. */
export function DataProvider({ children }: { children: ReactNode }) {
  // First load: the "after a reload" rules apply (deserialize's default).
  const [data, setData] = useState<AppData>(() => previewData() ?? deserialize(localStorage.getItem(STORAGE_KEY)));
  // The state last taken from another tab. It is never written back, even when loading it changed it
  // (review bug 1: two tabs would otherwise keep rewriting each other's step).
  const fromOtherTab = useRef<AppData | null>(null);

  useEffect(() => {
    if (data === fromOtherTab.current) return;
    // Skip identical writes so a change received from another tab is not written straight back.
    const json = serialize(data);
    if (localStorage.getItem(STORAGE_KEY) !== json) localStorage.setItem(STORAGE_KEY, json);
  }, [data]);

  // Keep every open tab in sync: a lock, sign-out or delete-all in one tab reaches the others.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.storageArea !== localStorage || (e.key !== STORAGE_KEY && e.key !== null) || e.newValue === e.oldValue) return;
      const next = e.newValue;
      // Not a reload: the other tab's state is taken as it is, without the reload-only rules.
      // Built and remembered outside the updater, so the updater stays pure (StrictMode runs it twice).
      const n = deserialize(next, { reload: false });
      fromOtherTab.current = n;
      setData((d) => (next === serialize(d) ? d : n));
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const update = useCallback((fn: (d: AppData) => AppData) => setData((d) => fn(d)), []);
  const replace = useCallback((d: AppData) => setData(d), []);
  const analysis = useMemo(() => analyze(data), [data]);

  return <Ctx.Provider value={{ data, analysis, update, replace }}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside DataProvider');
  return s;
}
