// iPhone shell. Screens come from @wealthfire/mobile-ui, logic from @wealthfire/core.
// iOS-only behaviour lives here (no hardware back button; light status bar on dark UI).
import { StatusBar } from 'expo-status-bar';
import { WealthfireApp } from '@wealthfire/mobile-ui';

export default function App() {
  return (
    <>
      <StatusBar style="light" />
      <WealthfireApp platform="ios" />
    </>
  );
}
