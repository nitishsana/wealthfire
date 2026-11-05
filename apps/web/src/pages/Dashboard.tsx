import { Link } from 'react-router-dom';
import { inr, inrShort, PHASE_LABELS } from '@wealthfire/core';
import { useStore } from '../store';
import { Bar, Card, Missing, Page, Stat } from '../ui';
import { FireTypePicker, FireTypesCompare } from '../components/FireTypes';

const STATUS_TEXT = { on_track: 'On track', close: 'Almost there', off_track: 'Off track' } as const;
const STATUS_TONE = { on_track: 'good', close: 'warn', off_track: 'bad' } as const;

export function Dashboard() {
  const { data, analysis: a } = useStore();
  const name = data.profile?.name?.split(' ')[0];
  const f = a.fire;

  return (
    <Page feature="dashboard" title={name ? `Hi ${name} 👋` : 'Welcome to Wealthfire'} intro="Your FIRE plan at a glance.">
      <Missing missing={a.missing} />

      <div className="grid stats">
        <Stat label="Net worth" value={inrShort(a.netWorth.netWorth)} sub={`Investable ${inrShort(a.netWorth.investable)}`} />
        <Stat label="Monthly spend" value={inr(f?.monthlyExpenseToday ?? a.expenses.monthlyLiving)} sub={a.expenses.months ? `Avg of ${a.expenses.months} months` : 'No expenses yet'} />
        <Stat label="Risk profile" value={a.risk?.profile ?? '—'} sub={a.risk ? `Score ${a.risk.score}/100` : 'Take the quiz'} />
        {f && <Stat label={`${a.fireType?.name ?? 'FIRE'} status`} value={STATUS_TEXT[f.status]} tone={STATUS_TONE[f.status]} sub={`Target age ${data.profile!.targetRetireAge}`} />}
      </div>

      {f && (
        <div className="grid two">
          <Card title={`${a.fireType?.emoji ?? '🔥'} ${a.fireType?.name ?? 'FIRE'} progress`}>
            <FireTypePicker compact />
            <p className="big">{Math.round(f.progressPct)}%</p>
            <Bar pct={f.progressPct} label="FIRE progress" />
            <p className="muted">
              {inrShort(a.netWorth.investable)} of {inrShort(f.fireNumberToday)} (today's rupees)
            </p>
            <ul className="tips">
              {f.messages.slice(0, 3).map((m) => <li key={m}>{m}</li>)}
            </ul>
            <Link className="btn" to="/fire">See FIRE plan</Link>
          </Card>
          <Card title="💸 Monthly SIP">
            <div className="grid stats tight">
              <Stat label="Now" value={inr(data.profile!.currentMonthlySip)} />
              <Stat label="Needed" value={inr(f.requiredMonthlySip)} tone={f.extraSipNeeded > 0 ? 'warn' : 'good'} />
            </div>
            <p className="muted">Steps up {data.assumptions.sipStepUp}% each year.</p>
            <Link className="btn" to="/portfolio">Where to invest</Link>
          </Card>
          {a.buckets && (
            <Card title="🪣 Buckets">
              <p><strong>{PHASE_LABELS[a.buckets.phase]}</strong></p>
              <ul className="tips">
                {[...a.buckets.moves.map((m) => m.reason), ...a.buckets.notes].slice(0, 3).map((t) => <li key={t}>{t}</li>)}
              </ul>
              <Link className="btn" to="/buckets">Open buckets</Link>
            </Card>
          )}
          <Card title="📈 Progress">
            <ul className="tips">{a.progress.messages.map((m) => <li key={m}>{m}</li>)}</ul>
            <Link className="btn" to="/progress">Save a check-in</Link>
          </Card>
        </div>
      )}
      {f && <FireTypesCompare compact />}
    </Page>
  );
}
