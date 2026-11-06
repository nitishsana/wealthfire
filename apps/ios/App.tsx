// iPhone shell. Screens come from @wealthfire/mobile-ui, logic from @wealthfire/core.
// iOS-only behaviour lives here (no hardware back button; light status bar on dark UI).
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { clearPickerCache, WealthfireApp } from '@wealthfire/mobile-ui';
import appJson from './app.json';

// Optional OTP provider config. Not set in v1, so onboarding uses the demo provider.
const extra: Record<string, unknown> = appJson.expo.extra;
const otp = {
  provider: typeof extra.otpProvider === 'string' && extra.otpProvider ? extra.otpProvider : undefined,
  apiUrl: typeof extra.otpApiUrl === 'string' && extra.otpApiUrl ? extra.otpApiUrl : undefined,
};
// Document reader config (design B3, C4). Not set, so the on-device reader (ML Kit) is used; it needs a
// development build (npm run ios), not Expo Go. extra.docReader 'demo' is honoured only when __DEV__.
const docReader = {
  reader: typeof extra.docReader === 'string' && extra.docReader ? extra.docReader : undefined,
  apiUrl: typeof extra.docReaderUrl === 'string' && extra.docReaderUrl ? extra.docReaderUrl : undefined,
  // Dev builds only: pick the demo reader's mode (match | misread | different | unreadable). Never shown in the UI.
  demoMode: __DEV__ && typeof extra.demoReaderMode === 'string' ? extra.demoReaderMode : undefined,
};

export default function App() {
  // Bug 2: once per launch, delete documents left in the picker / crop caches.
  useEffect(() => { void clearPickerCache(); }, []);

  return (
    <>
      <StatusBar style="light" />
      <WealthfireApp platform="ios" google={{ iosClientId: appJson.expo.extra.googleIosClientId || undefined }} otp={otp} docReader={docReader} />
    </>
  );
}
