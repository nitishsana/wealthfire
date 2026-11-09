// Review console: sign in, list Under-review cases, open one, Approve / Reject with a reason.
// Routes are hash-based (#/ and #/cases/<id>) so the in-memory session survives navigation.
import { ApiError, decide, getCase, listCases, type CaseView, type DocumentLink, type HistoryRow } from './api';
import { completeSignIn, current, signIn, signOut } from './auth';
import { announce, h, show, when } from './dom';

const REVIEWER = 'reviewer';
const REASON_MAX = 200;

const CHECK_LABELS: Record<string, string> = {
  kra: 'KRA lookup',
  'kra-name': 'KRA name match',
  'kra-dob': 'KRA date of birth match',
  aadhaar: 'Aadhaar verified',
  pan: 'PAN valid',
  'pan-name': 'PAN name match',
  'pan-aadhaar-link': 'PAN linked to Aadhaar',
  'face-match': 'Face match',
  liveness: 'Liveness',
  esign: 'E-sign',
};
const RESULT_LABELS: Record<string, string> = { pass: 'Pass', fail: 'Fail', unclear: 'Unclear' };
const REASON_LABELS: Record<string, string> = {
  'check-unclear': 'A check was unclear',
  'device-hand-check': 'Device sent for hand check',
  'partner-timeout': 'Partner check timed out',
  'pan-in-use': 'PAN already used by another account',
};
const DOC_LABELS: Record<string, string> = { selfie: 'Selfie', aadhaar: 'Aadhaar document', pan: 'PAN card', other: 'Other document' };

function errorBox(message: string): HTMLElement {
  return h('div', { class: 'error', role: 'alert' }, message);
}

function signedOutView(message?: string): void {
  updateHeader();
  show(
    h('h1', {}, 'Sign in'),
    message ? errorBox(message) : null,
    h('p', {}, 'Staff only. You will sign in with your Wealthfire staff account and a one-time code from your authenticator app.'),
    h('button', { type: 'button', onclick: () => void signIn() }, 'Sign in'),
  );
}

function noAccessView(): void {
  show(
    h('h1', {}, 'No reviewer access'),
    h('p', {}, 'Your account is not in the reviewer group. Ask an admin to add you, then sign in again.'),
  );
}

function updateHeader(): void {
  const s = current();
  const who = document.getElementById('who');
  const out = document.getElementById('signout') as HTMLButtonElement | null;
  if (who) who.textContent = s ? `Signed in as ${s.email || s.sub}` : '';
  if (out) out.hidden = !s;
}

function handleError(e: unknown, retry: () => void): void {
  if (e instanceof ApiError && e.status === 401) return signedOutView(e.message);
  if (e instanceof ApiError && e.status === 403) return noAccessView();
  const msg = e instanceof Error ? e.message : 'Something went wrong. Try again.';
  show(h('h1', {}, 'Something went wrong'), errorBox(msg), h('button', { type: 'button', onclick: retry }, 'Try again'));
}

// ---------- list ----------

async function listView(cursor?: string): Promise<void> {
  show(h('h1', {}, 'Cases to review'), h('p', { 'aria-busy': 'true' }, 'Loading cases…'));
  try {
    const page = await listCases(cursor);
    const rows = page.items.map((c) =>
      h('tr', {},
        h('td', {}, h('a', { href: `#/cases/${encodeURIComponent(c.id)}` }, `Case ${c.id.slice(0, 8)}`)),
        h('td', {}, when(c.updatedAt)),
        h('td', {}, REASON_LABELS[c.reason ?? ''] ?? c.reason ?? ''),
        h('td', {}, c.unclear.map((u) => CHECK_LABELS[u] ?? u).join(', ') || 'None'),
      ),
    );
    show(
      h('h1', {}, 'Cases to review'),
      rows.length === 0
        ? h('p', {}, 'No cases are waiting for review.')
        : h('table', {},
            h('caption', {}, `${rows.length} Under-review case${rows.length === 1 ? '' : 's'}, newest first`),
            h('thead', {}, h('tr', {},
              h('th', { scope: 'col' }, 'Case'),
              h('th', { scope: 'col' }, 'Updated'),
              h('th', { scope: 'col' }, 'Why'),
              h('th', { scope: 'col' }, 'Unclear checks'),
            )),
            h('tbody', {}, ...rows),
          ),
      h('div', { class: 'row' },
        cursor ? h('button', { type: 'button', class: 'secondary', onclick: () => void listView() }, 'First page') : null,
        page.nextCursor
          ? h('button', { type: 'button', onclick: () => void listView(page.nextCursor) }, 'Next page')
          : null,
        h('button', { type: 'button', class: 'secondary', onclick: () => void listView(cursor) }, 'Refresh'),
      ),
    );
  } catch (e) {
    handleError(e, () => void listView(cursor));
  }
}

// ---------- detail ----------

function checksList(c: CaseView): HTMLElement {
  const entries = Object.entries(c.checks);
  if (entries.length === 0) return h('p', {}, 'No check results yet.');
  return h('dl', { class: 'grid' },
    ...entries.flatMap(([name, r]) => [
      h('dt', {}, CHECK_LABELS[name] ?? name),
      h('dd', { class: r }, RESULT_LABELS[r] ?? r),
    ]),
  );
}

function documentsList(docs: DocumentLink[]): HTMLElement {
  if (docs.length === 0) return h('p', {}, 'No documents uploaded.');
  return h('ul', {},
    ...docs.map((d) =>
      h('li', {},
        h('a', { href: d.url, target: '_blank', rel: 'noopener noreferrer' },
          `Open ${DOC_LABELS[d.kind] ?? d.kind}`, h('span', { class: 'visually-hidden' }, ' (opens in a new tab)')),
        ' ',
        h('span', { class: 'hint' }, `Link works until ${when(d.expiresAt)}. Reload the case for a new link.`),
      ),
    ),
  );
}

function historyTable(rows: HistoryRow[]): HTMLElement {
  if (rows.length === 0) return h('p', {}, 'No history yet.');
  return h('table', {},
    h('caption', {}, 'Audit trail, newest first'),
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col' }, 'When'),
      h('th', { scope: 'col' }, 'Who'),
      h('th', { scope: 'col' }, 'Action'),
      h('th', { scope: 'col' }, 'Status change'),
      h('th', { scope: 'col' }, 'Reason or note'),
    )),
    h('tbody', {},
      ...rows.map((r) => h('tr', {},
        h('td', {}, when(r.ts)),
        h('td', {}, r.actor),
        h('td', {}, r.action),
        h('td', {}, r.to ? `${r.from ?? '-'} to ${r.to}` : '-'),
        h('td', {}, r.note ?? ''),
      )),
    ),
  );
}

function decisionForm(c: CaseView): HTMLElement {
  const errorId = 'decision-error';
  const hintId = 'text-hint';
  const counterId = 'text-count';
  const error = h('div', { id: errorId, class: 'error', role: 'alert', hidden: true });
  const approve = h('input', { type: 'radio', name: 'action', id: 'action-approve', value: 'approve' });
  const reject = h('input', { type: 'radio', name: 'action', id: 'action-reject', value: 'reject' });
  const label = h('label', { for: 'decision-text' }, 'Note (optional)');
  const text = h('textarea', {
    id: 'decision-text', name: 'text', maxlength: REASON_MAX, 'aria-describedby': `${hintId} ${counterId}`,
  });
  const counter = h('span', { id: counterId, class: 'hint', 'aria-live': 'polite' }, `0 of ${REASON_MAX} characters`);
  const submit = h('button', { type: 'submit' }, 'Submit decision');

  const sync = () => {
    const isReject = reject.checked;
    label.textContent = isReject ? 'Reason (required)' : 'Note (optional)';
    text.required = isReject;
    submit.textContent = isReject ? 'Reject case' : approve.checked ? 'Approve case' : 'Submit decision';
  };
  approve.addEventListener('change', sync);
  reject.addEventListener('change', sync);
  text.addEventListener('input', () => {
    counter.textContent = `${text.value.length} of ${REASON_MAX} characters`;
  });

  const fail = (msg: string, focus: HTMLElement) => {
    error.textContent = msg;
    error.hidden = false;
    focus.setAttribute('aria-invalid', 'true');
    focus.setAttribute('aria-errormessage', errorId);
    focus.focus();
  };

  const form = h('form', { novalidate: true, 'aria-labelledby': 'decision-heading' },
    h('h2', { id: 'decision-heading' }, 'Decision'),
    error,
    h('fieldset', {},
      h('legend', {}, 'Choose an outcome'),
      h('label', { for: 'action-approve' }, approve, ' Approve: mark as Verified'),
      h('label', { for: 'action-reject' }, reject, ' Reject: mark as Rejected'),
    ),
    label,
    text,
    h('p', { id: hintId, class: 'hint' }, `Up to ${REASON_MAX} characters. Do not type PAN, Aadhaar or other ID numbers.`),
    counter,
    h('div', { class: 'row' }, submit, h('a', { href: '#/' }, 'Back to the list')),
  );

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    error.hidden = true;
    text.removeAttribute('aria-invalid');
    const t = text.value.trim();
    if (!approve.checked && !reject.checked) return fail('Choose Approve or Reject.', approve);
    if (reject.checked && t.length === 0) return fail('Enter a reason for the rejection.', text);
    if (t.length > REASON_MAX) return fail(`Keep it to ${REASON_MAX} characters.`, text);
    submit.disabled = true;
    const body = reject.checked
      ? { action: 'reject' as const, reason: t, version: c.version }
      : { action: 'approve' as const, version: c.version, ...(t ? { note: t } : {}) };
    decide(c.id, body)
      .then((r) => {
        announce(`Case ${r.case.status === 'verified' ? 'approved' : 'rejected'}.`);
        show(
          h('h1', {}, r.case.status === 'verified' ? 'Case approved' : 'Case rejected'),
          h('p', {}, `Case ${c.id.slice(0, 8)} is now ${r.case.status === 'verified' ? 'Verified' : 'Rejected'}. This was recorded in the audit trail.`),
          h('a', { href: '#/' }, 'Back to the list'),
        );
      })
      .catch((e: unknown) => {
        submit.disabled = false;
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return handleError(e, () => {});
        const msg = e instanceof Error ? e.message : 'Something went wrong. Try again.';
        fail(e instanceof ApiError && e.status === 409 ? `${msg} Use Reload case below.` : msg, submit);
      });
  });

  return h('section', {}, form, h('div', { class: 'row' },
    h('button', { type: 'button', class: 'secondary', onclick: () => void detailView(c.id) }, 'Reload case')));
}

async function detailView(id: string): Promise<void> {
  show(h('h1', {}, 'Case'), h('p', { 'aria-busy': 'true' }, 'Loading case…'));
  try {
    const d = await getCase(id);
    const c = d.case;
    show(
      h('p', {}, h('a', { href: '#/' }, 'Back to the list')),
      h('h1', {}, `Case ${c.id.slice(0, 8)}`),
      h('dl', { class: 'grid' },
        h('dt', {}, 'Status'), h('dd', {}, c.status),
        h('dt', {}, 'Path'), h('dd', {}, c.path ?? 'Not decided'),
        h('dt', {}, 'Why'), h('dd', {}, REASON_LABELS[c.reason ?? ''] ?? c.reason ?? ''),
        h('dt', {}, 'Updated'), h('dd', {}, when(c.updatedAt)),
        h('dt', {}, 'PAN'), h('dd', {}, c.masks.pan),
        h('dt', {}, 'Aadhaar'), h('dd', {}, c.masks.aadhaar),
      ),
      h('h2', {}, 'Check results'),
      checksList(c),
      h('h2', {}, 'Documents'),
      documentsList(d.documents),
      c.status === 'under-review' ? decisionForm(c) : h('p', {}, 'This case is no longer Under review, so it cannot be changed here.'),
      h('h2', {}, 'History'),
      historyTable(d.history),
    );
  } catch (e) {
    handleError(e, () => void detailView(id));
  }
}

// ---------- router ----------

function route(): void {
  const s = current();
  updateHeader();
  if (!s) return signedOutView();
  if (!s.groups.includes(REVIEWER)) return noAccessView();
  const m = /^#\/cases\/([A-Za-z0-9-]{1,64})$/.exec(location.hash);
  if (m && m[1]) void detailView(decodeURIComponent(m[1]));
  else void listView();
}

async function start(): Promise<void> {
  document.getElementById('signout')?.addEventListener('click', () => signOut());
  window.addEventListener('hashchange', route);
  try {
    await completeSignIn();
  } catch (e) {
    return signedOutView(e instanceof Error ? e.message : 'Sign-in failed. Try again.');
  }
  route();
}

void start();
