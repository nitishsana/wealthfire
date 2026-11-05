// Home, Profile, Risk, Net worth. Same features and wording as apps/web/src/pages.
import { useState } from 'react';
import { Alert, Switch, Text, View } from 'react-native';
import {
  ASSET_TYPE_LABELS, computeRiskScore, DEFAULT_BARISTA_SHARE, inr, inrShort, isRiskComplete, newId, PHASE_LABELS, RISK_QUESTIONS,
  type AssetType, type LiabilityType, type Profile,
} from '@wealthfire/core';
import { useStore } from '../store';
import { useNav, type TabKey } from '../nav';
import { FireTypePicker, FireTypesCompare } from './FireTypes';
import { Bar, Btn, Card, Chips, Field, Line, Mix, NumField, s, Screen, Stat, Stats, Tips } from '../ui';

const STATUS_TEXT = { on_track: 'On track', close: 'Almost there', off_track: 'Off track' } as const;
const STATUS_TONE = { on_track: 'good', close: 'warn', off_track: 'bad' } as const;

export function Missing({ missing }: { missing: string[] }) {
  const go = useNav();
  if (!missing.length) return null;
  const map: Record<string, [string, TabKey]> = {
    profile: ['Add your profile', 'profile'], risk: ['Take the risk quiz', 'risk'], expenses: ['Add expenses', 'expenses'],
  };
  return (
    <Card title="A few steps left">
      {missing.map((m) => <Btn key={m} title={map[m]?.[0] ?? m} onPress={() => go(map[m]?.[1] ?? 'home')} />)}
      <Btn title="Or load demo data" onPress={() => go('settings')} />
    </Card>
  );
}

export function HomeScreen() {
  const { data, analysis: a } = useStore();
  const go = useNav();
  const f = a.fire;
  const first = data.profile?.name?.split(' ')[0];
  return (
    <Screen feature="dashboard" title={first ? `Hi ${first} 👋` : 'Welcome to Wealthfire'} intro="Your FIRE plan at a glance.">
      <Missing missing={a.missing} />
      <Stats>
        <Stat label="Net worth" value={inrShort(a.netWorth.netWorth)} sub={`Investable ${inrShort(a.netWorth.investable)}`} />
        <Stat label="Monthly spend" value={inr(f?.monthlyExpenseToday ?? a.expenses.monthlyLiving)} />
        <Stat label="Risk profile" value={a.risk?.profile ?? '—'} sub={a.risk ? `Score ${a.risk.score}/100` : undefined} />
        {f ? <Stat label={`${a.fireType?.name ?? 'FIRE'} status`} value={STATUS_TEXT[f.status]} tone={STATUS_TONE[f.status]} /> : null}
      </Stats>
      {f && data.profile ? (
        <>
          <Card title={`${a.fireType?.emoji ?? '🔥'} ${a.fireType?.name ?? 'FIRE'} progress`}>
            <FireTypePicker />
            <Text style={s.big}>{Math.round(f.progressPct)}%</Text>
            <Bar pct={f.progressPct} label="FIRE progress" />
            <Text style={s.muted}>{inrShort(a.netWorth.investable)} of {inrShort(f.fireNumberToday)} (today's rupees)</Text>
            <Tips items={f.messages.slice(0, 3)} />
            <Btn title="See FIRE plan" onPress={() => go('fire')} />
          </Card>
          <Card title="💸 Monthly SIP">
            <Stats>
              <Stat label="Now" value={inr(data.profile.currentMonthlySip)} />
              <Stat label="Needed" value={inr(f.requiredMonthlySip)} tone={f.extraSipNeeded > 0 ? 'warn' : 'good'} />
            </Stats>
            <Btn title="Where to invest" onPress={() => go('portfolio')} />
          </Card>
          {a.buckets ? (
            <Card title="🪣 Buckets">
              <Text style={s.text}>{PHASE_LABELS[a.buckets.phase]}</Text>
              <Tips items={[...a.buckets.moves.map((m) => m.reason), ...a.buckets.notes].slice(0, 3)} />
              <Btn title="Open buckets" onPress={() => go('buckets')} />
            </Card>
          ) : null}
          <Card title="📈 Progress">
            <Tips items={a.progress.messages} />
            <Btn title="Save a check-in" onPress={() => go('progress')} />
          </Card>
          <FireTypesCompare compact />
        </>
      ) : null}
    </Screen>
  );
}

const BLANK: Profile = { name: '', age: 30, city: '', monthlyIncome: 0, dependents: 0, targetRetireAge: 45, lifeExpectancy: 85, currentMonthlySip: 0, fireType: 'regular' };

export function ProfileScreen() {
  const { data, analysis, update } = useStore();
  const go = useNav();
  const [p, setP] = useState<Profile>(data.profile ?? BLANK);
  const [useOverride, setUseOverride] = useState(p.monthlyExpenseOverride !== undefined);
  const [error, setError] = useState('');
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setP((x) => ({ ...x, [k]: v }));

  function save() {
    if (!p.name.trim()) return setError('Please enter your name.');
    if (p.age < 18 || p.age > 80) return setError('Age must be 18 to 80.');
    if (p.targetRetireAge < p.age) return setError('Retire age must be your age or more.');
    if (p.monthlyIncome < 0 || p.currentMonthlySip < 0) return setError('Amounts cannot be negative.');
    setError('');
    const clean: Profile = { ...p, name: p.name.trim(), city: p.city.trim() };
    if (!useOverride) delete clean.monthlyExpenseOverride;
    update((d) => ({ ...d, profile: clean }));
    go(Object.keys(data.riskAnswers).length ? 'home' : 'risk');
  }

  return (
    <Screen feature="onboarding" title="Your profile" intro="Tell us about you. This sets your FIRE plan.">
      <Card>
        <Field label="Name" value={p.name} onChangeText={(t) => set('name', t)} />
        <NumField label="Age" value={p.age} onChange={(v) => set('age', v)} />
        <Field label="City" value={p.city} onChangeText={(t) => set('city', t)} />
        <NumField label="People who depend on you" value={p.dependents} onChange={(v) => set('dependents', v)} />
        <NumField label="Monthly take-home pay" suffix="₹" value={p.monthlyIncome} onChange={(v) => set('monthlyIncome', v)} />
        <NumField label="Current monthly SIP" suffix="₹" value={p.currentMonthlySip} onChange={(v) => set('currentMonthlySip', v)} />
        <NumField label="Age you want to retire" value={p.targetRetireAge} onChange={(v) => set('targetRetireAge', v)} />
        <NumField label="Plan money till age" value={p.lifeExpectancy} onChange={(v) => set('lifeExpectancy', v)} />
        <Text style={[s.muted, { marginTop: 6 }]}>Which FIRE are you aiming for?</Text>
        <FireTypePicker value={p.fireType ?? 'regular'} onChange={(id) => set('fireType', id)} />
        {p.fireType === 'barista' ? (
          <NumField label="Part-time income after FIRE (per month)" suffix="₹"
            value={p.partTimeIncome ?? Math.round((p.monthlyExpenseOverride ?? analysis.expenses.monthlyLiving) * DEFAULT_BARISTA_SHARE)}
            onChange={(v) => set('partTimeIncome', v)} />
        ) : null}
        <Text style={s.small}>Not sure? See "Which FIRE fits you" on the FIRE tab.</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 8 }}>
          <Switch accessibilityLabel="Type my monthly spend instead of using my expenses" value={useOverride} onValueChange={(on) => {
            setUseOverride(on);
            if (on && p.monthlyExpenseOverride === undefined) set('monthlyExpenseOverride', 50000);
          }} />
          <Text style={[s.text, { flex: 1 }]}>Type my monthly spend instead of using my expenses</Text>
        </View>
        {useOverride ? <NumField label="Monthly spend (no EMIs)" suffix="₹" value={p.monthlyExpenseOverride ?? 0} onChange={(v) => set('monthlyExpenseOverride', v)} /> : null}
        {error ? <Text style={{ color: '#ff6b6b' }} accessibilityRole="alert">{error}</Text> : null}
        <Btn primary title="Save profile" onPress={save} />
      </Card>
    </Screen>
  );
}

export function RiskScreen() {
  const { data, update } = useStore();
  const go = useNav();
  const answers = data.riskAnswers;
  const result = computeRiskScore(answers, data.profile?.age ?? 30);
  return (
    <Screen feature="risk" title="Risk score" intro="Six quick questions. Your answers and age set how much equity suits you.">
      {RISK_QUESTIONS.map((q, qi) => (
        <Card key={q.id} title={`${qi + 1}. ${q.text}`}>
          <Chips label={q.text} value={answers[q.id]} options={q.options.map((o, oi) => ({ label: o.label, value: oi }))}
            onChange={(oi) => update((d) => ({ ...d, riskAnswers: { ...d.riskAnswers, [q.id]: oi } }))} />
        </Card>
      ))}
      <Card title="Your result">
        {isRiskComplete(answers) ? (
          <>
            <Text style={s.big}>{result.profile} <Text style={s.muted}>· {result.score}/100</Text></Text>
            <Bar pct={result.score} label="Risk score" />
            <Btn primary title="See my portfolio" onPress={() => go('portfolio')} />
          </>
        ) : <Text style={s.muted}>Answer all {RISK_QUESTIONS.length} questions to see your score.</Text>}
      </Card>
    </Screen>
  );
}

const LIABILITY_LABELS: Record<LiabilityType, string> = {
  home_loan: 'Home loan', car_loan: 'Car loan', personal_loan: 'Personal loan', credit_card: 'Credit card dues', education_loan: 'Education loan', other: 'Other',
};

export function NetWorthScreen() {
  const { data, analysis, update } = useStore();
  const nw = analysis.netWorth;
  const [aName, setAName] = useState('');
  const [aType, setAType] = useState<AssetType>('equity_mf');
  const [aValue, setAValue] = useState(0);
  const [lName, setLName] = useState('');
  const [lType, setLType] = useState<LiabilityType>('home_loan');
  const [lOut, setLOut] = useState(0);
  const [lEmi, setLEmi] = useState(0);
  const [lRate, setLRate] = useState(9);

  const classItems = [
    { name: 'Equity', value: nw.byClass.equity }, { name: 'Debt', value: nw.byClass.debt }, { name: 'Gold', value: nw.byClass.gold },
    { name: 'Cash', value: nw.byClass.cash }, { name: 'Property / other', value: nw.byClass.illiquid },
  ].filter((i) => i.value > 0);

  return (
    <Screen feature="networth" title="Assets & liabilities" intro="What you own and what you owe, in one place.">
      <Stats>
        <Stat label="Net worth" value={inrShort(nw.netWorth)} tone={nw.netWorth >= 0 ? 'good' : 'bad'} />
        <Stat label="Assets" value={inrShort(nw.totalAssets)} />
        <Stat label="Liabilities" value={inrShort(nw.totalLiabilities)} />
        <Stat label="EMIs / month" value={inr(nw.monthlyEmi)} />
      </Stats>
      <Card title="Assets">
        {classItems.length ? <Mix items={classItems} /> : null}
        {data.assets.map((a) => (
          <Line key={a.id} left={a.name} sub={ASSET_TYPE_LABELS[a.type]} right={inr(a.value)}
            onRemove={() => update((d) => ({ ...d, assets: d.assets.filter((x) => x.id !== a.id) }))} />
        ))}
        <Field label="Name" value={aName} onChangeText={setAName} placeholder="e.g. Nifty 50 fund" />
        <Text style={s.muted}>Type</Text>
        <Chips label="Asset type" value={aType} onChange={setAType} options={Object.entries(ASSET_TYPE_LABELS).map(([k, v]) => ({ label: v, value: k as AssetType }))} />
        <NumField label="Value" suffix="₹" value={aValue} onChange={setAValue} />
        <Btn primary title="Add asset" onPress={() => {
          if (aValue <= 0) return;
          update((d) => ({ ...d, assets: [...d.assets, { id: newId('a'), name: aName.trim() || ASSET_TYPE_LABELS[aType], type: aType, value: aValue, source: 'manual' }] }));
          setAName(''); setAValue(0);
        }} />
      </Card>
      <Card title="Liabilities">
        {data.liabilities.map((l) => (
          <Line key={l.id} left={l.name} sub={`${l.interestRate}% · EMI ${inr(l.monthlyEmi)}`} right={inr(l.outstanding)}
            onRemove={() => update((d) => ({ ...d, liabilities: d.liabilities.filter((x) => x.id !== l.id) }))} />
        ))}
        <Field label="Name" value={lName} onChangeText={setLName} placeholder="e.g. HDFC home loan" />
        <Text style={s.muted}>Type</Text>
        <Chips label="Liability type" value={lType} onChange={setLType} options={Object.entries(LIABILITY_LABELS).map(([k, v]) => ({ label: v, value: k as LiabilityType }))} />
        <NumField label="Amount owed" suffix="₹" value={lOut} onChange={setLOut} />
        <NumField label="Monthly EMI" suffix="₹" value={lEmi} onChange={setLEmi} />
        <NumField label="Interest" suffix="%" value={lRate} onChange={setLRate} />
        <Btn primary title="Add liability" onPress={() => {
          if (lOut <= 0) return Alert.alert('Enter the amount owed.');
          update((d) => ({ ...d, liabilities: [...d.liabilities, { id: newId('l'), name: lName.trim() || LIABILITY_LABELS[lType], type: lType, outstanding: lOut, monthlyEmi: lEmi, interestRate: lRate }] }));
          setLName(''); setLOut(0); setLEmi(0);
        }} />
      </Card>
      <Text style={s.muted}>Property and "other" count in net worth, but not in your FIRE corpus.</Text>
    </Screen>
  );
}
