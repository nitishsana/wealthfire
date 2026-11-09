// Presigned S3 uploads for KYC documents (design §3 /kyc/documents). Keys are
// `<DOCS_PREFIX><userId>/<kind>-<uuid>.<ext>`, the layout the review console lists.
//
// S11: every signed PUT carries the tag `state=pending` (signed, so the client must send it); the
// object is retagged `state=linked` once a case references it. The bucket lifecycle deletes
// `pending` objects after 1 day, so unreferenced uploads never sit for the retention period.
// S14: the first bytes of an upload are checked against its declared type before it is used.
import {
  DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, PutObjectTaggingCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type UploadState = 'pending' | 'linked';
export const UPLOAD_TAG_KEY = 'state';
export const PENDING_TAGGING = `${UPLOAD_TAG_KEY}=pending`;
/** bytes read for the magic-byte check */
export const SNIFF_BYTES = 16;

export interface SignPutInput {
  key: string;
  contentType: string;
  /** exact size in bytes; signed, so S3 refuses a different body length */
  contentLength: number;
  expiresInSec: number;
}

export interface UploadSigner {
  /** URL (and headers the client must send, incl. the pending tag) for one PUT of exactly this object. */
  signPut(input: SignPutInput): Promise<{ url: string; headers: Record<string, string> }>;
  /** The object has been uploaded. */
  exists(key: string): Promise<boolean>;
  /** The first `n` bytes of the object, or null when it does not exist. */
  readStart(key: string, n: number): Promise<Uint8Array | null>;
  /** Sets the object's `state` tag. */
  setState(key: string, state: UploadState): Promise<void>;
  /** Deletes every object under `prefix`; returns how many were deleted. */
  deletePrefix(prefix: string): Promise<number>;
}

export type SniffedType = 'image/jpeg' | 'image/png' | 'application/pdf';

const startsWith = (b: Uint8Array, sig: readonly number[]): boolean => b.length >= sig.length && sig.every((x, i) => b[i] === x);

/** The file type its first bytes show (JPEG / PNG / PDF), or null for anything else. */
export function sniffType(bytes: Uint8Array): SniffedType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  return null;
}

const EXT_TYPES: Record<string, SniffedType> = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

/** Declared type of an upload id / key from its extension (.jpg / .png / .pdf), or null. */
export function declaredType(keyOrId: string): SniffedType | null {
  const m = /\.([a-z]{3})$/.exec(keyOrId);
  return (m && EXT_TYPES[m[1]!]) || null;
}

/**
 * S14: 'ok' when the object's magic bytes match the type its key declares, 'missing' when it is
 * not there, 'mismatch' otherwise (the upload must not be used).
 */
export async function checkUploadContent(uploads: UploadSigner, key: string): Promise<'ok' | 'missing' | 'mismatch'> {
  const want = declaredType(key);
  const head = await uploads.readStart(key, SNIFF_BYTES);
  if (head === null) return 'missing';
  return want !== null && sniffType(head) === want ? 'ok' : 'mismatch';
}

export class S3UploadSigner implements UploadSigner {
  constructor(private readonly s3: S3Client, private readonly bucket: string) {}

  async signPut(i: SignPutInput): Promise<{ url: string; headers: Record<string, string> }> {
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket, Key: i.key, ContentType: i.contentType, ContentLength: i.contentLength, Tagging: PENDING_TAGGING,
      }),
      { expiresIn: i.expiresInSec, signableHeaders: new Set(['content-type', 'content-length', 'x-amz-tagging']) },
    );
    return {
      url,
      headers: { 'content-type': i.contentType, 'content-length': String(i.contentLength), 'x-amz-tagging': PENDING_TAGGING },
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  async readStart(key: string, n: number): Promise<Uint8Array | null> {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${n - 1}` }));
      const body = out.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
      return body?.transformToByteArray ? await body.transformToByteArray() : new Uint8Array();
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async setState(key: string, state: UploadState): Promise<void> {
    await this.s3.send(new PutObjectTaggingCommand({
      Bucket: this.bucket, Key: key, Tagging: { TagSet: [{ Key: UPLOAD_TAG_KEY, Value: state }] },
    }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => typeof k === 'string' && k.startsWith(prefix));
      if (keys.length > 0) {
        const out = await this.s3.send(new DeleteObjectsCommand({
          Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }));
        if (out.Errors && out.Errors.length > 0) throw new Error('delete_failed');
        deleted += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }
}

function isNotFound(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'NotFound' || name === 'NoSuchKey';
}

const JPEG_HEAD = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const PDF_HEAD = new TextEncoder().encode('%PDF-1.7\n%\u00e2\u00e3');

/** Test signer: records what was signed; `markUploaded` simulates the client's PUT. */
export class FakeUploadSigner implements UploadSigner {
  readonly signed: SignPutInput[] = [];
  /** key -> first bytes */
  private readonly uploaded = new Map<string, Uint8Array>();
  readonly states = new Map<string, UploadState>();

  async signPut(i: SignPutInput): Promise<{ url: string; headers: Record<string, string> }> {
    this.signed.push({ ...i });
    return {
      url: `https://uploads.invalid/${i.key}?expires=${i.expiresInSec}`,
      headers: { 'content-type': i.contentType, 'content-length': String(i.contentLength), 'x-amz-tagging': PENDING_TAGGING },
    };
  }

  async exists(key: string): Promise<boolean> {
    return this.uploaded.has(key);
  }

  async readStart(key: string, n: number): Promise<Uint8Array | null> {
    const b = this.uploaded.get(key);
    return b ? b.slice(0, n) : null;
  }

  async setState(key: string, state: UploadState): Promise<void> {
    if (this.uploaded.has(key)) this.states.set(key, state);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const k of [...this.uploaded.keys()]) {
      if (k.startsWith(prefix)) {
        this.uploaded.delete(k);
        this.states.delete(k);
        n++;
      }
    }
    return n;
  }

  /** Simulates the client's PUT; content defaults to valid magic bytes for the key's extension. */
  markUploaded(key: string, bytes?: Uint8Array): void {
    const t = declaredType(key);
    this.uploaded.set(key, bytes ?? (t === 'image/png' ? PNG_HEAD : t === 'application/pdf' ? PDF_HEAD : JPEG_HEAD));
    this.states.set(key, 'pending');
  }

  /** keys currently stored */
  keys(): string[] {
    return [...this.uploaded.keys()];
  }
}
