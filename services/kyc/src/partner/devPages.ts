// R4: dev-only fake DigiLocker and e-sign pages, served by the api Lambda under /dev-partner/*
// (the router registers them ONLY when STAGE === 'dev'). On the dev stack the FakePartner sends
// users here instead of a real partner. A page shows the step, the tester picks an outcome, and
// the page sends the same signed webhook a real partner would (POST <API>/webhooks/partner, HMAC
// with the webhook secret), then returns the user to the app's return URL.
//
// Every link the FakePartner hands out carries a tag t = HMAC(webhook secret, kind|ref|user|return),
// so these pages only complete a step the API itself started, for that user, back to that
// return URL. Nothing here holds a PAN or full Aadhaar: the tester types only the last 4 digits.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DevPartnerHandler, DevPartnerRequest, DevPartnerResponse } from '../router';
import { ENV } from '../lib/env';
import { SIGNATURE_HEADER, signBody } from '../webhook/hmac';

/** Env var with the API's public base URL incl. stage, e.g. https://<id>.execute-api.ap-south-1.amazonaws.com/dev/ (src/lib/env.ts). */
export const API_BASE_URL_ENV = ENV.apiBaseUrl;
export const DEV_PARTNER_PREFIX = '/dev-partner';
/** How long the page waits for the webhook delivery. */
export const DELIVERY_TIMEOUT_MS = 5000;

export type DevStep = 'digilocker' | 'esign';

export interface DevPartnerDeps {
  /** the partner webhook secret (the same one the webhook Lambda verifies with) */
  webhookSecret: () => Promise<string>;
  /** where results are delivered: `${API_BASE_URL}/webhooks/partner` */
  webhookUrl: string;
  clock: { now(): number };
  /** injectable for tests; default global fetch with a 5 s timeout */
  send?: (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;
  newId?: () => string;
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const TAG_RE = /^[0-9a-f]{64}$/;

/** The string a link tag signs. */
export function linkPayload(step: DevStep, ref: string, userId: string, returnUrl: string): string {
  return `dev-partner-link\u0000${step}\u0000${ref}\u0000${userId}\u0000${returnUrl}`;
}

export function linkTag(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** FakePartnerOptions.linkSigner for the dev stack: tags links with the webhook secret. */
export function linkSignerFrom(secret: () => Promise<string>): (payload: string) => Promise<string> {
  return async (payload) => linkTag(await secret(), payload);
}

function tagOk(secret: string, payload: string, given: string): boolean {
  if (!TAG_RE.test(given)) return false;
  const a = Buffer.from(linkTag(secret, payload), 'hex');
  const b = Buffer.from(given, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Return URLs the pages will send a user back to (the KYC routes already allow-listed them). */
function safeReturn(v: string): string | null {
  if (v.length === 0 || v.length > 500) return null;
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' || u.protocol === 'wealthfire:') return v;
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return v;
  } catch {
    // not a URL
  }
  return null;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const HTML_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function page(status: number, title: string, inner: string, extraHead = ''): DevPartnerResponse {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="robots" content="noindex">${extraHead}<title>${esc(title)}</title></head>`
    + `<body><main><p><strong>Test page (dev only).</strong> This is not the real partner.</p><h1>${esc(title)}</h1>${inner}</main></body></html>`;
  return { status, headers: { ...HTML_HEADERS }, body };
}

const errorPage = (status: number, msg: string) => page(status, 'Cannot continue', `<p role="alert">${esc(msg)}</p>`);

export interface Link {
  ref: string;
  userId: string;
  returnUrl: string;
  tag: string;
}

function readLink(v: (k: string) => string | undefined): Link | null {
  const ref = v('ref') ?? '';
  const userId = v('u') ?? '';
  const ret = safeReturn(v('return') ?? '');
  const tag = v('t') ?? '';
  if (!ID_RE.test(ref) || !ID_RE.test(userId) || !ret || !TAG_RE.test(tag)) return null;
  return { ref, userId, returnUrl: ret, tag };
}

function hidden(l: Link): string {
  return [['ref', l.ref], ['u', l.userId], ['return', l.returnUrl], ['t', l.tag]]
    .map(([k, val]) => `<input type="hidden" name="${k}" value="${esc(val!)}">`).join('');
}

function radio(name: string, value: string, label: string, checked = false): string {
  const id = `${name}-${value}`;
  return `<p><input type="radio" id="${id}" name="${name}" value="${value}"${checked ? ' checked' : ''}> <label for="${id}">${esc(label)}</label></p>`;
}

const STEP_TITLE: Record<DevStep, string> = { digilocker: 'Fake DigiLocker', esign: 'Fake e-sign' };

function form(step: DevStep, l: Link): string {
  const choices = step === 'digilocker'
    ? radio('outcome', 'verified', 'Share Aadhaar: verified', true)
      + `<p><label for="last4">Last 4 digits of Aadhaar</label> <input id="last4" name="last4" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" required aria-describedby="last4-hint"></p>`
      + `<p id="last4-hint">Use the same last 4 digits typed in the app, or different ones to test a mismatch.</p>`
      + radio('outcome', 'not-verified', 'Aadhaar not verified (goes to a person)')
      + radio('outcome', 'timeout', 'Partner timeout')
    : radio('outcome', 'done', 'Sign the KYC form', true)
      + radio('outcome', 'failed', 'Signing failed')
      + radio('outcome', 'expired', 'Session expired')
      + radio('outcome', 'timeout', 'Partner timeout');
  return `<form method="post" action="${step}"><fieldset><legend>Choose the result</legend>${choices}</fieldset>`
    + `${hidden(l)}<p><button type="submit">Send result</button></p></form>`;
}

/** The webhook event a real partner would send for this outcome; null for an unknown outcome. */
export function eventFor(step: DevStep, outcome: string, last4: string | undefined, l: Link, id: string, now: number): Record<string, unknown> | null {
  const base = { id, timestamp: now, occurredAt: now, userId: l.userId, ref: l.ref };
  if (step === 'digilocker') {
    if (outcome === 'verified') {
      if (!last4 || !/^\d{4}$/.test(last4)) return null;
      return { ...base, type: 'kyc.result', data: { check: 'aadhaar', verified: true, last4 } };
    }
    if (outcome === 'not-verified') return { ...base, type: 'kyc.result', data: { check: 'aadhaar', verified: false } };
    if (outcome === 'timeout') return { ...base, type: 'kyc.result', data: { check: 'aadhaar', timeout: true } };
    return null;
  }
  if (outcome === 'done' || outcome === 'failed' || outcome === 'expired' || outcome === 'timeout') {
    return { ...base, type: 'esign.completed', data: { status: outcome } };
  }
  return null;
}

async function defaultSend(url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }): Promise<{ status: number }> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS), redirect: 'error' });
  return { status: r.status };
}

function showPage(step: DevStep, deps: DevPartnerDeps): DevPartnerHandler {
  return async (req: DevPartnerRequest) => {
    const l = readLink((k) => req.query?.[k]);
    if (!l) return errorPage(400, 'This link is not complete. Start the step again in the app.');
    if (!tagOk(await deps.webhookSecret(), linkPayload(step, l.ref, l.userId, l.returnUrl), l.tag)) {
      return errorPage(403, 'This link was not issued by the Wealthfire API. Start the step again in the app.');
    }
    return page(200, STEP_TITLE[step], form(step, l));
  };
}

function submitPage(step: DevStep, deps: DevPartnerDeps): DevPartnerHandler {
  return async (req: DevPartnerRequest) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    if (raw.length > 4096) return errorPage(400, 'That request is too large.');
    const f = new URLSearchParams(raw);
    const l = readLink((k) => f.get(k) ?? undefined);
    if (!l) return errorPage(400, 'This form is not complete. Start the step again in the app.');
    const secret = await deps.webhookSecret();
    if (!tagOk(secret, linkPayload(step, l.ref, l.userId, l.returnUrl), l.tag)) {
      return errorPage(403, 'This link was not issued by the Wealthfire API. Start the step again in the app.');
    }
    const now = deps.clock.now();
    const event = eventFor(step, f.get('outcome') ?? '', f.get('last4') ?? undefined, l, `devp_${(deps.newId ?? randomUUID)()}`, now);
    if (!event) return errorPage(400, 'Choose a result (and type 4 digits for a verified Aadhaar).');
    const body = JSON.stringify(event);
    let status = 0;
    try {
      ({ status } = await (deps.send ?? defaultSend)(deps.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: `sha256=${signBody(secret, body)}` },
        body,
      }));
    } catch {
      status = 0;
    }
    if (status < 200 || status >= 300) {
      return errorPage(502, 'The result could not be delivered to the webhook. Go back and try again.');
    }
    const href = esc(l.returnUrl);
    return page(
      200,
      'Result sent',
      `<p>The result was sent to Wealthfire.</p><p><a href="${href}">Return to Wealthfire</a></p>`,
      `<meta http-equiv="refresh" content="1;url=${href}">`,
    );
  };
}

/**
 * Route map for the router (keys 'METHOD /dev-partner/...'). Register ONLY on STAGE=dev: the
 * router ignores it on any other stage.
 */
export function devPartnerRoutes(deps: DevPartnerDeps): Record<string, DevPartnerHandler> {
  return {
    [`GET ${DEV_PARTNER_PREFIX}/digilocker`]: showPage('digilocker', deps),
    [`POST ${DEV_PARTNER_PREFIX}/digilocker`]: submitPage('digilocker', deps),
    [`GET ${DEV_PARTNER_PREFIX}/esign`]: showPage('esign', deps),
    [`POST ${DEV_PARTNER_PREFIX}/esign`]: submitPage('esign', deps),
  };
}
