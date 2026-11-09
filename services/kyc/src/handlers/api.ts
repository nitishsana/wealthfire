// Lambda "api": API Gateway → router. Accepts both HTTP API (payload v2) and REST API (v1 proxy)
// events, since the CDK stack currently fronts the Lambda with a REST API proxy.
// AWS clients are created once per container from the env the CDK stack sets.
import type {
  APIGatewayProxyEvent, APIGatewayProxyEventV2, APIGatewayProxyResult, APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { KMSClient } from '@aws-sdk/client-kms';
import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { SNSClient } from '@aws-sdk/client-sns';
import { loadConfig } from '../config';
import { OtpService } from '../auth/otp';
import { senderFromEnv } from '../auth/senders';
import { systemClock } from '../lib/clock';
import { Argon2Hasher, KmsEnvelopeEncryptor, KmsMacSigner } from '../lib/crypto';
import { ENV, listEnv, requireEnv, type Env } from '../lib/env';
import { createDocClient, dynamoRepos, tableNamesFromEnv } from '../lib/repo';
import { KmsTokenSigner, TokenService } from '../lib/tokens';
import { ConsoleLogger } from '../kyc/log';
import { dynamoKycRepos, kycTablesFromEnv } from '../kyc/repo';
import { kycRoutes } from '../kyc/routes';
import { DEFAULT_DOCS_PREFIX, KycService } from '../kyc/service';
import { APP_RETURN_URL, returnUrlPrefixesFromEnv } from '../lib/returnUrl';
import { CognitoStaffVerifier } from '../kyc/staff';
import { S3UploadSigner } from '../kyc/uploads';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DEV_PARTNER_PREFIX, devPartnerRoutes, linkSignerFrom } from '../partner/devPages';
import { FakePartner, type FakePartnerOptions } from '../partner/fake';
import { secretFrom } from './webhook';
import type { KycPartner } from '../partner/types';
import { reviewRoutes } from '../review/routes';
import { S3DownloadSigner } from '../review/s3';
import { reviewCaseStore } from '../store/views';
import { createRouter, LOCAL_STAGE, type HttpRequest, type HttpResponse } from '../router';

type Event = APIGatewayProxyEvent | APIGatewayProxyEventV2;
type Result = APIGatewayProxyResult | APIGatewayProxyStructuredResultV2;

/** The phone apps' DigiLocker / e-sign return deep link (pinned exactly, S15). */
export const APP_RETURN_SCHEME = APP_RETURN_URL;

/**
 * FakePartner on dev until sandbox access; prod refuses to start without a real adapter.
 * `fake` options come from devPartnerSetup() on the dev stack (redirects to /dev-partner/...).
 */
export function createPartner(env: Env, fake: FakePartnerOptions = {}): KycPartner {
  const stage = env[ENV.stage];
  const choice = env[ENV.partner] ?? (stage === 'dev' ? 'fake' : undefined);
  if (choice === 'fake' && stage !== 'prod') return new FakePartner(fake);
  throw new Error('No KYC partner adapter configured for this stage');
}

/** Webhook secret from Secrets Manager, read once per container (retried after a failure). */
export function cachedSecret(read: () => Promise<string>): () => Promise<string> {
  let p: Promise<string> | undefined;
  return () => {
    p ??= read().catch((e: unknown) => {
      p = undefined;
      throw e;
    });
    return p;
  };
}

export interface DevPartnerSetup {
  /** FakePartner options: redirect to `${API_BASE_URL}/dev-partner/...` with tagged links */
  fake: FakePartnerOptions;
  routes: ReturnType<typeof devPartnerRoutes>;
}

/**
 * R4: the dev-only fake DigiLocker / e-sign pages. Only when STAGE is exactly 'dev' and both
 * API_BASE_URL (https, the API's public URL incl. stage) and WEBHOOK_SECRET_ARN are set;
 * otherwise null (FakePartner keeps its placeholder URLs and no pages are served).
 */
export function devPartnerSetup(
  env: Env,
  readSecret: (arn: string) => Promise<string>,
  clock: { now(): number } = systemClock,
): DevPartnerSetup | null {
  if (env[ENV.stage] !== 'dev') return null;
  const base = (env[ENV.apiBaseUrl] ?? '').trim().replace(/\/+$/, '');
  const arn = (env[ENV.webhookSecretArn] ?? '').trim();
  if (!base || !arn) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`Bad ${ENV.apiBaseUrl}`);
  }
  if (url.protocol !== 'https:' || url.search || url.hash) throw new Error(`Bad ${ENV.apiBaseUrl}`);
  const secret = cachedSecret(() => readSecret(arn));
  return {
    fake: { baseUrl: `${base}${DEV_PARTNER_PREFIX}`, linkSigner: linkSignerFrom(secret) },
    routes: devPartnerRoutes({ webhookSecret: secret, webhookUrl: `${base}/webhooks/partner`, clock }),
  };
}

/**
 * S#1: the S3 client for the docs bucket (upload PUT presigns, review GET presigns, tagging,
 * content checks). `requestChecksumCalculation: 'WHEN_REQUIRED'` stops the SDK adding
 * x-amz-checksum-* / x-amz-sdk-checksum-algorithm (of an empty body) to presigned PUT URLs, which
 * the apps' real upload body would not match. Operations S3 itself requires a checksum for
 * (PutObjectTagging, DeleteObjects) still get one.
 */
export function createDocsS3Client(extra: S3ClientConfig = {}): S3Client {
  return new S3Client({ ...extra, requestChecksumCalculation: 'WHEN_REQUIRED' });
}

async function readWebhookSecret(arn: string): Promise<string> {
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
  if (!out.SecretString) throw new Error('webhook secret is empty');
  return secretFrom(out.SecretString);
}

/**
 * DigiLocker / e-sign return-URL allow-list (R10, S15): RETURN_URL_PREFIXES (validated by the
 * shared parser in src/lib/returnUrl.ts), else the built-in default, which has no loopback entry.
 */
export function returnUrlPrefixes(env: Env): string[] {
  return returnUrlPrefixesFromEnv(env);
}

/**
 * Local mode (demo OTP code, demo reviewer token, local files) runs only in the local Node server
 * (services/kyc/local/server.ts). The Lambda refuses to start with STAGE=local.
 */
export function assertNotLocalStage(env: Env): void {
  if ((env[ENV.stage] ?? '').trim().toLowerCase() === LOCAL_STAGE) {
    throw new Error('STAGE=local runs only in the local server, never in Lambda');
  }
}

export function buildRouter(env: Env = process.env): (req: HttpRequest) => Promise<HttpResponse> {
  assertNotLocalStage(env);
  const clock = systemClock;
  const doc = createDocClient();
  const kms = new KMSClient({});
  const s3 = createDocsS3Client();
  const mac = new KmsMacSigner(kms, requireEnv(env, ENV.hmacKeyId));
  // S9: PAN / contact envelopes use the field key (api role only); the Encryptor sends the
  // required {purpose: 'pan' | 'contact', ...} encryption context to KMS on every call.
  const encryptor = new KmsEnvelopeEncryptor(kms, requireEnv(env, ENV.fieldKeyId));
  const dev = devPartnerSetup(env, readWebhookSecret, clock);
  const signer = new KmsTokenSigner(kms, requireEnv(env, ENV.jwtKeyId));
  const authRepos = dynamoRepos(tableNamesFromEnv(env), doc);
  const tokens = new TokenService({ sessions: authRepos.sessions, signer, clock });
  const sender = senderFromEnv(env, { sns: () => new SNSClient({}), ses: () => new SESv2Client({}) });
  const otp = new OtpService({ repos: authRepos, clock, mac, encryptor, hasher: new Argon2Hasher(), sender, tokens });
  const tables = kycTablesFromEnv(env);
  const bucket = requireEnv(env, ENV.docsBucket);
  const docsPrefix = env[ENV.docsPrefix] ?? DEFAULT_DOCS_PREFIX;
  // One shared store for the KYC routes and the review routes.
  const repos = dynamoKycRepos(tables, doc);
  const kyc = new KycService({
    repos,
    partner: createPartner(env, dev?.fake),
    uploads: new S3UploadSigner(s3, bucket),
    encryptor,
    mac,
    clock,
    config: loadConfig(env),
    returnUrlPrefixes: returnUrlPrefixes(env),
    docsPrefix,
  });
  const review = reviewRoutes({
    cases: reviewCaseStore(repos.cases),
    audit: repos.audit,
    // F2/S#3: links come from the case's linked documents, keyed exactly like the KYC routes
    docKey: (userId, uploadId) => kyc.docKey(userId, uploadId),
    // F1/F2: link pending uploads before review links are signed and before Approve counts them
    linkDocuments: (userId) => kyc.linkDocuments(userId),
    signer: new S3DownloadSigner(s3, bucket),
    clock,
    onApproved: async (userId) => void (await kyc.uploadToKra(userId)),
  });
  const staff = new CognitoStaffVerifier(
    env.AWS_REGION ?? requireEnv(env, 'AWS_DEFAULT_REGION'),
    requireEnv(env, ENV.staffUserPoolId),
    requireEnv(env, ENV.staffClientId),
  );
  return createRouter({
    auth: { otp, tokens, clock },
    tokens,
    kyc: kycRoutes(kyc),
    review,
    staff,
    allowedOrigins: listEnv(env, ENV.allowedOrigins),
    // S#8: refresh-cookie origins are the app origins only (never the full CORS list)
    appOrigins: listEnv(env, ENV.appOrigins),
    logger: new ConsoleLogger(),
    clock,
    ...(env[ENV.stage] !== undefined ? { stage: env[ENV.stage] } : {}),
    // R4: the router also ignores these unless stage === 'dev'
    ...(dev ? { devPartner: dev.routes } : {}),
  });
}

const isV2 = (e: Event): e is APIGatewayProxyEventV2 => (e as { version?: string }).version === '2.0';

/** API Gateway event → HttpRequest (stage prefix removed, body base64-decoded). */
export function toHttpRequest(event: Event): HttpRequest {
  let body = event.body ?? undefined;
  if (body !== undefined && event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
  if (isV2(event)) {
    const stage = event.requestContext.stage;
    let path = event.rawPath || '/';
    if (stage && stage !== '$default' && path.startsWith(`/${stage}/`)) path = path.slice(stage.length + 1);
    const headers: Record<string, string | undefined> = { ...event.headers };
    if (event.cookies?.length) headers.cookie = event.cookies.join('; ');
    return {
      method: event.requestContext.http.method,
      path,
      headers,
      query: { ...(event.queryStringParameters ?? {}) },
      ...(body !== undefined ? { body } : {}),
      ip: event.requestContext.http.sourceIp ?? 'unknown',
    };
  }
  return {
    method: event.httpMethod,
    path: event.path || '/',
    headers: { ...(event.headers ?? {}) },
    query: { ...(event.queryStringParameters ?? {}) },
    ...(body !== undefined ? { body } : {}),
    ip: event.requestContext?.identity?.sourceIp ?? 'unknown',
  };
}

/** HttpResponse → the result shape for the event's payload version. */
export function toResult(event: Event, res: HttpResponse): Result {
  if (isV2(event)) {
    return { statusCode: res.statusCode, headers: res.headers, body: res.body, ...(res.cookies.length ? { cookies: res.cookies } : {}) };
  }
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: res.body,
    ...(res.cookies.length ? { multiValueHeaders: { 'Set-Cookie': res.cookies } } : {}),
  };
}

/** Builds a Lambda handler around a router factory (called once, lazily). */
export function createHandler(factory: () => (req: HttpRequest) => Promise<HttpResponse>) {
  let router: ((req: HttpRequest) => Promise<HttpResponse>) | null = null;
  return async (event: Event): Promise<Result> => {
    try {
      router ??= factory();
    } catch {
      console.error(JSON.stringify({ level: 'error', event: 'init_failed' }));
      return toResult(event, {
        statusCode: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        body: JSON.stringify({ error: 'not_configured', message: 'The service is not available yet.' }),
        cookies: [],
      });
    }
    return toResult(event, await router(toHttpRequest(event)));
  };
}

export const handler = createHandler(() => buildRouter(process.env));
