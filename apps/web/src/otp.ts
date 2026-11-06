// One OTP provider for the page's life. v1 = demo provider (codes shown on screen).
// A real provider (DigiLocker / Digio) needs a backend; set VITE_OTP_PROVIDER + VITE_OTP_API_URL then.
import { createOtpProvider } from '@wealthfire/core';

export const otpProvider = createOtpProvider({
  provider: import.meta.env.VITE_OTP_PROVIDER,
  apiUrl: import.meta.env.VITE_OTP_API_URL,
});
