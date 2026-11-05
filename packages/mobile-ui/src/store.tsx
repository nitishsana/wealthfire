import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { analyze, deserialize, emptyData, serialize, STORAGE_KEY, type Analysis, type AppData } from '@wealthfire/core';

interface Store {
  loaded: boolean;
  data: AppData;
  analysis: Analysis;
  update: (fn: (d: AppData) => AppData) => void;
  replace: (d: AppData) => void;
}

const Ctx = createContext<Store | null>(null);

/** Same data shape and key as the website; stored on the phone only (AsyncStorage). */
export function DataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppData>(emptyData);
  const [loaded, setLoaded] = useState(false);
  const skipFirstSave = useRef(true);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((json) => setData(deserialize(json)))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    if (skipFirstSave.current) { skipFirstSave.current = false; return; }
    AsyncStorage.setItem(STORAGE_KEY, serialize(data)).catch(() => {});
  }, [data, loaded]);

  const update = useCallback((fn: (d: AppData) => AppData) => setData((d) => fn(d)), []);
  const replace = useCallback((d: AppData) => setData(d), []);
  const analysis = useMemo(() => analyze(data), [data]);

  return <Ctx.Provider value={{ loaded, data, analysis, update, replace }}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside DataProvider');
  return s;
}
