// Local mode demo pieces (STAGE=local only, never in Lambda):
// - LocalDemoSender: an OTP "sender" that sends nothing. It keeps the last code per contact so
//   POST /auth/otp/send can answer `demoCode`, and prints `DEMO code for ******3210: 123456` in the
//   server window (contact masked).
// - LocalDemoStaffVerifier: accepts exactly `Authorization: Bearer local-demo-reviewer` as the
//   reviewer `demo-reviewer`. Anything else is refused.
import type { DemoCodeSource } from '../auth/routes';
import type { Sender } from '../auth/otp';
import type { StaffIdentity, StaffVerifier } from '../kyc/staff';
import type { ContactKind } from '../lib/repo';
import { REVIEWER_GROUP } from '../router';
import { assertLocalStage } from './guard';

export const DEMO_REVIEWER_TOKEN = 'local-demo-reviewer';
export const DEMO_REVIEWER_HEADER = `Bearer ${DEMO_REVIEWER_TOKEN}`;
export const DEMO_REVIEWER_ID = 'demo-reviewer';

/** `******3210` for a mobile, `a***@example.com` for an email. Never the whole contact. */
export function maskContact(kind: ContactKind, value: string): string {
  if (kind === 'email') {
    const at = value.lastIndexOf('@');
    if (at < 1) return '***';
    return `${value[0]}***${value.slice(at)}`;
  }
  const digits = value.replace(/\D/g, '');
  return `******${digits.slice(-4)}`;
}

/** One line of the home page's DEMO code list (contact already masked). */
export interface RecentDemoCode {
  contact: string;
  code: string;
  /** epoch ms */
  at: number;
}

export const MAX_RECENT_CODES = 10;

export class LocalDemoSender implements Sender, DemoCodeSource {
  private readonly codes = new Map<string, string>();
  /** masked contact -> latest code (Map order = oldest first) */
  private readonly history = new Map<string, RecentDemoCode>();

  constructor(
    stage: string | undefined,
    private readonly log: (line: string) => void = (l) => console.log(l),
    private readonly now: () => number = Date.now,
  ) {
    assertLocalStage(stage);
  }

  async send(kind: ContactKind, to: string, code: string): Promise<void> {
    this.codes.set(`${kind}:${to}`, code);
    const contact = maskContact(kind, to);
    this.history.delete(contact);
    this.history.set(contact, { contact, code, at: this.now() });
    while (this.history.size > MAX_RECENT_CODES) this.history.delete(this.history.keys().next().value!);
    this.log(`DEMO code for ${contact}: ${code}`);
  }

  /** Latest code per masked contact, newest first, at most 10. */
  recent(): RecentDemoCode[] {
    return [...this.history.values()].reverse().map((r) => ({ ...r }));
  }

  codeFor(kind: ContactKind, normalizedContact: string): string | undefined {
    return this.codes.get(`${kind}:${normalizedContact}`);
  }

  clear(): void {
    this.codes.clear();
    this.history.clear();
  }
}

export class LocalDemoStaffVerifier implements StaffVerifier {
  constructor(private readonly stage: string | undefined) {
    assertLocalStage(stage);
  }

  async verify(authorization: string | undefined): Promise<StaffIdentity | null> {
    // checked again per call: the stage is fixed at construction, but never trust it was 'local'
    if (this.stage !== 'local') return null;
    if (authorization !== DEMO_REVIEWER_HEADER) return null;
    return { id: DEMO_REVIEWER_ID, groups: [REVIEWER_GROUP] };
  }
}
