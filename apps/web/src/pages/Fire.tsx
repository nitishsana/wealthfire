import { DEFAULT_BARISTA_SHARE, inr, inrShort } from '@wealthfire/core';
import { useStore } from '../store';
import { Card, LineChart, Missing, NumberField, Page, Stat } from '../ui';
import { FireTypePicker, FireTypesCompare, FireTypesExplainer } from '../components/FireTypes';

export function FirePage() {
  const { data, analysis: a, update } = useStore();
  const f = a.fire;
  const p = data.profile;

  return (
    <Page feature="fire" title={`FIRE plan${a.fireType ? ` · ${a.fireType.emoji} ${a.fireType.name}` : ''}`} intro="How much you need, when you can stop working, and the SIP to get there.">
      <Missing missing={a.missing} />
      {f && p && (
        <>
          <Card title="Your FIRE type">
            <FireTypePicker />
            {a.fireType?.worksAfterFire && (
              <NumberField id="parttime" label="Part-time income after FIRE (per month, today's money)" suffix="₹" step={1000} min={0}
                value={p.partTimeIncome ?? Math.round(f.monthlyExpenseToday * DEFAULT_BARISTA_SHARE)}
                onChange={(v) => update((d) => ({ ...d, profile: { ...d.profile!, partTimeIncome: v } }))} />
            )}
          </Card>
          <Card title="Pick your retire age">
            <label className="field" htmlFor="age-slider">
              <span>Retire at <strong>{p.targetRetireAge}</strong> (in {f.yearsToFire} years)</span>
              <input id="age-slider" type="range" min={p.age} max={70} value={p.targetRetireAge}
                onChange={(e) => update((d) => ({ ...d, profile: { ...d.profile!, targetRetireAge: Number(e.target.value) } }))} />
            </label>
          </Card>

          <div className="grid stats">
            <Stat label="FIRE number" value={inrShort(f.fireNumber)} sub={`${inrShort(f.fireNumberToday)} in today's money`} />
            <Stat label="You'll have" value={inrShort(f.projectedCorpus)} sub="With current SIP" tone={f.status === 'on_track' ? 'good' : f.status === 'close' ? 'warn' : 'bad'} />
            <Stat label="SIP needed" value={inr(f.requiredMonthlySip)} sub={f.extraSipNeeded > 0 ? `+${inr(f.extraSipNeeded)} more` : 'You have enough'} />
            <Stat label="Earliest FIRE" value={f.earliestFireAgeWithCurrentSip ? `Age ${f.earliestFireAgeWithCurrentSip}` : 'After 80'} sub="At current SIP" />
          </div>

          <Card title="Corpus vs target">
            <LineChart points={f.projection.map((x) => ({ x: x.age, a: x.corpus, b: x.target }))} label="Projected corpus versus FIRE target by age" />
          </Card>

          <div className="grid two">
            <Card title="What this means">
              <ul className="tips">{f.messages.map((m) => <li key={m}>{m}</li>)}</ul>
            </Card>
            <Card title="Numbers used">
              <table>
                <tbody>
                  <tr><th scope="row">Monthly spend now</th><td className="num">{inr(f.monthlyExpenseToday)}</td></tr>
                  <tr><th scope="row">Corpus pays / month ({a.fireType?.name})</th><td className="num">{inr(f.targetMonthlySpend)}</td></tr>
                  <tr><th scope="row">Same, on FIRE day</th><td className="num">{inr(f.monthlyExpenseAtFire)}</td></tr>
                  <tr><th scope="row">Monthly surplus</th><td className="num">{inr(f.monthlySurplus)}</td></tr>
                  <tr><th scope="row">Savings rate</th><td className="num">{f.savingsRatePct.toFixed(0)}%</td></tr>
                  <tr><th scope="row">Inflation</th><td className="num">{data.assumptions.inflation}%</td></tr>
                  <tr><th scope="row">Safe withdrawal</th><td className="num">{data.assumptions.safeWithdrawalRate}%</td></tr>
                  <tr><th scope="row">Portfolio return</th><td className="num">{a.portfolio?.expectedReturn.toFixed(1)}%</td></tr>
                </tbody>
              </table>
              <p className="muted small">Change these in <a href="#/settings">Settings</a>.</p>
            </Card>
          </div>
          <FireTypesCompare />
        </>
      )}
      <FireTypesExplainer />
    </Page>
  );
}
