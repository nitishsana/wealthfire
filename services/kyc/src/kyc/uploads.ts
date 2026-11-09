// Presigned S3 uploads for KYC documents (design §3 /kyc/documents). Keys are
// `<DOCS_PREFIX><userId>/<kind>-<uuid>.<ext>`, the layout the review console lists.
import { HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface SignPutInput {
  key: string;
  contentType: string;
  /** exact size in bytes; signed, so S3 refuses a different body length */
  contentLength: number;
  expiresInSec: number;
}

export interface UploadSigner {
  /** URL (and headers the client must send) for one PUT of exactly this object. */
  signPut(input: SignPutInput): Promise<{ url: string; headers: Record<string, string> }>;
  /** The object has been uploaded. */
  exists(key: string): Promise<boolean>;
}

export class S3UploadSigner implements UploadSigner {
  constructor(private readonly s3: S3Client, private readonly bucket: string) {}

  async signPut(i: SignPutInput): Promise<{ url: string; headers: Record<string, string> }> {
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: i.key, ContentType: i.contentType, ContentLength: i.contentLength }),
      { expiresIn: i.expiresInSec, signableHeaders: new Set(['content-type', 'content-length']) },
    );
    return { url, headers: { 'content-type': i.contentType, 'content-length': String(i.contentLength) } };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === 'NotFound' || name === 'NoSuchKey') return false;
      throw e;
    }
  }
}

/** Test signer: records what was signed; `markUploaded` simulates the client's PUT. */
export class FakeUploadSigner implements UploadSigner {
  readonly signed: SignPutInput[] = [];
  private readonly uploaded = new Set<string>();

  async signPut(i: SignPutInput): Promise<{ url: string; headers: Record<string, string> }> {
    this.signed.push({ ...i });
    return {
      url: `https://uploads.invalid/${i.key}?expires=${i.expiresInSec}`,
      headers: { 'content-type': i.contentType, 'content-length': String(i.contentLength) },
    };
  }

  async exists(key: string): Promise<boolean> {
    return this.uploaded.has(key);
  }

  markUploaded(key: string): void {
    this.uploaded.add(key);
  }
}
