import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  consoleCsp, DATA_KEY_VIA_SERVICES, DEV_PREVIEW_ORIGIN, KYC_REGION, KycStack, PROD_ORIGIN, WAVE4_ENV, type Stage,
} from '../../infra/stack.js';
import { ENV, TABLE_ENV } from '../../src/lib/env.js';
import { METRIC_NAMESPACE, OTP_FAILURE_METRIC, otpFailureEmf } from '../../src/lib/metrics.js';

const env = { account: '000000000000', region: 'ap-south-1' };

/** Every synth gets a budgetEmail (the stack requires one, S12) unless the test overrides it. */
function synth(stage: Stage, context: Record<string, unknown> = {}): Template {
  const app = new App({ context: { budgetEmail: 'alerts@example.com', ...context } });
  // A dist dir that never exists keeps tests on the inline placeholder (no asset bundling).
  const stack = new KycStack(app, `Test-${stage}`, { stage, env, distDir: '/nonexistent-dist' });
  return Template.fromStack(stack);
}

type Statement = { Action: string | string[]; Resource: unknown; Effect: string };
function inlineStatements(t: Template): Statement[] {
  const policies = t.findResources('AWS::IAM::Policy');
  return Object.values(policies).flatMap(
    (p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement,
  );
}

describe.each<Stage>(['dev', 'prod'])('KycStack %s', (stage) => {
  const t = synth(stage);
  const retain = stage === 'prod' ? 'Retain' : 'Delete';

  it('creates the eight tables, on-demand, PITR on, customer-managed KMS', () => {
    const tables = t.findResources('AWS::DynamoDB::Table');
    const names = Object.values(tables).map((r) => (r as { Properties: { TableName: string } }).Properties.TableName);
    expect(names.sort()).toEqual(
      ['audit', 'consents', 'costs', 'kyc_cases', 'otp', 'sessions', 'users', 'webhook_events']
        .map((n) => `wealthfire-kyc-${stage}-${n}`).sort(),
    );
    for (const r of Object.values(tables)) {
      const res = r as { Properties: Record<string, unknown>; DeletionPolicy: string };
      expect(res.Properties.BillingMode).toBe('PAY_PER_REQUEST');
      expect(res.Properties.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
      expect(res.Properties.SSESpecification).toMatchObject({ SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: expect.anything() });
      expect(res.DeletionPolicy).toBe(retain);
    }
  });

  it('sets TTL on sessions, otp, webhook_events, kyc_cases (idempotency rows, S18) and costs (sign# counters, S14)', () => {
    for (const n of ['sessions', 'otp', 'webhook_events', 'kyc_cases', 'costs']) {
      t.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: `wealthfire-kyc-${stage}-${n}`,
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      });
    }
  });

  it('docs bucket blocks public access, uses SSE-KMS, has lifecycle delete', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({ ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }) }),
        ],
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ Id: 'delete-after-retention', ExpirationInDays: 2555, Status: 'Enabled' })]),
      },
    });
  });

  it('docs bucket policy denies non-TLS access', () => {
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            Principal: { AWS: '*' },
          }),
        ]),
      },
    });
  });

  it('creates data, JWT (ECC P-256 sign) and HMAC keys', () => {
    t.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true, KeySpec: Match.absent() });
    t.hasResourceProperties('AWS::KMS::Key', { KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY' });
    t.hasResourceProperties('AWS::KMS::Key', { KeySpec: 'HMAC_256', KeyUsage: 'GENERATE_VERIFY_MAC' });
  });

  it('staff Cognito pool requires TOTP MFA, no self sign-up, has reviewer group', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'ON',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'reviewer' });
  });

  it('has api and webhook Lambdas on Node 22', () => {
    for (const n of ['api', 'webhook']) {
      t.hasResourceProperties('AWS::Lambda::Function', { FunctionName: `wealthfire-kyc-${stage}-${n}`, Runtime: 'nodejs22.x' });
    }
  });

  it('IAM: no wildcard actions, and data actions are scoped to named resources', () => {
    const statements = inlineStatements(t);
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      for (const a of actions) expect(a, `action ${a}`).not.toContain('*');
      expect(s.Resource, `resource for ${actions.join(',')}`).not.toBe('*');
      if (Array.isArray(s.Resource)) expect(s.Resource).not.toContain('*');
    }
  });

  it('webhook role only touches kyc_cases, audit and webhook_events', () => {
    const policies = t.findResources('AWS::IAM::Policy');
    const webhook = Object.entries(policies).find(([id]) => id.startsWith('webhookFunction'));
    expect(webhook).toBeDefined();
    const json = JSON.stringify(webhook![1]);
    expect(json).toContain('KycCasesTable');
    expect(json).toContain('AuditTable');
    expect(json).toContain('WebhookEventsTable');
    for (const other of ['UsersTable', 'SessionsTable', 'OtpTable', 'CostsTable', 'JwtSigningKey', 'HmacKey', 'PartnerCredentials']) {
      expect(json).not.toContain(other);
    }
  });

  it('WAF rate rule is attached to the API stage', () => {
    t.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      Rules: Match.arrayWith([Match.objectLike({ Statement: { RateBasedStatement: Match.objectLike({ AggregateKeyType: 'IP' }) } })]),
    });
    t.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  });

  it('CORS allows only the expected origins', () => {
    const json = JSON.stringify(t.toJSON());
    expect(json).toContain(PROD_ORIGIN);
    if (stage === 'dev') expect(json).toContain(DEV_PREVIEW_ORIGIN);
    else expect(json).not.toContain(DEV_PREVIEW_ORIGIN);
  });

  it('budget emails the configured address', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ TimeUnit: 'MONTHLY', BudgetType: 'COST' }),
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({ Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'alerts@example.com' }] }),
      ]),
    });
  });

  it('partner secrets exist with no literal value in the template', () => {
    t.resourceCountIs('AWS::SecretsManager::Secret', 2);
    for (const r of Object.values(t.findResources('AWS::SecretsManager::Secret'))) {
      expect((r as { Properties: Record<string, unknown> }).Properties.SecretString).toBeUndefined();
    }
  });
});

type Fn = { Properties: { FunctionName: string; Environment: { Variables: Record<string, unknown> } } };
function fnEnv(t: Template, name: string): Record<string, unknown> {
  const fns = Object.values(t.findResources('AWS::Lambda::Function')) as Fn[];
  return fns.find((f) => f.Properties.FunctionName.endsWith(`-${name}`))!.Properties.Environment.Variables;
}

describe.each<Stage>(['dev', 'prod'])('KycStack %s: wave 2.5 integration', (stage) => {
  const t = synth(stage);

  it('Lambda env uses only the shared names from src/lib/env.ts', () => {
    const allowed = new Set<string>([
      ...Object.values(ENV), ...Object.values(TABLE_ENV), ...Object.values(WAVE4_ENV), 'NODE_OPTIONS',
    ]);
    for (const name of ['api', 'webhook']) {
      for (const k of Object.keys(fnEnv(t, name))) expect(allowed.has(k), `${name} env ${k}`).toBe(true);
    }
    const api = fnEnv(t, 'api');
    for (const k of [
      TABLE_ENV.users, TABLE_ENV.sessions, TABLE_ENV.otp, TABLE_ENV.kycCases, TABLE_ENV.audit, TABLE_ENV.costs,
      WAVE4_ENV.consentsTable, WAVE4_ENV.fieldKeyId,
    ]) {
      expect(api[k], k).toBeDefined();
    }
    // dev partner pages: dev only
    if (stage === 'dev') {
      expect(api[ENV.webhookSecretArn]).toBeDefined();
      expect(JSON.stringify(api[WAVE4_ENV.apiBaseUrl])).toMatch(/execute-api.*\/dev\//);
    } else {
      expect(api[ENV.webhookSecretArn]).toBeUndefined();
      expect(api[WAVE4_ENV.apiBaseUrl]).toBeUndefined();
    }
    const webhook = fnEnv(t, 'webhook');
    expect(Object.keys(webhook).sort()).toEqual(
      [ENV.stage, TABLE_ENV.kycCases, TABLE_ENV.audit, TABLE_ENV.webhookEvents, ENV.webhookSecretArn, 'NODE_OPTIONS'].sort(),
    );
    expect(JSON.stringify(t.toJSON())).not.toMatch(/USERS_TABLE|SESSIONS_TABLE|OTP_TABLE|WEBHOOK_EVENTS_TABLE/);
  });

  it('return-URL allow-list: the app path and scheme (dev adds the local preview)', () => {
    const v = fnEnv(t, 'api')[ENV.returnUrlPrefixes];
    expect(v).toBe(stage === 'prod'
      ? 'https://nitishsana.github.io/wealthfire/,wealthfire://kyc-return'
      : 'https://nitishsana.github.io/wealthfire/,wealthfire://kyc-return,http://127.0.0.1:5180/');
  });

  it('kyc_cases has the byStatus GSI (status + updatedAt)', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: `wealthfire-kyc-${stage}-kyc_cases`,
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({
        IndexName: 'byStatus',
        KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }, { AttributeName: 'updatedAt', KeyType: 'RANGE' }],
      })]),
    });
  });

  it('console app client: code flow only, openid + email, public client (PKCE), Hosted UI domain', () => {
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: `wealthfire-kyc-${stage}-review-console`,
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ['openid', 'email'],
      SupportedIdentityProviders: ['COGNITO'],
      CallbackURLs: [Match.anyValue()],
      LogoutURLs: [Match.anyValue()],
      EnableTokenRevocation: true,
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: `wealthfire-kyc-${stage}-staff` });
  });

  it('console hosting: private bucket behind CloudFront with OAC, HTTPS only', () => {
    t.resourceCountIs('AWS::CloudFront::Distribution', 1);
    t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    t.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: 's3', SigningBehavior: 'always' }),
    });
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https', ResponseHeadersPolicyId: Match.anyValue() }),
        Origins: [Match.objectLike({ OriginAccessControlId: Match.anyValue(), S3OriginConfig: { OriginAccessIdentity: '' } })],
      }),
    });
    // the console bucket blocks all public access; only CloudFront (by distribution ARN) may read
    const policies = Object.values(t.findResources('AWS::S3::BucketPolicy')).map((p) => JSON.stringify(p));
    const consolePolicy = policies.find((p) => p.includes('cloudfront.amazonaws.com'));
    expect(consolePolicy).toBeDefined();
    expect(consolePolicy).toContain('AWS:SourceArn');
    expect(consolePolicy).toContain('s3:GetObject');
    const buckets = Object.values(t.findResources('AWS::S3::Bucket')) as { Properties: Record<string, unknown> }[];
    expect(buckets).toHaveLength(2);
    for (const b of buckets) {
      expect(b.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      });
    }
  });

  it('console response headers: CSP (frame-ancestors none, API + Cognito only), HSTS, nosniff, DENY', () => {
    const [policy] = Object.values(t.findResources('AWS::CloudFront::ResponseHeadersPolicy')) as {
      Properties: { ResponseHeadersPolicyConfig: { SecurityHeadersConfig: Record<string, any> } };
    }[];
    const sec = policy!.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
    const csp = JSON.stringify(sec.ContentSecurityPolicy.ContentSecurityPolicy);
    for (const d of ["default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) {
      expect(csp).toContain(d);
    }
    expect(csp).toContain('.execute-api.');
    expect(csp).toContain(`wealthfire-kyc-${stage}-staff.auth.`);
    expect(csp).toContain('.amazoncognito.com');
    expect(sec.ContentSecurityPolicy.Override).toBe(true);
    expect(sec.StrictTransportSecurity).toMatchObject({ AccessControlMaxAgeSec: 63072000, IncludeSubdomains: true, Override: true });
    expect(sec.ContentTypeOptions).toEqual({ Override: true });
    expect(sec.FrameOptions).toEqual({ FrameOption: 'DENY', Override: true });
  });

  it('docs bucket CORS adds the console origin (GET only); the API CORS allows it too', () => {
    const docs = Object.values(t.findResources('AWS::S3::Bucket')).find(
      (b) => (b as { Properties: { CorsConfiguration?: unknown } }).Properties.CorsConfiguration,
    ) as { Properties: { CorsConfiguration: { CorsRules: { Id: string; AllowedMethods: string[]; AllowedOrigins: unknown[] }[] } } };
    const rules = docs.Properties.CorsConfiguration.CorsRules;
    expect(rules.map((r) => r.Id)).toEqual(['apps', 'review-console']);
    const consoleRule = rules[1]!;
    expect(consoleRule.AllowedMethods).toEqual(['GET']);
    expect(JSON.stringify(consoleRule.AllowedOrigins)).toContain('ConsoleDistribution');
    expect(JSON.stringify(fnEnv(t, 'api')[ENV.allowedOrigins])).toContain('ConsoleDistribution');
  });

  it('API role: s3:ListBucket on the docs bucket, prefix kyc/ only; audit table read/write', () => {
    const statements = inlineStatements(t) as (Statement & { Sid?: string; Condition?: unknown })[];
    const list = statements.find((s) => s.Sid === 'DocsList');
    expect(list).toMatchObject({ Action: 's3:ListBucket', Condition: { StringLike: { 's3:prefix': ['kyc/*'] } } });
    expect(JSON.stringify(list!.Resource)).toContain('DocsBucket');
    const apiPolicy = Object.entries(t.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('apiFunction'))!;
    const json = JSON.stringify(apiPolicy[1]);
    expect(json).toContain('AuditTable');
    for (const a of ['dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem']) expect(json).toContain(a);
    // no OTP delivery permissions without OTP context
    expect(json).not.toContain('sns:Publish');
    expect(json).not.toContain('ses:SendEmail');
  });

  it('consoleCsp matches the review console build (plus frame-ancestors)', () => {
    expect(consoleCsp('https://a.example', 'https://b.example')).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src https://a.example https://b.example; "
      + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
    );
  });
});

describe('context', () => {
  it('OTP senders: env + least-privilege IAM only when configured', () => {
    const t = synth('prod', {
      otpSmsSenderId: 'WLTHFR', otpSmsTemplateId: '1107000000000', otpEmailFrom: 'no-reply@wealthfire.example',
    });
    const env = fnEnv(t, 'api');
    expect(env).toMatchObject({
      [ENV.smsSenderId]: 'WLTHFR', [ENV.smsTemplateId]: '1107000000000', [ENV.emailFrom]: 'no-reply@wealthfire.example',
    });
    expect(env[ENV.smsEntityId]).toBeUndefined();
    const statements = inlineStatements(t) as (Statement & { Sid?: string; NotResource?: unknown; Condition?: unknown })[];
    const sms = statements.find((s) => s.Sid === 'OtpSms')!;
    expect(sms).toMatchObject({ Action: 'sns:Publish', NotResource: 'arn:aws:sns:*:*:*' });
    expect(sms.Resource).toBeUndefined(); // SMS only: no topic / endpoint ARN can match
    const email = statements.find((s) => s.Sid === 'OtpEmail')!;
    expect(email).toMatchObject({ Action: 'ses:SendEmail', Condition: { StringEquals: { 'ses:FromAddress': 'no-reply@wealthfire.example' } } });
    const res = JSON.stringify(email.Resource);
    expect(res).toContain('identity/no-reply@wealthfire.example');
    expect(res).toContain('identity/wealthfire.example');
  });

  it('rejects bad OTP context values', () => {
    expect(() => synth('dev', { otpSmsSenderId: 'has space' })).toThrow(/otpSmsSenderId/);
    expect(() => synth('dev', { otpEmailFrom: 'not-an-email' })).toThrow(/otpEmailFrom/);
  });

  it('console callback / logout URLs and Hosted UI prefix from context', () => {
    const t = synth('prod', {
      consoleCallbackUrls: 'https://review.wealthfire.example/', consoleLogoutUrls: ['https://review.wealthfire.example/bye'],
      cognitoDomainPrefix: 'wf-review-prod',
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: ['https://review.wealthfire.example/'], LogoutURLs: ['https://review.wealthfire.example/bye'],
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'wf-review-prod' });
    const json = JSON.stringify(t.toJSON());
    expect(json).toContain('https://review.wealthfire.example'); // CORS uses the context origin
    expect(String(fnEnv(t, 'api')[ENV.allowedOrigins])).toBe(`${PROD_ORIGIN},https://review.wealthfire.example`);
  });

  it('refuses non-https console URLs on prod (local http allowed on dev) and bad domain prefixes', () => {
    expect(() => synth('prod', { consoleCallbackUrls: 'http://127.0.0.1:5181/' })).toThrow(/consoleCallbackUrls/);
    expect(() => synth('dev', { consoleCallbackUrls: 'http://127.0.0.1:5181/' })).not.toThrow();
    expect(() => synth('dev', { consoleCallbackUrls: 'http://evil.example/' })).toThrow(/consoleCallbackUrls/);
    expect(() => synth('dev', { consoleLogoutUrls: 'not a url' })).toThrow(/consoleLogoutUrls/);
    for (const p of ['Upper', 'has_underscore', 'my-cognito-x', '-lead']) {
      expect(() => synth('dev', { cognitoDomainPrefix: p }), p).toThrow(/cognitoDomainPrefix/);
    }
  });

  it('DOC_RETENTION_DAYS overrides the lifecycle', () => {
    synth('dev', { DOC_RETENTION_DAYS: '365' }).hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 365 })]) },
    });
  });

  it('rejects a bad DOC_RETENTION_DAYS', () => {
    expect(() => synth('dev', { DOC_RETENTION_DAYS: 'abc' })).toThrow(/DOC_RETENTION_DAYS/);
  });
});

// ---------------- wave 4 (security review S1, S2, S5, S7, S9-S13, S18) ----------------

type Res = { Properties: Record<string, any> };
function byId(t: Template, type: string, idPrefix: string): Res {
  const hit = Object.entries(t.findResources(type)).find(([id]) => id.startsWith(idPrefix));
  expect(hit, `${type} ${idPrefix}`).toBeDefined();
  return hit![1] as Res;
}
function policyOf(t: Template, fnPrefix: 'apiFunction' | 'webhookFunction'): (Statement & { Sid?: string; Condition?: any })[] {
  return byId(t, 'AWS::IAM::Policy', fnPrefix).Properties.PolicyDocument.Statement;
}
const asList = (a: string | string[]) => (Array.isArray(a) ? a : [a]);

describe('S1 region', () => {
  it('the app pins both stacks to ap-south-1 even when the CLI region differs', async () => {
    const { buildApp } = await import('../../infra/build.js');
    const before = process.env.CDK_DEFAULT_REGION;
    process.env.CDK_DEFAULT_REGION = 'us-east-1';
    try {
      const stacks = buildApp(new App({ context: { budgetEmail: 'alerts@example.com' } }), '000000000000');
      expect(stacks.map((s) => s.stackName).sort()).toEqual(['WealthfireKyc-dev', 'WealthfireKyc-prod']);
      for (const s of stacks) expect(s.region).toBe(KYC_REGION);
    } finally {
      if (before === undefined) delete process.env.CDK_DEFAULT_REGION;
      else process.env.CDK_DEFAULT_REGION = before;
    }
  });

  it('a stack in any other region, or with no region, fails synth', () => {
    for (const region of ['us-east-1', 'ap-south-2', undefined]) {
      expect(() => new KycStack(new App(), `R-${region}`, { stage: 'dev', env: { account: '000000000000', region }, distDir: '/nonexistent-dist' }))
        .toThrow(/ap-south-1/);
    }
  });
});

describe.each<Stage>(['dev', 'prod'])('KycStack %s: wave 4', (stage) => {
  const t = synth(stage);
  const api = () => policyOf(t, 'apiFunction');
  const webhook = () => policyOf(t, 'webhookFunction');

  it('S2: consents table pk userId, sk sk; api env + append-only access (S6); webhook has none', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: `wealthfire-kyc-${stage}-consents`,
      KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    });
    expect(JSON.stringify(fnEnv(t, 'api')[WAVE4_ENV.consentsTable])).toContain('ConsentsTable');
    expect(JSON.stringify(api().find((s) => s.Sid === 'ConsentsAppend')!.Resource)).toContain('ConsentsTable');
    expect(JSON.stringify(webhook())).not.toContain('ConsentsTable');
    expect(fnEnv(t, 'webhook')[WAVE4_ENV.consentsTable]).toBeUndefined();
  });

  it('S7: gateway preflight allows DELETE and the four headers, with credentials', () => {
    const options = Object.values(t.findResources('AWS::ApiGateway::Method')).filter(
      (m) => (m as Res).Properties.HttpMethod === 'OPTIONS',
    ) as Res[];
    expect(options.length).toBeGreaterThan(0);
    for (const m of options) {
      const params = m.Properties.Integration.IntegrationResponses[0].ResponseParameters;
      expect(params['method.response.header.Access-Control-Allow-Headers'])
        .toBe("'content-type,authorization,idempotency-key,x-wf-client'");
      expect(params['method.response.header.Access-Control-Allow-Methods']).toBe("'GET,POST,DELETE,OPTIONS'");
      expect(params['method.response.header.Access-Control-Allow-Credentials']).toBe("'true'");
    }
  });

  it('S9: field key with explicit policy: api role only, purpose context required, webhook denied', () => {
    const key = byId(t, 'AWS::KMS::Key', 'FieldKey');
    expect(key.Properties.EnableKeyRotation).toBe(true);
    const st = key.Properties.KeyPolicy.Statement as { Sid: string; Effect: string; Action: string | string[]; Principal: any; Condition?: any }[];
    const sids = st.map((s) => s.Sid);
    expect(sids).toEqual(['KeyAdministration', 'ApiRoleUseWithContext', 'ApiRoleDescribe', 'DenyWithoutContext', 'DenyWebhookRole']);
    // the account can administer but IAM cannot grant data-plane use
    const admin = asList(st[0]!.Action);
    for (const a of ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey', 'kms:*']) expect(admin).not.toContain(a);
    const use = st[1]!;
    expect(JSON.stringify(use.Principal)).toContain('apiFunctionServiceRole');
    expect(use.Condition).toEqual({ StringEquals: { 'kms:EncryptionContext:purpose': ['pan', 'contact'] } });
    expect(st[3]).toMatchObject({ Effect: 'Deny', Principal: { AWS: '*' }, Condition: { Null: { 'kms:EncryptionContext:purpose': 'true' } } });
    expect(st[4]!.Effect).toBe('Deny');
    expect(JSON.stringify(st[4]!.Principal)).toContain('webhookFunctionServiceRole');
    expect(asList(st[4]!.Action)).toContain('kms:Decrypt');
    // api env + IAM with the same context condition
    expect(JSON.stringify(fnEnv(t, 'api')[WAVE4_ENV.fieldKeyId])).toContain('FieldKey');
    expect(api().find((s) => s.Sid === 'FieldKey')).toMatchObject({
      Effect: 'Allow', Condition: { StringEquals: { 'kms:EncryptionContext:purpose': ['pan', 'contact'] } },
    });
    // webhook: explicit Deny, no Allow on the field key, no env
    const wh = webhook();
    expect(wh.find((s) => s.Sid === 'NoFieldKey')).toMatchObject({ Effect: 'Deny' });
    for (const s of wh.filter((x) => x.Effect === 'Allow')) expect(JSON.stringify(s.Resource)).not.toContain('FieldKey');
    expect(fnEnv(t, 'webhook')[WAVE4_ENV.fieldKeyId]).toBeUndefined();
  });

  it('S9: every key has an explicit policy without kms:*; tables and docs stay on DataKey', () => {
    for (const [id, k] of Object.entries(t.findResources('AWS::KMS::Key'))) {
      const actions = ((k as Res).Properties.KeyPolicy.Statement as { Action: string | string[] }[]).flatMap((s) => asList(s.Action));
      expect(actions, id).not.toContain('kms:*');
    }
    const data = JSON.stringify(byId(t, 'AWS::KMS::Key', 'DataKey').Properties.KeyPolicy);
    expect(data).toContain('kms:GrantIsForAWSResource');
    for (const r of Object.values(t.findResources('AWS::DynamoDB::Table'))) {
      expect(JSON.stringify((r as Res).Properties.SSESpecification)).toContain('DataKey');
    }
    expect(JSON.stringify(t.findResources('AWS::S3::Bucket'))).toContain('DataKey');
    expect(fnEnv(t, 'api')[ENV.dataKeyId]).toBeDefined();
  });

  it('S10: audit is PutItem + Query only for both roles, with explicit Deny on changes', () => {
    for (const p of [api(), webhook()]) {
      const allowsAudit = p.filter((s) => s.Effect === 'Allow' && JSON.stringify(s.Resource).includes('AuditTable'));
      expect(allowsAudit).toHaveLength(1);
      expect(asList(allowsAudit[0]!.Action).sort()).toEqual(['dynamodb:PutItem', 'dynamodb:Query']);
      const deny = p.find((s) => s.Sid === 'AuditNoChange')!;
      expect(deny.Effect).toBe('Deny');
      expect(asList(deny.Action).sort()).toEqual(['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem']);
      expect(JSON.stringify(deny.Resource)).toContain('AuditTable');
    }
  });

  it('S11: pending uploads expire after a day; S3 CORS + IAM allow tagging', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({
          Id: 'delete-unlinked-uploads', Status: 'Enabled', ExpirationInDays: 1, TagFilters: [{ Key: 'state', Value: 'pending' }],
        })]),
      },
      CorsConfiguration: {
        CorsRules: Match.arrayWith([Match.objectLike({ Id: 'apps', AllowedHeaders: Match.arrayWith(['x-amz-tagging', 'if-none-match']) })]),
      },
    });
    expect(asList(api().find((s) => s.Sid === 'DocsPrefix')!.Action)).toContain('s3:PutObjectTagging');
  });

  it('S12: WAF OTP rule (20 / 5 min / IP, /auth/otp/), general rate rule, two AWS managed groups', () => {
    const acl = byId(t, 'AWS::WAFv2::WebACL', 'ApiWaf');
    const rules = acl.Properties.Rules as any[];
    const otp = rules.find((r) => r.Name === 'otp-rate-per-ip');
    expect(otp.Action).toEqual({ Block: {} });
    expect(otp.Statement.RateBasedStatement).toMatchObject({ AggregateKeyType: 'IP', Limit: 20, EvaluationWindowSec: 300 });
    expect(otp.Statement.RateBasedStatement.ScopeDownStatement.ByteMatchStatement).toMatchObject({
      SearchString: '/auth/otp/', FieldToMatch: { UriPath: {} }, PositionalConstraint: 'CONTAINS',
    });
    expect(rules.find((r) => r.Name === 'rate-per-ip')).toBeDefined();
    const managed = rules.filter((r) => r.Statement.ManagedRuleGroupStatement).map((r) => r.Statement.ManagedRuleGroupStatement.Name);
    expect(managed.sort()).toEqual(['AWSManagedRulesCommonRuleSet', 'AWSManagedRulesKnownBadInputsRuleSet']);
    for (const r of rules.filter((x) => x.Statement.ManagedRuleGroupStatement)) expect(r.OverrideAction).toEqual({ None: {} });
    expect(new Set(rules.map((r) => r.Priority)).size).toBe(rules.length);
  });

  it('S12: SMS spend alarm emails budgetEmail via SNS', () => {
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/SNS', MetricName: 'SMSMonthToDateSpentUSD', Threshold: 5, ComparisonOperator: 'GreaterThanThreshold',
      AlarmActions: [Match.objectLike({ Ref: Match.stringLikeRegexp('CostAlarmTopic') })],
    });
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'alerts@example.com' });
  });

  it('S18: DeleteObject is a separate api-only statement on kyc/*; webhook has no S3', () => {
    const del = api().filter((s) => asList(s.Action).includes('s3:DeleteObject'));
    expect(del).toHaveLength(1);
    expect(del[0]).toMatchObject({ Sid: 'DocsDelete', Action: 's3:DeleteObject' });
    expect(JSON.stringify(del[0]!.Resource)).toContain('/kyc/*');
    expect(JSON.stringify(webhook())).not.toMatch(/"s3:/);
  });

  it('S13: no custom domains without context', () => {
    t.resourceCountIs('AWS::ApiGateway::DomainName', 0);
    const dist = byId(t, 'AWS::CloudFront::Distribution', 'ConsoleDistribution');
    expect(dist.Properties.DistributionConfig.Aliases).toBeUndefined();
  });
});

describe('wave 4 context', () => {
  const API_CERT = 'arn:aws:acm:ap-south-1:000000000000:certificate/11111111-2222-3333-4444-555555555555';
  const CF_CERT = 'arn:aws:acm:us-east-1:000000000000:certificate/11111111-2222-3333-4444-555555555555';
  const base = { budgetEmail: 'alerts@example.com' };

  it('S5: appOrigin replaces the default app origins in API and docs CORS', () => {
    for (const stage of ['dev', 'prod'] as Stage[]) {
      const t = synth(stage, { ...base, appOrigin: 'https://app.wealthfire.example' });
      // a Fn::Join (the console origin is a token)
      const origins = JSON.stringify(fnEnv(t, 'api')[ENV.allowedOrigins]);
      expect(origins).toContain('"https://app.wealthfire.example,https://"');
      expect(origins).not.toContain(PROD_ORIGIN);
      expect(origins).not.toContain(DEV_PREVIEW_ORIGIN);
      const docs = Object.values(t.findResources('AWS::S3::Bucket')).find((b) => (b as Res).Properties.CorsConfiguration) as Res;
      expect(docs.Properties.CorsConfiguration.CorsRules[0].AllowedOrigins).toEqual(['https://app.wealthfire.example']);
    }
  });

  it('S5: rejects a bad appOrigin (path, http on prod, junk)', () => {
    expect(() => synth('prod', { ...base, appOrigin: 'https://app.example/path' })).toThrow(/appOrigin/);
    expect(() => synth('prod', { ...base, appOrigin: 'http://127.0.0.1:5180' })).toThrow(/appOrigin/);
    expect(() => synth('dev', { ...base, appOrigin: 'http://127.0.0.1:5180' })).not.toThrow();
    expect(() => synth('dev', { ...base, appOrigin: 'not a url' })).toThrow(/appOrigin/);
  });

  it('S13: custom API domain (TLS_1_2, regional, mapped) and console domain (TLSv1.2_2021)', () => {
    const t = synth('prod', {
      ...base, apiDomain: 'api.wealthfire.example', apiCertArn: API_CERT,
      consoleDomain: 'review.wealthfire.example', consoleCertArn: CF_CERT,
    });
    t.hasResourceProperties('AWS::ApiGateway::DomainName', {
      DomainName: 'api.wealthfire.example', SecurityPolicy: 'TLS_1_2',
      EndpointConfiguration: { Types: ['REGIONAL'] }, RegionalCertificateArn: API_CERT,
    });
    t.resourceCountIs('AWS::ApiGateway::BasePathMapping', 1);
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['review.wealthfire.example'],
        ViewerCertificate: Match.objectLike({ AcmCertificateArn: CF_CERT, MinimumProtocolVersion: 'TLSv1.2_2021' }),
      }),
    });
    // console callback + CORS use the custom console domain; CSP allows the custom API origin
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', { CallbackURLs: ['https://review.wealthfire.example/'] });
    expect(String(fnEnv(t, 'api')[ENV.allowedOrigins])).toBe(`${PROD_ORIGIN},https://review.wealthfire.example`);
    expect(JSON.stringify(t.findResources('AWS::CloudFront::ResponseHeadersPolicy'))).toContain('https://api.wealthfire.example');
  });

  it('S13: domain and certificate must come together, certs in the right region', () => {
    expect(() => synth('dev', { ...base, apiDomain: 'api.wealthfire.example' })).toThrow(/apiCertArn/);
    expect(() => synth('dev', { ...base, consoleCertArn: CF_CERT })).toThrow(/consoleDomain/);
    expect(() => synth('dev', { ...base, apiDomain: 'api.wealthfire.example', apiCertArn: CF_CERT })).toThrow(/apiCertArn/);
    expect(() => synth('dev', { ...base, consoleDomain: 'review.wealthfire.example', consoleCertArn: API_CERT })).toThrow(/consoleCertArn/);
    expect(() => synth('dev', { ...base, apiDomain: 'Not_A_Host', apiCertArn: API_CERT })).toThrow(/apiDomain/);
  });

  it('S18/S12: synth without budgetEmail throws unless synthOnly=true (then warns, no subscription); a bad one fails', () => {
    for (const context of [{}, { budgetEmail: '' }, { synthOnly: 'false' }, { synthOnly: 'yes' }]) {
      expect(() => new KycStack(new App({ context }), 'NoEmail', { stage: 'dev', env, distDir: '/nonexistent-dist' }), JSON.stringify(context))
        .toThrow(/budgetEmail.*synthOnly=true/);
    }
    for (const synthOnly of ['true', true]) {
      const app = new App({ context: { synthOnly } });
      const stack = new KycStack(app, 'NoEmail', { stage: 'dev', env, distDir: '/nonexistent-dist' });
      const t = Template.fromStack(stack);
      t.resourceCountIs('AWS::SNS::Subscription', 0);
      const warnings = app.synth().getStackArtifact(stack.artifactId).messages.filter((m) => m.level === 'warning');
      expect(warnings.map((w) => String(w.entry.data)).join('\n')).toContain('budgetEmail');
    }
    expect(() => synth('dev', { budgetEmail: 'nope' })).toThrow(/budgetEmail/);
    expect(() => synth('dev', { budgetEmail: 'nope', synthOnly: 'true' })).toThrow(/budgetEmail/);
  });

  it('S12: the synth script passes synthOnly=true (and deploy has no synthOnly)', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.synth).toContain('-c synthOnly=true');
    expect(pkg.scripts.deploy).not.toContain('synthOnly');
  });

  it('S12: smsSpendAlarmUsd sets the alarm threshold', () => {
    synth('dev', { ...base, smsSpendAlarmUsd: '12' }).hasResourceProperties('AWS::CloudWatch::Alarm', { Threshold: 12 });
  });
});

describe('S18 deploy guard', () => {
  it('refuses without a valid budgetEmail, accepts each context form', async () => {
    const { deployRefusal, contextArgs, ACCOUNT_STEPS } = await import('../../infra/deploy.js');
    expect(deployRefusal(['WealthfireKyc-dev'])).toMatch(/budgetEmail/);
    expect(deployRefusal(['-c', 'budgetEmail='])).toMatch(/budgetEmail/);
    expect(deployRefusal(['-c', 'budgetEmail=nope'])).toMatch(/not a valid/);
    expect(deployRefusal(['WealthfireKyc-dev', '-c', 'budgetEmail=a@example.com'])).toBeNull();
    expect(deployRefusal(['--context', 'budgetEmail=a@example.com'])).toBeNull();
    expect(deployRefusal(['--context=budgetEmail=a@example.com'])).toBeNull();
    expect(contextArgs(['-c', 'a=1', '--context=b=2=3'])).toEqual({ a: '1', b: '2=3' });
    expect(ACCOUNT_STEPS.join(' ')).toMatch(/SMS spend limit/);
    expect(ACCOUNT_STEPS.join(' ')).toMatch(/GuardDuty/);
  });

  it('S12: refuses synthOnly in any context form', async () => {
    const { deployRefusal } = await import('../../infra/deploy.js');
    const email = ['-c', 'budgetEmail=a@example.com'];
    expect(deployRefusal([...email, '-c', 'synthOnly=true'])).toMatch(/synthOnly/);
    expect(deployRefusal([...email, '--context', 'synthOnly=false'])).toMatch(/synthOnly/);
    expect(deployRefusal([...email, '--context=synthOnly=true'])).toMatch(/synthOnly/);
  });

  it('S12: cdk deploy runs with no shell: this Node + the local aws-cdk bin, args passed verbatim', async () => {
    const { deployCommand, CDK_APP } = await import('../../infra/deploy.js');
    const hostile = ['WealthfireKyc-dev', '-c', 'budgetEmail=a@example.com', '&', 'calc.exe', '$(rm -rf /)', '"; whoami'];
    const cmd = deployCommand(hostile, '/x/aws-cdk/bin/cdk');
    expect(cmd.options.shell).toBe(false);
    expect(cmd.command).toBe(process.execPath);
    expect(cmd.args).toEqual(['/x/aws-cdk/bin/cdk', 'deploy', '--app', CDK_APP, ...hostile]);
    expect(CDK_APP).toBe('npx tsx infra/app.ts'); // one argv entry, no shell quoting
    // the default resolves the installed aws-cdk bin (no npx / .cmd, which needs a shell on Windows)
    const real = deployCommand([]);
    expect(real.args[0]!.replace(/\\/g, '/')).toMatch(/node_modules\/aws-cdk\/bin\/cdk$/);
    expect(real.command).not.toMatch(/npx/);
  });

  it('S12: deploy.ts source never enables a shell', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../infra/deploy.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/shell:\s*true/);
  });
});

// ---------------- wave 4b (security re-check #6, #7, #8, #12, #13, #14) ----------------

describe.each<Stage>(['dev', 'prod'])('KycStack %s: wave 4b', (stage) => {
  const t = synth(stage);
  const api = () => policyOf(t, 'apiFunction');
  const webhook = () => policyOf(t, 'webhookFunction');

  it('#6: consents are PutItem + Query only for the api role, explicit Deny on changes', () => {
    const allows = api().filter((s) => s.Effect === 'Allow' && JSON.stringify(s.Resource).includes('ConsentsTable'));
    expect(allows).toHaveLength(1);
    expect(allows[0]!.Sid).toBe('ConsentsAppend');
    expect(asList(allows[0]!.Action).sort()).toEqual(['dynamodb:PutItem', 'dynamodb:Query']);
    const deny = api().find((s) => s.Sid === 'ConsentsNoChange')!;
    expect(deny.Effect).toBe('Deny');
    expect(asList(deny.Action).sort()).toEqual(['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem']);
    expect(JSON.stringify(deny.Resource)).toContain('ConsentsTable');
    expect(JSON.stringify(api().find((s) => s.Sid === 'TablesReadWrite')!.Resource)).not.toContain('ConsentsTable');
    expect(JSON.stringify(webhook())).not.toContain('ConsentsTable');
  });

  it('#8: APP_ORIGINS is the app origins only (no console); ALLOWED_ORIGINS still has the console', () => {
    const e = fnEnv(t, 'api');
    expect(e[WAVE4_ENV.appOrigins]).toBe(stage === 'prod' ? PROD_ORIGIN : `${PROD_ORIGIN},${DEV_PREVIEW_ORIGIN}`);
    expect(JSON.stringify(e[ENV.allowedOrigins])).toContain('ConsoleDistribution');
    expect(fnEnv(t, 'webhook')[WAVE4_ENV.appOrigins]).toBeUndefined();
  });

  it('#13: DataKey use by both roles only via DynamoDB / S3 / Secrets Manager in ap-south-1', () => {
    expect(DATA_KEY_VIA_SERVICES).toEqual([
      'dynamodb.ap-south-1.amazonaws.com', 's3.ap-south-1.amazonaws.com', 'secretsmanager.ap-south-1.amazonaws.com',
    ]);
    for (const p of [api(), webhook()]) {
      const onDataKey = p.filter((s) => s.Effect === 'Allow' && JSON.stringify(s.Resource).includes('DataKey'));
      expect(onDataKey).toHaveLength(1);
      expect(onDataKey[0]!.Sid).toBe('DataKey');
      expect(asList(onDataKey[0]!.Action)).toContain('kms:Decrypt');
      expect(onDataKey[0]!.Condition).toEqual({ StringEquals: { 'kms:ViaService': DATA_KEY_VIA_SERVICES } });
    }
  });

  it('#14: costs table expires rows by expiresAt', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: `wealthfire-kyc-${stage}-costs`,
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  it('#7: lockout alarm on OtpFailures Reason=lockout-started (Sum >= 5 per hour) emails via the alarm topic', () => {
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: `wealthfire-kyc-${stage}-otp-lockouts`,
      Namespace: 'Wealthfire/Kyc',
      MetricName: 'OtpFailures',
      Dimensions: [{ Name: 'Reason', Value: 'lockout-started' }],
      Statistic: 'Sum',
      Period: 3600,
      Threshold: 5,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: [Match.objectLike({ Ref: Match.stringLikeRegexp('CostAlarmTopic') })],
    });
  });
});

describe('wave 4b context', () => {
  it('#8: appOrigin is the only APP_ORIGINS value (dev too: no local preview)', () => {
    for (const stage of ['dev', 'prod'] as Stage[]) {
      const e = fnEnv(synth(stage, { appOrigin: 'https://app.wealthfire.example' }), 'api');
      expect(e[WAVE4_ENV.appOrigins]).toBe('https://app.wealthfire.example');
    }
  });

  it('#8: a custom console domain never reaches APP_ORIGINS', () => {
    const e = fnEnv(synth('prod', { consoleCallbackUrls: 'https://review.wealthfire.example/' }), 'api');
    expect(e[WAVE4_ENV.appOrigins]).toBe(PROD_ORIGIN);
    expect(e[ENV.allowedOrigins]).toBe(`${PROD_ORIGIN},https://review.wealthfire.example`);
  });

  it('#7: lockoutAlarmCount sets the threshold; a bad one fails', () => {
    synth('dev', { lockoutAlarmCount: '20' }).hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'OtpFailures', Threshold: 20,
    });
    expect(() => synth('dev', { lockoutAlarmCount: 'x' })).toThrow(/lockoutAlarmCount/);
  });

  it('#7: alarm metric matches the EMF the api Lambda writes (src/lib/metrics.ts)', () => {
    const emf = otpFailureEmf({ reason: 'lockout-started' }, 0) as {
      _aws: { CloudWatchMetrics: { Namespace: string; Dimensions: string[][]; Metrics: { Name: string }[] }[] }; Reason: string;
    };
    const m = emf._aws.CloudWatchMetrics[0]!;
    expect(m.Namespace).toBe(METRIC_NAMESPACE);
    expect(m.Namespace).toBe('Wealthfire/Kyc');
    expect(m.Metrics[0]!.Name).toBe(OTP_FAILURE_METRIC);
    expect(m.Dimensions).toEqual([['Reason']]);
    expect(emf.Reason).toBe('lockout-started');
  });
});
