// CDK entry: `npm run synth -w @wealthfire/kyc-service`. Synth only; deploy needs Nitish's OK.
// Context: -c budgetEmail=<address> -c budgetAmount=<USD> -c DOC_RETENTION_DAYS=<days>
//   Review console: -c cognitoDomainPrefix=<prefix> (default wealthfire-kyc-<stage>-staff)
//                   -c consoleCallbackUrls=<url,...> -c consoleLogoutUrls=<url,...> (default: the CloudFront URL)
//   OTP delivery:   -c otpSmsSenderId=<DLT header> [-c otpSmsEntityId=<id> -c otpSmsTemplateId=<id>]
//                   -c otpEmailFrom=<verified SES address>   (a channel without context stays off: 503)
import { App, Tags } from 'aws-cdk-lib';
import { KycStack, type Stage } from './stack.js';

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? 'ap-south-1';

for (const stage of ['dev', 'prod'] as Stage[]) {
  const stack = new KycStack(app, `WealthfireKyc-${stage}`, {
    stage,
    env: { account, region },
    description: `Wealthfire final KYC service (${stage})`,
  });
  Tags.of(stack).add('project', 'wealthfire-kyc');
  Tags.of(stack).add('env', stage);
}

app.synth();
