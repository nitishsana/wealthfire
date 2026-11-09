// Local test home (.kiro/specs/final-kyc-service/local-mode.md, "Local test home"):
// GET http://127.0.0.1:5181/ on the local server (STAGE=local only). One page to sign in to the
// app as each test investor (LOCAL_PERSONAS from packages/core), open the review console as the
// demo reviewer, reset local data, see which local servers are running and the latest DEMO codes.
// No script; one inline stylesheet allowed by its hash; every value is escaped.
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { LOCAL_PERSONAS, type LocalPersona } from '@wealthfire/core/src/localPersonas';
import type { RecentDemoCode } from './demo';
import { LOCAL_HOST } from './guard';

export const HOME_TITLE = 'Wealthfire local test home';

export interface PortStatus {
  label: string;
  port: number;
  running: boolean;
}

/** True when something accepts a TCP connection on 127.0.0.1:<port> within `timeoutMs`. */
export function isPortOpen(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((ok) => {
    const s = connect({ host: LOCAL_HOST, port });
    const done = (v: boolean): void => {
      s.removeAllListeners();
      s.destroy();
      ok(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const CSS = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1b1b1f; --muted: #50505a; --card: #f4f4f6; --line: #c9c9d1;
  --btn: #1f4e8c; --btn-fg: #ffffff; --focus: #b35c00; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #121216; --fg: #ececf1; --muted: #b4b4bf; --card: #1d1d24; --line: #3d3d48; --btn: #8fb8ff; --btn-fg: #0b0b10; --focus: #ffb366; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 64rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: 1.25rem; margin: 2rem 0 .75rem; }
h3 { font-size: 1.05rem; margin: 0 0 .25rem; }
p { margin: .25rem 0 .75rem; }
.muted { color: var(--muted); }
ul.cards { list-style: none; padding: 0; margin: 0; display: grid; gap: .75rem; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: .5rem; padding: .9rem; }
dl { display: grid; grid-template-columns: auto 1fr; gap: .1rem .6rem; margin: .5rem 0 .8rem; }
dt { color: var(--muted); }
dd { margin: 0; font-variant-numeric: tabular-nums; }
a.button { display: inline-block; background: var(--btn); color: var(--btn-fg); text-decoration: none; font-weight: 600;
  padding: .5rem .9rem; border-radius: .4rem; border: 2px solid transparent; }
a.button:hover { text-decoration: underline; }
a:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
table { border-collapse: collapse; }
th, td { text-align: left; padding: .3rem .9rem .3rem 0; border-bottom: 1px solid var(--line); }
.status { font-weight: 600; }
`;

const CSS_HASH = createHash('sha256').update(CSS, 'utf8').digest('base64');

/** Headers for the home page: no script at all, the one stylesheet by hash. */
export const HOME_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': `default-src 'none'; style-src 'sha256-${CSS_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

export interface HomeInput {
  appOrigin: string;
  consoleOrigin: string;
  resetPath: string;
  status: readonly PortStatus[];
  codes: readonly RecentDemoCode[];
  personas?: readonly LocalPersona[];
}

function personaCard(p: LocalPersona, appOrigin: string): string {
  // reader=demo&mode=match: the app's demo document reader, so one click also gets through Upload documents
  const href = `${appOrigin}/?persona=${encodeURIComponent(p.id)}&reader=demo&mode=match`;
  const hid = `persona-${esc(p.id)}`;
  return `<li class="card"><h3 id="${hid}">${esc(p.name)}</h3><p>${esc(p.tests)}</p>`
    + `<dl><dt>Mobile</dt><dd>${esc(p.mobile)}</dd><dt>PAN</dt><dd>${esc(p.pan)}</dd></dl>`
    + `<a class="button" href="${esc(href)}" aria-describedby="${hid}">Sign in as ${esc(p.name)}</a></li>`;
}

const time = (ms: number): string => new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

export function homePage(i: HomeInput): string {
  const personas = i.personas ?? LOCAL_PERSONAS;
  const status = i.status.map((s) =>
    `<tr><th scope="row">${esc(s.label)}</th><td>${esc(`${LOCAL_HOST}:${s.port}`)}</td>`
    + `<td class="status">${s.running ? 'Running' : 'Not running'}</td></tr>`).join('');
  const codes = i.codes.length === 0
    ? '<p class="muted">No DEMO codes yet. Send an OTP in the app and reload this page.</p>'
    : `<table><caption class="muted">Newest first</caption><thead><tr><th scope="col">Contact</th><th scope="col">DEMO code</th><th scope="col">Sent (IST)</th></tr></thead><tbody>`
      + i.codes.map((c) => `<tr><td>${esc(c.contact)}</td><td><strong>${esc(c.code)}</strong></td><td>${esc(time(c.at))}</td></tr>`).join('')
      + '</tbody></table>';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<meta name="robots" content="noindex"><title>${esc(HOME_TITLE)}</title><style>${CSS}</style></head><body><main>`
    + `<h1>${esc(HOME_TITLE)}</h1>`
    + '<p class="muted">Runs on this computer only. No SMS, email or real KYC partner is used. The test cases page opens with the launcher (Wealthfire Preview).</p>'
    + '<section aria-labelledby="h-investors"><h2 id="h-investors">Sign in to the app as a test investor</h2>'
    + '<p>Each button opens the app as that test user, with the mobile and details filled in.</p>'
    + `<ul class="cards">${personas.map((p) => personaCard(p, i.appOrigin)).join('')}</ul></section>`
    + '<section aria-labelledby="h-staff"><h2 id="h-staff">Staff</h2><p>Opens the review console signed in as the demo reviewer (no password, local only).</p>'
    + `<a class="button" href="${esc(`${i.consoleOrigin}/`)}">Sign in as demo reviewer</a></section>`
    + '<section aria-labelledby="h-server"><h2 id="h-server">Local server</h2>'
    + `<p><a class="button" href="${esc(i.resetPath)}">Reset local data</a></p>`
    + '<h3 id="h-status">Status</h3>'
    + `<table aria-labelledby="h-status"><thead><tr><th scope="col">Part</th><th scope="col">Address</th><th scope="col">Status</th></tr></thead><tbody>${status}</tbody></table>`
    + '<h3 id="h-codes">Latest DEMO codes</h3>'
    + codes
    + '</section></main></body></html>';
}
