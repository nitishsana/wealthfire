// Local mode persistence: the in-memory stores (src/lib/repo.ts, src/kyc/repo.ts, src/store/memory.ts,
// src/webhook/memory.ts, the FakePartner's ref table) saved to `.local-data/state.json` after
// every write and loaded at start. Writes are atomic (temp file + rename). Keys live in
// `.local-data/keys.json`, generated once and kept by Reset.
//
// Each store is listed with the exact fields that hold its data; a field that is missing or of
// the wrong kind throws at start, so a renamed field in a memory store fails loudly (and in the
// unit tests) instead of silently losing data.
import { createPrivateKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const STATE_FILE = 'state.json';
export const KEYS_FILE = 'keys.json';
export const STATE_VERSION = 1;

// ---------- keys ----------

export interface LocalKeys {
  /** LocalEncryptor key (PAN / contact envelopes), 32 bytes */
  field: Uint8Array;
  /** LocalMacSigner key (lookup hashes), 32 bytes */
  mac: Uint8Array;
  /** local file URL signatures, 32 bytes */
  files: Uint8Array;
  /** fake partner webhook + dev page link secret (hex) */
  webhook: string;
  /** access-token signing key (P-256) */
  jwt: KeyObject;
}

interface KeysFile {
  version: 1;
  field: string;
  mac: string;
  files: string;
  webhook: string;
  jwtPkcs8: string;
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const fromB64 = (s: unknown, n: number): Uint8Array => {
  if (typeof s !== 'string') throw new Error('bad local key file');
  const b = new Uint8Array(Buffer.from(s, 'base64'));
  if (b.length !== n) throw new Error('bad local key file');
  return b;
};

/** Reads `<dir>/keys.json`, creating it once with fresh random keys. */
export function loadOrCreateKeys(dir: string): LocalKeys {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, KEYS_FILE);
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const k: KeysFile = {
      version: 1,
      field: b64(randomBytes(32)),
      mac: b64(randomBytes(32)),
      files: b64(randomBytes(32)),
      webhook: randomBytes(32).toString('hex'),
      jwtPkcs8: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    };
    atomicWrite(file, JSON.stringify(k, null, 2), 0o600);
  }
  const k = JSON.parse(readFileSync(file, 'utf8')) as Partial<KeysFile>;
  if (k.version !== 1 || typeof k.webhook !== 'string' || !/^[0-9a-f]{64}$/.test(k.webhook) || typeof k.jwtPkcs8 !== 'string') {
    throw new Error(`bad local key file ${file}`);
  }
  return {
    field: fromB64(k.field, 32),
    mac: fromB64(k.mac, 32),
    files: fromB64(k.files, 32),
    webhook: k.webhook,
    jwt: createPrivateKey(k.jwtPkcs8),
  };
}

// ---------- atomic write ----------

/** Writes `file` via a temp file in the same folder + rename (retried briefly on Windows locks). */
export function atomicWrite(file: string, data: string, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, data, { mode });
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (i >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        rmSync(tmp, { force: true });
        throw e;
      }
      // short sync sleep: a lock (antivirus / indexer) is usually gone within milliseconds
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
}

// ---------- state ----------

/** One store and the fields that hold its data (Map, array or number). */
export interface PersistedPart {
  obj: object;
  fields: readonly string[];
}

type Encoded = { $map: [unknown, unknown][] } | unknown[] | number;

function fieldOf(part: PersistedPart, name: string, field: string): unknown {
  const holder = part.obj as Record<string, unknown>;
  if (!(field in holder)) throw new Error(`local state: ${name}.${field} does not exist`);
  const v = holder[field];
  if (!(v instanceof Map) && !Array.isArray(v) && typeof v !== 'number') throw new Error(`local state: ${name}.${field} is not a Map, array or number`);
  return v;
}

export class LocalStatePersister {
  private last = '';

  constructor(private readonly file: string, private readonly parts: Readonly<Record<string, PersistedPart>>) {
    // validate every field now (fail at start, not at the first save)
    for (const [name, part] of Object.entries(parts)) for (const f of part.fields) fieldOf(part, name, f);
  }

  /** The current state as JSON. */
  snapshot(): string {
    const out: Record<string, Record<string, Encoded>> = {};
    for (const [name, part] of Object.entries(this.parts)) {
      const o: Record<string, Encoded> = {};
      for (const f of part.fields) {
        const v = fieldOf(part, name, f);
        o[f] = v instanceof Map ? { $map: [...v.entries()] } : (v as unknown[] | number);
      }
      out[name] = o;
    }
    return JSON.stringify({ version: STATE_VERSION, stores: out });
  }

  /**
   * Loads the file into the stores. 'empty' when there is none; 'moved-aside' when it could not
   * be read (it is renamed to state.json.bad-<time> and the stores start empty).
   */
  load(): 'loaded' | 'empty' | 'moved-aside' {
    if (!existsSync(this.file)) return 'empty';
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: unknown; stores?: Record<string, Record<string, unknown>> };
      if (raw.version !== STATE_VERSION || typeof raw.stores !== 'object' || raw.stores === null) throw new Error('bad state');
      // decode everything first, then apply, so a bad file never half-loads
      const apply: (() => void)[] = [];
      for (const [name, part] of Object.entries(this.parts)) {
        const saved = raw.stores[name] ?? {};
        for (const f of part.fields) {
          const cur = fieldOf(part, name, f);
          const v = saved[f];
          if (v === undefined) continue;
          if (cur instanceof Map) {
            const entries = (v as { $map?: unknown }).$map;
            if (!Array.isArray(entries) || !entries.every((e) => Array.isArray(e) && e.length === 2)) throw new Error('bad state');
            apply.push(() => {
              cur.clear();
              for (const [k, val] of entries as [unknown, unknown][]) cur.set(k, val);
            });
          } else if (Array.isArray(cur)) {
            if (!Array.isArray(v)) throw new Error('bad state');
            apply.push(() => {
              cur.length = 0;
              cur.push(...v);
            });
          } else {
            if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('bad state');
            apply.push(() => {
              (part.obj as Record<string, unknown>)[f] = v;
            });
          }
        }
      }
      for (const a of apply) a();
      this.last = this.snapshot();
      return 'loaded';
    } catch {
      renameSync(this.file, `${this.file}.bad-${Date.now()}`);
      return 'moved-aside';
    }
  }

  /** Writes the state when it changed since the last save / load. True when written. */
  save(): boolean {
    const s = this.snapshot();
    if (s === this.last) return false;
    atomicWrite(this.file, s);
    this.last = s;
    return true;
  }

  /** Empties every store in place and deletes the state file. */
  clear(): void {
    for (const [name, part] of Object.entries(this.parts)) {
      for (const f of part.fields) {
        const v = fieldOf(part, name, f);
        if (v instanceof Map) v.clear();
        else if (Array.isArray(v)) v.length = 0;
        else (part.obj as Record<string, unknown>)[f] = 0;
      }
    }
    rmSync(this.file, { force: true });
    this.last = this.snapshot();
  }
}
