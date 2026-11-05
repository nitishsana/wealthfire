import { inr, inrShort, makeSnapshot, upsertSnapshot } from '@wealthfire/core';
import { useStore } from '../store';
import { Card, LineChart, Page, Stat } from '../ui';

const VERDICT = { ahead: 'Ahead of plan', on_plan: 'On plan', behind: 'Behind plan', new: 'Just started' } as const;
const TONE = { ahead: 'good', on_plan: 'good', behind: 'bad', new: undefined } as const;

export function ProgressPage() {
  const { data, analysis: a, update } = useStore();
  const pr = a.progress;
  const snaps = data.snapshots;

  const checkIn = () => update((d) => ({ ...d, snapshots: upsertSnapshot(d.snapshots, makeSnapshot(d, a)) }));

  return (
    <Page feature="progress" title="Progress over time" intro="Save a check-in once a month. We compare it with your plan.">
      <div className="row">
        <button className="btn primary" onClick={checkIn} disabled={!a.fire}>Save this month's check-in</button>
      </div>
      <div className="grid stats">
        <Stat label="Status" value={VERDICT[pr.verdict]} tone={TONE[pr.verdict]} sub={pr.vsPlanPct !== null ? `${pr.vsPlanPct >= 0 ? '+' : ''}${pr.vsPlanPct.toFixed(1)}% vs plan` : undefined} />
        <Stat label="Check-ins" value={String(pr.snapshots)} sub={pr.firstDate ? `Since ${pr.firstDate}` : undefined} />
        <Stat label="Growth" value={`${pr.growthPct.toFixed(1)}%`} />
        <Stat label="Added / month" value={inrShort(pr.monthlyAddedAvg)} sub="Incl. market moves" />
      </div>
      <Card title="What changed"><ul className="tips">{pr.messages.map((m) => <li key={m}>{m}</li>)}</ul></Card>
      {snaps.length >= 2 && (
        <Card title="Investable vs FIRE number">
          <LineChart points={snaps.map((s, i) => ({ x: i + 1, a: s.investable, b: s.fireNumber }))} label="Investable assets versus FIRE number at each check-in" />
          <p className="muted small">X axis: check-in number.</p>
        </Card>
      )}
      <Card title="History">
        <table>
          <thead><tr><th scope="col">Date</th><th scope="col" className="num">Investable</th><th scope="col" className="num">Net worth</th><th scope="col" className="num">FIRE number</th><th scope="col" className="num">SIP</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
          <tbody>
            {[...snaps].reverse().map((s) => (
              <tr key={s.date}>
                <td>{s.date}</td><td className="num">{inrShort(s.investable)}</td><td className="num">{inrShort(s.netWorth)}</td>
                <td className="num">{inrShort(s.fireNumber)}</td><td className="num">{inr(s.monthlySip)}</td>
                <td><button className="link" aria-label={`Remove check-in ${s.date}`} onClick={() => update((d) => ({ ...d, snapshots: d.snapshots.filter((x) => x.date !== s.date) }))}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Page>
  );
}
