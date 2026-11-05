import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { inrShort } from '@wealthfire/core';

export function Page({ feature, title, intro, children }: { feature: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section data-feature={feature} aria-labelledby={`h-${feature}`}>
      <h1 id={`h-${feature}`}>{title}</h1>
      {intro && <p className="intro">{intro}</p>}
      {children}
    </section>
  );
}

export function Card({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`card ${className ?? ''}`}>
      {title && <h2>{title}</h2>}
      {children}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Bar({ pct, label }: { pct: number; label: string }) {
  const v = Math.max(0, Math.min(100, pct));
  return (
    <div className="bar" role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="bar-fill" style={{ width: `${v}%` }} />
    </div>
  );
}

const MISSING_LINKS: Record<string, { to: string; text: string }> = {
  profile: { to: '/profile', text: 'Add your profile' },
  risk: { to: '/risk', text: 'Take the risk quiz' },
  expenses: { to: '/expenses', text: 'Add expenses' },
};

export function Missing({ missing }: { missing: string[] }) {
  if (!missing.length) return null;
  return (
    <div className="card notice" role="status">
      <strong>A few steps left:</strong>
      <ul>
        {missing.map((m) => (
          <li key={m}>
            <Link to={MISSING_LINKS[m]?.to ?? '/'}>{MISSING_LINKS[m]?.text ?? m}</Link>
          </li>
        ))}
      </ul>
      <p>
        Or <Link to="/settings">load demo data</Link> to look around.
      </p>
    </div>
  );
}

const PALETTE = ['#ff7a18', '#ffb347', '#f4d35e', '#5ec2b7', '#4f9dde', '#8b7cf6', '#e86fa8', '#9aa5b1', '#6fcf97'];

/** Donut chart with an accessible text legend. */
export function Donut({ items, label }: { items: { name: string; value: number }[]; label: string }) {
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  let acc = 0;
  const R = 60;
  const C = 2 * Math.PI * R;
  return (
    <figure className="donut">
      <svg viewBox="0 0 160 160" width="160" height="160" role="img" aria-label={label}>
        <circle cx="80" cy="80" r={R} fill="none" stroke="var(--line)" strokeWidth="22" />
        {items.map((it, i) => {
          const len = (it.value / total) * C;
          const el = (
            <circle key={it.name} cx="80" cy="80" r={R} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth="22"
              strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-acc} transform="rotate(-90 80 80)" />
          );
          acc += len;
          return el;
        })}
      </svg>
      <figcaption>
        <ul className="legend">
          {items.map((it, i) => (
            <li key={it.name}>
              <span className="dot" style={{ background: PALETTE[i % PALETTE.length] }} aria-hidden="true" />
              {it.name} <span className="muted">{Math.round((it.value / total) * 100)}%</span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

/** Two-line chart: corpus vs target over age. */
export function LineChart({ points, label }: { points: { x: number; a: number; b: number }[]; label: string }) {
  if (points.length < 2) return null;
  const W = 640, H = 220, P = 36;
  const maxY = Math.max(...points.map((p) => Math.max(p.a, p.b))) || 1;
  const minX = points[0]!.x, maxX = points[points.length - 1]!.x;
  const sx = (x: number) => P + ((x - minX) / (maxX - minX || 1)) * (W - 2 * P);
  const sy = (y: number) => H - P - (y / maxY) * (H - 2 * P);
  const path = (k: 'a' | 'b') => points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p[k]).toFixed(1)}`).join(' ');
  return (
    <figure className="line-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="none">
        <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="var(--line)" />
        <path d={path('b')} fill="none" stroke="var(--muted)" strokeWidth="2" strokeDasharray="6 5" />
        <path d={path('a')} fill="none" stroke="var(--accent)" strokeWidth="3" />
        <text x={P} y={H - 10} className="axis">Age {minX}</text>
        <text x={W - P} y={H - 10} textAnchor="end" className="axis">Age {maxX}</text>
        <text x={P} y={P - 10} className="axis">{inrShort(maxY)}</text>
      </svg>
      <figcaption className="legend inline">
        <span><span className="dot" style={{ background: 'var(--accent)' }} aria-hidden="true" /> Your corpus</span>
        <span><span className="dot" style={{ background: 'var(--muted)' }} aria-hidden="true" /> FIRE target</span>
      </figcaption>
    </figure>
  );
}

export function NumberField({ label, value, onChange, min, max, step, suffix, id }: {
  label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; suffix?: string; id: string;
}) {
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <span className="input-wrap">
        <input id={id} type="number" inputMode="decimal" value={Number.isFinite(value) ? value : ''} min={min} max={max} step={step ?? 1}
          onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />
        {suffix && <span className="suffix">{suffix}</span>}
      </span>
    </label>
  );
}
