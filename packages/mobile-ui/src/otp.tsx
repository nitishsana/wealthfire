// One OTP provider for the app's life, shared with the onboarding screens.
// v1: no otpProvider in app.json extra, so createOtpProvider returns the demo provider.
import { createContext, useContext, useState, type ReactNode } from 'react';
import { createOtpProviderSafe, type OtpProvider } from '@wealthfire/core';

export interface OtpConfig {
  provider?: string;
  apiUrl?: string;
}

const OtpCtx = createContext<OtpProvider | null>(null);

export function OtpProviderScope({ config, children }: { config: OtpConfig; children: ReactNode }) {
  // Created once; a later config change needs an app restart (same as the web build-time env).
  // Safe factory: an unknown otpProvider id in app.json falls back to the demo provider instead of crashing at launch.
  const [provider] = useState<OtpProvider>(() => createOtpProviderSafe({ provider: config.provider, apiUrl: config.apiUrl }));
  return <OtpCtx.Provider value={provider}>{children}</OtpCtx.Provider>;
}

export function useOtpProvider(): OtpProvider {
  const p = useContext(OtpCtx);
  if (!p) throw new Error('useOtpProvider outside OtpProviderScope');
  return p;
}
