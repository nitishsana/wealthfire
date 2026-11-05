// Android shell. Screens come from @wealthfire/mobile-ui, logic from @wealthfire/core.
// Android-only behaviour lives here: the hardware back button goes back through tabs.
import { useEffect, useRef, useState } from 'react';
import { BackHandler } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { WealthfireApp, type TabKey } from '@wealthfire/mobile-ui';
import appJson from './app.json';

export default function App() {
  const [tab, setTab] = useState<TabKey>('home');
  const history = useRef<TabKey[]>([]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const prev = history.current.pop();
      if (prev) { setTab(prev); return true; }
      return false; // let Android close the app
    });
    return () => sub.remove();
  }, []);

  return (
    <>
      <StatusBar style="light" />
      <WealthfireApp platform="android" google={{ androidClientId: appJson.expo.extra.googleAndroidClientId || undefined }} tab={tab} setTab={(t) => { if (t !== tab) history.current.push(tab); setTab(t); }} />
    </>
  );
}
