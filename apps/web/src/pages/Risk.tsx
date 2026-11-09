import { computeRiskScore, isRiskComplete, RISK_INCOMPLETE_TEXT, RISK_QUESTIONS } from '@wealthfire/core';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import { Bar, Card, Page } from '../ui';

export function RiskPage() {
  const { data, update } = useStore();
  const answers = data.riskAnswers;
  const done = isRiskComplete(answers);
  const result = computeRiskScore(answers, data.profile?.age ?? 30);

  const pick = (qid: string, idx: number) => update((d) => ({ ...d, riskAnswers: { ...d.riskAnswers, [qid]: idx } }));

  return (
    <Page feature="risk" title="Risk score" intro="Six quick questions. Your answers and age set how much equity suits you.">
      {RISK_QUESTIONS.map((q, qi) => (
        <Card key={q.id}>
          <fieldset>
            <legend>{qi + 1}. {q.text}</legend>
            <div className="choices">
              {q.options.map((o, oi) => (
                <label key={o.label} className={`choice ${answers[q.id] === oi ? 'on' : ''}`}>
                  <input type="radio" name={q.id} checked={answers[q.id] === oi} onChange={() => pick(q.id, oi)} />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
        </Card>
      ))}
      <Card title="Your result" className="sticky-result">
        {done ? (
          <>
            <p className="big">{result.profile} <span className="muted">· {result.score}/100</span></p>
            <Bar pct={result.score} label="Risk score" />
            {!data.profile && <p className="muted">Add your <Link to="/profile">profile</Link> so age is counted.</p>}
            <Link className="btn primary" to="/portfolio">See my portfolio</Link>
          </>
        ) : (
          <p className="muted">{RISK_INCOMPLETE_TEXT}</p>
        )}
      </Card>
    </Page>
  );
}
