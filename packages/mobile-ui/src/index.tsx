import { useEffect, useRef, useState, type ComponentType } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { DataProvider, useStore } from './store';
import { NavCtx, TABS, type TabKey } from './nav';
import { theme } from './theme';
import { HomeScreen, NetWorthScreen, ProfileScreen, RiskScreen } from './screens/Core';
import { BucketsScreen, ConnectScreen, ExpensesScreen, FireScreen, PortfolioScreen, ProgressScreen, SettingsScreen } from './screens/Plan';
import { GoogleCtx, type GoogleConfig } from './screens/Gmail';
import { OnboardingScreen } from './screens/Onboarding';
import { OtpProviderScope, type OtpConfig } from './otp';
import { DocReaderScope, type DocReaderConfig } from './reader';
import { OnboardingBackCtx, SignInNoticeCtx, type OnboardingBackRef, type SignInNotice } from './shell';

export type { GoogleConfig } from './screens/Gmail';
export type { OnboardingBackRef } from './shell';
export type { OtpConfig } from './otp';
export type { DocReaderConfig } from './reader';

export { TABS, type TabKey } from './nav';
export { clearPickerCache } from './cacheCleanup';
export { theme } from './theme';

const SCREENS: Record<TabKey, ComponentType> = {
  home: HomeScreen, profile: ProfileScreen, risk: RiskScreen, networth: NetWorthScreen, expenses: ExpensesScreen,
  fire: FireScreen, portfolio: PortfolioScreen, buckets: BucketsScreen, progress: ProgressScreen, connect: ConnectScreen, settings: SettingsScreen,
};

export interface WealthfireAppProps {
  /** 'android' puts the tab bar at the bottom (Material style); 'ios' too, with iOS spacing. */
  platform: 'android' | 'ios';
  /** Optional hook so the shell can react to tab changes (e.g. Android back button). */
  onTabChange?: (tab: TabKey) => void;
  initialTab?: TabKey;
  tab?: TabKey;
  setTab?: (t: TabKey) => void;
  /** Google OAuth client ids for Gmail sign-in (from the app's app.json extra). */
  google?: GoogleConfig;
  /** OTP provider for onboarding (from app.json extra.otpProvider / otpApiUrl). Empty → demo provider. */
  otp?: OtpConfig;
  /** Document reader for onboarding KYC (from app.json extra.docReader / docReaderUrl). Empty → on-device reader (ML Kit); 'demo' only in dev builds. */
  docReader?: DocReaderConfig;
  /**
   * Android: set while onboarding is shown to a handler that steps back one onboarding step (true) or lets
   * Android close the app (false). null outside onboarding, so the shell's tab history applies.
   */
  onboardingBack?: OnboardingBackRef;
}

function Body({ platform, tab, setTab }: { platform: 'android' | 'ios'; tab: TabKey; setTab: (t: TabKey) => void }) {
  const { loaded, data } = useStore();
  const ScreenComp = SCREENS[tab];
  const needsOnboarding = data.onboarding.step !== 'done';
  // Stays true after the last step so the "You're all set" screen shows until "Go to Home".
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  useEffect(() => { if (loaded && needsOnboarding) setOnboardingOpen(true); }, [loaded, needsOnboarding]);
  // Before data loads: header + spinner only, so the tab bar never flashes ahead of onboarding.
  if (!loaded || needsOnboarding || onboardingOpen) {
    return (
      <NavCtx.Provider value={setTab}>
        <SafeAreaView style={st.root} edges={['top', 'left', 'right', 'bottom']}>
          <View style={st.header}>
            <Text style={st.brand}>🔥 Wealthfire</Text>
            <Text style={st.lock}>🔒 Data stays on this phone</Text>
          </View>
          <View style={{ flex: 1 }}>
            {loaded
              ? <OnboardingScreen onFinish={() => { setOnboardingOpen(false); setTab('home'); }} />
              : <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} />}
          </View>
        </SafeAreaView>
      </NavCtx.Provider>
    );
  }
  return (
    <NavCtx.Provider value={setTab}>
      <SafeAreaView style={st.root} edges={['top', 'left', 'right', 'bottom']}>
        <View style={st.header}>
          <Text style={st.brand}>🔥 Wealthfire</Text>
          <Text style={st.lock}>🔒 Data stays on this phone</Text>
        </View>
        <View style={{ flex: 1 }}><ScreenComp key={tab} /></View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[st.tabs, platform === 'ios' && st.tabsIos]} contentContainerStyle={{ paddingHorizontal: 6 }}
          accessibilityRole="tablist">
          {TABS.map((t) => {
            const on = t.key === tab;
            return (
              <Pressable key={t.key} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={t.label}
                onPress={() => setTab(t.key)} style={[st.tab, on && st.tabOn]}>
                <Text style={st.tabIcon}>{t.icon}</Text>
                <Text style={[st.tabLabel, on && { color: theme.accent }]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </SafeAreaView>
    </NavCtx.Provider>
  );
}

/** The full Wealthfire app. apps/android and apps/ios each render this with their platform. */
export function WealthfireApp({ platform, onTabChange, initialTab = 'home', tab: ctlTab, setTab: ctlSetTab, google = {}, otp = {}, docReader = {}, onboardingBack }: WealthfireAppProps) {
  const [ownTab, setOwnTab] = useState<TabKey>(initialTab);
  const tab = ctlTab ?? ownTab;
  const setTab = (t: TabKey) => { (ctlSetTab ?? setOwnTab)(t); onTabChange?.(t); };
  // Minor issue 3: memory-only notice for the next Sign in screen (e.g. "All data deleted.").
  const notice = useRef<string | null>(null);
  const [signInNotice] = useState<SignInNotice>(() => ({
    set: (text) => { notice.current = text; },
    take: () => { const t = notice.current; notice.current = null; return t; },
  }));
  return (
    <SafeAreaProvider>
      <GoogleCtx.Provider value={google}>
        <OtpProviderScope config={otp}>
          <DocReaderScope config={docReader}>
            <DataProvider>
              <OnboardingBackCtx.Provider value={onboardingBack ?? null}>
                <SignInNoticeCtx.Provider value={signInNotice}>
                  <Body platform={platform} tab={tab} setTab={setTab} />
                </SignInNoticeCtx.Provider>
              </OnboardingBackCtx.Provider>
            </DataProvider>
          </DocReaderScope>
        </OtpProviderScope>
      </GoogleCtx.Provider>
    </SafeAreaProvider>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomColor: theme.line, borderBottomWidth: 1 },
  brand: { color: theme.accent, fontSize: 20, fontWeight: '800' },
  lock: { color: theme.muted, fontSize: 11 },
  tabs: { flexGrow: 0, backgroundColor: theme.panel, borderTopColor: theme.line, borderTopWidth: 1 },
  tabsIos: { paddingBottom: 2 },
  tab: { alignItems: 'center', paddingVertical: 8, paddingHorizontal: 10, minWidth: 64, minHeight: 48 },
  tabOn: { borderTopColor: theme.accent, borderTopWidth: 2 },
  tabIcon: { fontSize: 18 },
  tabLabel: { color: theme.muted, fontSize: 11, marginTop: 2 },
});
