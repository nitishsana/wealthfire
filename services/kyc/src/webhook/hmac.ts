// Interim webhook signature check: HMAC-SHA256 of the raw body with the partner webhook secret,
// hex in `x-webhook-signature` (an optional `sha256=` prefix is accepted). Used by the Lambda until
// the real partner adapter's KycPartner.verifyWebhook (wave 5, partner docs) replaces it.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookVerifier } from './ports';

export const SIGNATURE_HEADER = 'x-webhook-signature';

export function signBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

export class HmacWebhookVerifier implements WebhookVerifier {
  constructor(private readonly secret: string) {
    if (secret.length < 16) throw new Error('webhook secret is too short');
  }

  verifyWebhook(headers: Record<string, string>, body: string): boolean {
    let sig = headers[SIGNATURE_HEADER];
    if (typeof sig !== 'string') return false;
    sig = sig.trim();
    if (sig.startsWith('sha256=')) sig = sig.slice(7);
    if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
    const want = Buffer.from(signBody(this.secret, body), 'hex');
    const got = Buffer.from(sig, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  }
}
