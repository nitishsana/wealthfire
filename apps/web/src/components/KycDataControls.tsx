// Profile: 'Withdraw consent' and 'Delete my KYC data' (DPDP, design 7). Server mode only, and only
// when a KYC case exists. Each opens a confirm step first (title, one-line effect, Cancel + a red
// confirm button). Same texts and order as packages/mobile-ui/src/server.tsx KycDataControls.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  hasKycCase, isServerError, KYC_TEXT, kycDataButtons, kycDeleteDone, kycWithdrawBody, kycWithdrawDone, needsSignIn,
  type KycStatusView, type ServerKycClient,
} from '@wealthfire/core';

type Ask = 'withdraw' | 'delete' | null;
const FAILED = 'Something went wrong. Try again.';

export function KycDataControls({ client }: { client: ServerKycClient }) {
  const [view, setView] = useState<KycStatusView | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const withdrawRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const lastAsk = useRef<Ask>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // While the buttons are disabled (busy) the focus would drop to the page: keep it on the confirm.
  useEffect(() => { if (busy && ask) dialogRef.current?.focus(); }, [busy, ask]);
  // After an error the focus goes to the error line inside the confirm (item 7).
  useEffect(() => { if (error && ask && !busy) errorRef.current?.focus(); }, [error, ask, busy]);

  const load = async () => {
    try { setView(await client.getStatus()); } catch { setView(null); } // no session / offline: hide the buttons
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus: Cancel when the confirm step opens (the safe choice); back to the button that opened it on close.
  useEffect(() => {
    if (ask) { lastAsk.current = ask; cancelRef.current?.focus(); return; }
    const from = lastAsk.current;
    lastAsk.current = null;
    if (from === 'withdraw') withdrawRef.current?.focus();
    else if (from === 'delete') deleteRef.current?.focus();
  }, [ask]);

  if (!hasKycCase(view) && !done) return null;

  async function confirm() {
    const what = ask;
    if (!what || busy) return;
    const before = view;
    setBusy(true); setError('');
    try {
      if (what === 'withdraw') await client.withdrawConsent();
      else await client.deleteKycData();
      // F3: a verified case keeps its KYC, so no 'stopped' line after a withdraw; a kept record says so after a delete
      setDone(what === 'withdraw' ? kycWithdrawDone(before) : kycDeleteDone(client.dataSession()));
      lastAsk.current = null;
      setAsk(null);
      await load();
    } catch (e) {
      // F12 (same as phones): an ended session says so; other errors show their fixed text
      setError(needsSignIn(e) ? KYC_TEXT.signInAgain : isServerError(e) ? e.message : FAILED);
    } finally {
      setBusy(false);
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); if (!busy) setAsk(null); return; }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    // focus trap: Tab and Shift+Tab wrap inside the confirm
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="-1"].error'));
    if (items.length === 0) { e.preventDefault(); dialogRef.current.focus(); return; }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === dialogRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (at === last || at === dialogRef.current)) { e.preventDefault(); first.focus(); }
  };
  // which buttons show (core rule, same on phones): no repeat withdraw / delete on a verified case this session
  const buttons = kycDataButtons(view, client.dataSession());
  const title = ask === 'withdraw' ? KYC_TEXT.withdrawTitle : KYC_TEXT.deleteTitle;
  const body = ask === 'withdraw' ? kycWithdrawBody(view) : KYC_TEXT.deleteBody;

  return (
    <section data-feature="kyc-data-controls" className="card kyc-data" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{KYC_TEXT.dataTitle}</h2>
      {ask ? (
        // A real modal: backdrop, aria-modal, focus kept inside (Tab wraps), Escape closes, focus returns on close.
        <div className="modal-backdrop">
          <div ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={`${id}-b`}
            className="confirm modal" tabIndex={-1} onKeyDown={onKey}>
            <h3 id={`${id}-t`}>{title}</h3>
            <p id={`${id}-b`}>{body}</p>
            {/* An error stays inside the confirm and takes the focus (not the page behind). */}
            {error && <p ref={errorRef} tabIndex={-1} className="error" role="alert">{error}</p>}
            <div className="row">
              <button ref={cancelRef} type="button" className="btn" disabled={busy} onClick={() => setAsk(null)}>{KYC_TEXT.cancel}</button>
              <button type="button" className="btn danger solid" disabled={busy} onClick={() => void confirm()}>
                {ask === 'withdraw' ? KYC_TEXT.withdrawConfirm : KYC_TEXT.deleteConfirm}
              </button>
            </div>
          </div>
        </div>
      ) : buttons.withdraw || buttons.delete ? (
        <div className="row">
          {buttons.withdraw && <button ref={withdrawRef} type="button" className="btn danger" onClick={() => { setDone(''); setError(''); setAsk('withdraw'); }}>{KYC_TEXT.withdrawButton}</button>}
          {buttons.delete && <button ref={deleteRef} type="button" className="btn danger" onClick={() => { setDone(''); setError(''); setAsk('delete'); }}>{KYC_TEXT.deleteButton}</button>}
        </div>
      ) : null}
      {done && <p className="muted" role="status">{done}</p>}
      {error && !ask && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
