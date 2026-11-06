// iPhone shell. Screens come from @wealthfire/mobile-ui, logic from @wealthfire/core.
// iOS-only behaviour lives here (no hardware back button; light status bar on dark UI).
import { StatusBar } from 'expo-status-bar';
import { WealthfireApp } from '@wealthfire/mobile-ui';
import appJson from './app.json';

// Optional OTP provider config. Not set in v1, so onboarding uses the demo provider.
const extra: Record<string, unknown> = appJson.expo.extra;
const otp = {
  provider: typeof extra.otpProvider === 'string' && extra.otpProvider ? extra.otpProvider : undefined,
  apiUrl: typeof extra.otpApiUrl === 'string' && extra.otpApiUrl ? extra.otpApiUrl : undefined,
};

export default function App() {
  return (
    <>
      <StatusBar style="light" />
      <WealthfireApp platform="ios" google={{ iosClientId: appJson.expo.extra.googleIosClientId || undefined }} otp={otp} />
    </>
  );
}
