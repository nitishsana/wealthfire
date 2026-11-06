import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_BARISTA_SHARE, FIRE_TYPES, type Profile } from '@wealthfire/core';
import { useStore } from '../store';
import { Card, NumberField, Page } from '../ui';

const BLANK: Profile = {
  name: '', age: 30, city: '', monthlyIncome: 0, dependents: 0,
  targetRetireAge: 45, lifeExpectancy: 85, currentMonthlySip: 0, fireType: 'regular',
};

export function ProfilePage() {
  const { data, analysis, update } = useStore();
  const nav = useNavigate();
  const [p, setP] = useState<Profile>(data.profile ?? BLANK);
  const [useOverride, setUseOverride] = useState(p.monthlyExpenseOverride !== undefined);
  const [error, setError] = useState('');
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setP((x) => ({ ...x, [k]: v }));

  function save(e: FormEvent) {
    e.preventDefault();
    if (!p.name.trim()) return setError('Please enter your name.');
    if (p.age < 18 || p.age > 80) return setError('Age must be 18 to 80.');
    if (p.targetRetireAge < p.age) return setError('Retire age must be your age or more.');
    if (p.monthlyIncome < 0 || p.currentMonthlySip < 0) return setError('Amounts cannot be negative.');
    setError('');
    const clean: Profile = { ...p, name: p.name.trim(), city: p.city.trim() };
    if (!useOverride) delete clean.monthlyExpenseOverride;
    update((d) => ({ ...d, profile: clean }));
    nav(data.riskAnswers && Object.keys(data.riskAnswers).length ? '/' : '/risk');
  }

  return (
    <Page feature="onboarding" title="Your profile" intro="Tell us about you. This sets your FIRE plan.">
      <form onSubmit={save} noValidate>
        <Card>
          <div className="form-grid">
            <label className="field" htmlFor="name">
              <span>Name</span>
              <input id="name" value={p.name} onChange={(e) => set('name', e.target.value)} autoComplete="name" required />
            </label>
            <NumberField id="age" label="Age" value={p.age} onChange={(v) => set('age', v)} min={18} max={80} />
            <label className="field" htmlFor="city">
              <span>City</span>
              <input id="city" value={p.city} onChange={(e) => set('city', e.target.value)} autoComplete="address-level2" />
            </label>
            <NumberField id="dependents" label="People who depend on you" value={p.dependents} onChange={(v) => set('dependents', v)} min={0} />
            <NumberField id="income" label="Monthly take-home pay" value={p.monthlyIncome} onChange={(v) => set('monthlyIncome', v)} min={0} step={1000} suffix="₹" />
            <NumberField id="sip" label="Current monthly SIP" value={p.currentMonthlySip} onChange={(v) => set('currentMonthlySip', v)} min={0} step={500} suffix="₹" />
            <NumberField id="retire" label="Age you want to retire" value={p.targetRetireAge} onChange={(v) => set('targetRetireAge', v)} min={p.age} max={80} />
            <NumberField id="life" label="Plan money till age" value={p.lifeExpectancy} onChange={(v) => set('lifeExpectancy', v)} min={60} max={100} />
          </div>
          <fieldset data-feature="firetype-pick" className="fire-pick">
            <legend>Which FIRE are you aiming for?</legend>
            <div className="type-cards">
              {FIRE_TYPES.map((t) => (
                <label key={t.id} className={`type-card ${(p.fireType ?? 'regular') === t.id ? 'on' : ''}`}>
                  <input type="radio" name="p-firetype" checked={(p.fireType ?? 'regular') === t.id} onChange={() => set('fireType', t.id)} />
                  <span className="type-name">{t.emoji} {t.name}</span>
                  <span className="muted small">{t.tagline}</span>
                </label>
              ))}
            </div>
            <p className="muted small">Not sure? See <a href="#/fire">Which FIRE fits you</a>. You can change it any time.</p>
          </fieldset>
          {p.fireType === 'barista' && (
            <NumberField id="parttime" label="Part-time income after FIRE (per month)"
              value={p.partTimeIncome ?? Math.round((p.monthlyExpenseOverride ?? analysis.expenses.monthlyLiving) * DEFAULT_BARISTA_SHARE)}
              onChange={(v) => set('partTimeIncome', v)} min={0} step={1000} suffix="₹" />
          )}
          <label className="check">
            <input type="checkbox" checked={useOverride} onChange={(e) => {
              setUseOverride(e.target.checked);
              if (e.target.checked && p.monthlyExpenseOverride === undefined) set('monthlyExpenseOverride', 50000);
            }} />
            Type my monthly spend instead of using my expenses
          </label>
          {useOverride && (
            <NumberField id="override" label="Monthly spend (no EMIs)" value={p.monthlyExpenseOverride ?? 0} onChange={(v) => set('monthlyExpenseOverride', v)} min={0} step={1000} suffix="₹" />
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn primary" type="submit">Save profile</button>
        </Card>
      </form>
    </Page>
  );
}
