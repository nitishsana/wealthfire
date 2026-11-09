// OTP providers for the app's life, shared with the onboarding screens (same split as apps/web/src/otp.ts).
// - Contact OTP (email / mobile): through the Wealthfire KYC server (HttpOtpProvider) when app.json extra.apiUrl is set;
//   otherwise the provider from extra.otpProvider (v1: the demo provider).
// - Aadhaar OTP on the device: always the extra.otpProvider provider (demo in v1). With a server, the real Aadhaar check is
//   DigiLocker / partner OTP after Check numbers (ServerKycClient.startAadhaar).
import { createContext, useContext, useState, type ReactNode } from 'react';
import { createOtpProviderSafe, HttpOtpProvider, type OtpProvider } from '@wealthfire/core';
import { useKycServer } from './server';

export interface OtpConfig {
  provider?: string;
  apiUrl?: string;
}

interface Providers { contact: OtpProvider; aadhaar: OtpProvider }
const OtpCtx = createContext<Providers | null>(null);

export function OtpProviderScope({ config, children }: { config: OtpConfig; children: ReactNode }) {
  const server = useKycServer();
  // Created once; a later config change needs an app restart (same as the web build-time env).
  // Safe factory: an unknown otpProvider id in app.json falls back to the demo provider instead of crashing at launch.
  const [providers] = useState<Providers>(() => {
    const aadhaar = createOtpProviderSafe({ provider: config.provider, apiUrl: config.apiUrl });
    return { aadhaar, contact: server ? new HttpOtpProvider(server.client) : aadhaar };
  });
  return <OtpCtx.Provider value={providers}>{children}</OtpCtx.Provider>;
}

/** 'contact' for Sign in / Verify your email or mobile, 'aadhaar' (default) for the Aadhaar OTP. */
export function useOtpProvider(kind: 'contact' | 'aadhaar' = 'aadhaar'): OtpProvider {
  const p = useContext(OtpCtx);
  if (!p) throw new Error('useOtpProvider outside OtpProviderScope');
  return p[kind];
}
