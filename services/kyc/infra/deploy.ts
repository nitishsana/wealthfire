// Deploy wrapper: `npx tsx infra/deploy.ts <stack> -c budgetEmail=<address> [cdk deploy args...]`.
// Refuses to run without a valid budgetEmail (S18), then prints the account steps from DEPLOY.md
// and runs `cdk deploy`. Deploying needs Nitish's OK; agents never run this.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EMAIL } from './stack.js';

/** Context values passed as `-c k=v`, `--context k=v` or `--context=k=v`. */
export function contextArgs(args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    let kv: string | undefined;
    if (a === '-c' || a === '--context') kv = args[++i];
    else if (a.startsWith('--context=')) kv = a.slice('--context='.length);
    if (kv === undefined) continue;
    const eq = kv.indexOf('=');
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}

/** Why the deploy must not run, or null when it may. */
export function deployRefusal(args: readonly string[]): string | null {
  const email = contextArgs(args).budgetEmail;
  if (email === undefined || email.trim() === '') {
    return 'Refusing to deploy: pass -c budgetEmail=<address> so the budget and cost alarms email someone.';
  }
  if (!EMAIL.test(email.trim())) return 'Refusing to deploy: budgetEmail is not a valid email address.';
  return null;
}

export const ACCOUNT_STEPS = [
  'SNS SMS: set the account monthly SMS spend limit in ap-south-1 (SNS > Text messaging > Spend limit).',
  'GuardDuty: enable GuardDuty (with S3 protection) in ap-south-1 for this account.',
  'Confirm the budget / cost-alarm email subscription after the first deploy.',
];

function main(): void {
  const args = process.argv.slice(2);
  const refusal = deployRefusal(args);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  console.log('Account steps (see infra/DEPLOY.md):');
  for (const s of ACCOUNT_STEPS) console.log(`- ${s}`);
  // shell: npx is a .cmd on Windows. Args are the operator's own; quote the one with spaces.
  const r = spawnSync('npx', ['cdk', 'deploy', '--app', '"npx tsx infra/app.ts"', ...args], { stdio: 'inherit', shell: true });
  process.exit(r.status ?? 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
