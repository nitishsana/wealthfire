// Real OTP senders behind the auth `Sender` interface: SNS SMS for mobile, SES v2 for email.
// Each channel is on only when its env is set (OTP_SMS_SENDER_ID / OTP_EMAIL_FROM); a channel
// without config fails the send, so /auth/otp/send answers 503 (send_failed) for it.
// Nothing here logs, or puts in an error message, the contact or the code.
import { PublishCommand } from '@aws-sdk/client-sns';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ENV, type Env } from '../lib/env';
import type { ContactKind } from '../lib/repo';
import { OTP_LIMITS, type Sender } from './otp';

/** Minimal client surfaces (the SDK clients satisfy them; tests pass fakes). */
export interface SnsLike {
  send(cmd: PublishCommand): Promise<unknown>;
}
export interface SesLike {
  send(cmd: SendEmailCommand): Promise<unknown>;
}

const MINUTES = Math.round(OTP_LIMITS.expiryMs / 60_000);
/** Fixed text (India DLT templates must match it exactly; register it with the operator). */
export const otpSmsText = (code: string): string =>
  `${code} is your Wealthfire sign-in code. It expires in ${MINUTES} minutes. Do not share it with anyone.`;
export const OTP_EMAIL_SUBJECT = 'Your Wealthfire sign-in code';
export const otpEmailText = (code: string): string =>
  `Your Wealthfire sign-in code is ${code}.\n\nIt expires in ${MINUTES} minutes. Do not share it with anyone. ` +
  'If you did not ask for this code, you can ignore this email.';

/** Error with a fixed message (never the contact or the code). */
export class SenderError extends Error {
  constructor(readonly code: 'not_configured' | 'wrong_channel' | 'bad_contact' | 'delivery_failed') {
    super(`otp sender: ${code}`);
    this.name = 'SenderError';
  }
}

const MOBILE_IN = /^[6-9]\d{9}$/;
const SENDER_ID = /^[A-Za-z0-9]{3,11}$/;
const DLT_ID = /^\d{1,30}$/;
const EMAIL = /^[^\s@<>()",;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export interface SmsOptions {
  /** SNS sender id (India: the DLT-registered header) */
  senderId: string;
  /** India DLT principal entity id (optional SNS attribute AWS.MM.SMS.EntityId) */
  entityId?: string;
  /** India DLT content template id (optional SNS attribute AWS.MM.SMS.TemplateId) */
  templateId?: string;
}

/** SMS via SNS Publish to a phone number (Transactional). `to` is the normalised 10-digit mobile. */
export class SnsSmsSender implements Sender {
  constructor(private readonly sns: SnsLike, private readonly opts: SmsOptions) {
    if (!SENDER_ID.test(opts.senderId)) throw new SenderError('not_configured');
    if (opts.entityId !== undefined && !DLT_ID.test(opts.entityId)) throw new SenderError('not_configured');
    if (opts.templateId !== undefined && !DLT_ID.test(opts.templateId)) throw new SenderError('not_configured');
  }

  async send(kind: ContactKind, to: string, code: string): Promise<void> {
    if (kind !== 'mobile') throw new SenderError('wrong_channel');
    if (!MOBILE_IN.test(to)) throw new SenderError('bad_contact');
    const attr = (v: string) => ({ DataType: 'String', StringValue: v });
    try {
      await this.sns.send(new PublishCommand({
        PhoneNumber: `+91${to}`,
        Message: otpSmsText(code),
        MessageAttributes: {
          'AWS.SNS.SMS.SMSType': attr('Transactional'),
          'AWS.SNS.SMS.SenderID': attr(this.opts.senderId),
          ...(this.opts.entityId ? { 'AWS.MM.SMS.EntityId': attr(this.opts.entityId) } : {}),
          ...(this.opts.templateId ? { 'AWS.MM.SMS.TemplateId': attr(this.opts.templateId) } : {}),
        },
      }));
    } catch {
      throw new SenderError('delivery_failed'); // the SDK error can echo the phone number
    }
  }
}

/** Email via SES v2 SendEmail (simple content, text only). `from` must be a verified identity. */
export class SesEmailSender implements Sender {
  constructor(private readonly ses: SesLike, private readonly from: string) {
    if (!EMAIL.test(from)) throw new SenderError('not_configured');
  }

  async send(kind: ContactKind, to: string, code: string): Promise<void> {
    if (kind !== 'email') throw new SenderError('wrong_channel');
    if (!EMAIL.test(to) || to.length > 320) throw new SenderError('bad_contact');
    try {
      await this.ses.send(new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: OTP_EMAIL_SUBJECT, Charset: 'UTF-8' },
            Body: { Text: { Data: otpEmailText(code), Charset: 'UTF-8' } },
          },
        },
      }));
    } catch {
      throw new SenderError('delivery_failed');
    }
  }
}

/** A channel with no sender configured: every send fails (the OTP route answers 503). */
export class UnconfiguredSender implements Sender {
  async send(): Promise<void> {
    throw new SenderError('not_configured');
  }
}

/** Routes each send to its channel's sender; a missing channel fails. */
export class ChannelSender implements Sender {
  constructor(private readonly channels: Partial<Record<ContactKind, Sender>>) {}

  /** Which channels have a sender (for wiring checks / logs; no personal data). */
  get enabled(): ContactKind[] {
    return (Object.keys(this.channels) as ContactKind[]).filter((k) => this.channels[k] !== undefined);
  }

  send(kind: ContactKind, to: string, code: string): Promise<void> {
    const s = this.channels[kind];
    if (!s) return Promise.reject(new SenderError('not_configured'));
    return s.send(kind, to, code);
  }
}

/**
 * Sender from env: SMS when OTP_SMS_SENDER_ID is set, email when OTP_EMAIL_FROM is set. With
 * neither, the always-failing UnconfiguredSender. Clients are created only for enabled channels.
 */
export function senderFromEnv(env: Env, clients: { sns: () => SnsLike; ses: () => SesLike }): Sender {
  const senderId = env[ENV.smsSenderId]?.trim();
  const from = env[ENV.emailFrom]?.trim();
  const entityId = env[ENV.smsEntityId]?.trim() || undefined;
  const templateId = env[ENV.smsTemplateId]?.trim() || undefined;
  const channels: Partial<Record<ContactKind, Sender>> = {};
  if (senderId) {
    channels.mobile = new SnsSmsSender(clients.sns(), {
      senderId, ...(entityId ? { entityId } : {}), ...(templateId ? { templateId } : {}),
    });
  }
  if (from) channels.email = new SesEmailSender(clients.ses(), from);
  return channels.mobile || channels.email ? new ChannelSender(channels) : new UnconfiguredSender();
}
