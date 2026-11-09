// Cognito Hosted UI sign-in: authorization code flow with PKCE (S256). MFA is enforced by the
// user pool. Tokens live in memory only (this module's variables): a reload means signing in
// again, which the Hosted UI session makes quick. Only the one-time PKCE verifier and state are
// kept in sessionStorage, because they must survive the redirect; both are removed on return.
// Local test mode (config.localDemo, loopback only) skips Cognito: "Sign in as demo reviewer"
// makes an in-memory session whose token is the fixed LOCAL_DEMO_TOKEN, which only the local KYC
// server (STAGE=local) accepts.
import { config, isLocalDemo } from './config';

/** The bearer value the local KYC server accepts as reviewer `demo-reviewer`. */
export const LOCAL_DEMO_TOKEN = 'local-demo-reviewer';

export interface Session {
  idToken: string;
  /** cognito sub */
  sub: string;
  email: string;
  groups: string[];
  /** epoch ms */
  expiresAt: number;
}

const PKCE_KEY = 'wf-review-pkce';
let session: Session | null = null;

function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(n = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(n)));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Reads claims for display / expiry only. The API gateway verifies the signature. */
function claims(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('bad token');
  const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

export async function signIn(): Promise<never> {
  const verifier = randomString(48);
  const state = randomString(16);
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
  const url = new URL('/oauth2/authorize', config.cognitoDomain);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid email',
    state,
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
  }).toString();
  location.assign(url.toString());
  return new Promise<never>(() => {});
}

/**
 * Finishes a Hosted UI redirect if the URL carries `code` + `state`. Returns the new session,
 * null when there is nothing to finish. Throws on a state mismatch or a failed exchange.
 */
export async function completeSignIn(): Promise<Session | null> {
  if (isLocalDemo()) return null;
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  if (!code && !error) return null;
  const saved = sessionStorage.getItem(PKCE_KEY);
  sessionStorage.removeItem(PKCE_KEY);
  // Drop code/state from the address bar and history.
  history.replaceState(null, '', location.pathname + location.hash);
  if (error) throw new Error('Sign-in was cancelled or failed.');
  const pkce = saved ? (JSON.parse(saved) as { verifier: string; state: string }) : null;
  if (!pkce || pkce.state !== state) throw new Error('Sign-in could not be verified. Try again.');

  const res = await fetch(new URL('/oauth2/token', config.cognitoDomain), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code: code as string,
      redirect_uri: config.redirectUri,
      code_verifier: pkce.verifier,
    }),
  });
  if (!res.ok) throw new Error('Sign-in failed. Try again.');
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error('Sign-in failed. Try again.');
  session = toSession(tokens.id_token);
  return session;
}

function toSession(idToken: string): Session {
  const c = claims(idToken);
  const groups = Array.isArray(c['cognito:groups']) ? (c['cognito:groups'] as unknown[]).filter((g): g is string => typeof g === 'string') : [];
  return {
    idToken,
    sub: String(c.sub ?? ''),
    email: String(c.email ?? ''),
    groups,
    expiresAt: Number(c.exp ?? 0) * 1000,
  };
}

/** The live session, or null when signed out or expired. */
export function current(): Session | null {
  if (session && Date.now() >= session.expiresAt - 30_000) session = null;
  return session;
}

export function forget(): void {
  session = null;
}

/** Local test mode only: signs in as the demo reviewer, no password. */
export function signInDemo(): Session {
  if (!isLocalDemo()) throw new Error('Demo sign-in is only for local test mode.');
  session = {
    idToken: LOCAL_DEMO_TOKEN,
    sub: 'demo-reviewer',
    email: 'Demo reviewer',
    groups: ['reviewer'],
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  return session;
}

/**
 * Ends the session. Online this redirects to the Cognito logout page; in local test mode it only
 * clears the session (returns false) so the caller shows the sign-in button again.
 */
export function signOut(): boolean {
  session = null;
  if (isLocalDemo()) return false;
  const url = new URL('/logout', config.cognitoDomain);
  url.search = new URLSearchParams({ client_id: config.clientId, logout_uri: config.logoutUri }).toString();
  location.assign(url.toString());
  return true;
}
