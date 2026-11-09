// Config, baked in at build time by build.mjs via esbuild `define`. No secrets: the Cognito app
// client is public (PKCE, no client secret).
//
// Local test mode (`localDemo: true`, built with `build.mjs --local`): the console shows "Sign in
// as demo reviewer" instead of Cognito and sends `Bearer local-demo-reviewer`. Such a build also
// reads `config.json` beside index.html at start (the local KYC server writes it), so the API
// address can be set at run time. Demo mode only ever runs on a loopback page with a loopback API;
// anything else falls back to the normal Cognito sign-in. Normal (online) builds never fetch
// config.json, so their CSP and behaviour are unchanged.
export interface ConsoleConfig {
  apiUrl: string;
  /** empty in local test mode */
  cognitoDomain: string;
  /** empty in local test mode */
  clientId: string;
  /** empty in local test mode */
  redirectUri: string;
  /** empty in local test mode */
  logoutUri: string;
  /** local test mode: demo reviewer sign-in, no Cognito. Loopback only. */
  localDemo?: boolean;
}

declare const __CONFIG__: ConsoleConfig;

/** The live config. Starts as the baked config; `loadRuntimeConfig` may update it in local mode. */
export const config: ConsoleConfig = { ...__CONFIG__ };

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopbackUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Local test mode is on only when asked for AND both the page and the API are on this computer. */
export function localDemoAllowed(c: ConsoleConfig, pageHostname: string): boolean {
  return c.localDemo === true && LOOPBACK_HOSTS.has(pageHostname) && isLoopbackUrl(c.apiUrl);
}

export function isLocalDemo(): boolean {
  return localDemoAllowed(config, typeof location === 'undefined' ? '' : location.hostname);
}

const KNOWN = ['apiUrl', 'cognitoDomain', 'clientId', 'redirectUri', 'logoutUri', 'localDemo'];

/**
 * Checks a runtime config.json against the baked config. Only `apiUrl` and `localDemo` may be set
 * at run time, `localDemo` must stay true, and the API origin must be the one the build's CSP
 * allows (the baked apiUrl origin). Returns the merged config or an error message.
 */
export function mergeRuntimeConfig(baked: ConsoleConfig, raw: unknown): { config: ConsoleConfig } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'config.json is not a JSON object.' };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!KNOWN.includes(k)) return { error: `config.json: ${k} is not a known field.` };
  }
  if (r.localDemo !== undefined && r.localDemo !== true) return { error: 'config.json: this build is for local test mode only (localDemo must be true).' };
  const next: ConsoleConfig = { ...baked };
  if (r.apiUrl !== undefined) {
    if (typeof r.apiUrl !== 'string' || !isLoopbackUrl(r.apiUrl)) return { error: 'config.json: apiUrl must be a 127.0.0.1 or localhost address.' };
    if (new URL(r.apiUrl).origin !== new URL(baked.apiUrl).origin) {
      return { error: `config.json: apiUrl ${new URL(r.apiUrl).origin} is not allowed by this build. Rebuild with that apiUrl.` };
    }
    next.apiUrl = r.apiUrl;
  }
  return { config: next };
}

/**
 * Local test mode builds only: reads config.json beside index.html. A missing file keeps the
 * baked config. Returns an error message for a file that is there but not usable.
 */
export async function loadRuntimeConfig(): Promise<string | null> {
  if (__CONFIG__.localDemo !== true) return null;
  let res: Response;
  try {
    res = await fetch('config.json', { cache: 'no-store', credentials: 'same-origin' });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return 'config.json could not be read.';
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return 'config.json is not valid JSON.';
  }
  const merged = mergeRuntimeConfig(__CONFIG__, raw);
  if ('error' in merged) return merged.error;
  Object.assign(config, merged.config);
  return null;
}
