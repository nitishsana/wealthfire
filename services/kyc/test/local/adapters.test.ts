import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/lib/clock';
import { LocalEncryptor } from '../../src/lib/crypto';
import { LocalTokenSigner, signAccessToken, verifyAccessToken } from '../../src/lib/tokens';
import { CognitoStaffVerifier } from '../../src/kyc/staff';
import { PENDING_TAGGING, signedPutHeaders } from '../../src/kyc/uploads';
import { hasLocalConsoleBuild, resetAllowed } from '../../src/local/app';
import {
  DEMO_REVIEWER_HEADER, DEMO_REVIEWER_TOKEN, LocalDemoSender, LocalDemoStaffVerifier, maskContact,
} from '../../src/local/demo';
import { LocalFileStore, safeKey } from '../../src/local/files';
import { atomicWrite, loadOrCreateKeys, LocalStatePersister, KEYS_FILE } from '../../src/local/state';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wf-kyc-local-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 9, 9, 9, 9]);
const KEY = 'kyc/user-1/selfie-00000000-0000-4000-8000-000000000000.jpg';

function store(clock = new FakeClock()) {
  const dir = tmp();
  const files = new LocalFileStore({ dir: join(dir, 'files'), baseUrl: 'http://127.0.0.1:5181/', key: new Uint8Array(32).fill(7), clock });
  return { files, clock, dir };
}

async function signed(files: LocalFileStore, size = JPEG.length, key = KEY) {
  const s = await files.signPut({ key, contentType: 'image/jpeg', contentLength: size, expiresInSec: 300 });
  const u = new URL(s.url);
  return { s, u, query: Object.fromEntries(u.searchParams.entries()), path: decodeURIComponent(u.pathname.slice('/local-files/'.length)) };
}

describe('LocalFileStore (signed local upload / download URLs)', () => {
  it('signs a PUT URL on the local server with the same headers as the S3 signer', async () => {
    const { files } = store();
    const { s, u, path } = await signed(files);
    expect(u.origin).toBe('http://127.0.0.1:5181');
    expect(u.pathname).toBe(`/local-files/${KEY}`);
    expect([...u.searchParams.keys()].sort()).toEqual(['exp', 'sig']);
    expect(path).toBe(KEY);
    expect(s.headers).toEqual(signedPutHeaders({ contentType: 'image/jpeg', contentLength: JPEG.length }));
    expect(s.headers['x-amz-tagging']).toBe(PENDING_TAGGING);
    expect(s.headers['if-none-match']).toBe('*');
  });

  it('PUT stores the file + a pending tag sidecar; the type check reads it; no overwrite (412)', async () => {
    const { files } = store();
    const { s, query, path } = await signed(files);
    expect(await files.exists(KEY)).toBe(false);
    expect(await files.readStart(KEY, 4)).toBeNull();
    const r = files.handlePut(path, query, s.headers, JPEG);
    expect(r.status).toBe(200);
    expect(await files.exists(KEY)).toBe(true);
    expect([...(await files.readStart(KEY, 3))!]).toEqual([0xff, 0xd8, 0xff]);
    expect(files.stateOf(KEY)).toBe('pending');
    // if-none-match: * honoured
    const again = files.handlePut(path, query, s.headers, Buffer.from(JPEG).fill(1, 3));
    expect(again.status).toBe(412);
    expect([...(await files.readStart(KEY, 4))!]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    await files.setState(KEY, 'linked');
    expect(files.stateOf(KEY)).toBe('linked');
    expect(files.keys()).toEqual([KEY]);
  });

  it('PUT refuses a bad signature, an expired URL, a changed type or size, and a missing tag / if-none-match', async () => {
    const { files, clock } = store();
    const { s, query, path } = await signed(files);
    expect(files.handlePut(path, { ...query, sig: '0'.repeat(64) }, s.headers, JPEG).status).toBe(403);
    expect(files.handlePut(path, { ...query, sig: 'nothex' }, s.headers, JPEG).status).toBe(403);
    expect(files.handlePut(path, query, { ...s.headers, 'content-type': 'image/png' }, JPEG).status).toBe(403);
    expect(files.handlePut(path, query, { ...s.headers, 'content-length': '99' }, JPEG).status).toBe(403);
    expect(files.handlePut(path, query, s.headers, Buffer.concat([JPEG, JPEG])).status).toBe(400);
    const { 'x-amz-tagging': _t, ...noTag } = s.headers;
    expect(files.handlePut(path, query, noTag, JPEG).status).toBe(403);
    expect(files.handlePut(path, query, { ...s.headers, 'x-amz-tagging': 'state=linked' }, JPEG).status).toBe(403);
    const { 'if-none-match': _i, ...noCond } = s.headers;
    expect(files.handlePut(path, query, noCond, JPEG).status).toBe(403);
    // another key with this signature
    expect(files.handlePut(KEY.replace('user-1', 'user-2'), query, s.headers, JPEG).status).toBe(403);
    clock.advance(301_000);
    expect(files.handlePut(path, query, s.headers, JPEG).status).toBe(403);
    expect(files.keys()).toEqual([]);
  });

  it('download links are signed, expire, keep the PDF attachment disposition, and refuse tampering', async () => {
    const { files, clock } = store();
    const { s, query, path } = await signed(files);
    files.handlePut(path, query, s.headers, JPEG);
    const u = new URL(await files.sign(KEY, 300));
    const q = Object.fromEntries(u.searchParams.entries());
    expect(q.disposition).toBeUndefined();
    const ok = files.handleGet(KEY, q);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(Buffer.compare(ok.body as Buffer, JPEG)).toBe(0);
    expect(files.handleGet(KEY, { ...q, disposition: 'inline' }).status).toBe(403);
    const pdf = new URL(await files.sign('kyc/user-1/pan-1.pdf', 300));
    expect(pdf.searchParams.get('disposition')).toBe('attachment; filename="pan.pdf"');
    expect(files.handleGet('kyc/user-1/pan-1.pdf', Object.fromEntries(pdf.searchParams.entries())).status).toBe(404);
    clock.advance(301_000);
    expect(files.handleGet(KEY, q).status).toBe(403);
  });

  it('deletePrefix keeps the given keys and removes tag sidecars; wipe empties the folder', async () => {
    const { files } = store();
    const keys = [KEY, KEY.replace('selfie-0', 'selfie-1'), 'kyc/user-2/pan-1.jpg'];
    for (const k of keys) {
      const { s, query, path } = await signed(files, JPEG.length, k);
      expect(files.handlePut(path, query, s.headers, JPEG).status).toBe(200);
    }
    expect(await files.deletePrefix('kyc/user-1/', new Set([KEY]))).toBe(1);
    expect(files.keys()).toEqual(['kyc/user-1/' + KEY.split('/')[2], 'kyc/user-2/pan-1.jpg'].sort());
    files.wipe();
    expect(files.keys()).toEqual([]);
  });

  it('safeKey refuses traversal, absolute, empty and sidecar keys', () => {
    for (const bad of ['', '../x.jpg', 'kyc/../x.jpg', '/kyc/a.jpg', 'kyc//a.jpg', 'kyc/a.jpg.tag', 'kyc\\a.jpg', 'kyc/.hidden', 'kyc/a b.jpg']) {
      expect(safeKey(bad), bad).toBeNull();
    }
    expect(safeKey(KEY)).toBe(KEY);
  });
});

describe('LocalStatePersister (state.json)', () => {
  class Store {
    readonly items = new Map<string, { v: number }>();
    readonly rows: string[] = [];
    seq = 0;
  }

  it('round-trips Maps, arrays and numbers; saves only on change; atomic (no temp file left)', () => {
    const dir = tmp();
    const file = join(dir, 'state.json');
    const a = new Store();
    const p = new LocalStatePersister(file, { s: { obj: a, fields: ['items', 'rows', 'seq'] } });
    expect(p.load()).toBe('empty');
    a.items.set('u1', { v: 1 });
    a.rows.push('r1');
    a.seq = 3;
    expect(p.save()).toBe(true);
    expect(p.save()).toBe(false);
    expect(readdirSync(dir)).toEqual(['state.json']);
    const b = new Store();
    expect(new LocalStatePersister(file, { s: { obj: b, fields: ['items', 'rows', 'seq'] } }).load()).toBe('loaded');
    expect(b.items.get('u1')).toEqual({ v: 1 });
    expect(b.rows).toEqual(['r1']);
    expect(b.seq).toBe(3);
  });

  it('clear() empties the stores in place and deletes the file', () => {
    const dir = tmp();
    const file = join(dir, 'state.json');
    const a = new Store();
    const p = new LocalStatePersister(file, { s: { obj: a, fields: ['items', 'rows', 'seq'] } });
    a.items.set('x', { v: 1 });
    a.rows.push('y');
    a.seq = 9;
    p.save();
    p.clear();
    expect(a.items.size).toBe(0);
    expect(a.rows).toEqual([]);
    expect(a.seq).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('a field that does not exist fails at start (a renamed memory-store field cannot lose data silently)', () => {
    expect(() => new LocalStatePersister(join(tmp(), 's.json'), { s: { obj: new Store(), fields: ['nope'] } })).toThrow(/s\.nope/);
  });

  it('an unreadable state file is moved aside and the stores start empty', () => {
    const dir = tmp();
    const file = join(dir, 'state.json');
    writeFileSync(file, '{not json');
    const a = new Store();
    expect(new LocalStatePersister(file, { s: { obj: a, fields: ['items'] } }).load()).toBe('moved-aside');
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).some((n) => n.startsWith('state.json.bad-'))).toBe(true);
  });

  it('atomicWrite replaces the file', () => {
    const f = join(tmp(), 'a.json');
    atomicWrite(f, '1');
    atomicWrite(f, '2');
    expect(readFileSync(f, 'utf8')).toBe('2');
  });
});

describe('local keys (keys.json)', () => {
  it('generated once, reused on the next start; drive LocalEncryptor and LocalTokenSigner', async () => {
    const dir = tmp();
    const k1 = loadOrCreateKeys(dir);
    const k2 = loadOrCreateKeys(dir);
    expect(existsSync(join(dir, KEYS_FILE))).toBe(true);
    expect(Buffer.from(k2.field).equals(Buffer.from(k1.field))).toBe(true);
    expect(k2.webhook).toBe(k1.webhook);
    // a value encrypted before a restart decrypts after it (purpose context still required)
    const ct = await new LocalEncryptor(k1.field).encrypt('ABCPR0002K', { purpose: 'pan', userId: 'u' });
    expect(await new LocalEncryptor(k2.field).decrypt(ct, { purpose: 'pan', userId: 'u' })).toBe('ABCPR0002K');
    await expect(new LocalEncryptor(k2.field).encrypt('x', { purpose: 'other' })).rejects.toThrow();
    // an access token signed before a restart verifies after it
    const clock = new FakeClock();
    const t = await signAccessToken(new LocalTokenSigner('local', k1.jwt), clock, 'u1', 'f1');
    expect((await verifyAccessToken(new LocalTokenSigner('local', k2.jwt), clock, t.token)).sub).toBe('u1');
  });

  it('a damaged key file is refused (never silently replaced)', () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, KEYS_FILE), JSON.stringify({ version: 1, field: 'AAAA', mac: 'AAAA', files: 'AAAA', webhook: 'x', jwtPkcs8: 'x' }));
    expect(() => loadOrCreateKeys(dir)).toThrow(/key file/);
  });
});

describe('LocalDemoSender', () => {
  it('sends nothing, keeps the last code per contact and prints it with the contact masked', async () => {
    const lines: string[] = [];
    const s = new LocalDemoSender('local', (l) => lines.push(l));
    await s.send('mobile', '9876543210', '123456');
    await s.send('mobile', '9876543210', '654321');
    await s.send('email', 'asha.rao@example.com', '111111');
    expect(s.codeFor('mobile', '9876543210')).toBe('654321');
    expect(s.codeFor('email', 'asha.rao@example.com')).toBe('111111');
    expect(s.codeFor('mobile', '9999999999')).toBeUndefined();
    expect(lines).toEqual(['DEMO code for ******3210: 123456', 'DEMO code for ******3210: 654321', 'DEMO code for a***@example.com: 111111']);
    expect(lines.join()).not.toMatch(/98765|asha\.rao/);
    s.clear();
    expect(s.codeFor('mobile', '9876543210')).toBeUndefined();
  });

  it('maskContact', () => {
    expect(maskContact('mobile', '9876543210')).toBe('******3210');
    expect(maskContact('email', 'a@b.co')).toBe('a***@b.co');
  });

  it('refuses to exist outside STAGE=local', () => {
    for (const stage of ['dev', 'prod', 'Local', '', undefined]) expect(() => new LocalDemoSender(stage), String(stage)).toThrow(/STAGE=local/);
  });
});

describe('LocalDemoStaffVerifier', () => {
  it('accepts exactly `Bearer local-demo-reviewer` as reviewer demo-reviewer', async () => {
    const v = new LocalDemoStaffVerifier('local');
    expect(await v.verify(DEMO_REVIEWER_HEADER)).toEqual({ id: 'demo-reviewer', groups: ['reviewer'] });
    for (const bad of [undefined, '', DEMO_REVIEWER_TOKEN, `Bearer ${DEMO_REVIEWER_TOKEN} `, `bearer ${DEMO_REVIEWER_TOKEN}`, 'Bearer local-demo-reviewer2', 'Bearer x']) {
      expect(await v.verify(bad), String(bad)).toBeNull();
    }
  });

  it('refuses to exist outside STAGE=local; the Cognito verifier refuses the demo token', async () => {
    for (const stage of ['dev', 'prod', 'LOCAL', undefined]) expect(() => new LocalDemoStaffVerifier(stage), String(stage)).toThrow(/STAGE=local/);
    const cognito = new CognitoStaffVerifier('ap-south-1', 'ap-south-1_x', 'client', async () => {
      throw new Error('no network in tests');
    });
    expect(await cognito.verify(DEMO_REVIEWER_HEADER)).toBeNull();
  });
});

describe('resetAllowed (TC-81)', () => {
  const own = 'http://127.0.0.1:5181';
  it('allows own Origin, a browser same-origin post with Origin null / absent, and curl (no headers)', () => {
    expect(resetAllowed({ origin: own }, own)).toBe(true);
    expect(resetAllowed({ origin: own, 'sec-fetch-site': 'same-origin' }, own)).toBe(true);
    expect(resetAllowed({ origin: 'null', 'sec-fetch-site': 'same-origin' }, own)).toBe(true);
    expect(resetAllowed({ 'sec-fetch-site': 'same-origin' }, own)).toBe(true);
    expect(resetAllowed({}, own)).toBe(true);
    expect(resetAllowed({ origin: 'null' }, own)).toBe(true);
  });
  it('refuses any other site', () => {
    expect(resetAllowed({ origin: 'https://evil.example' }, own)).toBe(false);
    expect(resetAllowed({ origin: 'http://127.0.0.1:5180', 'sec-fetch-site': 'same-site' }, own)).toBe(false);
    expect(resetAllowed({ origin: own, 'sec-fetch-site': 'cross-site' }, own)).toBe(false);
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect(resetAllowed({ origin: 'null', 'sec-fetch-site': site }, own), site).toBe(false);
      expect(resetAllowed({ 'sec-fetch-site': site }, own), site).toBe(false);
    }
  });
});

describe('hasLocalConsoleBuild', () => {
  it('true only for a dist with index.html and config.json {localDemo: true}', () => {
    const d = tmp();
    expect(hasLocalConsoleBuild(d)).toBe(false);
    writeFileSync(join(d, 'index.html'), '<!doctype html>');
    expect(hasLocalConsoleBuild(d)).toBe(false);
    writeFileSync(join(d, 'config.json'), JSON.stringify({ apiUrl: 'https://x' }));
    expect(hasLocalConsoleBuild(d)).toBe(false);
    writeFileSync(join(d, 'config.json'), JSON.stringify({ apiUrl: 'http://127.0.0.1:5181', localDemo: true }));
    expect(hasLocalConsoleBuild(d)).toBe(true);
  });
});
