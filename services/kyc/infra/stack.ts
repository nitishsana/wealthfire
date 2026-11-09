// Wealthfire final KYC service stack (design §1, §2, §7, §8).
// One stack per environment (dev, prod) in ap-south-1. Synth only: deploying needs Nitish's OK.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Annotations,
  Duration,
  Lazy,
  RemovalPolicy,
  Stack,
  Token,
  type StackProps,
  aws_apigateway as apigw,
  aws_budgets as budgets,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
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
// The one env naming scheme, shared with the Lambda code (no AWS SDK imports in that file).
import { ENV, TABLE_ENV } from '../src/lib/env.js';

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
/** DigiLocker / e-sign return-URL allow-list (the dev stack adds the local preview). */
export const PROD_RETURN_URL_PREFIXES = ['https://nitishsana.github.io/wealthfire/', 'wealthfire://'] as const;
export const DEV_RETURN_URL_PREFIXES = [...PROD_RETURN_URL_PREFIXES, `${DEV_PREVIEW_ORIGIN}/`] as const;

/**
 * CSP for the review console. Mirrors review-console/build.mjs (which also writes it as a meta tag)
 * and adds frame-ancestors, which only works as a real header.
 */
export function consoleCsp(apiOrigin: string, cognitoOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    `connect-src ${apiOrigin} ${cognitoOrigin}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

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

/** A list context value: a JSON array or a comma-separated string. Empty → []. */
function listContext(scope: Construct, key: string): string[] {
  const raw: unknown = scope.node.tryGetContext(key);
  if (raw === undefined || raw === null || raw === '') return [];
  const items = Array.isArray(raw) ? raw : String(raw).split(',');
  return items.map((s) => String(s).trim()).filter(Boolean);
}

/** An optional string context value matching `re`. Throws (naming the key, not the value) on a bad one. */
function stringContext(scope: Construct, key: string, re: RegExp): string | undefined {
  const raw: unknown = scope.node.tryGetContext(key);
  if (raw === undefined || raw === null || raw === '') return undefined;
  const v = String(raw).trim();
  if (!re.test(v)) throw new Error(`Context "${key}" is not valid`);
  return v;
}

/** Console callback / logout URLs: https, or http://localhost / 127.0.0.1 on dev only (Cognito rule). */
function consoleUrls(scope: Construct, key: string, isProd: boolean): string[] {
  const urls = listContext(scope, key);
  for (const u of urls) {
    let p: URL;
    try {
      p = new URL(u);
    } catch {
      throw new Error(`Context "${key}" has an invalid URL`);
    }
    const local = p.protocol === 'http:' && (p.hostname === 'localhost' || p.hostname === '127.0.0.1');
    if (!(p.protocol === 'https:' || (local && !isProd)) || p.hash || p.username || p.password) {
      throw new Error(`Context "${key}" URLs must be https${isProd ? '' : ' (or http://localhost / 127.0.0.1 on dev)'}`);
    }
  }
  return urls;
}

const DOMAIN_PREFIX = /^(?!.*(?:aws|amazon|cognito))[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL = /^[^\s@<>()",;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

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
    // Seen partner webhook event ids (replay / duplicate guard); items expire via TTL after a day.
    const webhookEvents = table('WebhookEventsTable', 'webhook_events', 'eventId', undefined, 'expiresAt');

    // ---------- Review console hosting: private S3 + CloudFront (OAC) ----------
    // Files are uploaded by hand after `node review-console/build.mjs` (aws s3 sync dist/ s3://<ConsoleBucketName>);
    // a BucketDeployment would add a custom-resource Lambda with wildcard S3 actions.
    const consoleBucket = new s3.Bucket(this, 'ConsoleBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy,
    });
    const domainPrefix = stringContext(this, 'cognitoDomainPrefix', DOMAIN_PREFIX) ?? `${prefix}-staff`;
    const cognitoOrigin = `https://${domainPrefix}.auth.${this.region}.amazoncognito.com`;
    // The API is created further down; the CSP resolves its origin at synth time.
    let apiForCsp: apigw.RestApi | undefined;
    const apiOrigin = Lazy.string({
      produce: () => {
        if (!apiForCsp) throw new Error('API not created');
        return `https://${apiForCsp.restApiId}.execute-api.${this.region}.${this.urlSuffix}`;
      },
    });
    const consoleHeaders = new cloudfront.ResponseHeadersPolicy(this, 'ConsoleHeaders', {
      responseHeadersPolicyName: `${prefix}-review-console`,
      comment: 'Wealthfire review console security headers',
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: consoleCsp(apiOrigin, cognitoOrigin), override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730), includeSubdomains: true, preload: true, override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
      },
    });
    const consoleCdn = new cloudfront.Distribution(this, 'ConsoleDistribution', {
      comment: `Wealthfire KYC review console (${stage})`,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(consoleBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        responseHeadersPolicy: consoleHeaders,
      },
    });
    const consoleUrl = `https://${consoleCdn.distributionDomainName}/`;
    // Hosted UI redirect targets: context, else the CloudFront URL.
    const callbackUrls = consoleUrls(this, 'consoleCallbackUrls', isProd);
    const logoutUrls = consoleUrls(this, 'consoleLogoutUrls', isProd);
    const consoleCallbacks = callbackUrls.length ? callbackUrls : [consoleUrl];
    const consoleLogouts = logoutUrls.length ? logoutUrls : consoleCallbacks;
    // Browser origins of the console (for API / docs CORS).
    const consoleOrigins = callbackUrls.length
      ? [...new Set(callbackUrls.map((u) => new URL(u).origin))]
      : [`https://${consoleCdn.distributionDomainName}`];
    const apiOrigins = [...allowedOrigins, ...consoleOrigins.filter((o) => Token.isUnresolved(o) || !allowedOrigins.includes(o))];

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
      // Browser uploads/downloads via presigned URLs: the apps PUT + GET, the review console GETs.
      cors: [
        {
          id: 'apps',
          allowedOrigins,
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedHeaders: ['content-type', 'content-length'],
          maxAge: 300,
        },
        {
          id: 'review-console',
          allowedOrigins: consoleOrigins,
          allowedMethods: [s3.HttpMethods.GET],
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
    // Hosted UI (managed sign-in) for the console: authorization code flow. The client is public
    // (no secret), so Cognito requires and checks PKCE from the browser.
    const hostedUi = staffPool.addDomain('HostedUiDomain', { cognitoDomain: { domainPrefix } });
    const staffClient = staffPool.addClient('ReviewConsoleClient', {
      userPoolClientName: `${prefix}-review-console`,
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false, clientCredentials: false },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: consoleCallbacks,
        logoutUrls: consoleLogouts,
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.hours(8),
    });

    // ---------- Lambdas ----------
    // OTP delivery (optional; a channel without config makes /auth/otp/send answer 503 for it).
    const smsSenderId = stringContext(this, 'otpSmsSenderId', /^[A-Za-z0-9]{3,11}$/);
    const smsEntityId = stringContext(this, 'otpSmsEntityId', /^\d{1,30}$/);
    const smsTemplateId = stringContext(this, 'otpSmsTemplateId', /^\d{1,30}$/);
    const emailFrom = stringContext(this, 'otpEmailFrom', EMAIL);

    const distDir = props.distDir ?? DEFAULT_DIST;
    // Every name comes from src/lib/env.ts, the one scheme the Lambda code reads.
    const env: Record<string, string> = {
      [ENV.stage]: stage,
      [ENV.allowedOrigins]: apiOrigins.join(','),
      [ENV.returnUrlPrefixes]: (isProd ? PROD_RETURN_URL_PREFIXES : DEV_RETURN_URL_PREFIXES).join(','),
      [TABLE_ENV.users]: users.tableName,
      [TABLE_ENV.sessions]: sessions.tableName,
      [TABLE_ENV.otp]: otp.tableName,
      [TABLE_ENV.kycCases]: kycCases.tableName,
      [TABLE_ENV.audit]: audit.tableName,
      [TABLE_ENV.costs]: costs.tableName,
      [ENV.docsBucket]: docs.bucketName,
      [ENV.docsPrefix]: DOCS_PREFIX,
      [ENV.dataKeyId]: dataKey.keyArn,
      [ENV.jwtKeyId]: jwtKey.keyArn,
      [ENV.hmacKeyId]: hmacKey.keyArn,
      [ENV.partnerSecretArn]: partnerSecret.secretArn,
      [ENV.staffUserPoolId]: staffPool.userPoolId,
      [ENV.staffClientId]: staffClient.userPoolClientId,
      ...(smsSenderId ? { [ENV.smsSenderId]: smsSenderId } : {}),
      ...(smsEntityId ? { [ENV.smsEntityId]: smsEntityId } : {}),
      ...(smsTemplateId ? { [ENV.smsTemplateId]: smsTemplateId } : {}),
      ...(emailFrom ? { [ENV.emailFrom]: emailFrom } : {}),
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
      [ENV.stage]: stage,
      [TABLE_ENV.kycCases]: kycCases.tableName,
      [TABLE_ENV.audit]: audit.tableName,
      [TABLE_ENV.webhookEvents]: webhookEvents.tableName,
      [ENV.webhookSecretArn]: webhookSecret.secretArn,
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
    // The review case detail lists a case's documents (ListObjectsV2, Prefix kyc/<userId>/).
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DocsList',
        actions: ['s3:ListBucket'],
        resources: [docs.bucketArn],
        conditions: { StringLike: { 's3:prefix': [`${DOCS_PREFIX}*`] } },
      }),
    );
    if (smsSenderId) {
      // SMS to a phone number has no resource ARN. NotResource on every SNS ARN allows ONLY direct
      // SMS publishing: no topic or platform endpoint can be published to.
      apiFn.addToRolePolicy(
        new iam.PolicyStatement({ sid: 'OtpSms', actions: ['sns:Publish'], notResources: ['arn:aws:sns:*:*:*'] }),
      );
    }
    if (emailFrom) {
      const domain = emailFrom.split('@')[1] as string;
      apiFn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'OtpEmail',
          actions: ['ses:SendEmail'],
          resources: [
            `arn:${this.partition}:ses:${this.region}:${this.account}:identity/${emailFrom}`,
            `arn:${this.partition}:ses:${this.region}:${this.account}:identity/${domain}`,
          ],
          conditions: { StringEquals: { 'ses:FromAddress': emailFrom } },
        }),
      );
    }
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'PartnerSecretRead',
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [partnerSecret.secretArn],
      }),
    );

    webhookFn.addToRolePolicy(
      new iam.PolicyStatement({ sid: 'TablesReadWrite', actions: tableRw, resources: tableArns([kycCases, audit, webhookEvents]) }),
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
        // the apps plus the review console (it calls /review/* from the browser)
        allowOrigins: apiOrigins,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['content-type', 'authorization', 'idempotency-key'],
        allowCredentials: true,
        maxAge: Duration.minutes(10),
      },
      disableExecuteApiEndpoint: false,
    });
    apiForCsp = api;
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
    new CfnOutput(this, 'ConsoleUrl', { value: consoleUrl });
    new CfnOutput(this, 'ConsoleBucketName', { value: consoleBucket.bucketName });
    new CfnOutput(this, 'CognitoHostedUiDomain', { value: hostedUi.baseUrl() });
    new CfnOutput(this, 'WebhookEventsTableName', { value: webhookEvents.tableName });
  }
}
