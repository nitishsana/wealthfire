import { useState, type FormEvent } from 'react';
import { ASSET_TYPE_LABELS, inr, inrShort, newId, type AssetType, type LiabilityType } from '@wealthfire/core';
import { useStore } from '../store';
import { Card, Donut, NumberField, Page, Stat } from '../ui';

const LIABILITY_LABELS: Record<LiabilityType, string> = {
  home_loan: 'Home loan', car_loan: 'Car loan', personal_loan: 'Personal loan',
  credit_card: 'Credit card dues', education_loan: 'Education loan', other: 'Other',
};

export function NetWorthPage() {
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

  function addAsset(e: FormEvent) {
    e.preventDefault();
    if (aValue <= 0) return;
    update((d) => ({ ...d, assets: [...d.assets, { id: newId('a'), name: aName.trim() || ASSET_TYPE_LABELS[aType], type: aType, value: aValue, source: 'manual' }] }));
    setAName(''); setAValue(0);
  }
  function addLiability(e: FormEvent) {
    e.preventDefault();
    if (lOut <= 0) return;
    update((d) => ({ ...d, liabilities: [...d.liabilities, { id: newId('l'), name: lName.trim() || LIABILITY_LABELS[lType], type: lType, outstanding: lOut, monthlyEmi: lEmi, interestRate: lRate }] }));
    setLName(''); setLOut(0); setLEmi(0);
  }

  const classItems = [
    { name: 'Equity', value: nw.byClass.equity },
    { name: 'Debt', value: nw.byClass.debt },
    { name: 'Gold', value: nw.byClass.gold },
    { name: 'Cash', value: nw.byClass.cash },
    { name: 'Property / other', value: nw.byClass.illiquid },
  ].filter((i) => i.value > 0);

  return (
    <Page feature="networth" title="Assets & liabilities" intro="What you own and what you owe, in one place.">
      <div className="grid stats">
        <Stat label="Net worth" value={inrShort(nw.netWorth)} tone={nw.netWorth >= 0 ? 'good' : 'bad'} />
        <Stat label="Assets" value={inrShort(nw.totalAssets)} />
        <Stat label="Liabilities" value={inrShort(nw.totalLiabilities)} />
        <Stat label="EMIs / month" value={inr(nw.monthlyEmi)} />
      </div>

      <div className="grid two">
        <Card title="Assets">
          {classItems.length > 0 && <Donut items={classItems} label="Assets by type" />}
          <table>
            <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col" className="num">Value</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
            <tbody>
              {data.assets.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td><td>{ASSET_TYPE_LABELS[a.type]}</td><td className="num">{inr(a.value)}</td>
                  <td><button className="link" aria-label={`Remove ${a.name}`} onClick={() => update((d) => ({ ...d, assets: d.assets.filter((x) => x.id !== a.id) }))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <form onSubmit={addAsset} className="form-grid compact">
            <label className="field" htmlFor="aname"><span>Name</span><input id="aname" value={aName} onChange={(e) => setAName(e.target.value)} placeholder="e.g. Nifty 50 fund" /></label>
            <label className="field" htmlFor="atype"><span>Type</span>
              <select id="atype" value={aType} onChange={(e) => setAType(e.target.value as AssetType)}>
                {Object.entries(ASSET_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <NumberField id="avalue" label="Value" value={aValue} onChange={setAValue} min={0} step={1000} suffix="₹" />
            <button className="btn primary" type="submit">Add asset</button>
          </form>
        </Card>

        <Card title="Liabilities">
          <table>
            <thead><tr><th scope="col">Name</th><th scope="col" className="num">Owed</th><th scope="col" className="num">EMI</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
            <tbody>
              {data.liabilities.map((l) => (
                <tr key={l.id}>
                  <td>{l.name} <span className="muted">{l.interestRate}%</span></td><td className="num">{inr(l.outstanding)}</td><td className="num">{inr(l.monthlyEmi)}</td>
                  <td><button className="link" aria-label={`Remove ${l.name}`} onClick={() => update((d) => ({ ...d, liabilities: d.liabilities.filter((x) => x.id !== l.id) }))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <form onSubmit={addLiability} className="form-grid compact">
            <label className="field" htmlFor="lname"><span>Name</span><input id="lname" value={lName} onChange={(e) => setLName(e.target.value)} placeholder="e.g. HDFC home loan" /></label>
            <label className="field" htmlFor="ltype"><span>Type</span>
              <select id="ltype" value={lType} onChange={(e) => setLType(e.target.value as LiabilityType)}>
                {Object.entries(LIABILITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <NumberField id="lout" label="Amount owed" value={lOut} onChange={setLOut} min={0} step={1000} suffix="₹" />
            <NumberField id="lemi" label="Monthly EMI" value={lEmi} onChange={setLEmi} min={0} step={500} suffix="₹" />
            <NumberField id="lrate" label="Interest" value={lRate} onChange={setLRate} min={0} step={0.1} suffix="%" />
            <button className="btn primary" type="submit">Add liability</button>
          </form>
        </Card>
      </div>
      <p className="muted">Property and "other" count in net worth, but not in your FIRE corpus.</p>
    </Page>
  );
}
