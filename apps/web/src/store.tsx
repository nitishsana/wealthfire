import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { analyze, deserialize, serialize, STORAGE_KEY, type Analysis, type AppData } from '@wealthfire/core';

interface Store {
  data: AppData;
  analysis: Analysis;
  update: (fn: (d: AppData) => AppData) => void;
  replace: (d: AppData) => void;
}

const Ctx = createContext<Store | null>(null);

/** Data lives only in this browser (localStorage). Nothing is sent to a server. */
export function DataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppData>(() => deserialize(localStorage.getItem(STORAGE_KEY)));

  useEffect(() => {
    // Skip identical writes so a change received from another tab is not written straight back.
    const json = serialize(data);
    if (localStorage.getItem(STORAGE_KEY) !== json) localStorage.setItem(STORAGE_KEY, json);
  }, [data]);

  // Keep every open tab in sync: a lock, sign-out or delete-all in one tab reaches the others.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.storageArea !== localStorage || (e.key !== STORAGE_KEY && e.key !== null) || e.newValue === e.oldValue) return;
      const next = e.newValue;
      setData((d) => (next === serialize(d) ? d : deserialize(next)));
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
