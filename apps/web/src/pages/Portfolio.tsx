import { inr } from '@wealthfire/core';
import { useStore } from '../store';
import { Card, Donut, Missing, Page, Stat } from '../ui';

export function PortfolioPage() {
  const { analysis: a } = useStore();
  const pf = a.portfolio;

  return (
    <Page feature="portfolio" title="Suggested portfolio" intro={`Fund types picked from your risk score and how far ${a.fireType?.name ?? 'FIRE'} is. The SIP is sized for your ${a.fireType?.name ?? 'FIRE'} goal.`}>
      <Missing missing={a.missing.filter((m) => m !== 'expenses')} />
      {pf && (
        <>
          <div className="grid stats">
            <Stat label="Risk profile" value={pf.profile} />
            <Stat label="Equity" value={`${pf.equityPct}%`} />
            <Stat label="Expected return" value={`${pf.expectedReturn.toFixed(1)}%/yr`} sub="Long-run estimate" />
            <Stat label="Monthly SIP" value={inr(pf.lines.reduce((s, l) => s + l.monthlyAmount, 0))} />
          </div>
          <p className="muted">{pf.glideNote}</p>
          <div className="grid two">
            <Card title="Mix">
              <Donut items={pf.lines.map((l) => ({ name: l.category.name, value: l.weight }))} label="Suggested fund mix" />
            </Card>
            <Card title="Split your SIP like this">
              <table>
                <thead><tr><th scope="col">Fund type</th><th scope="col" className="num">Share</th><th scope="col" className="num">Per month</th></tr></thead>
                <tbody>
                  {pf.lines.map((l) => (
                    <tr key={l.category.id}>
                      <td>{l.category.name}<div className="muted small">{l.category.note}</div></td>
                      <td className="num">{l.weight}%</td>
                      <td className="num">{inr(l.monthlyAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">Pick low-cost direct plans in each type. We don't push any fund house.</p>
            </Card>
          </div>
        </>
      )}
    </Page>
  );
}
