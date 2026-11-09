// Android shell. Screens come from @wealthfire/mobile-ui, logic from @wealthfire/core.
// Android-only behaviour lives here: the hardware back button goes back through tabs.
import { useEffect, useRef, useState } from 'react';
import { BackHandler } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { clearPickerCache, WealthfireApp, type OnboardingBackRef, type TabKey } from '@wealthfire/mobile-ui';
import appJson from './app.json';

// Optional OTP provider config. Not set in v1, so onboarding uses the demo provider.
const extra: Record<string, unknown> = appJson.expo.extra;
const otp = {
  provider: typeof extra.otpProvider === 'string' && extra.otpProvider ? extra.otpProvider : undefined,
  apiUrl: typeof extra.otpApiUrl === 'string' && extra.otpApiUrl ? extra.otpApiUrl : undefined,
};
// Document reader config (design B3, C4). Not set, so the on-device reader (ML Kit) is used; it needs a
// development build (npm run android), not Expo Go. extra.docReader 'demo' is honoured only when __DEV__.
const docReader = {
  reader: typeof extra.docReader === 'string' && extra.docReader ? extra.docReader : undefined,
  apiUrl: typeof extra.docReaderUrl === 'string' && extra.docReaderUrl ? extra.docReaderUrl : undefined,
  // Dev builds only: pick the demo reader's mode (match | misread | different | unreadable). Never shown in the UI.
  demoMode: __DEV__ && typeof extra.demoReaderMode === 'string' ? extra.demoReaderMode : undefined,
};
// Final KYC server (services/kyc, design §6). Not set, so onboarding and Settings stay device-only (demo OTP, device status).
// Set extra.apiUrl (HTTPS) to use it; extra.kycRedirectOrigins lists extra partner page origins (comma separated).
const kycServer = {
  apiUrl: typeof extra.apiUrl === 'string' && extra.apiUrl ? extra.apiUrl : undefined,
  redirectOrigins: typeof extra.kycRedirectOrigins === 'string' && extra.kycRedirectOrigins ? extra.kycRedirectOrigins : undefined,
};

export default function App() {
  const [tab, setTab] = useState<TabKey>('home');
  const history = useRef<TabKey[]>([]);
  // Set by onboarding while it is shown (minor issue 5); null outside onboarding.
  const onboardingBack: OnboardingBackRef = useRef<(() => boolean) | null>(null);

  // Bug 2: once per launch, delete documents left in the picker / crop caches.
  useEffect(() => { void clearPickerCache(); }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // During onboarding: step back one onboarding step, or (e.g. on Sign in) let Android close the app.
      const onboarding = onboardingBack.current;
      if (onboarding) return onboarding();
      const prev = history.current.pop();
      if (prev) { setTab(prev); return true; }
      return false; // let Android close the app
    });
    return () => sub.remove();
  }, []);

  return (
    <>
      <StatusBar style="light" />
      <WealthfireApp platform="android" google={{ androidClientId: appJson.expo.extra.googleAndroidClientId || undefined }} otp={otp} docReader={docReader} kycServer={kycServer} onboardingBack={onboardingBack} tab={tab} setTab={(t) => { if (t !== tab) history.current.push(tab); setTab(t); }} />
    </>
  );
}
