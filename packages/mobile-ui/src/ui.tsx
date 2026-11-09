import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ViewStyle } from 'react-native';
import { theme } from './theme';

export function Screen({ feature, title, intro, children }: { feature: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <ScrollView testID={`feature-${feature}`} style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <Text style={s.h1} accessibilityRole="header">{title}</Text>
      {intro ? <Text style={s.intro}>{intro}</Text> : null}
      {children}
      <Text style={s.disclaimer}>
        Wealthfire gives educational estimates, not investment advice. Mutual fund investments are subject to market risks.
        Talk to a SEBI-registered adviser before you invest.
      </Text>
    </ScrollView>
  );
}

export function Card({ title, children, style }: { title?: string; children: ReactNode; style?: ViewStyle }) {
  return (
    <View style={[s.card, style]}>
      {title ? <Text style={s.h2} accessibilityRole="header">{title}</Text> : null}
      {children}
    </View>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <View style={s.stat} accessible accessibilityLabel={`${label}: ${value}${sub ? `, ${sub}` : ''}`}>
      <Text style={s.muted}>{label}</Text>
      <Text style={[s.statValue, tone ? { color: theme[tone] } : null]}>{value}</Text>
      {sub ? <Text style={s.small}>{sub}</Text> : null}
    </View>
  );
}

export function Stats({ children }: { children: ReactNode }) {
  return <View style={s.stats}>{children}</View>;
}

export function Bar({ pct, label }: { pct: number; label: string }) {
  const v = Math.max(0, Math.min(100, pct));
  return (
    <View style={s.bar} accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 100, now: Math.round(v) }}>
      <View style={[s.barFill, { width: `${v}%` }]} />
    </View>
  );
}

/** Stacked bar + legend. Mobile stand-in for the web donut. */
export function Mix({ items }: { items: { name: string; value: number }[] }) {
  const total = items.reduce((t, i) => t + i.value, 0) || 1;
  return (
    <View>
      <View style={s.mix}>
        {items.map((it, i) => <View key={it.name} style={{ flex: it.value, backgroundColor: theme.palette[i % theme.palette.length] }} />)}
      </View>
      {items.map((it, i) => (
        <View key={it.name} style={s.legendRow}>
          <View style={[s.dot, { backgroundColor: theme.palette[i % theme.palette.length] }]} />
          <Text style={s.text}>{it.name} <Text style={s.muted}>{Math.round((it.value / total) * 100)}%</Text></Text>
        </View>
      ))}
    </View>
  );
}

/** `danger`: red outline; `danger` + `solid`: red button (a confirm step's destructive action). */
export function Btn({ title, onPress, primary, danger, solid, disabled }: { title: string; onPress: () => void; primary?: boolean; danger?: boolean; solid?: boolean; disabled?: boolean }) {
  const red = danger && solid;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [s.btn, primary && s.btnPrimary, danger && s.btnDanger, red && { backgroundColor: theme.bad }, (pressed || disabled) && { opacity: 0.6 }]}>
      <Text style={[s.btnText, primary && { color: '#1a0f05' }, danger && { color: red ? '#1a0f05' : theme.bad }]}>{title}</Text>
    </Pressable>
  );
}

export function Field({ label, value, onChangeText, placeholder, multiline }: { label: string; value: string; onChangeText: (t: string) => void; placeholder?: string; multiline?: boolean }) {
  return (
    <View style={s.field}>
      <Text style={s.muted}>{label}</Text>
      <TextInput accessibilityLabel={label} style={[s.input, multiline && { minHeight: 110, textAlignVertical: 'top' }]} value={value} onChangeText={onChangeText}
        placeholder={placeholder} placeholderTextColor={theme.muted} multiline={multiline} />
    </View>
  );
}

export function NumField({ label, value, onChange, suffix }: { label: string; value: number; onChange: (n: number) => void; suffix?: string }) {
  // Keep the typed text locally so "", "-" or "7." can be typed without snapping back.
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <View style={s.field}>
      <Text style={s.muted}>{label}{suffix ? ` (${suffix})` : ''}</Text>
      <TextInput accessibilityLabel={label} style={s.input} keyboardType="numbers-and-punctuation" value={text}
        onChangeText={(t) => {
          setText(t);
          const n = Number(t.replace(/[^\d.-]/g, ''));
          if (Number.isFinite(n)) onChange(n);
        }} />
    </View>
  );
}

export function Chips<T extends string | number>({ options, value, onChange, label }: { options: { label: string; value: T }[]; value: T | undefined; onChange: (v: T) => void; label: string }) {
  return (
    <View style={s.chips} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={String(o.value)} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => onChange(o.value)} style={[s.chip, on && s.chipOn]}>
            <Text style={s.text}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Line({ left, right, sub, onRemove }: { left: string; right: string; sub?: string; onRemove?: () => void }) {
  return (
    <View style={s.line}>
      <View style={{ flex: 1 }}>
        <Text style={s.text}>{left}</Text>
        {sub ? <Text style={s.small}>{sub}</Text> : null}
      </View>
      <Text style={[s.text, { fontVariant: ['tabular-nums'] }]}>{right}</Text>
      {onRemove ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${left}`} onPress={onRemove} hitSlop={10} style={{ paddingLeft: 12 }}>
          <Text style={s.muted}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Tips({ items }: { items: string[] }) {
  return <View>{items.map((t) => <Text key={t} style={[s.text, { marginBottom: 6 }]}>• {t}</Text>)}</View>;
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 16, paddingBottom: 40 },
  h1: { color: theme.text, fontSize: 26, fontWeight: '800', marginBottom: 4 },
  h2: { color: theme.text, fontSize: 17, fontWeight: '700', marginBottom: 10 },
  intro: { color: theme.muted, marginBottom: 16 },
  text: { color: theme.text, fontSize: 15 },
  muted: { color: theme.muted, fontSize: 14 },
  small: { color: theme.muted, fontSize: 12 },
  big: { color: theme.text, fontSize: 30, fontWeight: '800', marginBottom: 6 },
  card: { backgroundColor: theme.panel, borderColor: theme.line, borderWidth: 1, borderRadius: 14, padding: 16, marginBottom: 14 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 14 },
  stat: { flexGrow: 1, flexBasis: '45%', backgroundColor: theme.panel, borderColor: theme.line, borderWidth: 1, borderRadius: 14, padding: 12 },
  statValue: { color: theme.text, fontSize: 20, fontWeight: '700' },
  bar: { height: 10, backgroundColor: theme.panel2, borderRadius: 99, overflow: 'hidden', marginVertical: 6 },
  barFill: { height: '100%', backgroundColor: theme.accent, borderRadius: 99 },
  mix: { flexDirection: 'row', height: 16, borderRadius: 8, overflow: 'hidden', marginBottom: 10 },
  legendRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  btn: { backgroundColor: theme.panel2, borderColor: theme.line, borderWidth: 1, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 16, alignItems: 'center', marginTop: 8, minHeight: 44 },
  btnPrimary: { backgroundColor: theme.accent, borderColor: theme.accent },
  btnDanger: { borderColor: theme.bad },
  btnText: { color: theme.text, fontWeight: '700', fontSize: 15 },
  field: { marginBottom: 10 },
  input: { backgroundColor: theme.bg, color: theme.text, borderColor: theme.line, borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 9, fontSize: 15, marginTop: 4, minHeight: 44 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderColor: theme.line, borderWidth: 1, borderRadius: 99, paddingVertical: 8, paddingHorizontal: 14, minHeight: 40, justifyContent: 'center' },
  chipOn: { borderColor: theme.accent, backgroundColor: 'rgba(255,122,24,0.18)' },
  line: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomColor: theme.line, borderBottomWidth: 1 },
  disclaimer: { color: theme.muted, fontSize: 11, marginTop: 24 },
});
