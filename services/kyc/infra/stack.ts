// Wealthfire final KYC service stack (design §1, §2, §7, §8).
// One stack per environment (dev, prod) in ap-south-1. Synth only: deploying needs Nitish's OK.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Annotations,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_apigateway as apigw,
  aws_budgets as budgets,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_wafv2 as wafv2,
  CfnOutput,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export type Stage = 'dev' | 'prod';

export interface KycStackProps extends StackProps {
  stage: Stage;
  /** Directory holding dist/<lambda>/index.mjs. Defaults to services/kyc/dist. */
  distDir?: string;
}

/** Web app origin (GitHub Pages). */
export const PROD_ORIGIN = 'https://nitishsana.github.io';
/** Local preview origin, allowed in dev only. */
export const DEV_PREVIEW_ORIGIN = 'http://127.0.0.1:5180';
/** S3 key prefix under which the api Lambda may read and write KYC documents. */
export const DOCS_PREFIX = 'kyc/';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = join(here, '..', 'dist');

/** Reads a numeric context value, or returns the fallback. Throws on a non-number. */
function numberContext(scope: Construct, key: string, fallback: number): number {
  const raw: unknown = scope.node.tryGetContext(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Context "${key}" must be a positive number, got "${String(raw)}"`);
  return n;
}

export class KycStack extends Stack {
  constructor(scope: Construct, id: string, props: KycStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const isProd = stage === 'prod';
    const removalPolicy = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const prefix = `wealthfire-kyc-${stage}`;
    const allowedOrigins = isProd ? [PROD_ORIGIN] : [PROD_ORIGIN, DEV_PREVIEW_ORIGIN];

    // ---------- KMS keys (one set per environment) ----------
    const dataKey = new kms.Key(this, 'DataKey', {
      alias: `alias/${prefix}-data`,
      description: `Wealthfire KYC ${stage}: encrypts tables, documents and secrets`,
      enableKeyRotation: true,
      removalPolicy,
    });
    const jwtKey = new kms.Key(this, 'JwtSigningKey', {
      alias: `alias/${prefix}-jwt`,
      description: `Wealthfire KYC ${stage}: signs user access tokens (ES256)`,
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      removalPolicy,
    });
    const hmacKey = new kms.Key(this, 'HmacKey', {
      alias: `alias/${prefix}-hmac`,
      description: `Wealthfire KYC ${stage}: keyed lookup hashes (PAN, contact)`,
      keySpec: kms.KeySpec.HMAC_256,
      keyUsage: kms.KeyUsage.GENERATE_VERIFY_MAC,
      removalPolicy,
    });

    // ---------- DynamoDB tables (design §2) ----------
    const table = (
      id: string,
      name: string,
      partitionKey: string,
      sortKey?: string,
      ttl?: string,
    ): dynamodb.Table =>
      new dynamodb.Table(this, id, {
        tableName: `${prefix}-${name}`,
        partitionKey: { name: partitionKey, type: dynamodb.AttributeType.STRING },
        ...(sortKey ? { sortKey: { name: sortKey, type: dynamodb.AttributeType.STRING } } : {}),
        ...(ttl ? { timeToLiveAttribute: ttl } : {}),
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
        encryptionKey: dataKey,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        deletionProtection: isProd,
        removalPolicy,
      });

    const users = table('UsersTable', 'users', 'userId');
    users.addGlobalSecondaryIndex({
      indexName: 'byContactHash',
      partitionKey: { name: 'contactHash', type: dynamodb.AttributeType.STRING },
    });
    users.addGlobalSecondaryIndex({
      indexName: 'byPanHash',
      partitionKey: { name: 'panHash', type: dynamodb.AttributeType.STRING },
    });
    const sessions = table('SessionsTable', 'sessions', 'refreshTokenHash', undefined, 'expiresAt');
    sessions.addGlobalSecondaryIndex({
      indexName: 'byUserId',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
    });
    const otp = table('OtpTable', 'otp', 'challengeId', undefined, 'expiresAt');
    const kycCases = table('KycCasesTable', 'kyc_cases', 'userId');
    kycCases.addGlobalSecondaryIndex({
      indexName: 'byStatus',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
    });
    // Design key "userId#ts": partition userId, sort ts (ISO time) so a user's trail is one query.
    const audit = table('AuditTable', 'audit', 'userId', 'ts');
    // Design key "yyyy-mm#checkId": partition month (yyyy-mm), sort checkId.
    const costs = table('CostsTable', 'costs', 'month', 'checkId');

    // ---------- S3 documents bucket ----------
    // Retention is set by the compliance adviser (DOC_RETENTION_DAYS). 2555 days (~7 years) is only
    // a placeholder default until the adviser confirms the number.
    const retentionDays = numberContext(this, 'DOC_RETENTION_DAYS', 2555);
    const docs = new s3.Bucket(this, 'DocsBucket', {
      bucketName: `wealthfire-kyc-docs-${stage}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: dataKey,
      bucketKeyEnabled: true,
      enforceSSL: true,
      versioned: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [
        { id: 'delete-after-retention', enabled: true, expiration: Duration.days(retentionDays) },
        { id: 'abort-incomplete-uploads', enabled: true, abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      // Browser uploads/downloads via presigned URLs.
      cors: [
        {
          allowedOrigins,
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedHeaders: ['content-type', 'content-length'],
          maxAge: 300,
        },
      ],
      // No autoDeleteObjects: its custom resource needs wildcard s3 actions. A non-empty dev
      // bucket must be emptied by hand before the dev stack is destroyed.
      removalPolicy,
    });

    // ---------- Secrets (placeholders; real values are set by hand after partner sign-up) ----------
    const partnerSecret = new secretsmanager.Secret(this, 'PartnerCredentials', {
      secretName: `${prefix}/partner-credentials`,
      description: 'KYC partner API credentials (placeholder; set from the partner portal, never in the repo)',
      encryptionKey: dataKey,
      removalPolicy,
    });
    const webhookSecret = new secretsmanager.Secret(this, 'PartnerWebhookSecret', {
      secretName: `${prefix}/partner-webhook-secret`,
      description: 'KYC partner webhook signing secret (placeholder; set from the partner portal)',
      encryptionKey: dataKey,
      removalPolicy,
    });

    // ---------- Cognito user pool for staff (review console) ----------
    const staffPool = new cognito.UserPool(this, 'StaffUserPool', {
      userPoolName: `${prefix}-staff`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 14,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: isProd,
      removalPolicy,
    });
    new cognito.CfnUserPoolGroup(this, 'ReviewerGroup', {
      userPoolId: staffPool.userPoolId,
      groupName: 'reviewer',
      description: 'Staff who may approve or reject Under-review KYC cases',
    });
    const staffClient = staffPool.addClient('ReviewConsoleClient', {
      userPoolClientName: `${prefix}-review-console`,
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.hours(8),
    });

    // ---------- Lambdas ----------
    const distDir = props.distDir ?? DEFAULT_DIST;
    const env = {
      STAGE: stage,
      ALLOWED_ORIGINS: allowedOrigins.join(','),
      TABLE_USERS: users.tableName,
      TABLE_SESSIONS: sessions.tableName,
      TABLE_OTP: otp.tableName,
      TABLE_KYC_CASES: kycCases.tableName,
      TABLE_AUDIT: audit.tableName,
      TABLE_COSTS: costs.tableName,
      DOCS_BUCKET: docs.bucketName,
      DOCS_PREFIX,
      DATA_KEY_ID: dataKey.keyArn,
      JWT_KEY_ID: jwtKey.keyArn,
      HMAC_KEY_ID: hmacKey.keyArn,
      PARTNER_SECRET_ARN: partnerSecret.secretArn,
      STAFF_USER_POOL_ID: staffPool.userPoolId,
      STAFF_CLIENT_ID: staffClient.userPoolClientId,
      NODE_OPTIONS: '--enable-source-maps',
    };

    const makeFn = (name: 'api' | 'webhook', timeout: Duration, environment: Record<string, string>) => {
      const built = join(distDir, name, 'index.mjs');
      const code = existsSync(built)
        ? lambda.Code.fromAsset(join(distDir, name))
        : // Placeholder until wave 2 bundles the handler (npm run build). Answers 503 to every call.
          lambda.Code.fromInline(
            "exports.handler = async () => ({ statusCode: 503, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'not_deployed' }) });",
          );
      // Explicit log group (no logRetention custom resource, which needs wildcard IAM actions).
      const logGroup = new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/aws/lambda/${prefix}-${name}`,
        retention: isProd ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_MONTH,
        removalPolicy,
      });
      return new lambda.Function(this, `${name}Function`, {
        functionName: `${prefix}-${name}`,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code,
        memorySize: 512,
        timeout,
        environment,
        logGroup,
      });
    };

    const apiFn = makeFn('api', Duration.seconds(15), env);
    const webhookFn = makeFn('webhook', Duration.seconds(10), {
      STAGE: stage,
      TABLE_KYC_CASES: kycCases.tableName,
      TABLE_AUDIT: audit.tableName,
      WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
      NODE_OPTIONS: '--enable-source-maps',
    });

    // ---------- Least-privilege IAM (explicit actions, no wildcards) ----------
    const tableRw = [
      'dynamodb:GetItem',
      'dynamodb:BatchGetItem',
      'dynamodb:Query',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:BatchWriteItem',
      'dynamodb:ConditionCheckItem',
      'dynamodb:DescribeTable',
    ];
    const tableArns = (ts: dynamodb.Table[]) => ts.flatMap((t) => [t.tableArn, `${t.tableArn}/index/*`]);
    const dataKeyUse = ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'];

    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'TablesReadWrite',
        actions: tableRw,
        resources: tableArns([users, sessions, otp, kycCases, audit, costs]),
      }),
    );
    apiFn.addToRolePolicy(new iam.PolicyStatement({ sid: 'DataKey', actions: dataKeyUse, resources: [dataKey.keyArn] }));
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'JwtSign',
        actions: ['kms:Sign', 'kms:Verify', 'kms:GetPublicKey', 'kms:DescribeKey'],
        resources: [jwtKey.keyArn],
      }),
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'HmacLookup',
        actions: ['kms:GenerateMac', 'kms:VerifyMac', 'kms:DescribeKey'],
        resources: [hmacKey.keyArn],
      }),
    );
    // Presigned PUT/GET URLs are signed with the role's credentials, so the role needs these actions.
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DocsPrefix',
        actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
        resources: [docs.arnForObjects(`${DOCS_PREFIX}*`)],
      }),
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'PartnerSecretRead',
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [partnerSecret.secretArn],
      }),
    );

    webhookFn.addToRolePolicy(
      new iam.PolicyStatement({ sid: 'TablesReadWrite', actions: tableRw, resources: tableArns([kycCases, audit]) }),
    );
    webhookFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DataKey',
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
        resources: [dataKey.keyArn],
      }),
    );
    webhookFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'WebhookSecretRead',
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [webhookSecret.secretArn],
      }),
    );

    // ---------- API Gateway (REST API, because WAFv2 cannot attach to HTTP APIs) ----------
    const api = new apigw.RestApi(this, 'Api', {
      restApiName: `${prefix}-api`,
      description: `Wealthfire KYC API (${stage})`,
      endpointTypes: [apigw.EndpointType.REGIONAL],
      cloudWatchRole: false,
      deployOptions: {
        stageName: stage,
        throttlingRateLimit: isProd ? 50 : 10,
        throttlingBurstLimit: isProd ? 100 : 20,
        tracingEnabled: false,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['content-type', 'authorization', 'idempotency-key'],
        allowCredentials: true,
        maxAge: Duration.minutes(10),
      },
      disableExecuteApiEndpoint: false,
    });
    const apiIntegration = new apigw.LambdaIntegration(apiFn);
    api.root.addProxy({ defaultIntegration: apiIntegration, anyMethod: true });

    // Partner webhook goes to its own Lambda (explicit resource wins over the proxy).
    api.root
      .addResource('webhooks')
      .addResource('partner')
      .addMethod('POST', new apigw.LambdaIntegration(webhookFn));

    // Staff routes: Cognito token required at the gateway; the Lambda also checks group "reviewer".
    const staffAuthorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'StaffAuthorizer', {
      cognitoUserPools: [staffPool],
      authorizerName: `${prefix}-staff`,
    });
    const staffMethod = {
      authorizer: staffAuthorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
    };
    const review = api.root.addResource('review');
    review.addProxy({ defaultIntegration: apiIntegration, anyMethod: false }).addMethod('ANY', apiIntegration, staffMethod);
    review.addMethod('ANY', apiIntegration, staffMethod);

    // ---------- WAF rate rule on the API stage ----------
    const waf = new wafv2.CfnWebACL(this, 'ApiWaf', {
      name: `${prefix}-api`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${prefix}-api`, sampledRequestsEnabled: true },
      rules: [
        {
          name: 'rate-per-ip',
          priority: 0,
          action: { block: {} },
          statement: { rateBasedStatement: { aggregateKeyType: 'IP', limit: 300, evaluationWindowSec: 300 } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${prefix}-rate-per-ip`, sampledRequestsEnabled: true },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'ApiWafAssociation', {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: waf.attrArn,
    });

    // ---------- Monthly budget alarm (R7) ----------
    const budgetAmount = numberContext(this, 'budgetAmount', 10);
    const budgetEmail: unknown = this.node.tryGetContext('budgetEmail');
    const subscribers =
      typeof budgetEmail === 'string' && budgetEmail.includes('@')
        ? [{ subscriptionType: 'EMAIL', address: budgetEmail }]
        : [];
    if (subscribers.length === 0) {
      Annotations.of(this).addWarningV2(
        'wealthfire:budgetEmail',
        'No budgetEmail context set: the budget is created without an email alarm. Pass -c budgetEmail=<address> before deploying.',
      );
    }
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${prefix}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: budgetAmount, unit: 'USD' },
      },
      notificationsWithSubscribers: subscribers.length
        ? [
            {
              notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
              subscribers,
            },
            {
              notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
              subscribers,
            },
          ]
        : [],
    });

    // ---------- Outputs ----------
    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'StaffUserPoolId', { value: staffPool.userPoolId });
    new CfnOutput(this, 'StaffClientId', { value: staffClient.userPoolClientId });
    new CfnOutput(this, 'DocsBucketName', { value: docs.bucketName });
  }
}
