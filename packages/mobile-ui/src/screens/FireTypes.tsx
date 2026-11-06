// FIRE types on Android / iOS. Same content as apps/web/src/components/FireTypes.tsx.
import { Text, View } from 'react-native';
import { FIRE_TYPES, inr, inrShort, type FireTypeId } from '@wealthfire/core';
import { useStore } from '../store';
import { useNav } from '../nav';
import { Bar, Btn, Card, Chips, Line, s } from '../ui';

/** Chips to switch FIRE type. Pass value/onChange to bind to local form state (Profile). */
export function FireTypePicker({ value, onChange }: { value?: FireTypeId; onChange?: (id: FireTypeId) => void }) {
  const { data, update } = useStore();
  const current = value ?? data.profile?.fireType ?? 'regular';
  const pick = onChange ?? ((id: FireTypeId) => update((d) => (d.profile ? { ...d, profile: { ...d.profile, fireType: id } } : d)));
  return (
    <View testID="feature-firetype-pick" style={{ marginBottom: 8 }}>
      <Chips label="Which FIRE are you aiming for?" value={current} onChange={pick}
        options={FIRE_TYPES.map((t) => ({ label: `${t.emoji} ${t.name}`, value: t.id }))} />
      <Text style={[s.small, { marginTop: 6 }]}>{FIRE_TYPES.find((t) => t.id === current)?.tagline}</Text>
    </View>
  );
}

export function FireTypesCompare({ compact }: { compact?: boolean }) {
  const { data, analysis: a } = useStore();
  const go = useNav();
  if (!a.fireTypes.length || !data.profile) return null;
  const c = a.coast;
  return (
    <View testID="feature-firetypes">
      <Card title="🔥 FIRE types compared">
        {a.fireTypes.map(({ type, corpusSpend, plan }) => (
          <Line key={type.id}
            left={`${type.emoji} ${type.name}${type.id === a.fireType?.id ? '  · Your goal' : ''}`}
            sub={`Corpus pays ${inr(corpusSpend)}/mo · FIRE age ${plan.earliestFireAgeWithCurrentSip ?? 'after 80'}${compact ? '' : ` · SIP ${inr(plan.requiredMonthlySip)}`}`}
            right={inrShort(plan.fireNumber)} />
        ))}
        <Text style={[s.small, { marginTop: 8 }]}>FIRE number is for retiring at {data.profile.targetRetireAge}, grown by inflation. Same {data.assumptions.safeWithdrawalRate}% withdrawal rate for all.</Text>
        {compact ? <Btn title="Compare FIRE types" onPress={() => go('fire')} /> : null}
      </Card>
      {c ? (
        <Card title="⛵ Coast FIRE milestone">
          <Text style={s.text}>
            {c.reached
              ? `You've hit Coast FIRE. Your investments can grow to your FIRE number by ${c.coastAge} even if you stop adding.`
              : `Have ${inrShort(c.neededToday)} invested and it grows to your FIRE number by ${c.coastAge} on its own.`}
          </Text>
          <Bar pct={c.progressPct} label="Coast FIRE progress" />
          <Text style={s.small}>
            {Math.round(c.progressPct)}% there. {!c.reached ? (c.ageReached ? `At your current SIP you reach it at age ${c.ageReached}. ` : `Your current SIP doesn't reach it before ${c.coastAge}. `) : ''}After that you only need to earn enough for today's bills.
          </Text>
        </Card>
      ) : null}
    </View>
  );
}

export function FireTypesExplainer() {
  return (
    <Card title="Which FIRE fits you?">
      {FIRE_TYPES.map((t) => (
        <View key={t.id} style={{ marginBottom: 12 }}>
          <Text style={[s.text, { fontWeight: '700' }]}>{t.emoji} {t.name}</Text>
          <Text style={s.text}>{t.about}</Text>
          <Text style={s.small}>Lifestyle: {t.lifestyle}</Text>
          <Text style={s.small}>Watch out: {t.watchOut}</Text>
        </View>
      ))}
      <View>
        <Text style={[s.text, { fontWeight: '700' }]}>⛵ Coast FIRE</Text>
        <Text style={s.text}>A milestone, not a lifestyle. Once you've saved enough, compounding carries you to FIRE by about 60, even if you stop investing.</Text>
        <Text style={s.small}>Then: you only need to earn enough to cover today's bills.</Text>
        <Text style={s.small}>Watch out: it relies on returns holding up for many years.</Text>
      </View>
    </Card>
  );
}
