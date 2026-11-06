// Small app-shell hooks shared by the onboarding screens and the platform shells (apps/android, apps/ios).
import { createContext, useContext, useEffect, type MutableRefObject } from 'react';

/**
 * Android hardware Back during onboarding (minor issue 5). The onboarding screen puts its handler here while it is
 * shown, and clears it when it goes away. The handler returns true when it stepped back one onboarding step, false to
 * let Android do its default (close the app, e.g. on Sign in). null: onboarding is not shown, tab history applies.
 */
export type OnboardingBackRef = MutableRefObject<(() => boolean) | null>;
export const OnboardingBackCtx = createContext<OnboardingBackRef | null>(null);
export const useOnboardingBackRef = () => useContext(OnboardingBackCtx);

/**
 * One-time notice for the Sign in screen (minor issue 3): "All data deleted." after Delete all data, since the gate
 * switches to Sign in at once. Memory only; Sign in takes it (shows it once and clears it).
 */
export interface SignInNotice {
  set: (text: string) => void;
  /** Returns the pending notice and clears it. */
  take: () => string | null;
}
export const SignInNoticeCtx = createContext<SignInNotice>({ set: () => {}, take: () => null });
export const useSignInNotice = () => useContext(SignInNoticeCtx);

/**
 * Count of onboarding actions running now (a read, re-read, OTP send or verify). While above 0, Android hardware Back
 * does nothing, so a running action can't be cut off. Shared by WealthfireApp; useBlockBackWhile updates it.
 */
export const OnboardingBusyCtx = createContext<MutableRefObject<number>>({ current: 0 });
export function useBlockBackWhile(busy: boolean): void {
  const count = useContext(OnboardingBusyCtx);
  useEffect(() => {
    if (!busy) return;
    count.current += 1;
    return () => { count.current = Math.max(0, count.current - 1); };
  }, [busy, count]);
}
