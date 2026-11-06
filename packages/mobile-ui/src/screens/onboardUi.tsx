// Small building blocks shared by the onboarding screens (Onboarding.tsx, Documents.tsx).
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { theme } from '../theme';
import { s } from '../ui';

export function Input({ label, error, warn, ...rest }: TextInputProps & { label: string; error?: string | null; warn?: string | null }) {
  return (
    <View style={s.field}>
      <Text style={s.muted}>{label}</Text>
      <TextInput accessibilityLabel={label} accessibilityHint={error ?? warn ?? undefined} style={[s.input, error ? { borderColor: theme.bad } : null]}
        placeholderTextColor={theme.muted} {...rest} />
      {error ? <Text style={[ob.msg, { color: theme.bad }]} accessibilityLiveRegion="polite">{error}</Text> : null}
      {!error && warn ? <Text style={[ob.msg, { color: theme.warn }]} accessibilityLiveRegion="polite">{warn}</Text> : null}
    </View>
  );
}

export function Link({ title, label, onPress }: { title: string; label?: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label ?? title} onPress={onPress} hitSlop={10} style={ob.link}>
      <Text style={ob.linkText}>{title}</Text>
    </Pressable>
  );
}

/** Error / status line read out by screen readers. */
export function Msg({ text, tone = 'bad' }: { text: string; tone?: 'bad' | 'warn' | 'good' | 'muted' }) {
  return <Text style={[ob.msg, { color: theme[tone] }]} accessibilityLiveRegion="polite">{text}</Text>;
}

export const ob = StyleSheet.create({
  msg: { fontSize: 13, marginTop: 4 },
  link: { paddingVertical: 10, minHeight: 44, justifyContent: 'center' },
  linkText: { color: theme.accent, fontWeight: '700', fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  demo: { backgroundColor: theme.panel2, borderColor: theme.warn, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 12 },
});
