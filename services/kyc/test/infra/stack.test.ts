import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { consoleCsp, DEV_PREVIEW_ORIGIN, KycStack, PROD_ORIGIN, type Stage } from '../../infra/stack.js';
import { ENV, TABLE_ENV } from '../../src/lib/env.js';

const env = { account: '000000000000', region: 'ap-south-1' };

function synth(stage: Stage, context: Record<string, unknown> = { budgetEmail: 'alerts@example.com' }): Template {
  const app = new App({ context });
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

  it('creates the seven tables, on-demand, PITR on, customer-managed KMS', () => {
    const tables = t.findResources('AWS::DynamoDB::Table');
    const names = Object.values(tables).map((r) => (r as { Properties: { TableName: string } }).Properties.TableName);
    expect(names.sort()).toEqual(
      ['audit', 'costs', 'kyc_cases', 'otp', 'sessions', 'users', 'webhook_events'].map((n) => `wealthfire-kyc-${stage}-${n}`).sort(),
    );
    for (const r of Object.values(tables)) {
      const res = r as { Properties: Record<string, unknown>; DeletionPolicy: string };
      expect(res.Properties.BillingMode).toBe('PAY_PER_REQUEST');
      expect(res.Properties.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
      expect(res.Properties.SSESpecification).toMatchObject({ SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: expect.anything() });
      expect(res.DeletionPolicy).toBe(retain);
    }
  });

  it('sets TTL on sessions, otp and webhook_events', () => {
    for (const n of ['sessions', 'otp', 'webhook_events']) {
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
    const allowed = new Set<string>([...Object.values(ENV), ...Object.values(TABLE_ENV), 'NODE_OPTIONS']);
    for (const name of ['api', 'webhook']) {
      for (const k of Object.keys(fnEnv(t, name))) expect(allowed.has(k), `${name} env ${k}`).toBe(true);
    }
    const api = fnEnv(t, 'api');
    for (const k of [TABLE_ENV.users, TABLE_ENV.sessions, TABLE_ENV.otp, TABLE_ENV.kycCases, TABLE_ENV.audit, TABLE_ENV.costs]) {
      expect(api[k], k).toBeDefined();
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
      ? 'https://nitishsana.github.io/wealthfire/,wealthfire://'
      : 'https://nitishsana.github.io/wealthfire/,wealthfire://,http://127.0.0.1:5180/');
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
