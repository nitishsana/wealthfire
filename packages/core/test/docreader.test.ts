import { describe, expect, it } from 'vitest';
import {
  DOC_MESSAGES, DemoDocumentReader, createDocumentReader, validateAadhaar, validateDocFile, validatePan,
  type DemoReadMode, type DocFile, type KycField,
} from '../src';

const MB10 = 10 * 1024 * 1024;
const PAN = 'ABCPS1234F';
const AADHAAR = '234123412346';
const file = (kind: DocFile['kind'], mime: DocFile['mime'] = 'image/jpeg'): DocFile =>
  ({ kind, name: `${kind}.jpg`, mime, size: 200_000, uri: 'blob:x' });
const expectedFor = (f: KycField) => (f === 'pan' ? PAN : AADHAAR);
const validFor = (f: KycField, v: string) => (f === 'pan' ? validatePan(v) : validateAadhaar(v)) === null;

describe('validateDocFile', () => {
  const selfieMsg = 'Use a JPG or PNG photo under 10 MB.';
  const cardMsg = 'Use a JPG, PNG or PDF under 10 MB.';
  it('selfie PDF rejected, card PDF ok', () => {
    expect(validateDocFile({ kind: 'selfie', mime: 'application/pdf', size: 1000 })).toBe(selfieMsg);
    expect(validateDocFile({ kind: 'selfie', mime: 'image/png', size: 1000 })).toBeNull();
    expect(validateDocFile({ kind: 'aadhaar', mime: 'application/pdf', size: 1000 })).toBeNull();
    expect(validateDocFile({ kind: 'pan', mime: 'application/pdf', size: 1000 })).toBeNull();
  });
  it('10 MB ok, 10 MB + 1 rejected', () => {
    expect(validateDocFile({ kind: 'pan', mime: 'image/jpeg', size: MB10 })).toBeNull();
    expect(validateDocFile({ kind: 'pan', mime: 'image/jpeg', size: MB10 + 1 })).toBe(cardMsg);
    expect(validateDocFile({ kind: 'selfie', mime: 'image/jpeg', size: MB10 + 1 })).toBe(selfieMsg);
    expect(validateDocFile({ kind: 'pan', mime: 'image/jpeg', size: 0 })).toBe(cardMsg);
  });
  it('GIF rejected', () => {
    const gif = 'image/gif' as DocFile['mime'];
    expect(validateDocFile({ kind: 'aadhaar', mime: gif, size: 1000 })).toBe(cardMsg);
    expect(validateDocFile({ kind: 'selfie', mime: gif, size: 1000 })).toBe(selfieMsg);
  });
});

describe('DemoDocumentReader', () => {
  const fields: KycField[] = ['pan', 'aadhaar'];

  it('is demo and defaults to match', () => {
    const r = new DemoDocumentReader();
    expect(r.id).toBe('demo');
    expect(r.isDemo).toBe(true);
    expect(r.mode).toBe('match');
  });

  for (const field of fields) {
    const doc = file(field);
    const expected = expectedFor(field);

    it(`match (${field}): first and strict read return expected`, async () => {
      const r = new DemoDocumentReader('match');
      expect(await r.read(doc, field, { strict: false, expected })).toEqual({ ok: true, value: expected, nameMatch: true });
      expect(await r.read(doc, field, { strict: true, expected })).toEqual({ ok: true, value: expected, nameMatch: true });
    });

    it(`misread (${field}): first read valid and different, strict returns expected`, async () => {
      const r = new DemoDocumentReader('misread');
      const first = await r.read(doc, field, { strict: false, expected });
      if (!first.ok) throw new Error('expected ok');
      expect(first.value).not.toBe(expected);
      expect(validFor(field, first.value)).toBe(true);
      expect(first.nameMatch).toBe(true);
      expect([...first.value].filter((ch, i) => ch !== expected[i]).length).toBeLessThanOrEqual(field === 'pan' ? 1 : 2);
      expect(await r.read(doc, field, { strict: true, expected })).toEqual({ ok: true, value: expected, nameMatch: true });
    });

    it(`different (${field}): never equals expected, same on strict`, async () => {
      const r = new DemoDocumentReader('different');
      const first = await r.read(doc, field, { strict: false, expected });
      const strict = await r.read(doc, field, { strict: true, expected });
      if (!first.ok || !strict.ok) throw new Error('expected ok');
      expect(first.value).not.toBe(expected);
      expect(validFor(field, first.value)).toBe(true);
      expect(strict.value).toBe(first.value);
      expect([first.nameMatch, strict.nameMatch]).toEqual([false, false]);
    });

    it(`unreadable (${field}): names the document`, async () => {
      const r = new DemoDocumentReader('unreadable');
      const name = field === 'pan' ? 'PAN' : 'Aadhaar';
      const want = { ok: false, reason: 'unreadable', message: `We couldn't read your ${name} card. Upload a clearer photo or PDF.` };
      expect(await r.read(doc, field, { strict: false, expected })).toEqual(want);
      expect(await r.read(doc, field, { strict: true, expected })).toEqual(want);
    });
  }

  it('different swaps when typed equals the fixed number', async () => {
    const r = new DemoDocumentReader('different');
    expect(await r.read(file('aadhaar'), 'aadhaar', { strict: false, expected: '499118665246' }))
      .toEqual({ ok: true, value: '234123412346', nameMatch: false });
    expect(await r.read(file('aadhaar'), 'aadhaar', { strict: false, expected: AADHAAR }))
      .toEqual({ ok: true, value: '499118665246', nameMatch: false });
    expect(await r.read(file('pan'), 'pan', { strict: false, expected: 'AAAPZ9999Z' })).toEqual({ ok: true, value: 'ABCPE1234F', nameMatch: false });
    expect(validateAadhaar('499118665246')).toBeNull();
  });

  it('mode can be changed at runtime; bad file → invalid', async () => {
    const r = new DemoDocumentReader();
    r.mode = 'unreadable' as DemoReadMode;
    expect((await r.read(file('pan'), 'pan', { strict: false, expected: PAN })).ok).toBe(false);
    r.mode = 'match';
    expect(await r.read({ ...file('pan'), size: MB10 + 1 }, 'pan', { strict: false, expected: PAN }))
      .toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('createDocumentReader', () => {
  const extract = async () => ['INCOME TAX DEPARTMENT\nName\nABCPS1234F'];
  it('undefined, empty or ondevice → on-device reader with the given extractor', async () => {
    for (const reader of [undefined, '', 'ondevice']) {
      const r = createDocumentReader({ reader, extract });
      expect(r.id).toBe('ondevice');
      expect(r.isDemo).toBe(false);
      expect(await r.read(file('pan'), 'pan', { strict: false })).toEqual({ ok: true, value: PAN, nameMatch: null });
    }
  });
  it('on-device without an extractor always fails, never a fake match', async () => {
    for (const reader of [undefined, '', 'ondevice']) {
      const r = createDocumentReader({ reader });
      expect(r.id).toBe('ondevice');
      expect(r.isDemo).toBe(false);
      const want = { ok: false, reason: 'unreadable', message: "Document reading isn't available in this app build." };
      expect(await r.read(file('pan'), 'pan', { strict: false, expected: PAN })).toEqual(want);
      expect(await r.read(file('aadhaar'), 'aadhaar', { strict: true, expected: AADHAAR })).toEqual(want);
    }
  });
  it('demo → demo reader', () => {
    expect(createDocumentReader({ reader: 'demo' })).toBeInstanceOf(DemoDocumentReader);
    expect(createDocumentReader({ reader: 'demo', extract }).isDemo).toBe(true);
  });
  it('real readers are not built yet', () => {
    expect(() => createDocumentReader({ reader: 'digio' })).toThrow('Document reader "digio" is not built yet');
    expect(() => createDocumentReader({ reader: 'hyperverge', apiUrl: 'https://x' })).toThrow('not built yet');
  });
});

describe('DOC_MESSAGES shared texts', () => {
  it('has the shared texts and no demo label', () => {
    expect(DOC_MESSAGES).toMatchObject({
      couldNotReadFile: 'Could not read that file.',
      couldNotReadDocs: 'Could not read your documents. Check your connection and try again.',
      noCamera: 'No camera found. Upload a photo instead.',
      cameraReason: 'Wealthfire needs your camera to take your KYC selfie.',
      cameraDenied: 'Allow camera access, or choose a file instead.',
      uploadIntro: 'Add all three to finish your KYC.',
      matchLabel: '✅ Match',
      mismatchLabel: "❌ Doesn't match",
      cameraInUse: 'Your camera is in use by another app. Close it and try again.',
      waitingForCamera: 'Waiting for camera permission…',
      notPan: "This doesn't look like a PAN card. Upload your PAN card.",
      notAadhaar: "This doesn't look like an Aadhaar card. Upload your Aadhaar card.",
      maskedAadhaar: 'This Aadhaar is masked. Upload the full Aadhaar or the e-Aadhaar PDF.',
      readerUnavailable: "Document reading isn't available in this app build.",
    });
    expect('demoLabel' in DOC_MESSAGES).toBe(false);
  });
});
