// CDK entry: `npm run synth -w @wealthfire/kyc-service`. Synth only; deploy needs Nitish's OK and
// goes through infra/deploy.ts (it refuses without budgetEmail). Account steps: infra/DEPLOY.md.
// The stack throws without budgetEmail unless -c synthOnly=true (the synth script passes it).
// Context: -c budgetEmail=<address> -c budgetAmount=<USD> -c smsSpendAlarmUsd=<USD> -c DOC_RETENTION_DAYS=<days>
//          -c lockoutAlarmCount=<n> (OTP lockouts per hour that alarm, default 5)
//   Review console: -c cognitoDomainPrefix=<prefix> (default wealthfire-kyc-<stage>-staff)
//                   -c consoleCallbackUrls=<url,...> -c consoleLogoutUrls=<url,...> (default: the console URL)
//   OTP delivery:   -c otpSmsSenderId=<DLT header> [-c otpSmsEntityId=<id> -c otpSmsTemplateId=<id>]
//                   -c otpEmailFrom=<verified SES address>   (a channel without context stays off: 503)
//   App origin:     -c appOrigin=<https origin>   (CORS then allows only that app origin)
//   Custom domains: -c apiDomain=<host> -c apiCertArn=<ACM ARN in ap-south-1>
//                   -c consoleDomain=<host> -c consoleCertArn=<ACM ARN in us-east-1>
import { App } from 'aws-cdk-lib';
import { buildApp } from './build.js';

const app = new App();
buildApp(app); // region fixed to ap-south-1 (S1)
app.synth();
