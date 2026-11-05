import { useState, type ComponentType } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { DataProvider, useStore } from './store';
import { NavCtx, TABS, type TabKey } from './nav';
import { theme } from './theme';
import { HomeScreen, NetWorthScreen, ProfileScreen, RiskScreen } from './screens/Core';
import { BucketsScreen, ConnectScreen, ExpensesScreen, FireScreen, PortfolioScreen, ProgressScreen, SettingsScreen } from './screens/Plan';

export { TABS, type TabKey } from './nav';
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
}

function Body({ platform, tab, setTab }: { platform: 'android' | 'ios'; tab: TabKey; setTab: (t: TabKey) => void }) {
  const { loaded } = useStore();
  const ScreenComp = SCREENS[tab];
  return (
    <NavCtx.Provider value={setTab}>
      <SafeAreaView style={st.root} edges={['top', 'left', 'right', 'bottom']}>
        <View style={st.header}>
          <Text style={st.brand}>🔥 Wealthfire</Text>
          <Text style={st.lock}>🔒 Data stays on this phone</Text>
        </View>
        <View style={{ flex: 1 }}>{loaded ? <ScreenComp key={tab} /> : <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} />}</View>
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
export function WealthfireApp({ platform, onTabChange, initialTab = 'home', tab: ctlTab, setTab: ctlSetTab }: WealthfireAppProps) {
  const [ownTab, setOwnTab] = useState<TabKey>(initialTab);
  const tab = ctlTab ?? ownTab;
  const setTab = (t: TabKey) => { (ctlSetTab ?? setOwnTab)(t); onTabChange?.(t); };
  return (
    <SafeAreaProvider>
      <DataProvider>
        <Body platform={platform} tab={tab} setTab={setTab} />
      </DataProvider>
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
