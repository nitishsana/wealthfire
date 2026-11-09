// Date of birth field (DD/MM/YYYY), shared by "Your details" and the server KYC's DOB form.
// Error text comes from core validateDob and shows after blur.
import { DOB_HINT, DOB_LABEL, validateDob } from '@wealthfire/core';

/** ISO yyyy-mm-dd → DD/MM/YYYY for the field (other text unchanged). */
export const isoToDmy = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : iso);

/** Typed digits → DD/MM/YYYY with the slashes added (numeric keypads have no '/'). */
export function formatDobInput(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 8);
  return [d.slice(0, 2), d.slice(2, 4), d.slice(4)].filter(Boolean).join('/');
}

export function DobField({ id, value, touched, disabled, onChange, onBlur }: {
  id: string;
  value: string;
  /** show the error (after blur) */
  touched: boolean;
  disabled?: boolean;
  onChange: (v: string) => void;
  onBlur: () => void;
}) {
  const err = touched ? validateDob(value) : null;
  return (
    <label className="field" htmlFor={id}>
      <span>{DOB_LABEL}</span>
      <input id={id} type="text" inputMode="numeric" autoComplete="bday" value={value} maxLength={10} placeholder={DOB_HINT} required
        disabled={disabled} aria-invalid={err ? true : undefined} aria-describedby={[`${id}-hint`, err ? `${id}-err` : ''].filter(Boolean).join(' ')}
        onChange={(e) => onChange(formatDobInput(e.target.value))} onBlur={onBlur} />
      <span id={`${id}-hint`} className="muted small">{DOB_HINT}</span>
      {err && <span id={`${id}-err`} className="error" role="status">{err}</span>}
    </label>
  );
}
