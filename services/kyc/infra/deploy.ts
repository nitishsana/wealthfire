// Deploy wrapper: `npx tsx infra/deploy.ts <stack> -c budgetEmail=<address> [cdk deploy args...]`.
// Refuses to run without a valid budgetEmail (S18), then prints the account steps from DEPLOY.md
// and runs `cdk deploy`. Deploying needs Nitish's OK; agents never run this.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EMAIL, SYNTH_ONLY_CONTEXT } from './stack.js';

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
  const ctx = contextArgs(args);
  // S12: synthOnly turns off the stack's budgetEmail check; it is for `npm run synth`, never a deploy.
  if (SYNTH_ONLY_CONTEXT in ctx) return `Refusing to deploy: -c ${SYNTH_ONLY_CONTEXT} is for synth only.`;
  const email = ctx.budgetEmail;
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

/** The CDK app command cdk runs (a fixed string; no operator input goes into it). */
export const CDK_APP = 'npx tsx infra/app.ts';

/**
 * S12: the `cdk deploy` process. No shell, so args are passed to cdk verbatim and cannot inject
 * shell commands. It runs the local aws-cdk bin with this Node: `npx.cmd` cannot be spawned without
 * a shell on Windows (Node refuses .cmd files with shell: false, EINVAL).
 */
export function deployCommand(
  args: readonly string[],
  cdkBin: string = createRequire(import.meta.url).resolve('aws-cdk/bin/cdk'),
): { command: string; args: string[]; options: SpawnSyncOptions } {
  return {
    command: process.execPath,
    args: [cdkBin, 'deploy', '--app', CDK_APP, ...args],
    options: { stdio: 'inherit', shell: false },
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const refusal = deployRefusal(args);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  console.log('Account steps (see infra/DEPLOY.md):');
  for (const s of ACCOUNT_STEPS) console.log(`- ${s}`);
  const cmd = deployCommand(args);
  const r = spawnSync(cmd.command, cmd.args, cmd.options);
  if (r.error) console.error(`cdk deploy did not start: ${r.error.message}`);
  process.exit(r.status ?? 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
