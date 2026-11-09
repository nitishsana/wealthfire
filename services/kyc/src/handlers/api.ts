// Lambda "api": API Gateway → router. Accepts both HTTP API (payload v2) and REST API (v1 proxy)
// events, since the CDK stack currently fronts the Lambda with a REST API proxy.
// AWS clients are created once per container from the env the CDK stack sets.
import type {
  APIGatewayProxyEvent, APIGatewayProxyEventV2, APIGatewayProxyResult, APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { KMSClient } from '@aws-sdk/client-kms';
import { S3Client } from '@aws-sdk/client-s3';
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
import { DEFAULT_DOCS_PREFIX, DEFAULT_RETURN_URL_PREFIXES, KycService } from '../kyc/service';
import { CognitoStaffVerifier } from '../kyc/staff';
import { S3UploadSigner } from '../kyc/uploads';
import { FakePartner } from '../partner/fake';
import type { KycPartner } from '../partner/types';
import { reviewRoutes } from '../review/routes';
import { S3DocumentStore, S3DownloadSigner } from '../review/s3';
import { reviewCaseStore } from '../store/views';
import { createRouter, type HttpRequest, type HttpResponse } from '../router';

type Event = APIGatewayProxyEvent | APIGatewayProxyEventV2;
type Result = APIGatewayProxyResult | APIGatewayProxyStructuredResultV2;

/** App deep-link scheme used by the phone apps for DigiLocker / e-sign returns. */
export const APP_RETURN_SCHEME = 'wealthfire://';

/** FakePartner on dev until sandbox access; prod refuses to start without a real adapter. */
export function createPartner(env: Env): KycPartner {
  const stage = env[ENV.stage];
  const choice = env[ENV.partner] ?? (stage === 'dev' ? 'fake' : undefined);
  if (choice === 'fake' && stage !== 'prod') return new FakePartner();
  throw new Error('No KYC partner adapter configured for this stage');
}

/**
 * DigiLocker / e-sign return-URL allow-list: RETURN_URL_PREFIXES (comma-separated, set by the CDK
 * stack), else the built-in default. Each entry must be an https / local-http prefix ending in '/'
 * or the app scheme, so a bare origin can never open the whole host.
 */
export function returnUrlPrefixes(env: Env): string[] {
  const list = listEnv(env, ENV.returnUrlPrefixes);
  if (list.length === 0) return [...DEFAULT_RETURN_URL_PREFIXES];
  for (const p of list) {
    const ok = p === APP_RETURN_SCHEME
      || ((p.startsWith('https://') || p.startsWith('http://127.0.0.1:') || p.startsWith('http://localhost:')) && p.endsWith('/'));
    if (!ok) throw new Error(`Bad ${ENV.returnUrlPrefixes} entry`);
  }
  return list;
}

export function buildRouter(env: Env = process.env): (req: HttpRequest) => Promise<HttpResponse> {
  const clock = systemClock;
  const doc = createDocClient();
  const kms = new KMSClient({});
  const s3 = new S3Client({});
  const mac = new KmsMacSigner(kms, requireEnv(env, ENV.hmacKeyId));
  const encryptor = new KmsEnvelopeEncryptor(kms, requireEnv(env, ENV.dataKeyId));
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
    cases: reviewCaseStore(repos.cases),
    audit: repos.audit,
    documents: new S3DocumentStore(s3, bucket, docsPrefix),
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
