// Expenses, FIRE, Portfolio, Buckets, Progress, Connect, Settings.
// Same features and wording as apps/web/src/pages.
import { useState } from 'react';
import { Alert, Switch, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import {
  BUCKET_NAMES, categorize, DEFAULT_ASSUMPTIONS, demoData, emptyData, EXPENSE_CATEGORIES, inr, inrShort, makeSnapshot,
  newId, parseStatement, PHASE_LABELS, todayIso, upsertSnapshot, type Assumptions, type BucketState, type ExpenseCategory,
} from '@wealthfire/core';
import { useStore } from '../store';
import { Missing } from './Core';
import { useNav } from '../nav';
import { Bar, Btn, Card, Chips, Field, Line, Mix, NumField, s, Screen, Stat, Stats, Tips } from '../ui';

const SAMPLE = `05/10/2026, SWIGGY BANGALORE, 450.00
06 Oct 2026  AMAZON PAY INDIA  1,299.00 Dr
07/10/2026 PAYMENT RECEIVED - THANK YOU 25,000.00 Cr
08/10/2026, UBER INDIA, 320`;

export function ExpensesScreen() {
  const { data, analysis, update } = useStore();
  const sm = analysis.expenses;
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(todayIso());
  const [cat, setCat] = useState<ExpenseCategory | 'auto'>('auto');

  function importText(t: string) {
    const r = parseStatement(t, 'statement');
    if (!r.expenses.length) return setMsg(`No spends found. Skipped ${r.skipped} lines.`);
    update((d) => ({ ...d, expenses: [...d.expenses, ...r.expenses] }));
    setMsg(`Added ${r.expenses.length} spends. Skipped ${r.skipped} lines (headers, payments, refunds).`);
    setText('');
  }

  async function pickFile() {
    const res = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/plain', 'text/comma-separated-values'], copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    if ((asset.size ?? 0) > 2_000_000) return setMsg('File is too big. Max 2 MB.');
    try {
      importText(await new File(asset.uri).text());
    } catch {
      setMsg('Could not read that file.');
    }
  }

  const recent = [...data.expenses].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40);

  return (
    <Screen feature="expenses" title="Expenses" intro="Upload a credit card statement or add spends. We sort them for you.">
      <Stats>
        <Stat label="Monthly spend" value={inr(sm.monthlyAverage)} sub={`${sm.months} month${sm.months === 1 ? '' : 's'} of data`} />
        <Stat label="Without EMIs" value={inr(sm.monthlyLiving)} sub="Used for FIRE" />
        <Stat label="Top category" value={sm.byCategory[0]?.category ?? '—'} sub={sm.byCategory[0] ? `${inr(sm.byCategory[0].monthly)}/mo` : undefined} />
      </Stats>
      <Card title="📥 Upload statement">
        <Btn title="Pick a CSV or text file" onPress={pickFile} />
        <Field label="Or paste statement lines" value={text} onChangeText={setText} placeholder={SAMPLE} multiline />
        <Btn primary title="Import" disabled={!text.trim()} onPress={() => importText(text)} />
        <Btn title="Try a sample" onPress={() => setText(SAMPLE)} />
        {msg ? <Text style={[s.muted, { marginTop: 8 }]} accessibilityLiveRegion="polite">{msg}</Text> : null}
        <Text style={s.small}>Or let Wealthfire read card alerts from Gmail (Gmail tab).</Text>
      </Card>
      <Card title="✍️ Add a spend">
        <Field label="What" value={desc} onChangeText={setDesc} placeholder="e.g. Swiggy" />
        <NumField label="Amount" suffix="₹" value={amount} onChange={setAmount} />
        <Field label="Date (yyyy-mm-dd)" value={date} onChangeText={setDate} />
        <Text style={s.muted}>Category</Text>
        <Chips label="Category" value={cat} onChange={setCat}
          options={[{ label: 'Auto-detect', value: 'auto' as const }, ...EXPENSE_CATEGORIES.map((c) => ({ label: c, value: c }))]} />
        <Btn primary title="Add" onPress={() => {
          if (amount <= 0 || !desc.trim()) return;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Alert.alert('Use a date like 2026-11-05.');
          const category = cat === 'auto' ? categorize(desc) : cat;
          update((d) => ({ ...d, expenses: [...d.expenses, { id: newId('e'), date, description: desc.trim(), amount, category, source: 'manual' }] }));
          setDesc(''); setAmount(0);
        }} />
      </Card>
      {sm.byCategory.length ? (
        <Card title="Where your money goes (per month)">
          <Mix items={sm.byCategory.map((c) => ({ name: `${c.category} · ${inr(c.monthly)}`, value: c.monthly }))} />
        </Card>
      ) : null}
      <Card title={`Recent spends (${data.expenses.length})`}>
        {recent.map((e) => (
          <Line key={e.id} left={e.description} sub={`${e.date} · ${e.category}`} right={inr(e.amount)}
            onRemove={() => update((d) => ({ ...d, expenses: d.expenses.filter((x) => x.id !== e.id) }))} />
        ))}
      </Card>
    </Screen>
  );
}

export function FireScreen() {
  const { data, analysis: a, update } = useStore();
  const f = a.fire;
  const p = data.profile;
  const setAge = (n: number) => update((d) => ({ ...d, profile: { ...d.profile!, targetRetireAge: Math.max(d.profile!.age, Math.min(70, n)) } }));
  return (
    <Screen feature="fire" title="FIRE plan" intro="How much you need, when you can stop working, and the SIP to get there.">
      <Missing missing={a.missing} />
      {f && p ? (
        <>
          <Card title="Pick your retire age">
            <Text style={s.big}>{p.targetRetireAge} <Text style={s.muted}>in {f.yearsToFire} years</Text></Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><Btn title="− 1 year" onPress={() => setAge(p.targetRetireAge - 1)} /></View>
              <View style={{ flex: 1 }}><Btn title="+ 1 year" onPress={() => setAge(p.targetRetireAge + 1)} /></View>
            </View>
          </Card>
          <Stats>
            <Stat label="FIRE number" value={inrShort(f.fireNumber)} sub={`${inrShort(f.fireNumberToday)} in today's money`} />
            <Stat label="You'll have" value={inrShort(f.projectedCorpus)} sub="With current SIP" tone={f.status === 'on_track' ? 'good' : f.status === 'close' ? 'warn' : 'bad'} />
            <Stat label="SIP needed" value={inr(f.requiredMonthlySip)} sub={f.extraSipNeeded > 0 ? `+${inr(f.extraSipNeeded)} more` : 'You have enough'} />
            <Stat label="Earliest FIRE" value={f.earliestFireAgeWithCurrentSip ? `Age ${f.earliestFireAgeWithCurrentSip}` : 'After 80'} sub="At current SIP" />
          </Stats>
          <Card title="Corpus vs target">
            {f.projection.filter((x, i) => i % 5 === 0 || i === f.projection.length - 1).map((x) => (
              <Line key={x.age} left={`Age ${x.age}`} sub={`Target ${inrShort(x.target)}`} right={inrShort(x.corpus)} />
            ))}
          </Card>
          <Card title="What this means"><Tips items={f.messages} /></Card>
          <Card title="Numbers used">
            <Line left="Monthly spend now" right={inr(f.monthlyExpenseToday)} />
            <Line left="Monthly spend at FIRE" right={inr(f.monthlyExpenseAtFire)} />
            <Line left="Monthly surplus" right={inr(f.monthlySurplus)} />
            <Line left="Savings rate" right={`${f.savingsRatePct.toFixed(0)}%`} />
            <Line left="Inflation" right={`${data.assumptions.inflation}%`} />
            <Line left="Safe withdrawal" right={`${data.assumptions.safeWithdrawalRate}%`} />
            <Line left="Portfolio return" right={`${a.portfolio?.expectedReturn.toFixed(1)}%`} />
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

export function PortfolioScreen() {
  const { analysis: a } = useStore();
  const pf = a.portfolio;
  return (
    <Screen feature="portfolio" title="Suggested portfolio" intro="Fund types picked from your risk score and how far FIRE is.">
      <Missing missing={a.missing.filter((m) => m !== 'expenses')} />
      {pf ? (
        <>
          <Stats>
            <Stat label="Risk profile" value={pf.profile} />
            <Stat label="Equity" value={`${pf.equityPct}%`} />
            <Stat label="Expected return" value={`${pf.expectedReturn.toFixed(1)}%/yr`} sub="Long-run estimate" />
            <Stat label="Monthly SIP" value={inr(pf.lines.reduce((t, l) => t + l.monthlyAmount, 0))} />
          </Stats>
          <Text style={[s.muted, { marginBottom: 12 }]}>{pf.glideNote}</Text>
          <Card title="Mix"><Mix items={pf.lines.map((l) => ({ name: l.category.name, value: l.weight }))} /></Card>
          <Card title="Split your SIP like this">
            {pf.lines.map((l) => <Line key={l.category.id} left={`${l.category.name} · ${l.weight}%`} sub={l.category.note} right={inr(l.monthlyAmount)} />)}
            <Text style={[s.small, { marginTop: 8 }]}>Pick low-cost direct plans in each type. We don't push any fund house.</Text>
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const KEYS: (keyof BucketState)[] = ['bucket1', 'bucket2', 'bucket3'];
const HOLDS: Record<keyof BucketState, string> = {
  bucket1: 'Cash, liquid funds · next 2 yrs', bucket2: 'Debt funds, FDs, gold · yrs 3-7', bucket3: 'Equity funds · yr 8 onward',
};
const PHASES = ['accumulate', 'build_bucket2', 'build_bucket1', 'drawdown'] as const;

export function BucketsScreen() {
  const { data, analysis: a, update } = useStore();
  const b = a.buckets;
  const fromHoldings = data.buckets === null;
  return (
    <Screen feature="buckets" title="Bucket plan" intro="Three pots with three jobs. Tips change as FIRE gets closer and as markets move.">
      <Missing missing={a.missing} />
      {b ? (
        <>
          <Card title="Where you are">
            {PHASES.map((ph, i) => (
              <Text key={ph} style={[s.text, { paddingVertical: 4 }, ph === b.phase ? { color: '#ff7a18', fontWeight: '800' } : { color: '#a3acb9' }]}>
                {i + 1}. {PHASE_LABELS[ph]}{ph === b.phase ? '  ← you' : ''}
              </Text>
            ))}
          </Card>
          {KEYS.map((k) => (
            <Card key={k} title={BUCKET_NAMES[k]}>
              <Text style={s.small}>{HOLDS[k]}</Text>
              <Text style={s.big}>{inrShort(b.current[k])}</Text>
              <Bar pct={b.fillPct[k]} label={`${BUCKET_NAMES[k]} filled`} />
              <Text style={s.small}>Target {inrShort(b.targets[k])} · {b.fillPct[k]}% full</Text>
            </Card>
          ))}
          <Card title="✅ Do this now">
            {b.moves.length === 0 ? <Text style={s.text}>No moves needed. Keep your SIPs running.</Text> : null}
            {b.moves.map((m, i) => (
              <Line key={i} left={`${m.from === 'sip' ? 'SIP' : BUCKET_NAMES[m.from].split(' · ')[0]} → ${BUCKET_NAMES[m.to].split(' · ')[0]}`} sub={m.reason}
                right={m.from === 'sip' ? `${inr(m.amount)}/mo` : inr(m.amount)} />
            ))}
            <Tips items={b.notes} />
          </Card>
          <Card title="Market and balances">
            <NumField label="Stock market return, last 12 months" suffix="%" value={data.assumptions.lastYearEquityReturn}
              onChange={(v) => update((d) => ({ ...d, assumptions: { ...d.assumptions, lastYearEquityReturn: v } }))} />
            <Text style={s.small}>Below 0% means a bad year. Then we never sell equity.</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 8 }}>
              <Switch accessibilityLabel="Fill buckets from my assets" value={fromHoldings}
                onValueChange={(on) => update((d) => ({ ...d, buckets: on ? null : { ...b.current } }))} />
              <Text style={[s.text, { flex: 1 }]}>Fill buckets from my assets (cash → 1, debt + gold → 2, equity → 3)</Text>
            </View>
            {!fromHoldings && data.buckets ? KEYS.map((k) => (
              <NumField key={k} label={BUCKET_NAMES[k]} suffix="₹" value={data.buckets![k]} onChange={(v) => update((d) => ({ ...d, buckets: { ...d.buckets!, [k]: v } }))} />
            )) : null}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const VERDICT = { ahead: 'Ahead of plan', on_plan: 'On plan', behind: 'Behind plan', new: 'Just started' } as const;

export function ProgressScreen() {
  const { data, analysis: a, update } = useStore();
  const pr = a.progress;
  return (
    <Screen feature="progress" title="Progress over time" intro="Save a check-in once a month. We compare it with your plan.">
      <Btn primary title="Save this month's check-in" disabled={!a.fire} onPress={() => update((d) => ({ ...d, snapshots: upsertSnapshot(d.snapshots, makeSnapshot(d, a)) }))} />
      <View style={{ height: 12 }} />
      <Stats>
        <Stat label="Status" value={VERDICT[pr.verdict]} tone={pr.verdict === 'behind' ? 'bad' : pr.verdict === 'new' ? undefined : 'good'}
          sub={pr.vsPlanPct !== null ? `${pr.vsPlanPct >= 0 ? '+' : ''}${pr.vsPlanPct.toFixed(1)}% vs plan` : undefined} />
        <Stat label="Check-ins" value={String(pr.snapshots)} sub={pr.firstDate ? `Since ${pr.firstDate}` : undefined} />
        <Stat label="Growth" value={`${pr.growthPct.toFixed(1)}%`} />
        <Stat label="Added / month" value={inrShort(pr.monthlyAddedAvg)} sub="Incl. market moves" />
      </Stats>
      <Card title="What changed"><Tips items={pr.messages} /></Card>
      <Card title="History">
        {[...data.snapshots].reverse().map((sn) => (
          <Line key={sn.date} left={sn.date} sub={`FIRE number ${inrShort(sn.fireNumber)} · SIP ${inr(sn.monthlySip)}`} right={inrShort(sn.investable)}
            onRemove={() => update((d) => ({ ...d, snapshots: d.snapshots.filter((x) => x.date !== sn.date) }))} />
        ))}
      </Card>
    </Screen>
  );
}

const SOURCES = [
  { icon: '🏦', name: 'Bank accounts (Account Aggregator)', what: 'Pull balances and FDs with your consent.' },
  { icon: '📊', name: 'Mutual funds (CAS)', what: 'Import all your mutual funds from CAMS / KFintech.' },
  { icon: '📈', name: 'Stocks (Zerodha, Groww, etc.)', what: 'Import stock holdings.' },
  { icon: '🧓', name: 'EPF / NPS', what: 'Track retirement balances.' },
];

export function ConnectScreen() {
  const go = useNav();
  return (
    <Screen feature="connect" title="Connect apps" intro="Link your accounts for one full view. Gmail works now; the rest come next.">
      <Card title="📧 Gmail">
        <Text style={s.text}>Read card spend alert emails and add spends automatically.</Text>
        <Btn primary title="Set up Gmail" onPress={() => go('gmail')} />
      </Card>
      {SOURCES.map((src) => (
        <Card key={src.name} title={`${src.icon} ${src.name}`}>
          <Text style={s.text}>{src.what}</Text>
          <Btn title="Coming soon" disabled onPress={() => {}} />
        </Card>
      ))}
    </Screen>
  );
}

const FIELDS: { key: keyof Assumptions; label: string }[] = [
  { key: 'inflation', label: 'Inflation' }, { key: 'equityReturn', label: 'Equity return' }, { key: 'debtReturn', label: 'Debt return' },
  { key: 'cashReturn', label: 'Cash return' }, { key: 'safeWithdrawalRate', label: 'Safe withdrawal rate' }, { key: 'sipStepUp', label: 'SIP step-up each year' },
];

export function SettingsScreen() {
  const { data, update, replace } = useStore();
  const [msg, setMsg] = useState('');
  return (
    <Screen feature="demo" title="Settings" intro="Assumptions, demo data and your data.">
      <Card title="Assumptions (% per year)">
        {FIELDS.map((f) => (
          <NumField key={f.key} label={f.label} suffix="%" value={data.assumptions[f.key]} onChange={(v) => update((d) => ({ ...d, assumptions: { ...d.assumptions, [f.key]: v } }))} />
        ))}
        <Btn title="Reset to defaults" onPress={() => update((d) => ({ ...d, assumptions: { ...DEFAULT_ASSUMPTIONS } }))} />
      </Card>
      <Card title="Demo">
        <Text style={s.text}>Fill the app with a sample user to look around.</Text>
        <Btn primary title="Load demo data" onPress={() => { replace(demoData()); setMsg('Demo data loaded.'); }} />
      </Card>
      <Card title="Your data">
        <Text style={s.muted}>Stored only on this phone.</Text>
        <Btn danger title="Delete all data" onPress={() => Alert.alert('Delete all data?', 'This cannot be undone.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => { replace(emptyData()); setMsg('All data deleted.'); } },
        ])} />
      </Card>
      {msg ? <Text style={s.text} accessibilityLiveRegion="polite">{msg}</Text> : null}
    </Screen>
  );
}
