// Builds the CDK app (both stages). Kept apart from app.ts so tests can check it without synth.
import { App, Tags } from 'aws-cdk-lib';
import { KYC_REGION, KycStack, type Stage } from './stack.js';

export const STAGES: readonly Stage[] = ['dev', 'prod'];

export function buildApp(app: App, account: string | undefined = process.env.CDK_DEFAULT_ACCOUNT): KycStack[] {
  // S1: hard-coded. CDK_DEFAULT_REGION (the CLI profile's region) is ignored on purpose.
  const region = KYC_REGION;
  return STAGES.map((stage) => {
    const stack = new KycStack(app, `WealthfireKyc-${stage}`, {
      stage,
      env: { account, region },
      description: `Wealthfire final KYC service (${stage})`,
    });
    Tags.of(stack).add('project', 'wealthfire-kyc');
    Tags.of(stack).add('env', stage);
    return stack;
  });
}
