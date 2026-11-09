// Local mode server (.kiro/specs/final-kyc-service/local-mode.md): the SAME createRouter, KYC
// service, review routes, webhook handler and fake partner pages as the Lambda, wired with local
// adapters and no AWS:
//   stores      memory stores saved to <dataDir>/state.json (src/local/state.ts)
//   keys        <dataDir>/keys.json, generated once (LocalEncryptor, LocalMacSigner, token key, ...)
//   partner     FakePartner, links to <api>/dev-partner/... (tagged), webhook delivered in-process
//               through the real webhook handler with a real HMAC signature
//   uploads     <api>/local-files/<key> signed URLs, files in <dataDir>/files (src/local/files.ts)
//   OTP         LocalDemoSender: nothing is sent; `demoCode` in the send answer, code in the window
//   staff       `Bearer local-demo-reviewer` only
//   reset       GET/POST <api>/local/reset
// Binds 127.0.0.1 only; refuses any stage but 'local'. Two listeners: the API and the review
// console (its built dist + a generated /config.json).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { LOCAL_PERSONAS } from '@wealthfire/core/src/localPersonas';
import { OtpService } from '../auth/otp';
import { PERSONA_HEADER } from '../auth/routes';
import { loadConfig } from '../config';
import { systemClock, type Clock } from '../lib/clock';
import { Argon2Hasher, LocalEncryptor, LocalMacSigner } from '../lib/crypto';
import type { AuthMetrics } from '../lib/metrics';
import { memoryRepos } from '../lib/repo';
import { returnUrlPrefixesFromEnv } from '../lib/returnUrl';
import { LocalTokenSigner, TokenService } from '../lib/tokens';
import { ConsoleLogger, type Logger } from '../kyc/log';
import { memoryKycRepos } from '../kyc/repo';
import { kycRoutes } from '../kyc/routes';
import { DEFAULT_DOCS_PREFIX, KycService } from '../kyc/service';
import { DEV_PARTNER_PREFIX, devPartnerRoutes, linkSignerFrom } from '../partner/devPages';
import { FakePartner } from '../partner/fake';
import { reviewRoutes } from '../review/routes';
import { createRouter, type HttpRequest } from '../router';
import { reviewCaseStore, webhookCaseStore } from '../store/views';
import { handleWebhook, type WebhookDeps } from '../webhook/handler';
import { HmacWebhookVerifier } from '../webhook/hmac';
import { MemorySeenEventStore } from '../webhook/memory';
import { LocalDemoSender, LocalDemoStaffVerifier } from './demo';
import { LOCAL_FILES_PATH, LocalFileStore, type LocalFileResponse } from './files';
import { assertLocalStage, assertLoopbackHost, LOCAL_HOST } from './guard';
import { HOME_HEADERS, homePage, isPortOpen } from './home';
import { LocalStatePersister, loadOrCreateKeys, STATE_FILE } from './state';

export const DEFAULT_API_PORT = 5181;
export const DEFAULT_CONSOLE_PORT = 5182;
export const DEFAULT_APP_ORIGIN = `http://${LOCAL_HOST}:5180`;
export const RESET_PATH = '/local/reset';
/** the Local test home */
export const HOME_PATH = '/';
export const WEBHOOK_PATH = '/webhooks/partner';
/** Largest JSON request read (the router itself refuses > 16 KB with 413). */
const MAX_JSON_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** The review console's runtime config (served as <console>/config.json). */
export interface LocalConsoleConfig {
  apiUrl: string;
  localDemo: true;
}

export interface LocalAppOptions {
  stage: string | undefined;
  /** `.local-data` folder (state.json, keys.json, files/) */
  dataDir: string;
  /** this server's API origin, e.g. http://127.0.0.1:5181 */
  apiOrigin: string;
  /** the review console origin, e.g. http://127.0.0.1:5182 */
  consoleOrigin: string;
  /** the web app origin (Vite localkyc), default http://127.0.0.1:5180 */
  appOrigin?: string;
  /** the review console's built dist folder */
  consoleDist: string;
  /** where DEMO codes and notices go (default console.log) */
  print?: (line: string) => void;
  /** request log (default ConsoleLogger: JSON lines, scrubbed) */
  logger?: Logger;
  clock?: Clock;
}

const noMetrics: AuthMetrics = { otpFailure: () => undefined };

/** True when a review console dist is a local build (`build.mjs --local`: config.json with localDemo: true). */
export function hasLocalConsoleBuild(dist: string): boolean {
  const file = join(dist, 'config.json');
  if (!existsSync(file) || !existsSync(join(dist, 'index.html'))) return false;
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { localDemo?: unknown }).localDemo === true;
  } catch {
    return false;
  }
}

export interface LocalApp {
  handleApi(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleConsole(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** wipes state and files (keeps keys.json) */
  reset(): void;
  consoleConfig: LocalConsoleConfig;
  files: LocalFileStore;
  partner: FakePartner;
}

export function createLocalApp(o: LocalAppOptions): LocalApp {
  assertLocalStage(o.stage);
  const stage = o.stage;
  const print = o.print ?? ((l: string) => console.log(l));
  const clock = o.clock ?? systemClock;
  const dataDir = resolve(o.dataDir);
  const api = o.apiOrigin.replace(/\/+$/, '');
  const appOrigin = (o.appOrigin ?? DEFAULT_APP_ORIGIN).replace(/\/+$/, '');
  const consoleOrigin = o.consoleOrigin.replace(/\/+$/, '');
  for (const u of [api, appOrigin, consoleOrigin]) {
    const url = new URL(u);
    if (url.protocol !== 'http:' || url.hostname !== LOCAL_HOST) throw new Error('local mode origins must be http://127.0.0.1:<port>');
  }
  const env = { STAGE: stage, RETURN_URL_PREFIXES: `${appOrigin}/,wealthfire://kyc-return`, API_BASE_URL: `${api}/` };

  const keys = loadOrCreateKeys(dataDir);
  const mac = new LocalMacSigner(keys.mac);
  const encryptor = new LocalEncryptor(keys.field);
  const authRepos = memoryRepos();
  const repos = memoryKycRepos();
  const seen = new MemorySeenEventStore();
  const tokens = new TokenService({ sessions: authRepos.sessions, signer: new LocalTokenSigner('local', keys.jwt), clock });
  const sender = new LocalDemoSender(stage, print, () => clock.now());
  const otp = new OtpService({ repos: authRepos, clock, mac, encryptor, hasher: new Argon2Hasher(), sender, tokens, metrics: noMetrics });
  const files = new LocalFileStore({ dir: join(dataDir, 'files'), baseUrl: api, key: keys.files, clock });
  const config = loadConfig(env);
  const secret = async (): Promise<string> => keys.webhook;

  const webhookDeps: WebhookDeps = {
    verifier: new HmacWebhookVerifier(keys.webhook),
    cases: webhookCaseStore(repos.cases),
    audit: repos.audit,
    seen,
    config,
    clock,
  };
  // the dev pages post their signed result straight into the real webhook handler (no network)
  const devPartner = devPartnerRoutes({
    webhookSecret: secret,
    webhookUrl: `${api}${WEBHOOK_PATH}`,
    clock,
    send: async (_url, init) => ({ status: (await handleWebhook({ body: init.body, headers: init.headers }, webhookDeps)).status }),
  });
  const partner = new FakePartner({ baseUrl: `${api}${DEV_PARTNER_PREFIX}`, linkSigner: linkSignerFrom(secret) });
  const kyc = new KycService({
    repos, partner, uploads: files, encryptor, mac, clock, config,
    returnUrlPrefixes: returnUrlPrefixesFromEnv(env), docsPrefix: DEFAULT_DOCS_PREFIX,
  });
  const review = reviewRoutes({
    cases: reviewCaseStore(repos.cases),
    audit: repos.audit,
    docKey: (userId, uploadId) => kyc.docKey(userId, uploadId),
    linkDocuments: (userId) => kyc.linkDocuments(userId),
    signer: files,
    clock,
    onApproved: async (userId) => void (await kyc.uploadToKra(userId)),
  });
  const allowed = [appOrigin, consoleOrigin];
  const router = createRouter({
    auth: { otp, tokens, clock, demo: sender, personaIds: LOCAL_PERSONAS.map((p) => p.id) },
    tokens,
    kyc: kycRoutes(kyc),
    review,
    staff: new LocalDemoStaffVerifier(stage),
    allowedOrigins: allowed,
    appOrigins: [appOrigin],
    logger: o.logger ?? new ConsoleLogger(),
    clock,
    stage,
    devPartner,
  });

  const persister = new LocalStatePersister(join(dataDir, STATE_FILE), {
    users: { obj: authRepos.users, fields: ['byId', 'byContact'] },
    sessions: { obj: authRepos.sessions, fields: ['sessions', 'families'] },
    otp: { obj: authRepos.otp, fields: ['challenges', 'logs'] },
    cases: { obj: repos.cases, fields: ['items', 'pans', 'archived'] },
    audit: { obj: repos.audit, fields: ['rows'] },
    idempotency: { obj: repos.idempotency, fields: ['items'] },
    costs: { obj: repos.costs, fields: ['rows', 'counters'] },
    consents: { obj: repos.consents, fields: ['rows'] },
    webhookEvents: { obj: seen, fields: ['items'] },
    partner: { obj: partner, fields: ['refOwner', 'seq'] },
  });
  const loaded = persister.load();
  if (loaded === 'moved-aside') print(`Local data in ${STATE_FILE} could not be read; it was moved aside and the server starts empty.`);

  const reset = (): void => {
    persister.clear();
    files.wipe();
    sender.clear();
  };

  const consoleConfig: LocalConsoleConfig = { apiUrl: api, localDemo: true };

  // ---------- API listener ----------

  const corsFor = (origin: string | undefined): Record<string, string> =>
    origin && allowed.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};

  async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', api);
      const method = (req.method ?? 'GET').toUpperCase();
      const query = Object.fromEntries(url.searchParams.entries());
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

      if (url.pathname.startsWith(LOCAL_FILES_PATH)) {
        let key: string;
        try {
          key = decodeURIComponent(url.pathname.slice(LOCAL_FILES_PATH.length));
        } catch {
          return sendFile(res, { status: 400, headers: {}, body: '' }, corsFor(origin));
        }
        if (method === 'OPTIONS') {
          return sendFile(res, {
            status: 204,
            headers: {
              'access-control-allow-methods': 'PUT, GET, OPTIONS',
              'access-control-allow-headers': 'content-type, x-amz-tagging, if-none-match',
              'access-control-max-age': '600',
            },
            body: '',
          }, corsFor(origin));
        }
        if (method === 'PUT') {
          const body = await readBody(req, MAX_FILE_BYTES);
          if (!body) return sendFile(res, { status: 413, headers: {}, body: '' }, corsFor(origin));
          return sendFile(res, files.handlePut(key, query, req.headers, body), corsFor(origin));
        }
        if (method === 'GET') return sendFile(res, files.handleGet(key, query), corsFor(origin));
        return sendFile(res, { status: 405, headers: {}, body: '' }, corsFor(origin));
      }

      if (url.pathname === HOME_PATH && (method === 'GET' || method === 'HEAD')) {
        const port = (origin: string): number => Number(new URL(origin).port);
        const parts: [string, number][] = [['App (web)', port(appOrigin)], ['Local KYC server', port(api)], ['Review console', port(consoleOrigin)]];
        const status = await Promise.all(parts.map(async ([label, p]) => ({ label, port: p, running: await isPortOpen(p) })));
        const html = homePage({ appOrigin, consoleOrigin, resetPath: RESET_PATH, status, codes: sender.recent() });
        res.writeHead(200, { ...HOME_HEADERS });
        res.end(method === 'HEAD' ? undefined : html);
        return;
      }

      if (url.pathname === RESET_PATH) {
        if (method === 'GET') return sendHtml(res, 200, resetPage());
        if (method === 'POST') {
          // a form on this page only: a cross-site post carries another Origin
          if (origin !== undefined && origin !== api) return sendHtml(res, 403, page('Not allowed', '<p role="alert">Open the reset page on this server to reset.</p>'));
          await readBody(req, MAX_JSON_BYTES);
          reset();
          print('Local data cleared.');
          return sendHtml(res, 200, page('Local data cleared.', `<p>Local data cleared.</p><p><a href="${RESET_PATH}">Back</a></p>`));
        }
        return sendHtml(res, 405, page('Not allowed', '<p>Use the button on the reset page.</p>'));
      }

      if (url.pathname === WEBHOOK_PATH && method === 'POST') {
        const body = await readBody(req, MAX_JSON_BYTES);
        const r = body
          ? await handleWebhook({ body: body.toString('utf8'), headers: flatHeaders(req) }, webhookDeps)
          : { status: 400, body: { error: 'malformed' } };
        persister.save();
        res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(r.body));
        return;
      }

      const raw = await readBody(req, MAX_JSON_BYTES);
      if (!raw) {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsFor(origin) });
        res.end(JSON.stringify({ error: 'payload_too_large', message: 'That request is too large.' }));
        return;
      }
      const hreq: HttpRequest = {
        method,
        path: url.pathname,
        headers: flatHeaders(req),
        query,
        ...(raw.length > 0 ? { body: raw.toString('utf8') } : {}),
        ip: req.socket.remoteAddress ?? 'unknown',
      };
      const out = await router(hreq);
      persister.save();
      const headers: Record<string, string | string[]> = { ...out.headers };
      // local only: the web app's test-user header (never on the online router / infra list)
      if (method === 'OPTIONS' && typeof headers['access-control-allow-headers'] === 'string') {
        headers['access-control-allow-headers'] = `${headers['access-control-allow-headers']}, ${PERSONA_HEADER}`;
      }
      if (out.cookies.length) headers['set-cookie'] = out.cookies;
      res.writeHead(out.statusCode, headers);
      res.end(out.body);
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'internal', message: 'Something went wrong. Try again.' }));
    }
  }

  // ---------- console listener ----------

  async function handleConsole(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
      return;
    }
    let path: string;
    try {
      path = new URL(req.url ?? '/', consoleOrigin).pathname;
    } catch {
      path = '/';
    }
    const base = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
    const dist = resolve(o.consoleDist);
    // `build.mjs --local` writes dist/config.json itself (served as-is below); this is only the
    // fallback when a dist has none
    if (path === '/config.json' && !existsSync(join(dist, 'config.json'))) {
      res.writeHead(200, { ...base, 'content-type': 'application/json; charset=utf-8' });
      res.end(method === 'HEAD' ? undefined : JSON.stringify(consoleConfig));
      return;
    }
    const name = path === '/' ? 'index.html' : path.slice(1);
    // only a plain file name that is actually in dist (no folders, no traversal)
    const ok = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(name) && existsSync(dist) && readdirSync(dist).includes(name);
    if (!ok) {
      if (!existsSync(join(dist, 'index.html'))) {
        res.writeHead(503, { ...base, 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Review console not built', '<p>Build it first: <code>node services/kyc/review-console/build.mjs</code>, then restart the preview.</p>'));
        return;
      }
      res.writeHead(404, { ...base, 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = /\.([a-z0-9]+)$/.exec(name)?.[1] ?? '';
    const types: Record<string, string> = {
      html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
      svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon',
    };
    res.writeHead(200, { ...base, 'content-type': types[ext] ?? 'application/octet-stream' });
    res.end(method === 'HEAD' ? undefined : readFileSync(join(dist, name)));
  }

  return { handleApi, handleConsole, reset, consoleConfig, files, partner };
}

// ---------- HTTP helpers ----------

/** The request body, or null when it is larger than `max` bytes. */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) over = true;
      else if (!over) chunks.push(c);
    });
    req.on('end', () => ok(over ? null : Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

function flatHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

function sendFile(res: ServerResponse, r: LocalFileResponse, cors: Record<string, string>): void {
  res.writeHead(r.status, { ...r.headers, ...cors });
  res.end(r.body);
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>${esc(title)}</title></head>`
    + `<body><main><p><strong>Wealthfire local KYC server</strong> (this computer only)</p><h1>${esc(title)}</h1>${inner}</main></body></html>`;
}

function resetPage(): string {
  return page('Reset local data', '<p>This deletes every local test user, KYC case, consent, audit row and uploaded file. The local keys are kept.</p>'
    + `<form method="post" action="${RESET_PATH}"><button type="submit">Reset local data</button></form>`);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(html);
}

// ---------- server ----------

export interface StartOptions extends Omit<LocalAppOptions, 'apiOrigin' | 'consoleOrigin'> {
  host?: string;
  /** 0 = a free port (tests) */
  apiPort?: number;
  consolePort?: number;
}

export interface RunningLocalServer {
  /** the Local test home (`<api>/`) */
  homeUrl: string;
  apiUrl: string;
  consoleUrl: string;
  resetUrl: string;
  app: LocalApp;
  close(): Promise<void>;
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      ok((server.address() as AddressInfo).port);
    });
  });
}

const closeServer = (s: Server): Promise<void> => new Promise((ok) => {
  s.closeAllConnections?.();
  s.close(() => ok());
});

/** Starts both listeners on 127.0.0.1 (refuses any other host or stage). */
export async function startLocalServer(o: StartOptions): Promise<RunningLocalServer> {
  const host = o.host ?? LOCAL_HOST;
  assertLoopbackHost(host);
  assertLocalStage(o.stage);
  let app: LocalApp | null = null;
  const notReady = (res: ServerResponse): void => {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Starting');
  };
  const apiServer = createServer((req, res) => void (app ? app.handleApi(req, res) : notReady(res)));
  const consoleServer = createServer((req, res) => void (app ? app.handleConsole(req, res) : notReady(res)));
  try {
    const apiPort = await listen(apiServer, host, o.apiPort ?? DEFAULT_API_PORT);
    const consolePort = await listen(consoleServer, host, o.consolePort ?? DEFAULT_CONSOLE_PORT);
    const apiUrl = `http://${host}:${apiPort}`;
    const consoleUrl = `http://${host}:${consolePort}`;
    app = createLocalApp({ ...o, apiOrigin: apiUrl, consoleOrigin: consoleUrl });
    return {
      homeUrl: `${apiUrl}${HOME_PATH}`,
      apiUrl,
      consoleUrl,
      resetUrl: `${apiUrl}${RESET_PATH}`,
      app,
      close: async () => {
        await Promise.all([closeServer(apiServer), closeServer(consoleServer)]);
      },
    };
  } catch (e) {
    await Promise.all([closeServer(apiServer), closeServer(consoleServer)]);
    throw e;
  }
}
