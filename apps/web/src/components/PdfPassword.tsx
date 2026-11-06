// Password for a locked e-Aadhaar / e-PAN PDF (reader reason 'locked').
// The password lives in this component's state for one read only: it is cleared as soon as
// "Open PDF" is pressed, and never stored, logged or sent anywhere.
import { useId, useState, type FormEvent } from 'react';

interface Props {
  /** Re-read the PDF with this password. */
  onOpen: (password: string) => void | Promise<unknown>;
  disabled?: boolean;
}

export function PdfPassword({ onOpen, disabled }: Props) {
  const id = useId();
  const [password, setPassword] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || disabled) return;
    const p = password;
    setPassword(''); // one read only
    void onOpen(p);
  }

  return (
    <form className="field pdf-password" noValidate onSubmit={submit}>
      <label htmlFor={`${id}-pw`}>PDF password</label>
      <div className="row">
        <input id={`${id}-pw`} type="password" autoComplete="off" data-lpignore="true" data-1p-ignore="" spellCheck={false}
          autoCorrect="off" autoCapitalize="off" value={password} disabled={disabled} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" className="btn" disabled={disabled || !password}>Open PDF</button>
      </div>
    </form>
  );
}
