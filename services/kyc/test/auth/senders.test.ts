import { describe, expect, it } from 'vitest';
import { FakeSender, OtpService } from '../../src/auth/otp';
import {
  ChannelSender, OTP_EMAIL_SUBJECT, SenderError, SesEmailSender, SnsSmsSender, UnconfiguredSender, otpEmailText, otpSmsText,
  senderFromEnv, type SesLike, type SnsLike,
} from '../../src/auth/senders';
import { Argon2Hasher } from '../../src/lib/crypto';
import { FAST_ARGON2, setup } from './helpers';

const CODE = '482913';

type Cmd = { constructor: { name: string }; input: Record<string, any> };

function fakeClient(fail?: Error) {
  const sent: Cmd[] = [];
  const client = {
    send: async (cmd: Cmd) => {
      sent.push(cmd);
      if (fail) throw fail;
      return {};
    },
  };
  return { client: client as unknown as SnsLike & SesLike, sent };
}

describe('SnsSmsSender', () => {
  it('publishes a Transactional SMS to +91<mobile> with the sender id and DLT ids', async () => {
    const f = fakeClient();
    await new SnsSmsSender(f.client, { senderId: 'WLTHFR', entityId: '1101234567890', templateId: '1107000000000' })
      .send('mobile', '9876543210', CODE);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.constructor.name).toBe('PublishCommand');
    expect(f.sent[0]!.input).toEqual({
      PhoneNumber: '+919876543210',
      Message: otpSmsText(CODE),
      MessageAttributes: {
        'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
        'AWS.SNS.SMS.SenderID': { DataType: 'String', StringValue: 'WLTHFR' },
        'AWS.MM.SMS.EntityId': { DataType: 'String', StringValue: '1101234567890' },
        'AWS.MM.SMS.TemplateId': { DataType: 'String', StringValue: '1107000000000' },
      },
    });
    expect(otpSmsText(CODE)).toMatch(/^482913 is your Wealthfire sign-in code\. It expires in 5 minutes\./);
  });

  it('omits the optional DLT attributes; refuses email, bad numbers and bad config', async () => {
    const f = fakeClient();
    const s = new SnsSmsSender(f.client, { senderId: 'WLTHFR' });
    await s.send('mobile', '6000000000', CODE);
    expect(Object.keys(f.sent[0]!.input.MessageAttributes)).toEqual(['AWS.SNS.SMS.SMSType', 'AWS.SNS.SMS.SenderID']);
    await expect(s.send('email', 'a@example.com', CODE)).rejects.toMatchObject({ code: 'wrong_channel' });
    for (const bad of ['12345', '+919876543210', '5876543210', '98765432100']) {
      await expect(s.send('mobile', bad, CODE)).rejects.toMatchObject({ code: 'bad_contact' });
    }
    expect(f.sent).toHaveLength(1);
    expect(() => new SnsSmsSender(f.client, { senderId: 'has space' })).toThrow(SenderError);
    expect(() => new SnsSmsSender(f.client, { senderId: 'WLTHFR', templateId: 'abc' })).toThrow(SenderError);
  });

  it('a delivery failure never carries the number or the code', async () => {
    const f = fakeClient(new Error('Invalid parameter: PhoneNumber +919876543210 482913'));
    const err = await new SnsSmsSender(f.client, { senderId: 'WLTHFR' }).send('mobile', '9876543210', CODE).catch((e) => e);
    expect(err).toBeInstanceOf(SenderError);
    expect(String(err.message)).not.toMatch(/9876543210|482913/);
  });
});

describe('SesEmailSender', () => {
  it('sends a simple text email from the configured address', async () => {
    const f = fakeClient();
    await new SesEmailSender(f.client, 'no-reply@wealthfire.example').send('email', 'asha@example.com', CODE);
    expect(f.sent[0]!.constructor.name).toBe('SendEmailCommand');
    expect(f.sent[0]!.input).toEqual({
      FromEmailAddress: 'no-reply@wealthfire.example',
      Destination: { ToAddresses: ['asha@example.com'] },
      Content: {
        Simple: {
          Subject: { Data: OTP_EMAIL_SUBJECT, Charset: 'UTF-8' },
          Body: { Text: { Data: otpEmailText(CODE), Charset: 'UTF-8' } },
        },
      },
    });
    expect(OTP_EMAIL_SUBJECT).not.toContain(CODE); // the code is never in the subject (lock-screen previews)
  });

  it('refuses mobile, a bad address, a bad from-address; hides SDK errors', async () => {
    const f = fakeClient();
    const s = new SesEmailSender(f.client, 'no-reply@wealthfire.example');
    await expect(s.send('mobile', '9876543210', CODE)).rejects.toMatchObject({ code: 'wrong_channel' });
    await expect(s.send('email', 'not-an-email', CODE)).rejects.toMatchObject({ code: 'bad_contact' });
    expect(() => new SesEmailSender(f.client, 'Wealthfire <x@y.z>')).toThrow(SenderError);
    const boom = fakeClient(new Error('MessageRejected: asha@example.com 482913'));
    const err = await new SesEmailSender(boom.client, 'no-reply@wealthfire.example').send('email', 'asha@example.com', CODE).catch((e) => e);
    expect(err).toMatchObject({ code: 'delivery_failed' });
    expect(String(err.message)).not.toMatch(/asha|482913/);
  });
});

describe('senderFromEnv', () => {
  it('no env: the failing sender, and no AWS client is created', async () => {
    let made = 0;
    const s = senderFromEnv({}, { sns: () => (made++, fakeClient().client), ses: () => (made++, fakeClient().client) });
    expect(s).toBeInstanceOf(UnconfiguredSender);
    expect(made).toBe(0);
    await expect(s.send('mobile', '9876543210', CODE)).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('each channel turns on with its own env; a missing channel fails', async () => {
    const sns = fakeClient();
    const ses = fakeClient();
    const smsOnly = senderFromEnv({ OTP_SMS_SENDER_ID: 'WLTHFR' }, { sns: () => sns.client, ses: () => ses.client });
    expect((smsOnly as ChannelSender).enabled).toEqual(['mobile']);
    await smsOnly.send('mobile', '9876543210', CODE);
    await expect(smsOnly.send('email', 'a@example.com', CODE)).rejects.toMatchObject({ code: 'not_configured' });

    const both = senderFromEnv(
      { OTP_SMS_SENDER_ID: 'WLTHFR', OTP_SMS_TEMPLATE_ID: '1107000000000', OTP_EMAIL_FROM: 'no-reply@wealthfire.example' },
      { sns: () => sns.client, ses: () => ses.client },
    );
    expect((both as ChannelSender).enabled.sort()).toEqual(['email', 'mobile']);
    await both.send('email', 'a@example.com', CODE);
    await both.send('mobile', '9876543210', CODE);
    expect(ses.sent).toHaveLength(1);
    expect(sns.sent).toHaveLength(2);
    expect(sns.sent[1]!.input.MessageAttributes['AWS.MM.SMS.TemplateId']).toBeDefined();
  });

  it('wired into OtpService: a send failure is send_failed (503) and leaves no live challenge', async () => {
    const a = setup();
    const deps = { repos: a.repos, clock: a.clock, mac: a.mac, encryptor: a.encryptor, hasher: new Argon2Hasher(FAST_ARGON2), tokens: a.tokens };
    const otp = new OtpService({ ...deps, sender: new UnconfiguredSender() });
    await expect(otp.send({ kind: 'mobile', contact: '+91 98765 43210', ip: '1' })).rejects.toMatchObject({ code: 'send_failed' });
    expect(a.repos.otp.challengeCount()).toBe(0);
    const ok = new OtpService({ ...deps, sender: new FakeSender() });
    await expect(ok.send({ kind: 'mobile', contact: '+91 98765 43211', ip: '1' })).resolves.toHaveProperty('challengeId');
  });
});
