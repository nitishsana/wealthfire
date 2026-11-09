// S3 implementations of DocumentStore / DownloadSigner. Assumed key layout (set by the KYC routes
// builder's /kyc/documents): `<DOCS_PREFIX><userId>/<kind>[-...].<ext>`, kind = selfie | aadhaar | pan.
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { DocumentKind, DocumentStore, DownloadSigner, StoredDocument } from './ports';

const KINDS: readonly DocumentKind[] = ['selfie', 'aadhaar', 'pan'];
const MAX_DOCS = 50;

export function kindOf(fileName: string): DocumentKind {
  const head = fileName.toLowerCase().split(/[-_.]/)[0] ?? '';
  return (KINDS as readonly string[]).includes(head) ? (head as DocumentKind) : 'other';
}

export class S3DocumentStore implements DocumentStore {
  constructor(private readonly s3: S3Client, private readonly bucket: string, private readonly prefix: string) {}

  async list(userId: string): Promise<StoredDocument[]> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(userId)) return [];
    const base = `${this.prefix}${userId}/`;
    const out = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: base, MaxKeys: MAX_DOCS }));
    return (out.Contents ?? [])
      .filter((o) => typeof o.Key === 'string' && o.Key.length > base.length)
      .map((o) => ({
        kind: kindOf((o.Key as string).slice(base.length)),
        key: o.Key as string,
        ...(o.LastModified ? { uploadedAt: o.LastModified.toISOString() } : {}),
      }));
  }
}

export class S3DownloadSigner implements DownloadSigner {
  constructor(private readonly s3: S3Client, private readonly bucket: string) {}

  sign(key: string, expiresInSec: number): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseCacheControl: 'no-store' }),
      { expiresIn: expiresInSec },
    );
  }
}
