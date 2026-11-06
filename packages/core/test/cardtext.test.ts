import { describe, expect, it } from 'vitest';
import {
  DOC_MESSAGES, createOnDeviceReader, fixPanSwaps, parseAadhaarText, parsePanText, pickMajority,
  nameOnCard, sameDocument, verhoeffCheckDigit,
  type DocFile, type TextExtractor,
} from '../src';

// Synthetic OCR texts only (test numbers ABCPE1234F / 234123412346). No real card data.
const PAN_TEXT = [
  'आयकर विभाग INCOME TAX DEPARTMENT',
  'GOVT. OF INDIA',
  'Permanent Account Number Card',
  'ABCPE1234F',
  'NITISH SANA',
  'Date of Birth 01/01/1990',
].join('\n');

const AADHAAR_TEXT = [
  'भारत सरकार',
  'Government of India',
  'Nitish Sana',
  'DOB: 01/01/1990',
  'MALE',
  '2341 2341 2346',
  'आधार - आम आदमी का अधिकार',
].join('\n');

const RANDOM_PDF = [
  'Electricity bill for October',
  'Account number 234123412346',
  'Amount due Rs 1,240.00',
].join('\n');

const file = (kind: DocFile['kind'], mime: DocFile['mime'] = 'image/jpeg'): DocFile =>
  ({ kind, name: `${kind}.jpg`, mime, size: 200_000, uri: 'blob:x' });
const reader = (texts: string[] | (() => Promise<string[]>)) => {
  const extract: TextExtractor = typeof texts === 'function' ? texts : async () => texts;
  return createOnDeviceReader(extract);
};

describe('parsePanText', () => {
  it('reads a PAN card', () => {
    expect(parsePanText(PAN_TEXT)).toMatchObject({ looksLikeCard: true, value: 'ABCPE1234F', masked: false });
  });
  it('fixes OCR swaps by position', () => {
    expect(fixPanSwaps('ABCPE1Z34F')).toBe('ABCPE1234F');
    expect(fixPanSwaps('A8CPE1234F')).toBe('ABCPE1234F');
    expect(fixPanSwaps('ABCPEI2S4F')).toBe('ABCPE1254F');
    expect(parsePanText(PAN_TEXT.replace('ABCPE1234F', 'ABCPE1Z34F')).value).toBe('ABCPE1234F');
    expect(parsePanText(PAN_TEXT.replace('ABCPE1234F', 'A8CPE I234 F')).value).toBe('ABCPE1234F');
  });
  it('a company PAN is still reported (not dropped)', () => {
    expect(parsePanText(PAN_TEXT.replace('ABCPE1234F', 'ABCCE1234F')).value).toBe('ABCCE1234F');
  });
  it('Aadhaar text and random text are not a PAN card', () => {
    expect(parsePanText(AADHAAR_TEXT).looksLikeCard).toBe(false);
    expect(parsePanText(RANDOM_PDF)).toMatchObject({ looksLikeCard: false, value: null });
  });
  it('card words but no number', () => {
    expect(parsePanText('INCOME TAX DEPARTMENT\nName\nNITISH SANA')).toMatchObject({ looksLikeCard: true, value: null });
  });
});

describe('parseAadhaarText', () => {
  it('reads an Aadhaar card, grouped or not', () => {
    expect(parseAadhaarText(AADHAAR_TEXT)).toMatchObject({ looksLikeCard: true, value: '234123412346', masked: false });
    expect(parseAadhaarText(AADHAAR_TEXT.replace('2341 2341 2346', '234123412346')).value).toBe('234123412346');
  });
  it('a PAN text given to the Aadhaar parser is not a card', () => {
    expect(parseAadhaarText(PAN_TEXT).looksLikeCard).toBe(false);
  });
  it('random PDF text is not a card', () => {
    expect(parseAadhaarText(RANDOM_PDF).looksLikeCard).toBe(false);
  });
  it('VID is ignored', () => {
    const t = 'Unique Identification Authority of India\nMale\nVID : 9134 2341 2341 2346';
    expect(parseAadhaarText(t)).toMatchObject({ looksLikeCard: true, value: null, candidates: [] });
    // a bare 16-digit run is not read as an Aadhaar either
    expect(parseAadhaarText('Aadhaar\n9134 2341 2341 2346').value).toBeNull();
    expect(parseAadhaarText('Aadhaar\n9134234123412346').value).toBeNull();
    // VID next to the real number: the number is read
    expect(parseAadhaarText(`${AADHAAR_TEXT}\nVID: 9134 4991 1866 5246`).value).toBe('234123412346');
  });
  it('masked Aadhaar', () => {
    const t = 'Aadhaar\nGovernment of India\nFemale\nXXXX XXXX 2346';
    expect(parseAadhaarText(t)).toMatchObject({ looksLikeCard: true, value: null, masked: true });
    expect(parseAadhaarText('Aadhaar\nxxxxxxxx2346').masked).toBe(true);
  });
  it('Verhoeff-failing and 0/1-start 12-digit runs are rejected', () => {
    expect(parseAadhaarText('Aadhaar\n2341 2341 2347').value).toBeNull();
    expect(parseAadhaarText('Aadhaar\n1341 2341 2346').value).toBeNull();
  });
  it('two different valid numbers in one text tie → no value', () => {
    expect(parseAadhaarText('Aadhaar\n2341 2341 2346\n4991 1866 5246').value).toBeNull();
  });
});

describe('pickMajority', () => {
  it('most frequent wins; ties and empty → null', () => {
    expect(pickMajority(['A', 'B', 'A', null])).toBe('A');
    expect(pickMajority(['A', 'B'])).toBeNull();
    expect(pickMajority([null, undefined])).toBeNull();
    expect(pickMajority([])).toBeNull();
    expect(pickMajority(['A'])).toBe('A');
  });
});

describe('createOnDeviceReader', () => {
  it('is on-device and not demo', () => {
    const r = reader([]);
    expect(r.id).toBe('ondevice');
    expect(r.isDemo).toBe(false);
  });

  it('reads PAN and Aadhaar; never uses expected', async () => {
    expect(await reader([PAN_TEXT]).read(file('pan'), 'pan', { strict: false, expected: 'AAAPZ9999Z' }))
      .toEqual({ ok: true, value: 'ABCPE1234F', nameMatch: null });
    expect(await reader([AADHAAR_TEXT]).read(file('aadhaar'), 'aadhaar', { strict: false, expected: '499118665246' }))
      .toEqual({ ok: true, value: '234123412346', nameMatch: null });
  });

  it('wrong card → not a PAN / not an Aadhaar', async () => {
    expect(await reader([AADHAAR_TEXT]).read(file('pan'), 'pan', { strict: false }))
      .toEqual({ ok: false, reason: 'invalid', message: "This doesn't look like a PAN card. Upload your PAN card." });
    expect(await reader([PAN_TEXT]).read(file('aadhaar'), 'aadhaar', { strict: false }))
      .toEqual({ ok: false, reason: 'invalid', message: "This doesn't look like an Aadhaar card. Upload your Aadhaar card." });
    expect(await reader([RANDOM_PDF]).read(file('aadhaar', 'application/pdf'), 'aadhaar', { strict: false }))
      .toMatchObject({ ok: false, reason: 'invalid', message: DOC_MESSAGES.notAadhaar });
    expect(await reader([]).read(file('pan'), 'pan', { strict: false }))
      .toMatchObject({ ok: false, message: DOC_MESSAGES.notPan });
  });

  it('masked Aadhaar → invalid with the masked message', async () => {
    expect(await reader(['Aadhaar\nDOB: 01/01/1990\nXXXX XXXX 2346']).read(file('aadhaar'), 'aadhaar', { strict: false }))
      .toEqual({ ok: false, reason: 'invalid', message: 'This Aadhaar is masked. Upload the full Aadhaar or the e-Aadhaar PDF.' });
  });

  it('card words but no valid number → unreadable', async () => {
    expect(await reader(['INCOME TAX DEPARTMENT\nName\nNITISH']).read(file('pan'), 'pan', { strict: false }))
      .toEqual({ ok: false, reason: 'unreadable', message: "We couldn't read your PAN card. Upload a clearer photo or PDF." });
  });

  it('majority across passes; a tie is unreadable', async () => {
    const other = AADHAAR_TEXT.replace('2341 2341 2346', '4991 1866 5246');
    const passes = [AADHAAR_TEXT, other, AADHAAR_TEXT, 'blurred noise'];
    expect(await reader(passes).read(file('aadhaar'), 'aadhaar', { strict: true })).toEqual({ ok: true, value: '234123412346', nameMatch: null });
    expect(await reader([AADHAAR_TEXT, other]).read(file('aadhaar'), 'aadhaar', { strict: true }))
      .toMatchObject({ ok: false, reason: 'unreadable' });
    // a sideways pass with the number but no keywords still counts
    expect(await reader(['INCOME TAX DEPARTMENT\nName', 'ABCPE1Z34F']).read(file('pan'), 'pan', { strict: true }))
      .toEqual({ ok: true, value: 'ABCPE1234F', nameMatch: null });
  });

  it('passes strict to the extractor; bad file and extractor errors', async () => {
    const seen: boolean[] = [];
    const r = createOnDeviceReader(async (_d, o) => { seen.push(o.strict); return [PAN_TEXT]; });
    await r.read(file('pan'), 'pan', { strict: true });
    await r.read(file('pan'), 'pan', { strict: false });
    expect(seen).toEqual([true, false]);
    expect(await r.read({ ...file('pan'), size: 0 }, 'pan', { strict: false })).toMatchObject({ ok: false, reason: 'invalid' });
    const broken = reader(async () => { throw new Error('ocr crashed'); });
    expect(await broken.read(file('pan'), 'pan', { strict: false })).toMatchObject({ ok: false, reason: 'unreadable' });
  });
});

// ---- Pre-merge fixes (review bugs 1, 2, 4, 5, 6; locked PDFs; same file) ----

const ITR_ACK = [
  'INDIAN INCOME TAX RETURN ACKNOWLEDGEMENT',
  'Assessment Year 2026-27',
  'INCOME TAX DEPARTMENT',
  'PAN ABCPE1234F',
  'Name NITISH SANA',
].join('\n');

const VOTER_ID = [
  'ELECTION COMMISSION OF INDIA',
  'Government of India',
  'IDENTITY CARD',
  'Name: Nitish Sana',
  'Male',
  'Date of Birth 01/01/1990',
  '2341 2341 2346',
].join('\n');

/** A Verhoeff-valid 12-digit number from its first 11 digits. */
const withCheck = (first11: string) => first11 + verhoeffCheckDigit(first11);
const aadhaarCard = (numberLine: string) => AADHAAR_TEXT.replace('2341 2341 2346', numberLine);

describe('PAN card needs PAN words and a card label', () => {
  it('ITR / acknowledgement text is not a PAN card', async () => {
    expect(parsePanText(ITR_ACK).looksLikeCard).toBe(false);
    expect(parsePanText('INCOME TAX DEPARTMENT\nITR-V\nName\nABCPE1234F').looksLikeCard).toBe(false);
    expect(await reader([ITR_ACK]).read(file('pan', 'application/pdf'), 'pan', { strict: false }))
      .toEqual({ ok: false, reason: 'invalid', message: DOC_MESSAGES.notPan });
  });
  it('"GOVT. OF INDIA" alone is not enough', () => {
    expect(parsePanText('GOVT. OF INDIA\nName\nDate of Birth\nABCPE1234F').looksLikeCard).toBe(false);
  });
  it('PAN words without a card label are not enough', () => {
    expect(parsePanText('INCOME TAX DEPARTMENT\nABCPE1234F').looksLikeCard).toBe(false);
  });
  it('Hindi words and labels count', () => {
    expect(parsePanText('आयकर विभाग\nजन्म की तारीख\nABCPE1234F')).toMatchObject({ looksLikeCard: true, value: 'ABCPE1234F' });
    expect(parsePanText('Permanent Account Number\nनाम\nABCPE1234F').looksLikeCard).toBe(true);
  });
});

describe('PAN candidates', () => {
  it('an all-digit run never becomes a PAN', () => {
    const t = `${PAN_TEXT}\nMobile 1208512345`;
    expect(parsePanText(t).candidates).toEqual(['ABCPE1234F']);
    expect(parsePanText('INCOME TAX DEPARTMENT\nName\n1208512345').value).toBeNull();
  });
  it('a joined-words token does not tie a clean single-word PAN', () => {
    // "RAMPA SOILK" joins to RAMPASOILK → swaps → RAMPA5011K (PAN-shaped)
    const t = `${PAN_TEXT}\nRAMPA SOILK`;
    expect(parsePanText(t)).toMatchObject({ value: 'ABCPE1234F', candidates: ['ABCPE1234F'] });
    // with no clean candidate the joined one is still used
    expect(parsePanText('INCOME TAX DEPARTMENT\nName\nA8CPE I234 F').value).toBe('ABCPE1234F');
  });
  it('company PAN → companyPan message', async () => {
    expect(await reader([PAN_TEXT.replace('ABCPE1234F', 'ABCCE1234F')]).read(file('pan'), 'pan', { strict: false }))
      .toEqual({ ok: false, reason: 'invalid', message: 'This is a company or firm PAN. Upload your personal PAN card.' });
    expect(await reader([PAN_TEXT.replace('ABCPE1234F', 'ABCFE1234F')]).read(file('pan'), 'pan', { strict: false }))
      .toMatchObject({ ok: false, message: DOC_MESSAGES.companyPan });
  });
});

describe('Aadhaar card needs Aadhaar words and a card label', () => {
  it('voter-ID-like text with "Government of India" is not an Aadhaar', async () => {
    expect(parseAadhaarText(VOTER_ID).looksLikeCard).toBe(false);
    expect(await reader([VOTER_ID]).read(file('aadhaar'), 'aadhaar', { strict: false }))
      .toEqual({ ok: false, reason: 'invalid', message: DOC_MESSAGES.notAadhaar });
  });
  it('"Government of India" / "भारत सरकार" alone never counts', () => {
    expect(parseAadhaarText('Government of India\nDOB: 01/01/1990\n2341 2341 2346').looksLikeCard).toBe(false);
    expect(parseAadhaarText('भारत सरकार\nपुरुष\n2341 2341 2346').looksLikeCard).toBe(false);
  });
  it('Aadhaar word without a card label is not enough; with one it is', () => {
    expect(parseAadhaarText('Aadhaar\n2341 2341 2346').looksLikeCard).toBe(false);
    expect(parseAadhaarText('Aadhaar\nAddress: Pune\n2341 2341 2346').looksLikeCard).toBe(true);
    expect(parseAadhaarText('आधार\nमहिला\n2341 2341 2346').looksLikeCard).toBe(true);
    expect(parseAadhaarText('Unique Identification Authority of India\nEnrolment No: 1234/56789/01234').looksLikeCard).toBe(true);
  });
});

describe('Aadhaar number reading', () => {
  it('a number after a date on the same line is read', () => {
    expect(parseAadhaarText(aadhaarCard('DOB: 01/01/1990 2341 2341 2346')).value).toBe('234123412346');
    expect(parseAadhaarText(aadhaarCard('01-01-1990 2341 2341 2346')).value).toBe('234123412346');
    expect(parseAadhaarText(aadhaarCard('Year of Birth : 1990 2341 2341 2346')).value).toBe('234123412346');
  });
  it('a VID on the same line does not hide the number, and the VID is never read', () => {
    const p = parseAadhaarText(aadhaarCard('Your Aadhaar No. : 2341 2341 2346 VID : 9134 4991 1866 5246'));
    expect(p.value).toBe('234123412346');
    expect(p.candidates).toEqual(['234123412346']);
  });
  it('dots and hyphens as separators', () => {
    expect(parseAadhaarText(aadhaarCard('2341.2341.2346')).value).toBe('234123412346');
    expect(parseAadhaarText(aadhaarCard('2341-2341-2346')).value).toBe('234123412346');
    expect(parseAadhaarText(aadhaarCard('2341 - 2341 - 2346')).value).toBe('234123412346');
  });
  it('OCR letter swaps inside digit groups (O→0, I/l→1, S→5, B→8)', () => {
    const zero = withCheck('23410234123');
    const ocr0 = `${zero.slice(0, 4)} ${zero.slice(4, 8).replace(/0/g, 'O')} ${zero.slice(8)}`;
    expect(parseAadhaarText(aadhaarCard(ocr0)).value).toBe(zero);
    expect(parseAadhaarText(aadhaarCard('234l 234I 2346')).value).toBe('234123412346');
    const n58 = withCheck('25842341234');
    const ocr58 = `${n58.slice(0, 4).replace('5', 'S').replace('8', 'B')} ${n58.slice(4, 8)} ${n58.slice(8)}`;
    expect(parseAadhaarText(aadhaarCard(ocr58)).value).toBe(n58);
  });
  it('words are not read as digits', () => {
    expect(parseAadhaarText(aadhaarCard('BOSS SOIL BIOS')).value).toBeNull();
  });
});

describe('locked PDFs', () => {
  const lockedErr = (code: string) => Object.assign(new Error('locked'), { code });
  it('pdf-locked → locked with the password prompt', async () => {
    const r = reader(async () => { throw lockedErr('pdf-locked'); });
    expect(await r.read(file('aadhaar', 'application/pdf'), 'aadhaar', { strict: false }))
      .toEqual({ ok: false, reason: 'locked', message: "This PDF has a password. Enter it to read the file. It isn't saved." });
  });
  it('pdf-bad-password → locked with the wrong-password message', async () => {
    const r = reader(async () => { throw lockedErr('pdf-bad-password'); });
    expect(await r.read(file('pan', 'application/pdf'), 'pan', { strict: false, password: 'nope' }))
      .toEqual({ ok: false, reason: 'locked', message: "That password didn't open the PDF. Try again." });
  });
  it('other codes are still unreadable', async () => {
    const r = reader(async () => { throw lockedErr('something-else'); });
    expect(await r.read(file('pan', 'application/pdf'), 'pan', { strict: false }))
      .toMatchObject({ ok: false, reason: 'unreadable' });
  });
  it('the password is passed to the extractor only when given', async () => {
    const seen: { strict: boolean; password?: string }[] = [];
    const r = createOnDeviceReader(async (_d, o) => { seen.push(o); return [PAN_TEXT]; });
    expect(await r.read(file('pan', 'application/pdf'), 'pan', { strict: true, password: 'p@ss' }))
      .toEqual({ ok: true, value: 'ABCPE1234F', nameMatch: null });
    await r.read(file('pan', 'application/pdf'), 'pan', { strict: false });
    expect(seen).toEqual([{ strict: true, password: 'p@ss' }, { strict: false }]);
    expect('password' in seen[1]!).toBe(false);
  });
});

describe('sameDocument and new messages', () => {
  it('same name, size and type → same file', () => {
    const a = { name: 'card.pdf', size: 1000, mime: 'application/pdf' as const };
    expect(sameDocument(a, { ...a })).toBe(true);
    expect(sameDocument(a, { ...a, name: 'other.pdf' })).toBe(false);
    expect(sameDocument(a, { ...a, size: 1001 })).toBe(false);
    expect(sameDocument(a, { ...a, mime: 'image/png' })).toBe(false);
  });
  it('message texts', () => {
    expect(DOC_MESSAGES.pdfLockedPhone).toBe('This PDF has a password. Remove the password or upload a photo of the card instead.');
    expect(DOC_MESSAGES.sameFile).toBe('You uploaded the same file for both cards. Upload your Aadhaar and PAN separately.');
    expect(DOC_MESSAGES.noRereadsLeft).toBe('No re-checks left for this card.');
    expect(DOC_MESSAGES.verifiedNumberLabel).toBe('Verified number');
  });
});

describe('nameOnCard', () => {
  it('exact name (case, punctuation and spacing ignored)', () => {
    expect(nameOnCard([PAN_TEXT], 'Nitish', 'Sana')).toBe(true);
    expect(nameOnCard(['Name: NITISH  KUMAR SANA'], 'nitish kumar', 'sana')).toBe(true);
    expect(nameOnCard(["Name: ANITA D'SOUZA"], 'Anita', "D'Souza")).toBe(true);
  });
  it('one OCR typo allowed in words of 5+ letters only', () => {
    expect(nameOnCard(['NITISN SANA'], 'Nitish', 'Sana')).toBe(true); // 6 letters, one changed
    expect(nameOnCard(['NITSH SANA'], 'Nitish', 'Sana')).toBe(true); // one letter dropped
    expect(nameOnCard(['NITISH SAMA'], 'Nitish', 'Sana')).toBe(false); // 4 letters: exact only
    expect(nameOnCard(['NIXISN SANA'], 'Nitish', 'Sana')).toBe(false); // two changes
  });
  it('whole words only, in any pass', () => {
    expect(nameOnCard(['NITISHSANA'], 'Nitish', 'Sana')).toBe(false);
    expect(nameOnCard(['NITISH', 'noise\nSANA'], 'Nitish', 'Sana')).toBe(true);
  });
  it('missing surname → false', () => {
    expect(nameOnCard(['Name NITISH'], 'Nitish', 'Sana')).toBe(false);
    expect(nameOnCard(['Name NITISH RAO'], 'Nitish', 'Sana Rao')).toBe(false); // every last-name word needed
  });
  it('another person → false; nothing to compare → false', () => {
    expect(nameOnCard(['Name RAHUL VERMA'], 'Nitish', 'Sana')).toBe(false);
    expect(nameOnCard([PAN_TEXT], '', '')).toBe(false);
  });
  it('only the first word of the first name is needed', () => {
    expect(nameOnCard(['NITISH SANA'], 'Nitish Kumar', 'Sana')).toBe(true);
  });
});

describe('reader name check', () => {
  it('returns nameMatch from the card text when a name is given', async () => {
    expect(await reader([PAN_TEXT]).read(file('pan'), 'pan', { strict: false, name: { first: 'Nitish', last: 'Sana' } }))
      .toEqual({ ok: true, value: 'ABCPE1234F', nameMatch: true });
    expect(await reader([AADHAAR_TEXT]).read(file('aadhaar'), 'aadhaar', { strict: false, name: { first: 'Rahul', last: 'Verma' } }))
      .toEqual({ ok: true, value: '234123412346', nameMatch: false });
    expect(await reader([AADHAAR_TEXT]).read(file('aadhaar'), 'aadhaar', { strict: false }))
      .toEqual({ ok: true, value: '234123412346', nameMatch: null });
  });
  it('message texts', () => {
    expect(DOC_MESSAGES.nameMatches).toBe('Name matches');
    expect(DOC_MESSAGES.nameMismatch).toBe("The name on this card doesn't match the name you entered.");
  });
});
