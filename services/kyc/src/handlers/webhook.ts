// Lambda entry for POST /webhooks/partner (API Gateway HTTP API, payload v2). Wiring only: the
// logic lives in src/webhook/handler.ts. Env: TABLE_KYC_CASES, TABLE_AUDIT, WEBHOOK_EVENTS_TABLE,
// WEBHOOK_SECRET_ARN, optional KYC_* thresholds (src/config.ts).
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { loadConfig } from '../config';
import { systemClock } from '../lib/clock';
import { createDocClient } from '../lib/repo';
import { WEBHOOK_ENV, dynamoWebhookStores, webhookTablesFromEnv } from '../webhook/dynamo';
import { handleWebhook, type WebhookDeps } from '../webhook/handler';
import { HmacWebhookVerifier } from '../webhook/hmac';
import type { WebhookLogFields } from '../webhook/ports';

/** Secret value: the plain signing secret, or JSON `{ "secret": "..." }`. */
export function secretFrom(value: string): string {
  const v = value.trim();
  if (v.startsWith('{')) {
    const s = (JSON.parse(v) as { secret?: unknown }).secret;
    if (typeof s !== 'string') throw new Error('webhook secret JSON has no "secret"');
    return s;
  }
  return v;
}

/** Only the fixed fields of WebhookLogFields reach CloudWatch. */
function log(f: WebhookLogFields): void {
  const { msg, eventId, type, outcome, status, error } = f;
  console.log(JSON.stringify({ msg, eventId, type, outcome, status, error }));
}

let depsPromise: Promise<WebhookDeps> | undefined;

async function buildDeps(): Promise<WebhookDeps> {
  const env = process.env;
  const arn = env[WEBHOOK_ENV.secretArn];
  if (!arn) throw new Error(`Missing env ${WEBHOOK_ENV.secretArn}`);
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
  if (!out.SecretString) throw new Error('webhook secret is empty');
  const stores = dynamoWebhookStores(webhookTablesFromEnv(env), createDocClient());
  return {
    verifier: new HmacWebhookVerifier(secretFrom(out.SecretString)),
    ...stores,
    config: loadConfig(env),
    clock: systemClock,
    log,
  };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let deps: WebhookDeps;
  try {
    depsPromise ??= buildDeps();
    deps = await depsPromise;
  } catch (e) {
    depsPromise = undefined; // retry the setup on the next call
    log({ msg: 'webhook.setup_failed', status: 500, error: (e as { name?: string })?.name ?? 'Error' });
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'internal' }) };
  }
  const raw = event.body ?? '';
  const body = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  const res = await handleWebhook({ body, headers: event.headers ?? {} }, deps);
  return { statusCode: res.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(res.body) };
}
