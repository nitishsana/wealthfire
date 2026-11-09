// The ONE naming scheme for Lambda environment variables. infra/stack.ts sets exactly these names
// (it imports this file), and every handler reads them through here. No imports: safe for CDK code.

/** Table name variables: TABLE_<NAME>. */
export const TABLE_ENV = {
  users: 'TABLE_USERS',
  sessions: 'TABLE_SESSIONS',
  otp: 'TABLE_OTP',
  kycCases: 'TABLE_KYC_CASES',
  audit: 'TABLE_AUDIT',
  costs: 'TABLE_COSTS',
  webhookEvents: 'TABLE_WEBHOOK_EVENTS',
} as const;

export const ENV = {
  stage: 'STAGE',
  /** CORS allow-list (comma-separated exact origins) */
  allowedOrigins: 'ALLOWED_ORIGINS',
  /** DigiLocker / e-sign return URL prefixes (comma-separated) */
  returnUrlPrefixes: 'RETURN_URL_PREFIXES',
  docsBucket: 'DOCS_BUCKET',
  docsPrefix: 'DOCS_PREFIX',
  /** Table / S3 key (DataKey). Not for PAN / contact envelopes: those use fieldKeyId. */
  dataKeyId: 'DATA_KEY_ID',
  /** Field-encryption key for PAN / contact envelopes (context {purpose: 'pan' | 'contact'}); api role only */
  fieldKeyId: 'FIELD_KEY_ID',
  /** Consent records table (pk userId, sk purpose#ts) */
  consentsTable: 'CONSENTS_TABLE',
  /** Dev only: the API's public base URL incl. stage, e.g. https://<id>.execute-api.ap-south-1.amazonaws.com/dev/ */
  apiBaseUrl: 'API_BASE_URL',
  jwtKeyId: 'JWT_KEY_ID',
  hmacKeyId: 'HMAC_KEY_ID',
  partnerSecretArn: 'PARTNER_SECRET_ARN',
  webhookSecretArn: 'WEBHOOK_SECRET_ARN',
  staffUserPoolId: 'STAFF_USER_POOL_ID',
  staffClientId: 'STAFF_CLIENT_ID',
  /** 'fake' on dev until a real partner adapter exists */
  partner: 'KYC_PARTNER',
  /** SNS SMS sender id (India DLT header); SMS OTP is off without it */
  smsSenderId: 'OTP_SMS_SENDER_ID',
  /** India DLT principal entity id / content template id (optional SNS attributes) */
  smsEntityId: 'OTP_SMS_ENTITY_ID',
  smsTemplateId: 'OTP_SMS_TEMPLATE_ID',
  /** SES v2 from-address (verified identity); email OTP is off without it */
  emailFrom: 'OTP_EMAIL_FROM',
} as const;

export type Env = Record<string, string | undefined>;

/** The value of `key`, or an error naming the variable (never its value). */
export function requireEnv(env: Env, key: string): string {
  const v = env[key];
  if (v === undefined || v.trim() === '') throw new Error(`Missing env ${key}`);
  return v;
}

/** Comma-separated list, trimmed, empties dropped. */
export function listEnv(env: Env, key: string): string[] {
  return (env[key] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
