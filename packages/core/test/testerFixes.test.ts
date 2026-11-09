import { describe, expect, it } from 'vitest';
import {
  analyze, checkRowState, demoData, emptyData, initialChecks, applyReread, takeDocumentNumber, parseStatement,
  RISK_INCOMPLETE_TEXT, shownRiskResult, DOC_MESSAGES, rereadsLeftText,
} from '../src';

describe('TC-44: statement files with either sign for debits', () => {
  it('positive debits (card statement): spends in, negative refunds and payments out', () => {
    const r = parseStatement([
      '05/10/2026, SWIGGY BANGALORE, 450.00',
      '06/10/2026, AMAZON PAY INDIA, 1299',
      '07/10/2026, AMAZON REFUND, -1299',
      '08/10/2026, PAYMENT - THANK YOU, -5000',
      '09/10/2026, UBER TRIP, 230 Dr',
      '10/10/2026, CASHBACK, 50 Cr',
    ].join('\n'));
    expect(r.expenses.map((e) => [e.description, e.amount])).toEqual([['SWIGGY BANGALORE', 450], ['AMAZON PAY INDIA', 1299], ['UBER TRIP', 230]]);
    expect(r.skipped).toBe(3);
  });

  it('negative debits (bank export): negatives are spends, positive credits are skipped', () => {
    const r = parseStatement([
      'Date,Description,Amount',
      '2026-10-01,SWIGGY ORDER,-450',
      '2026-10-02,BIGBASKET,-1200.50',
      '2026-10-03,SALARY OCT,85000',
      '2026-10-04,ZOMATO REFUND,320',
      '2026-10-05,NETFLIX,-649',
      '2026-10-06,UPI FROM FRIEND,500',
    ].join('\n'));
    expect(r.expenses.map((e) => [e.description, e.amount, e.category])).toEqual([
      ['SWIGGY ORDER', 450, 'Food'], ['BIGBASKET', 1200.5, 'Groceries'], ['NETFLIX', 649, 'Entertainment'],
    ]);
    expect(r.skipped).toBe(4); // header + salary + refund + incoming UPI
  });

  it('the tester file imports as spends', () => {
    const r = parseStatement(['2026-10-01,SWIGGY ORDER,-450', '2026-10-02,UBER,-230', '2026-10-03,AMAZON,-999'].join('\n'));
    expect(r.expenses).toHaveLength(3);
    expect(r.skipped).toBe(0);
  });
});

describe('TC-42: no risk score before all 6 answers', () => {
  it('Analysis.risk and the shown result stay empty until the quiz is complete', () => {
    const d = demoData(new Date(2026, 10, 5));
    expect(analyze(d).risk).not.toBeNull(); // demo user answered everything
    const partial = { ...d, riskAnswers: { horizon: 4 } };
    const a = analyze(partial);
    expect(a.risk).toBeNull();
    expect(a.missing).toContain('risk');
    expect(a.portfolio).not.toBeNull(); // the plan still works with a middle-answer estimate
    expect(shownRiskResult({}, 30)).toBeNull();
    expect(shownRiskResult(d.riskAnswers, 30)).not.toBeNull();
    expect(RISK_INCOMPLETE_TEXT).toBe('Answer all 6 questions to see your risk profile.');
    expect(analyze(emptyData()).risk).toBeNull();
  });
});

describe('TC-50 / TC-31: Check numbers row', () => {
  const typed = { pan: 'ABCPS1234F', aadhaar: '234123412346' };
  const [pan] = initialChecks(typed, { pan: 'AAAPZ9999Z', aadhaar: '234123412346' }, { pan: false, aadhaar: true });

  it('numbers differ: all three choices and the counter', () => {
    expect(checkRowState(pan!)).toMatchObject({ review: true, useDocument: true, edit: true, uploadAgain: true, leftText: '2 re-checks left' });
  });

  it('after Use number from document + one re-read, Upload again and 1 re-check stay', () => {
    const took = takeDocumentNumber(pan!);
    expect(checkRowState(took)).toMatchObject({ useDocument: false, edit: false, uploadAgain: true, leftText: '2 re-checks left' });
    const again = applyReread(took, took.final, 'AAAPZ9999Z', false);
    expect(checkRowState(again)).toMatchObject({ review: true, useDocument: false, uploadAgain: true, left: 1, leftText: '1 re-check left' });
  });

  it('no re-checks left: the row says so in words', () => {
    const used = applyReread(applyReread(pan!, pan!.final, 'AAAPZ9999Z', false), pan!.final, 'AAAPZ9999Z', false);
    expect(checkRowState(used)).toMatchObject({ uploadAgain: false, edit: false, useDocument: true, left: 0, leftText: 'No re-checks left for this card.' });
    expect(rereadsLeftText(0)).toBe(DOC_MESSAGES.noRereadsLeft);
    expect(checkRowState(pan!, 0).leftText).toBe('No re-checks left for this card.');
  });

  it('a matched card offers nothing', () => {
    const [, aad] = initialChecks(typed, { pan: 'ABCPS1234F', aadhaar: '234123412346' }, { pan: true, aadhaar: true });
    expect(checkRowState(aad!)).toMatchObject({ review: false, uploadAgain: false, leftText: '' });
  });
});

describe('TC-77: upload hint', () => {
  it('selfie-only names no PDF and no "each"', async () => {
    const { kycUploadHint } = await import('../src');
    expect(kycUploadHint(true)).toBe('Upload a new selfie (JPG or PNG, up to 10 MB).');
    expect(kycUploadHint(true)).not.toMatch(/PDF|each/);
    expect(kycUploadHint(false)).toBe('Upload your selfie, Aadhaar card and PAN card (JPG, PNG or PDF; selfie JPG or PNG; up to 10 MB each).');
  });
});
