// OTP providers for the page's life.
// - Contact OTP (email / mobile): through the Wealthfire KYC server (HttpOtpProvider) when VITE_API_URL
//   is set; otherwise the provider from VITE_OTP_PROVIDER (default demo: codes shown on screen).
// - Aadhaar OTP on the device: always the VITE_OTP_PROVIDER provider (demo in v1). With a server, the
//   real Aadhaar check is DigiLocker / partner OTP after Check numbers (ServerKycClient.startAadhaar).
// An unknown VITE_OTP_PROVIDER value falls back to the default provider instead of blanking the page.
import { createOtpProviderSafe, HttpOtpProvider, type OtpProvider } from '@wealthfire/core';
import { kycServer } from './server';

export const aadhaarOtpProvider: OtpProvider = createOtpProviderSafe({
  provider: import.meta.env.VITE_OTP_PROVIDER,
  apiUrl: import.meta.env.VITE_OTP_API_URL,
});

/** Contact OTP provider (Sign in and Verify your email / mobile). */
export const otpProvider: OtpProvider = kycServer ? new HttpOtpProvider(kycServer) : aadhaarOtpProvider;
