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
    localStorage.setItem(STORAGE_KEY, serialize(data));
  }, [data]);

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
