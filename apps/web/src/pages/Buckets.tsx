import { BUCKET_NAMES, inr, inrShort, PHASE_LABELS, type BucketState } from '@wealthfire/core';
import { useStore } from '../store';
import { Bar, Card, Missing, NumberField, Page } from '../ui';

const KEYS: (keyof BucketState)[] = ['bucket1', 'bucket2', 'bucket3'];
const HOLDS: Record<keyof BucketState, string> = {
  bucket1: 'Cash, liquid funds · next 2 yrs',
  bucket2: 'Debt funds, FDs, gold · yrs 3-7',
  bucket3: 'Equity funds · yr 8 onward',
};
const PHASES = ['accumulate', 'build_bucket2', 'build_bucket1', 'drawdown'] as const;

export function BucketsPage() {
  const { data, analysis: a, update } = useStore();
  const b = a.buckets;
  const fromHoldings = data.buckets === null;

  return (
    <Page feature="buckets" title="Bucket plan" intro="Three pots with three jobs. Tips change as FIRE gets closer and as markets move.">
      <Missing missing={a.missing} />
      {b && (
        <>
          <Card title="Where you are">
            <ol className="phases" aria-label="Bucket phases">
              {PHASES.map((ph) => (
                <li key={ph} className={ph === b.phase ? 'on' : ''} aria-current={ph === b.phase ? 'step' : undefined}>{PHASE_LABELS[ph]}</li>
              ))}
            </ol>
          </Card>

          <div className="grid three">
            {KEYS.map((k) => (
              <Card key={k} title={BUCKET_NAMES[k]}>
                <p className="muted small">{HOLDS[k]}</p>
                <p className="big">{inrShort(b.current[k])}</p>
                <Bar pct={b.fillPct[k]} label={`${BUCKET_NAMES[k]} filled`} />
                <p className="muted small">Target {inrShort(b.targets[k])} · {b.fillPct[k]}% full</p>
              </Card>
            ))}
          </div>

          <div className="grid two">
            <Card title="✅ Do this now">
              {b.moves.length === 0 && <p>No moves needed. Keep your SIPs running.</p>}
              <ul className="moves">
                {b.moves.map((m, i) => (
                  <li key={i}>
                    <strong>{m.from === 'sip' ? `${inr(m.amount)}/month of SIP` : inr(m.amount)}</strong>{' '}
                    {m.from === 'sip' ? '→' : `${BUCKET_NAMES[m.from].split(' · ')[0]} →`} {BUCKET_NAMES[m.to].split(' · ')[0]}
                    <div className="muted small">{m.reason}</div>
                  </li>
                ))}
              </ul>
              <ul className="tips">{b.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            </Card>

            <Card title="Market and balances">
              <NumberField id="mkt" label="Stock market return, last 12 months" value={data.assumptions.lastYearEquityReturn} step={1} suffix="%"
                onChange={(v) => update((d) => ({ ...d, assumptions: { ...d.assumptions, lastYearEquityReturn: v } }))} />
              <p className="muted small">Below 0% means a bad year. Then we never sell equity.</p>
              <label className="check">
                <input type="checkbox" checked={fromHoldings} onChange={(e) =>
                  update((d) => ({ ...d, buckets: e.target.checked ? null : { ...b.current } }))} />
                Fill buckets from my assets (cash → 1, debt + gold → 2, equity → 3)
              </label>
              {!fromHoldings && KEYS.map((k) => (
                <NumberField key={k} id={`bal-${k}`} label={BUCKET_NAMES[k]} value={data.buckets![k]} step={10000} suffix="₹"
                  onChange={(v) => update((d) => ({ ...d, buckets: { ...d.buckets!, [k]: v } }))} />
              ))}
            </Card>
          </div>
        </>
      )}
    </Page>
  );
}
