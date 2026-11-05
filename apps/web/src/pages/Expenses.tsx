import { useState, type ChangeEvent, type FormEvent } from 'react';
import { categorize, EXPENSE_CATEGORIES, inr, newId, parseStatement, todayIso, type ExpenseCategory } from '@wealthfire/core';
import { useStore } from '../store';
import { Card, Donut, NumberField, Page, Stat } from '../ui';

const SAMPLE = `05/10/2026, SWIGGY BANGALORE, 450.00
06 Oct 2026  AMAZON PAY INDIA  1,299.00 Dr
07/10/2026 PAYMENT RECEIVED - THANK YOU 25,000.00 Cr
08/10/2026, UBER INDIA, 320`;

export function ExpensesPage() {
  const { data, analysis, update } = useStore();
  const s = analysis.expenses;
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(todayIso());
  const [cat, setCat] = useState<ExpenseCategory | 'auto'>('auto');

  function importText(t: string) {
    const r = parseStatement(t, 'statement');
    if (!r.expenses.length) { setMsg(`No spends found. Skipped ${r.skipped} lines.`); return; }
    update((d) => ({ ...d, expenses: [...d.expenses, ...r.expenses] }));
    setMsg(`Added ${r.expenses.length} spends. Skipped ${r.skipped} lines (headers, payments, refunds).`);
    setText('');
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 2_000_000) { setMsg('File is too big. Max 2 MB.'); return; }
    if (!/\.(csv|txt)$/i.test(f.name)) { setMsg('Upload a .csv or .txt file. PDF support comes with Gmail sync.'); return; }
    importText(await f.text());
    e.target.value = '';
  }

  function addManual(e: FormEvent) {
    e.preventDefault();
    if (amount <= 0 || !desc.trim()) return;
    const category = cat === 'auto' ? categorize(desc) : cat;
    update((d) => ({ ...d, expenses: [...d.expenses, { id: newId('e'), date, description: desc.trim(), amount, category, source: 'manual' }] }));
    setDesc(''); setAmount(0);
  }

  const recent = [...data.expenses].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40);

  return (
    <Page feature="expenses" title="Expenses" intro="Upload a credit card statement or add spends. We sort them for you.">
      <div className="grid stats">
        <Stat label="Monthly spend" value={inr(s.monthlyAverage)} sub={`${s.months} month${s.months === 1 ? '' : 's'} of data`} />
        <Stat label="Without EMIs" value={inr(s.monthlyLiving)} sub="Used for FIRE" />
        <Stat label="Top category" value={s.byCategory[0]?.category ?? '—'} sub={s.byCategory[0] ? inr(s.byCategory[0].monthly) + '/mo' : ''} />
      </div>

      <div className="grid two">
        <Card title="📥 Upload statement">
          <label className="field" htmlFor="file"><span>CSV or text file</span>
            <input id="file" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={onFile} />
          </label>
          <label className="field" htmlFor="paste"><span>Or paste statement lines</span>
            <textarea id="paste" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={SAMPLE} />
          </label>
          <div className="row">
            <button className="btn primary" onClick={() => importText(text)} disabled={!text.trim()}>Import</button>
            <button className="btn" onClick={() => setText(SAMPLE)}>Try a sample</button>
          </div>
          {msg && <p role="status" className="muted">{msg}</p>}
          <p className="muted small">Auto-read from Gmail is coming. See <a href="#/connect">Connect</a>.</p>
        </Card>

        <Card title="✍️ Add a spend">
          <form onSubmit={addManual} className="form-grid compact">
            <label className="field" htmlFor="edesc"><span>What</span><input id="edesc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Swiggy" /></label>
            <NumberField id="eamt" label="Amount" value={amount} onChange={setAmount} min={0} suffix="₹" />
            <label className="field" htmlFor="edate"><span>Date</span><input id="edate" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <label className="field" htmlFor="ecat"><span>Category</span>
              <select id="ecat" value={cat} onChange={(e) => setCat(e.target.value as ExpenseCategory | 'auto')}>
                <option value="auto">Auto-detect</option>
                {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <button className="btn primary" type="submit">Add</button>
          </form>
        </Card>
      </div>

      {s.byCategory.length > 0 && (
        <Card title="Where your money goes (per month)">
          <Donut items={s.byCategory.map((c) => ({ name: `${c.category} · ${inr(c.monthly)}`, value: c.monthly }))} label="Monthly spend by category" />
        </Card>
      )}

      <Card title={`Recent spends (${data.expenses.length})`}>
        <table>
          <thead><tr><th scope="col">Date</th><th scope="col">What</th><th scope="col">Category</th><th scope="col" className="num">Amount</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
          <tbody>
            {recent.map((e) => (
              <tr key={e.id}>
                <td>{e.date}</td><td>{e.description}</td>
                <td>
                  <select aria-label={`Category for ${e.description}`} value={e.category}
                    onChange={(ev) => update((d) => ({ ...d, expenses: d.expenses.map((x) => (x.id === e.id ? { ...x, category: ev.target.value as ExpenseCategory } : x)) }))}>
                    {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </td>
                <td className="num">{inr(e.amount)}</td>
                <td><button className="link" aria-label={`Remove ${e.description}`} onClick={() => update((d) => ({ ...d, expenses: d.expenses.filter((x) => x.id !== e.id) }))}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Page>
  );
}
