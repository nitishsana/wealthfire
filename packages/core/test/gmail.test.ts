import { describe, expect, it } from 'vitest';
import { decodeBase64Url, demoData, deserialize, mergeExpenses, parseCardAlert, serialize, syncGmail, GmailAuthError, type FetchLike } from '../src';

const at = Date.UTC(2026, 9, 10);
const mail = (subject: string, body: string, id = 'm1') => ({ id, subject, body, receivedAt: at });

describe('parseCardAlert', () => {
  it('HDFC style', () => {
    const e = parseCardAlert(mail('Alert : Update on your HDFC Bank Credit Card',
      'Dear Customer, Rs.450.00 is debited from your HDFC Bank Credit Card ending 1234 towards SWIGGY on 05 Oct, 2026 at 20:15:00.'));
    expect(e).toMatchObject({ id: 'gm_m1', amount: 450, description: 'SWIGGY', category: 'Food', date: '2026-10-05', source: 'gmail' });
  });
  it('ICICI style with Info:', () => {
    const e = parseCardAlert(mail('Transaction alert for your ICICI Bank Credit Card',
      'INR 1,299.00 spent using ICICI Bank Card XX9876 on 06-Oct-26 on IND*AMAZON. Avl Limit: INR 2,10,000.00. Info: AMAZON PAY INDIA.'));
    expect(e).toMatchObject({ amount: 1299, date: '2026-10-06', category: 'Shopping' });
  });
  it('Axis / SBI style "at MERCHANT on date"', () => {
    const e = parseCardAlert(mail('Transaction alert', 'Transaction of Rs 320.50 on your SBI Card ending 4455 at UBER INDIA on 08/10/2026. If not done by you, call us.'));
    expect(e).toMatchObject({ amount: 320.5, description: 'UBER INDIA', category: 'Transport', date: '2026-10-08' });
  });
  it('falls back to the email date', () => {
    const e = parseCardAlert(mail('Card used', '₹ 2,000 spent on your Kotak card at HPCL PETROL PUMP.'));
    expect(e).toMatchObject({ amount: 2000, date: '2026-10-10', category: 'Fuel' });
  });
  it('skips refunds, OTPs, payments, declines and non-card mail', () => {
    expect(parseCardAlert(mail('Refund', 'Rs 450 has been credited to your card as refund from SWIGGY'))).toBeNull();
    expect(parseCardAlert(mail('OTP', 'OTP for transaction of Rs 500 on your card is 123456'))).toBeNull();
    expect(parseCardAlert(mail('Payment received', 'Payment received of Rs 25,000 on your credit card. Thank you'))).toBeNull();
    expect(parseCardAlert(mail('Declined', 'Transaction of Rs 900 on your card at ZOMATO was declined'))).toBeNull();
    expect(parseCardAlert(mail('Newsletter', 'Spent too much? Save Rs 500 with our app'))).toBeNull();
  });
});

describe('decodeBase64Url', () => {
  it('decodes UTF-8 including ₹', () => {
    // "Rs ₹450 spent" in base64url
    const enc = Buffer.from('Rs ₹450 spent', 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeBase64Url(enc)).toBe('Rs ₹450 spent');
  });
});

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function fakeGmail(messages: Record<string, { subject: string; body: string; html?: boolean }>, status = 200) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    if (status !== 200) return new Response('{}', { status });
    if (url.includes('/messages?')) return Response.json({ messages: Object.keys(messages).map((id) => ({ id })) });
    const id = url.split('/messages/')[1]!.split('?')[0]!;
    const m = messages[id]!;
    return Response.json({
      id, internalDate: String(at),
      payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: m.subject }],
        parts: [{ mimeType: m.html ? 'text/html' : 'text/plain', body: { data: b64(m.html ? `<p>${m.body}</p>` : m.body) } }] },
    });
  }) as unknown as FetchLike;
  return { fn, calls };
}

describe('syncGmail', () => {
  it('reads alerts, skips junk and already-imported ids', async () => {
    const { fn, calls } = fakeGmail({
      a: { subject: 'Card alert', body: 'Rs 640 spent on your HDFC card at ZOMATO on 03/10/2026.' },
      b: { subject: 'Card alert', body: 'Rs.3,850.00 spent on card ending 11 at BIGBASKET on 04/10/2026.', html: true },
      c: { subject: 'Offer', body: 'Get a new card today' },
      d: { subject: 'Card alert', body: 'Rs 100 spent on card at X on 01/10/2026' },
    });
    const r = await syncGmail('tok', { fetchFn: fn, existingIds: new Set(['gm_d']) });
    expect(r.scanned).toBe(4);
    expect(r.duplicates).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.added.map((e) => [e.description, e.amount, e.category])).toEqual([['ZOMATO', 640, 'Food'], ['BIGBASKET', 3850, 'Groceries']]);
    expect(calls.some((u) => u.includes('/messages/d'))).toBe(false);
    expect(decodeURIComponent(calls[0]!)).toContain('newer_than:90d');
  });
  it('throws GmailAuthError on 401', async () => {
    const { fn } = fakeGmail({}, 401);
    await expect(syncGmail('bad', { fetchFn: fn })).rejects.toBeInstanceOf(GmailAuthError);
  });
});

describe('store with gmail', () => {
  it('keeps gmailLastSync and dedupes merges', () => {
    const d = { ...demoData(new Date(2026, 10, 5)), gmailLastSync: '2026-11-05T10:00:00Z' };
    expect(deserialize(serialize(d)).gmailLastSync).toBe('2026-11-05T10:00:00Z');
    const e = { id: 'gm_x', date: '2026-10-01', description: 'X', amount: 1, category: 'Other' as const, source: 'gmail' as const };
    const once = mergeExpenses(d, [e]);
    expect(mergeExpenses(once, [e]).expenses.length).toBe(once.expenses.length);
  });
});
