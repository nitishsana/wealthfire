// Structured logs that never contain PAN, Aadhaar, OTPs, contacts or tokens (design §7).
// Callers log only fixed event names and safe fields; `scrub` is a second line of defence that
// masks anything shaped like a secret before a line is written.

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const PATTERNS: [RegExp, string][] = [
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[jwt]'], // JWT
  [/[A-Za-z]{5}\s*\d{4}\s*[A-Za-z]/g, '[pan]'], // PAN
  [/[^\s@"']+@[^\s@"']+\.[A-Za-z]{2,}/g, '[email]'], // email
  [/\d(?:[\s-]?\d){5,}/g, '[number]'], // Aadhaar, mobile, OTP (6+ digits)
  [/[A-Za-z0-9_-]{32,}/g, '[secret]'], // refresh tokens, random ids that look like secrets
];

/** Masks secret-shaped text. */
export function scrub(text: string): string {
  let out = text;
  for (const [re, label] of PATTERNS) out = out.replace(re, label);
  return out;
}

/** JSON lines on stdout / stderr (CloudWatch), scrubbed. */
export class ConsoleLogger implements Logger {
  info(event: string, fields: LogFields = {}): void {
    console.log(scrub(JSON.stringify({ level: 'info', event, ...fields })));
  }
  error(event: string, fields: LogFields = {}): void {
    console.error(scrub(JSON.stringify({ level: 'error', event, ...fields })));
  }
}

/** Test logger: keeps scrubbed lines in memory. */
export class MemoryLogger implements Logger {
  readonly lines: string[] = [];
  info(event: string, fields: LogFields = {}): void {
    this.lines.push(scrub(JSON.stringify({ level: 'info', event, ...fields })));
  }
  error(event: string, fields: LogFields = {}): void {
    this.lines.push(scrub(JSON.stringify({ level: 'error', event, ...fields })));
  }
}

export const silentLogger: Logger = { info: () => {}, error: () => {} };
