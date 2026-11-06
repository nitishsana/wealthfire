import { FIRE_TYPES, inr, inrShort, type FireTypeId } from '@wealthfire/core';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import { Bar, Card } from '../ui';

/** Lets the user switch FIRE type in place (Profile, FIRE plan, Home). */
export function FireTypePicker({ compact }: { compact?: boolean }) {
  const { data, update } = useStore();
  const current = data.profile?.fireType ?? 'regular';
  const pick = (id: FireTypeId) => update((d) => (d.profile ? { ...d, profile: { ...d.profile, fireType: id } } : d));
  return (
    <fieldset data-feature="firetype-pick" className="fire-pick">
      <legend className={compact ? 'sr-only' : undefined}>Which FIRE are you aiming for?</legend>
      <div className={compact ? 'choices' : 'type-cards'}>
        {FIRE_TYPES.map((t) => (
          <label key={t.id} className={`${compact ? 'choice' : 'type-card'} ${current === t.id ? 'on' : ''}`}>
            <input type="radio" name="firetype" checked={current === t.id} onChange={() => pick(t.id)} disabled={!data.profile} />
            <span className="type-name">{t.emoji} {t.name}</span>
            {!compact && <span className="muted small">{t.tagline}</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** All FIRE types side by side, plus the Coast FIRE milestone. */
export function FireTypesCompare({ compact }: { compact?: boolean }) {
  const { data, analysis: a } = useStore();
  if (!a.fireTypes.length || !data.profile) return null;
  const current = a.fireType?.id;
  const c = a.coast;
  return (
    <div data-feature="firetypes">
      <Card title="🔥 FIRE types compared">
        <table>
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col" className="num">Corpus pays / month</th>
              <th scope="col" className="num">FIRE number</th>
              {!compact && <th scope="col" className="num">SIP needed</th>}
              <th scope="col" className="num">FIRE age at current SIP</th>
            </tr>
          </thead>
          <tbody>
            {a.fireTypes.map(({ type, corpusSpend, plan }) => (
              <tr key={type.id} className={type.id === current ? 'row-on' : undefined} aria-current={type.id === current ? 'true' : undefined}>
                <th scope="row">{type.emoji} {type.name}{type.id === current && <span className="badge">Your goal</span>}</th>
                <td className="num">{inr(corpusSpend)}</td>
                <td className="num">{inrShort(plan.fireNumber)}<div className="muted small">{inrShort(plan.fireNumberToday)} today</div></td>
                {!compact && <td className="num">{inr(plan.requiredMonthlySip)}</td>}
                <td className="num">{plan.earliestFireAgeWithCurrentSip ?? 'After 80'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">FIRE number is for retiring at {data.profile.targetRetireAge}, grown by inflation. Same {data.assumptions.safeWithdrawalRate}% withdrawal rate for all.</p>
        {compact && <Link className="btn" to="/fire">Compare FIRE types</Link>}
      </Card>

      {c && (
        <Card title="⛵ Coast FIRE milestone">
          <p>
            {c.reached
              ? `You've hit Coast FIRE. Your investments can grow to your FIRE number by ${c.coastAge} even if you stop adding.`
              : `Have ${inrShort(c.neededToday)} invested and it grows to your FIRE number by ${c.coastAge} on its own.`}
          </p>
          <Bar pct={c.progressPct} label="Coast FIRE progress" />
          <p className="muted small">
            {Math.round(c.progressPct)}% there.{' '}
            {!c.reached && (c.ageReached ? `At your current SIP you reach it at age ${c.ageReached}.` : `Your current SIP doesn't reach it before ${c.coastAge}.`)}
            {' '}After that you only need to earn enough for today's bills.
          </p>
        </Card>
      )}
    </div>
  );
}

/** Plain explainer of each FIRE type. */
export function FireTypesExplainer() {
  return (
    <Card title="Which FIRE fits you?">
      <div className="grid two">
        {FIRE_TYPES.map((t) => (
          <div key={t.id} className="explain">
            <h3>{t.emoji} {t.name}</h3>
            <p>{t.about}</p>
            <p className="muted small"><strong>Lifestyle:</strong> {t.lifestyle}</p>
            <p className="muted small"><strong>Watch out:</strong> {t.watchOut}</p>
          </div>
        ))}
        <div className="explain">
          <h3>⛵ Coast FIRE</h3>
          <p>A milestone, not a lifestyle. Once you've saved enough, compounding carries you to FIRE by about 60, even if you stop investing.</p>
          <p className="muted small"><strong>Then:</strong> you only need to earn enough to cover today's bills.</p>
          <p className="muted small"><strong>Watch out:</strong> it relies on returns holding up for many years.</p>
        </div>
      </div>
    </Card>
  );
}
