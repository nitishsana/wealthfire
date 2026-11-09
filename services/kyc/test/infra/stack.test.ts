import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DEV_PREVIEW_ORIGIN, KycStack, PROD_ORIGIN, type Stage } from '../../infra/stack.js';

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

  it('creates the six tables, on-demand, PITR on, customer-managed KMS', () => {
    const tables = t.findResources('AWS::DynamoDB::Table');
    const names = Object.values(tables).map((r) => (r as { Properties: { TableName: string } }).Properties.TableName);
    expect(names.sort()).toEqual(
      ['audit', 'costs', 'kyc_cases', 'otp', 'sessions', 'users'].map((n) => `wealthfire-kyc-${stage}-${n}`).sort(),
    );
    for (const r of Object.values(tables)) {
      const res = r as { Properties: Record<string, unknown>; DeletionPolicy: string };
      expect(res.Properties.BillingMode).toBe('PAY_PER_REQUEST');
      expect(res.Properties.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
      expect(res.Properties.SSESpecification).toMatchObject({ SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: expect.anything() });
      expect(res.DeletionPolicy).toBe(retain);
    }
  });

  it('sets TTL on sessions and otp', () => {
    for (const n of ['sessions', 'otp']) {
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

  it('webhook role only touches kyc_cases and audit', () => {
    const policies = t.findResources('AWS::IAM::Policy');
    const webhook = Object.entries(policies).find(([id]) => id.startsWith('webhookFunction'));
    expect(webhook).toBeDefined();
    const json = JSON.stringify(webhook![1]);
    expect(json).toContain('KycCasesTable');
    expect(json).toContain('AuditTable');
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

describe('context', () => {
  it('DOC_RETENTION_DAYS overrides the lifecycle', () => {
    synth('dev', { DOC_RETENTION_DAYS: '365' }).hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 365 })]) },
    });
  });

  it('rejects a bad DOC_RETENTION_DAYS', () => {
    expect(() => synth('dev', { DOC_RETENTION_DAYS: 'abc' })).toThrow(/DOC_RETENTION_DAYS/);
  });
});
