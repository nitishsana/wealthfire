// Lambda "api": API Gateway → router. Accepts both HTTP API (payload v2) and REST API (v1 proxy)
// events, since the CDK stack currently fronts the Lambda with a REST API proxy.
// AWS clients are created once per container from the env the CDK stack sets.
import type {
  APIGatewayProxyEvent, APIGatewayProxyEventV2, APIGatewayProxyResult, APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { KMSClient } from '@aws-sdk/client-kms';
import { S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '../config';
import { OtpService, type Sender } from '../auth/otp';
import { systemClock } from '../lib/clock';
import { Argon2Hasher, KmsEnvelopeEncryptor, KmsMacSigner } from '../lib/crypto';
import { createDocClient, dynamoRepos, tableNamesFromEnv } from '../lib/repo';
import { KmsTokenSigner, TokenService } from '../lib/tokens';
import { ConsoleLogger } from '../kyc/log';
import { dynamoKycRepos, kycTablesFromEnv } from '../kyc/repo';
import { kycRoutes } from '../kyc/routes';
import { DEFAULT_DOCS_PREFIX, KycService } from '../kyc/service';
import { CognitoStaffVerifier } from '../kyc/staff';
import { S3UploadSigner } from '../kyc/uploads';
import { FakePartner } from '../partner/fake';
import type { KycPartner } from '../partner/types';
import { DynamoAuditLog, DynamoReviewCaseStore } from '../review/dynamo';
import { reviewRoutes } from '../review/routes';
import { S3DocumentStore, S3DownloadSigner } from '../review/s3';
import { createRouter, type HttpRequest, type HttpResponse } from '../router';

type Env = Record<string, string | undefined>;
type Event = APIGatewayProxyEvent | APIGatewayProxyEventV2;
type Result = APIGatewayProxyResult | APIGatewayProxyStructuredResultV2;

/** App deep-link scheme used by the phone apps for DigiLocker / e-sign returns. */
export const APP_RETURN_SCHEME = 'wealthfire://';

function need(env: Env, ...keys: string[]): string {
  for (const k of keys) if (env[k]) return env[k] as string;
  throw new Error(`Missing env ${keys.join(' / ')}`);
}

/** No SMS / email sender is wired yet (auth wave): OTP sends answer 503 until one is. */
class UnconfiguredSender implements Sender {
  async send(): Promise<void> {
    throw new Error('OTP sender not configured');
  }
}

/** FakePartner on dev until sandbox access; prod refuses to start without a real adapter. */
export function createPartner(env: Env): KycPartner {
  const choice = env.KYC_PARTNER ?? (env.STAGE === 'dev' ? 'fake' : undefined);
  if (choice === 'fake' && env.STAGE !== 'prod') return new FakePartner();
  throw new Error('No KYC partner adapter configured for this stage');
}

export function returnUrlPrefixes(env: Env): string[] {
  const origins = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...origins.map((o) => `${o.replace(/\/+$/, '')}/`), APP_RETURN_SCHEME];
}

export function buildRouter(env: Env = process.env): (req: HttpRequest) => Promise<HttpResponse> {
  const clock = systemClock;
  const doc = createDocClient();
  const kms = new KMSClient({});
  const s3 = new S3Client({});
  const mac = new KmsMacSigner(kms, need(env, 'HMAC_KEY_ID'));
  const encryptor = new KmsEnvelopeEncryptor(kms, need(env, 'DATA_KEY_ID'));
  const signer = new KmsTokenSigner(kms, need(env, 'JWT_KEY_ID'));
  const authRepos = dynamoRepos(
    tableNamesFromEnv({
      USERS_TABLE: env.USERS_TABLE ?? env.TABLE_USERS,
      SESSIONS_TABLE: env.SESSIONS_TABLE ?? env.TABLE_SESSIONS,
      OTP_TABLE: env.OTP_TABLE ?? env.TABLE_OTP,
    }),
    doc,
  );
  const tokens = new TokenService({ sessions: authRepos.sessions, signer, clock });
  const otp = new OtpService({
    repos: authRepos, clock, mac, encryptor, hasher: new Argon2Hasher(), sender: new UnconfiguredSender(), tokens,
  });
  const tables = kycTablesFromEnv(env);
  const bucket = need(env, 'DOCS_BUCKET');
  const docsPrefix = env.DOCS_PREFIX ?? DEFAULT_DOCS_PREFIX;
  const kyc = new KycService({
    repos: dynamoKycRepos(tables, doc),
    partner: createPartner(env),
    uploads: new S3UploadSigner(s3, bucket),
    encryptor,
    mac,
    clock,
    config: loadConfig(env),
    returnUrlPrefixes: returnUrlPrefixes(env),
    docsPrefix,
  });
  const review = reviewRoutes({
    cases: new DynamoReviewCaseStore(doc, tables.cases, tables.audit),
    audit: new DynamoAuditLog(doc, tables.audit),
    documents: new S3DocumentStore(s3, bucket, docsPrefix),
    signer: new S3DownloadSigner(s3, bucket),
    clock,
  });
  const staff = new CognitoStaffVerifier(
    need(env, 'AWS_REGION', 'AWS_DEFAULT_REGION'), need(env, 'STAFF_USER_POOL_ID'), need(env, 'STAFF_CLIENT_ID'),
  );
  return createRouter({
    auth: { otp, tokens, clock },
    tokens,
    kyc: kycRoutes(kyc),
    review,
    staff,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    logger: new ConsoleLogger(),
    clock,
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
