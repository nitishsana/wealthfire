// Local mode stand-in for the S3 docs bucket: presigned-style URLs served by the local server.
//   PUT <base>/local-files/<key>?exp=<epoch s>&sig=<hex>   upload (the app's signed PUT)
//   GET <base>/local-files/<key>?exp=..&sig=..&disposition=..   download (review console links)
// sig = HMAC-SHA256(file key, method | key | exp | content-type | length) for PUT and
// HMAC(method | key | exp | disposition | '') for GET. The PUT honours the same signed headers the
// S3 URL has (src/kyc/uploads.ts signedPutHeaders): content-type and content-length must match,
// `x-amz-tagging: state=pending` and `if-none-match: *` are required, an existing object is never
// overwritten (412), and the tag is stored beside the file as `<file>.tag`. No lifecycle.
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Clock } from '../lib/clock';
import { MAX_UPLOAD_BYTES } from '../kyc/service';
import {
  PENDING_TAGGING, UPLOAD_TAG_KEY, signedPutHeaders, type SignPutInput, type UploadSigner, type UploadState,
} from '../kyc/uploads';
import type { DownloadSigner } from '../review/ports';
import { contentDispositionFor } from '../review/s3';

export const LOCAL_FILES_PATH = '/local-files/';
export const TAG_SUFFIX = '.tag';
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;
const SIG = /^[0-9a-f]{64}$/;

const TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

export interface LocalFileResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

export interface LocalFileStoreOptions {
  /** folder for the objects (`.local-data/files`) */
  dir: string;
  /** the local API origin, e.g. http://127.0.0.1:5181 */
  baseUrl: string;
  /** HMAC key for the URL signatures (at least 32 bytes) */
  key: Uint8Array;
  clock: Clock;
}

/** A safe object key (`kyc/<user>/<upload>.jpg`), or null. */
export function safeKey(key: unknown): string | null {
  if (typeof key !== 'string' || key.length < 1 || key.length > 512) return null;
  const segs = key.split('/');
  if (!segs.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..' && !s.includes('..'))) return null;
  if (key.endsWith(TAG_SUFFIX)) return null;
  return key;
}

const json = (status: number, error: string): LocalFileResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  body: JSON.stringify({ error }),
});

function header(h: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export class LocalFileStore implements UploadSigner, DownloadSigner {
  private readonly dir: string;
  private readonly key: Buffer;
  private readonly base: string;

  constructor(private readonly opts: LocalFileStoreOptions) {
    if (opts.key.length < 32) throw new Error('local file key must be at least 32 bytes');
    this.dir = resolve(opts.dir);
    this.key = Buffer.from(opts.key);
    this.base = opts.baseUrl.replace(/\/+$/, '');
    mkdirSync(this.dir, { recursive: true });
  }

  // ---------- signing ----------

  private sig(method: 'PUT' | 'GET', key: string, exp: number, a: string, b: string): string {
    return createHmac('sha256', this.key).update(['local-file', method, key, String(exp), a, b].join('\u0000'), 'utf8').digest('hex');
  }

  private sigOk(given: string | undefined, want: string): boolean {
    if (typeof given !== 'string' || !SIG.test(given)) return false;
    return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(want, 'hex'));
  }

  private url(key: string, params: Record<string, string>): string {
    const path = key.split('/').map(encodeURIComponent).join('/');
    return `${this.base}${LOCAL_FILES_PATH}${path}?${new URLSearchParams(params).toString()}`;
  }

  private exp(expiresInSec: number): number {
    return Math.floor(this.opts.clock.now() / 1000) + expiresInSec;
  }

  async signPut(i: SignPutInput): Promise<{ url: string; headers: Record<string, string> }> {
    const key = safeKey(i.key);
    if (!key) throw new Error('bad upload key');
    const exp = this.exp(i.expiresInSec);
    const sig = this.sig('PUT', key, exp, i.contentType, String(i.contentLength));
    return { url: this.url(key, { exp: String(exp), sig }), headers: signedPutHeaders(i) };
  }

  /** DownloadSigner: a short-lived GET link (PDFs download as attachments, as on S3). */
  async sign(key: string, expiresInSec: number): Promise<string> {
    const k = safeKey(key);
    if (!k) throw new Error('bad download key');
    const exp = this.exp(expiresInSec);
    const disposition = contentDispositionFor(k) ?? '';
    const sig = this.sig('GET', k, exp, disposition, '');
    return this.url(k, { exp: String(exp), sig, ...(disposition ? { disposition } : {}) });
  }

  // ---------- storage ----------

  /** Absolute path for a safe key (always inside the files folder). */
  private pathOf(key: string): string {
    const p = resolve(this.dir, ...key.split('/'));
    if (!p.startsWith(this.dir + sep)) throw new Error('bad key');
    return p;
  }

  async exists(key: string): Promise<boolean> {
    const k = safeKey(key);
    return k !== null && existsSync(this.pathOf(k));
  }

  async readStart(key: string, n: number): Promise<Uint8Array | null> {
    const k = safeKey(key);
    if (!k) return null;
    const p = this.pathOf(k);
    if (!existsSync(p)) return null;
    const fd = openSync(p, 'r');
    try {
      const buf = Buffer.alloc(n);
      const read = readSync(fd, buf, 0, n, 0);
      return new Uint8Array(buf.subarray(0, read));
    } finally {
      closeSync(fd);
    }
  }

  /** Sets the `state` tag (like PutObjectTagging; a missing object is ignored, as in the fake). */
  async setState(key: string, state: UploadState): Promise<void> {
    const k = safeKey(key);
    if (!k) return;
    const p = this.pathOf(k);
    if (existsSync(p)) writeFileSync(p + TAG_SUFFIX, `${UPLOAD_TAG_KEY}=${state}`);
  }

  /** The stored tag value (`pending` / `linked`), or null. */
  stateOf(key: string): UploadState | null {
    const k = safeKey(key);
    if (!k) return null;
    const p = this.pathOf(k) + TAG_SUFFIX;
    if (!existsSync(p)) return null;
    const m = /^state=(pending|linked)$/.exec(readFileSync(p, 'utf8').trim());
    return m ? (m[1] as UploadState) : null;
  }

  /** Every stored object key (no tag sidecars). */
  keys(): string[] {
    const out: string[] = [];
    const walk = (abs: string, rel: string[]): void => {
      if (!existsSync(abs)) return;
      for (const name of readdirSync(abs)) {
        const full = join(abs, name);
        if (statSync(full).isDirectory()) walk(full, [...rel, name]);
        else if (!name.endsWith(TAG_SUFFIX)) out.push([...rel, name].join('/'));
      }
    };
    walk(this.dir, []);
    return out.sort();
  }

  async deletePrefix(prefix: string, keep?: ReadonlySet<string>): Promise<number> {
    let n = 0;
    for (const k of this.keys()) {
      if (!k.startsWith(prefix) || keep?.has(k)) continue;
      const p = this.pathOf(k);
      unlinkSync(p);
      if (existsSync(p + TAG_SUFFIX)) unlinkSync(p + TAG_SUFFIX);
      n++;
    }
    return n;
  }

  /** Reset: removes every stored object. */
  wipe(): void {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }

  // ---------- HTTP ----------

  private checkExp(exp: string | undefined): boolean {
    if (typeof exp !== 'string' || !/^\d{1,12}$/.test(exp)) return false;
    return Number(exp) > Math.floor(this.opts.clock.now() / 1000);
  }

  /** PUT /local-files/<key> (the app's signed upload). */
  handlePut(
    rawKey: string, query: Record<string, string | undefined>, headers: Record<string, string | string[] | undefined>, body: Buffer,
  ): LocalFileResponse {
    const key = safeKey(rawKey);
    if (!key) return json(400, 'bad_key');
    if (!this.checkExp(query.exp)) return json(403, 'expired');
    const type = header(headers, 'content-type') ?? '';
    const length = header(headers, 'content-length') ?? String(body.length);
    if (!this.sigOk(query.sig, this.sig('PUT', key, Number(query.exp), type, length))) return json(403, 'signature_mismatch');
    if (String(body.length) !== length || body.length > MAX_UPLOAD_BYTES) return json(400, 'length_mismatch');
    if (header(headers, 'x-amz-tagging') !== PENDING_TAGGING) return json(403, 'tagging_required');
    if (header(headers, 'if-none-match') !== '*') return json(403, 'if_none_match_required');
    const p = this.pathOf(key);
    mkdirSync(resolve(p, '..'), { recursive: true });
    try {
      // 'wx': never overwrite (S3 conditional write answers 412 PreconditionFailed)
      writeFileSync(p, body, { flag: 'wx' });
    } catch (e) {
      if ((e as { code?: string }).code === 'EEXIST') return json(412, 'precondition_failed');
      throw e;
    }
    writeFileSync(p + TAG_SUFFIX, PENDING_TAGGING);
    return { status: 200, headers: { 'cache-control': 'no-store', 'content-length': '0' }, body: '' };
  }

  /** GET /local-files/<key> (signed review console link). */
  handleGet(rawKey: string, query: Record<string, string | undefined>): LocalFileResponse {
    const key = safeKey(rawKey);
    if (!key) return json(400, 'bad_key');
    if (!this.checkExp(query.exp)) return json(403, 'expired');
    const disposition = query.disposition ?? '';
    if (!this.sigOk(query.sig, this.sig('GET', key, Number(query.exp), disposition, ''))) return json(403, 'signature_mismatch');
    const p = this.pathOf(key);
    if (!existsSync(p)) return json(404, 'not_found');
    const ext = /\.([a-z]{3})$/.exec(key)?.[1] ?? '';
    return {
      status: 200,
      headers: {
        'content-type': TYPES[ext] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'referrer-policy': 'no-referrer',
        ...(disposition ? { 'content-disposition': disposition } : {}),
      },
      body: readFileSync(p),
    };
  }
}
