# KYC service deploy steps

Deploying needs Nitish's OK. Agents only synth.

## Command

```
npx tsx infra/deploy.ts WealthfireKyc-dev -c budgetEmail=<address>
```

The wrapper refuses to run without a valid `budgetEmail`. Synth without it only warns.
Region is fixed to ap-south-1 in `infra/app.ts`.

## Account steps (once per AWS account, by hand)

| Step | Why |
|---|---|
| SNS SMS monthly spend limit in ap-south-1 (SNS > Text messaging > Spend limit) | Caps OTP SMS cost (S12). The stack also alarms on `SMSMonthToDateSpentUSD` above `smsSpendAlarmUsd` (default 5 USD). |
| Enable GuardDuty in ap-south-1, with S3 protection | Threat detection for the account and the documents bucket (S18). |
| Confirm the email subscription to the cost-alarm topic | SNS email subscriptions only work after the link in the mail is clicked. |

## Optional context

| Context | Effect |
|---|---|
| `appOrigin` | API and document CORS allow only this app origin. |
| `apiDomain` + `apiCertArn` (ap-south-1) | Regional custom API domain, TLS 1.2. DNS: point the domain at the `ApiDomainTarget` output. |
| `consoleDomain` + `consoleCertArn` (us-east-1) | Custom console domain on CloudFront, TLSv1.2_2021. DNS: point it at the distribution. |
