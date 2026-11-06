import { describe, expect, it } from 'vitest';
import {
  DOC_MESSAGES, createOnDeviceReader, fixPanSwaps, parseAadhaarText, parsePanText, pickMajority,
  nameOnCard, sameDocument, verhoeffCheckDigit, cardBlock, hasMultipleCards,
  type DocFile, type TextExtractor,
} from '../src';

// Synthetic OCR texts only (test numbers ABCPE1234F / 234123412346). No real card data.
const PAN_TEXT = [
  'आयकर विभाग INCOME TAX DEPARTMENT',
  'GOVT. OF INDIA',
  'Permanent Account Number Card',
  'ABCPE1234F',
  'नाम / Name',
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
  it('no general one-letter allowance', () => {
    expect(nameOnCard(['NITISN SANA'], 'Nitish', 'Sana')).toBe(false); // one letter changed
    expect(nameOnCard(['NITSH SANA'], 'Nitish', 'Sana')).toBe(false); // one letter dropped
    expect(nameOnCard(['NITISH SAMA'], 'Nitish', 'Sana')).toBe(false);
    expect(nameOnCard(['NIXISN SANA'], 'Nitish', 'Sana')).toBe(false);
  });
  it('whole words only; each pass on its own (words are not pooled across passes)', () => {
    expect(nameOnCard(['NITISHSANA'], 'Nitish', 'Sana')).toBe(false);
    expect(nameOnCard(['NITISH', 'noise\nSANA'], 'Nitish', 'Sana')).toBe(false);
    expect(nameOnCard(['noise', 'NITISH SANA'], 'Nitish', 'Sana')).toBe(true);
  });
  it('missing surname → false', () => {
    expect(nameOnCard(['Name NITISH'], 'Nitish', 'Sana')).toBe(false);
    expect(nameOnCard(['Name NITISH RAO'], 'Nitish', 'Sana Rao')).toBe(false); // every last-name word needed
  });
  it('another person → false; nothing to compare → null (not checked)', () => {
    expect(nameOnCard(['Name RAHUL VERMA'], 'Nitish', 'Sana')).toBe(false);
    expect(nameOnCard([PAN_TEXT], '', '')).toBeNull();
  });
  it('every typed first-name word is needed (N3)', () => {
    expect(nameOnCard(['NITISH SANA'], 'Nitish Kumar', 'Sana')).toBe(false);
    expect(nameOnCard(['NITISH KUMAR SANA'], 'Nitish Kumar', 'Sana')).toBe(true);
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

// ---- Final pre-release fixes (new bugs 1, 2, 3, minor 4) ----

/** New-style PAN with labels: the child's card, the parent as father. */
const CHILD_PAN_LABELLED = [
  'आयकर विभाग INCOME TAX DEPARTMENT',
  'GOVT. OF INDIA',
  'Permanent Account Number Card',
  'ABCPE1234F',
  'नाम / Name',
  'RAHUL SANA',
  "पिता का नाम / Father's Name",
  'NITISH SANA',
  'जन्म की तारीख / Date of Birth',
  '01/01/2015',
].join('\n');

/** Old-style PAN without labels: holder line, then father line. */
const CHILD_PAN_OLD = [
  'INCOME TAX DEPARTMENT GOVT. OF INDIA',
  'RAHUL SANA',
  'NITISH SANA',
  '01/01/2015',
  'Permanent Account Number',
  'ABCPE1234F',
  'Signature',
].join('\n');

describe('nameOnCard uses only the card holder name line', () => {
  it('child PAN with the parent as father → false (labelled and old layout)', () => {
    expect(nameOnCard([CHILD_PAN_LABELLED], 'Nitish', 'Sana', 'pan')).toBe(false);
    expect(nameOnCard([CHILD_PAN_OLD], 'Nitish', 'Sana', 'pan')).toBe(false);
    // auto-detected as a PAN without the field hint
    expect(nameOnCard([CHILD_PAN_LABELLED], 'Nitish', 'Sana')).toBe(false);
    // the child's own name still matches
    expect(nameOnCard([CHILD_PAN_LABELLED], 'Rahul', 'Sana', 'pan')).toBe(true);
    expect(nameOnCard([CHILD_PAN_OLD], 'Rahul', 'Sana', 'pan')).toBe(true);
  });
  it('PAN "Name:" on the same line; father line never counts', () => {
    const t = 'INCOME TAX DEPARTMENT\nName: PRIYA SANA\nFather\'s Name: NITISH KUMAR\nDate of Birth 01/01/1990\nABCPE1234F';
    expect(nameOnCard([t], 'Priya', 'Sana', 'pan')).toBe(true);
    expect(nameOnCard([t], 'Nitish', 'Sana', 'pan')).toBe(false);
    expect(nameOnCard([t], 'Priya', 'Kumar', 'pan')).toBe(false);
  });
  it('PAN with no name before the father / DOB line → null (no holder line: review), never a match', () => {
    expect(nameOnCard(["INCOME TAX DEPARTMENT\nFather's Name\nNITISH SANA"], 'Nitish', 'Sana', 'pan')).toBeNull();
  });
  it('the reader rejects a parent on a child PAN', async () => {
    expect(await reader([CHILD_PAN_LABELLED]).read(file('pan'), 'pan', { strict: false, name: { first: 'Nitish', last: 'Sana' } }))
      .toEqual({ ok: true, value: 'ABCPE1234F', nameMatch: false });
  });
  it('Aadhaar: W/O, S/O, D/O, C/O and address lines (and everything after) are dropped', () => {
    const eAadhaar = [
      'Unique Identification Authority of India',
      'Enrolment No.: 1234/56789/01234',
      'To',
      'Priya Sana',
      'W/O: Nitish Sana',
      'Flat 12, MG Road, Pune',
      'Nitish Sana',
    ].join('\n');
    expect(nameOnCard([eAadhaar], 'Nitish', 'Sana', 'aadhaar')).toBe(false);
    expect(nameOnCard([eAadhaar], 'Priya', 'Sana', 'aadhaar')).toBe(true);
    for (const rel of ['S/O', 'D/O', 'C/O', 'S/0']) {
      expect(nameOnCard([`Aadhaar\nRahul Sana\n${rel} Nitish Sana`], 'Nitish', 'Sana', 'aadhaar')).toBe(false);
    }
    expect(nameOnCard(['Aadhaar\nRahul Sana\nAddress: Nitish Sana, Pune'], 'Nitish', 'Sana', 'aadhaar')).toBe(false);
    expect(nameOnCard([AADHAAR_TEXT], 'Nitish', 'Sana', 'aadhaar')).toBe(true);
  });
  it('printed card words never count as name words (INDRA vs INDIA)', () => {
    expect(nameOnCard([PAN_TEXT], 'Indra', 'Sana', 'pan')).toBe(false);
    expect(nameOnCard([AADHAAR_TEXT], 'Indra', 'Sana', 'aadhaar')).toBe(false);
    expect(nameOnCard([PAN_TEXT.replace('NITISH SANA', 'INDRA SANA')], 'Indra', 'Sana', 'pan')).toBe(true);
    expect(nameOnCard(['Government of India\nINDRA SANA\nFEMALE'], 'Indra', 'Sana', 'aadhaar')).toBe(true);
    // "Male" / "Income" typed as a name can't match the printed word
    expect(nameOnCard([AADHAAR_TEXT], 'Nitish', 'Male', 'aadhaar')).toBe(false);
  });
});

describe('name typed without Latin letters → not checked (null)', () => {
  it('nameOnCard returns null for an Indian-script first or last name', () => {
    expect(nameOnCard([PAN_TEXT], 'नितीश', 'साना', 'pan')).toBeNull();
    expect(nameOnCard([PAN_TEXT], 'Nitish', 'साना', 'pan')).toBeNull();
    expect(nameOnCard([PAN_TEXT], 'नितीश', 'Sana', 'pan')).toBeNull();
  });
  it('the reader returns nameMatch: null', async () => {
    expect(await reader([PAN_TEXT]).read(file('pan'), 'pan', { strict: false, name: { first: 'नितीश', last: 'साना' } }))
      .toEqual({ ok: true, value: 'ABCPE1234F', nameMatch: null });
  });
});

describe('PAN letters are not a PAN card', () => {
  it('letter-style text is rejected', async () => {
    const letter = 'Income Tax Department\nDear NITISH SANA,\nYour PAN ABCPE1234F is linked with Aadhaar.\nName on record';
    expect(parsePanText(letter).looksLikeCard).toBe(false);
    expect(parsePanText('INCOME TAX DEPARTMENT\nSir/Madam\nName NITISH SANA\nABCPE1234F').looksLikeCard).toBe(false);
    expect(parsePanText('INCOME TAX DEPARTMENT\nName NITISH SANA\nPAN ABCPE1234F linked').looksLikeCard).toBe(false);
    expect(await reader([letter]).read(file('pan'), 'pan', { strict: false })).toMatchObject({ ok: false, message: DOC_MESSAGES.notPan });
    // the real card still passes
    expect(parsePanText(CHILD_PAN_LABELLED).looksLikeCard).toBe(true);
  });
});

describe('name review messages', () => {
  it('texts', () => {
    expect(DOC_MESSAGES.nameMismatch).toBe("The name on this card doesn't match the name you entered.");
    expect(DOC_MESSAGES.nameReview).toBe("We'll check this by hand.");
    expect(DOC_MESSAGES.numbersMatchNameReview).toBe("Both numbers match your documents, but a name doesn't. We'll check this by hand.");
    expect(DOC_MESSAGES.nameNotChecked).toBe("We couldn't check the name on this card.");
  });
});

// ---- Re-check fixes (B, C, D) ----

describe('name match: exact, OCR-confusable surname only', () => {
  const rajesh = 'INCOME TAX DEPARTMENT\nName\nRAJESH KUMAR\nFather\'s Name\nMOHAN KUMAR\nABCPE1234F';
  it('a sibling one letter apart never passes', () => {
    expect(nameOnCard([rajesh], 'Rakesh', 'Kumar', 'pan')).toBe(false);
    expect(nameOnCard([rajesh], 'Rajesh', 'Kumari', 'pan')).toBe(false);
    expect(nameOnCard([rajesh], 'Rajesh', 'Kumar', 'pan')).toBe(true);
  });
  it('OCR-confusable characters still match', () => {
    expect(nameOnCard(['Aadhaar\nNITISH 5ANA\nMALE'], 'Nitish', 'Sana', 'aadhaar')).toBe(true);
    expect(nameOnCard(['Aadhaar\nNIT1SH SANA\nMALE'], 'Nitish', 'Sana', 'aadhaar')).toBe(true);
    expect(nameOnCard(['Aadhaar\nPRIYA VERRNA\nFEMALE'], 'Priya', 'Verma', 'aadhaar')).toBe(true); // RN → M
    expect(nameOnCard(['Aadhaar\nPRIYA VVALIA\nFEMALE'], 'Priya', 'Walia', 'aadhaar')).toBe(true); // VV → W, L → I
    expect(nameOnCard(['Aadhaar\nPRIYA VVALIA\nFEMALE'], 'Priya', 'Wahia', 'aadhaar')).toBe(false);
  });
});

describe('relation lines as OCR reads them', () => {
  for (const rel of ['SO', 'S1O', 'S O', 'S/0', 'W|O', 'D/0', 'C 0', 'SlO', 'C/o']) {
    it(`"${rel}" is a relation line`, () => {
      expect(nameOnCard([`Aadhaar\nRahul Sana\n${rel} Nitish Sana\nMALE`], 'Nitish', 'Sana', 'aadhaar')).toBe(false);
      expect(nameOnCard([`Aadhaar\nRahul Sana\n${rel}: Nitish Sana\nMALE`], 'Rahul', 'Sana', 'aadhaar')).toBe(true);
    });
  }
  it('"DOB" and words starting with S/D/C are not relation lines', () => {
    expect(nameOnCard(['Aadhaar\nSONIA DOSHI\nDOB: 01/01/1990'], 'Sonia', 'Doshi', 'aadhaar')).toBe(true);
  });
});

describe('labels-first PAN layout', () => {
  const labelsFirst = [
    'INCOME TAX DEPARTMENT', 'GOVT. OF INDIA',
    'नाम / Name', "पिता का नाम / Father's Name", 'जन्म की तारीख / Date of Birth',
    'RAHUL SANA', 'NITISH SANA', '01/01/2015', 'ABCPE1234F',
  ].join('\n');
  it('the first value line is the holder', () => {
    expect(nameOnCard([labelsFirst], 'Rahul', 'Sana', 'pan')).toBe(true);
    expect(nameOnCard([labelsFirst], 'Nitish', 'Sana', 'pan')).toBe(false);
  });
  it('a pass that lost the holder line never hands over the father line', () => {
    const lost = labelsFirst.replace('RAHUL SANA\n', '');
    expect(nameOnCard([lost], 'Nitish', 'Sana', 'pan')).toBeNull();
    expect(nameOnCard([labelsFirst, lost], 'Nitish', 'Sana', 'pan')).toBe(false);
  });
});

describe('more non-card documents are rejected', () => {
  it('Form 16 / TDS', () => {
    expect(parsePanText('FORM NO. 16\nIncome Tax Department\nName of employee NITISH SANA\nPAN ABCPE1234F').looksLikeCard).toBe(false);
    expect(parsePanText('Form 16\nPermanent Account Number\nName\nABCPE1234F').looksLikeCard).toBe(false);
    expect(parsePanText('INCOME TAX DEPARTMENT\nCertificate of TDS\nName\nABCPE1234F').looksLikeCard).toBe(false);
  });
  it('PAN–Aadhaar link pages', () => {
    expect(parsePanText('Income Tax Department\nLink Aadhaar Status\nName NITISH SANA\nABCPE1234F').looksLikeCard).toBe(false);
    expect(parsePanText('Income Tax Department\nLink successful\nName NITISH SANA\nABCPE1234F').looksLikeCard).toBe(false);
    expect(parseAadhaarText('Aadhaar\nLink Aadhaar\nDOB 01/01/1990\n2341 2341 2346').looksLikeCard).toBe(false);
  });
  it('UIDAI letters', () => {
    expect(parseAadhaarText('Unique Identification Authority of India\nDear Resident,\nMale\n2341 2341 2346').looksLikeCard).toBe(false);
    expect(parseAadhaarText('Aadhaar\nYour Aadhaar has been updated\nDOB 01/01/1990\n2341 2341 2346').looksLikeCard).toBe(false);
  });
  it('real cards still pass', () => {
    expect(parsePanText(PAN_TEXT).looksLikeCard).toBe(true);
    expect(parseAadhaarText(AADHAAR_TEXT).looksLikeCard).toBe(true);
  });
});

// ---- Final re-check fixes (must 1, must 2, should 3, should 4) ----

const panCard = (number: string, holder: string, father: string) => [
  'INCOME TAX DEPARTMENT', 'GOVT. OF INDIA', 'Permanent Account Number Card', number,
  'Name', holder, "Father's Name", father, 'Date of Birth', '01/01/2015',
].join('\n');

describe('first name must be the holder first word, surname the last word(s)', () => {
  it('a father / husband first name in the middle never counts', () => {
    expect(nameOnCard([panCard('ABCPE1234F', 'ARJUN SACHIN TENDULKAR', 'SACHIN TENDULKAR')], 'Sachin', 'Tendulkar', 'pan')).toBe(false);
    expect(nameOnCard(['Government of India\nARJUN SACHIN TENDULKAR\nMALE'], 'Sachin', 'Tendulkar', 'aadhaar')).toBe(false);
    expect(nameOnCard(['Unique Identification Authority of India\nTo\nANJALI SACHIN TENDULKAR\nW/O: Sachin Tendulkar'], 'Sachin', 'Tendulkar', 'aadhaar')).toBe(false);
    expect(nameOnCard([panCard('ABCPE1234F', 'ANJALI SACHIN TENDULKAR', 'RAMESH TENDULKAR')], 'Sachin', 'Tendulkar', 'pan')).toBe(false);
  });
  it('the holder still matches', () => {
    expect(nameOnCard(['Government of India\nNITISH SANA\nMALE'], 'Nitish', 'Sana', 'aadhaar')).toBe(true);
    expect(nameOnCard(['Government of India\nNITISH KUMAR SANA\nMALE'], 'Nitish', 'Sana', 'aadhaar')).toBe(true);
    expect(nameOnCard([panCard('ABCPE1234F', 'ARJUN SACHIN TENDULKAR', 'SACHIN TENDULKAR')], 'Arjun', 'Tendulkar', 'pan')).toBe(true);
  });
  it('surname must be at the end', () => {
    expect(nameOnCard(['Government of India\nNITISH SANA KUMAR\nMALE'], 'Nitish', 'Sana', 'aadhaar')).toBe(false);
  });
  it('a one-letter typed first name is never a match', () => {
    expect(nameOnCard(['Government of India\nAARAV N SANA\nMALE'], 'N', 'Sana', 'aadhaar')).toBe(false);
    expect(nameOnCard(['Government of India\nN K SANA\nMALE'], 'N', 'Sana', 'aadhaar')).toBe(false);
  });
  it('an initial-only first name on the card is not confirmed → null', () => {
    expect(nameOnCard(['Government of India\nN K SANA\nMALE'], 'Nitish', 'Sana', 'aadhaar')).toBeNull();
    expect(nameOnCard(['Government of India\nR K SANA\nMALE'], 'Nitish', 'Sana', 'aadhaar')).toBe(false);
    expect(nameOnCard(['Government of India\nN K VERMA\nMALE'], 'Nitish', 'Sana', 'aadhaar')).toBe(false);
  });
  it('the first name allows OCR-confusable characters', () => {
    expect(nameOnCard(['Government of India\nNIT1SH SANA\nMALE'], 'Nitish', 'Sana', 'aadhaar')).toBe(true);
    expect(nameOnCard(['Government of India\nRAKESH KUMAR\nMALE'], 'Rajesh', 'Kumar', 'aadhaar')).toBe(false);
  });
});

describe('one card per text', () => {
  const parentPan = panCard('ABCPE1234F', 'NITISH SANA', 'MOHAN SANA');
  const childPan = panCard('ABCPS1234K', 'RAHUL SANA', 'NITISH SANA');
  const panFile = file('pan');
  it('two PAN cards in one text → oneCardOnly', async () => {
    expect(await reader([`${parentPan}\n${childPan}`]).read(panFile, 'pan', { strict: false, name: { first: 'Nitish', last: 'Sana' } }))
      .toEqual({ ok: false, reason: 'unreadable', message: 'Upload a photo with just one card.' });
    // parent number covered: still two headers / two Name labels
    const covered = `${parentPan.replace('ABCPE1234F', '')}\n${childPan}`;
    expect(await reader([covered]).read(panFile, 'pan', { strict: false, name: { first: 'Nitish', last: 'Sana' } }))
      .toEqual({ ok: false, reason: 'unreadable', message: DOC_MESSAGES.oneCardOnly });
  });
  const adult = ['भारत सरकार', 'Government of India', 'Nitish Sana', 'DOB: 01/01/1985', 'MALE', '4991 1866 5246'];
  const child = ['भारत सरकार', 'Government of India', 'Rahul Sana', 'DOB: 01/01/2015', 'MALE', '2341 2341 2346', 'आधार - आम आदमी का अधिकार'];
  it('adult Aadhaar above a child Aadhaar → oneCardOnly', async () => {
    expect(await reader([[...adult, ...child].join('\n')]).read(file('aadhaar'), 'aadhaar', { strict: false, name: { first: 'Nitish', last: 'Sana' } }))
      .toEqual({ ok: false, reason: 'unreadable', message: DOC_MESSAGES.oneCardOnly });
  });
  it('adult number covered: a second DOB line → oneCardOnly; the name block is still the child one', async () => {
    const t = [...adult.slice(0, -1), ...child].join('\n');
    expect(await reader([t]).read(file('aadhaar'), 'aadhaar', { strict: false, name: { first: 'Nitish', last: 'Sana' } }))
      .toEqual({ ok: false, reason: 'unreadable', message: DOC_MESSAGES.oneCardOnly });
    const block = cardBlock(t, 'aadhaar', '234123412346')!;
    expect(nameOnCard([block], 'Nitish', 'Sana', 'aadhaar')).toBe(false);
    expect(nameOnCard([block], 'Rahul', 'Sana', 'aadhaar')).toBe(true);
  });
  it('a single card is not flagged', () => {
    expect(hasMultipleCards(PAN_TEXT, 'pan')).toBe(false);
    expect(hasMultipleCards(CHILD_PAN_LABELLED, 'pan')).toBe(false);
    expect(hasMultipleCards(AADHAAR_TEXT, 'aadhaar')).toBe(false);
    expect(hasMultipleCards(`${AADHAAR_TEXT}\nYour Aadhaar No.: 2341 2341 2346\nGovernment of India`, 'aadhaar')).toBe(false);
    expect(cardBlock(childPan, 'pan', 'ABCPS1234K')).toBe(childPan);
    expect(cardBlock(childPan, 'pan', 'AAAPZ9999Z')).toBeNull();
  });
});

describe('more OCR relation forms', () => {
  for (const rel of ['5/O', 'S.O', 'S:O', 'S-O', '$/O', 'W.O', 'D:O', 'C-O', 'W-0']) {
    it(`"${rel}" is a relation line`, () => {
      expect(nameOnCard([`Aadhaar\nRahul Sana\n${rel} Nitish Sana\nMALE`], 'Nitish', 'Sana', 'aadhaar')).toBe(false);
      expect(nameOnCard([`Aadhaar\nRahul Sana\n${rel} Nitish Sana\nMALE`], 'Rahul', 'Sana', 'aadhaar')).toBe(true);
    });
  }
  it('"D.O.B" is a date label, not a relation', () => {
    expect(nameOnCard(['Aadhaar\nNITISH SANA\nD.O.B: 01/01/1990\nMALE'], 'Nitish', 'Sana', 'aadhaar')).toBe(true);
    // not a relation line: the two names around it count as two holder lines (→ more than one card)
    expect(hasMultipleCards('Aadhaar\nRAHUL SANA\nD.O.B: 01/01/2015\nNITISH SANA\nMALE\n2341 2341 2346', 'aadhaar')).toBe(true);
  });
});

describe('pre-2017 unlabelled PAN layout', () => {
  const old = ['INCOME TAX DEPARTMENT', 'GOVT. OF INDIA', 'NITISH SANA', 'MOHAN SANA', '01/01/1990', 'Permanent Account Number', 'ABCPE1234F', 'Signature'].join('\n');
  it('counts as a card; the holder is the first name line after the header', async () => {
    expect(parsePanText(old)).toMatchObject({ looksLikeCard: true, value: 'ABCPE1234F' });
    expect(await reader([old]).read(file('pan'), 'pan', { strict: false, name: { first: 'Nitish', last: 'Sana' } }))
      .toEqual({ ok: true, value: 'ABCPE1234F', nameMatch: true });
    expect(nameOnCard([old], 'Mohan', 'Sana', 'pan')).toBe(false);
  });
  it('without the date or GOVT. OF INDIA it is still not enough', () => {
    expect(parsePanText(old.replace('01/01/1990', '')).looksLikeCard).toBe(false);
    expect(parsePanText(old.replace('GOVT. OF INDIA', '')).looksLikeCard).toBe(false);
  });
  it('message key', () => {
    expect(DOC_MESSAGES.oneCardOnly).toBe('Upload a photo with just one card.');
  });
});

// ---- Round 3 filter fixes (N1, N2, N3, minor) ----

describe('N1: unlabelled pre-2017 PAN needs two name lines before the date', () => {
  const header = ['INCOME TAX DEPARTMENT  GOVT. OF INDIA'];
  const tail = ['15/08/1990', 'Permanent Account Number', 'ABCPS1234K', 'Signature'];
  const full = [...header, 'ARJUN TENDULKAR', 'SACHIN TENDULKAR', ...tail].join('\n');
  const covered = [...header, 'SACHIN TENDULKAR', ...tail].join('\n');
  it('holder line covered: the father line never counts (null → review)', () => {
    expect(nameOnCard([covered], 'Sachin', 'Tendulkar', 'pan')).toBeNull();
  });
  it('an OCR pass that dropped the holder line never wins', () => {
    expect(nameOnCard([full, covered], 'Sachin', 'Tendulkar', 'pan')).toBe(false);
    expect(nameOnCard([full, covered], 'Arjun', 'Tendulkar', 'pan')).toBe(true);
  });
  it('the reader sends the covered card to review (nameMatch null)', async () => {
    expect(await reader([covered]).read(file('pan'), 'pan', { strict: false, name: { first: 'Sachin', last: 'Tendulkar' } }))
      .toEqual({ ok: true, value: 'ABCPS1234K', nameMatch: null });
  });
  it('no Name label and one name line above a labelled date → null', () => {
    const t = 'INCOME TAX DEPARTMENT\nGOVT. OF INDIA\nABCPE1234F\nNITISH SANA\nDate of Birth 01/01/1990';
    expect(nameOnCard([t], 'Nitish', 'Sana', 'pan')).toBeNull();
  });
  it('the real holder on the full card still matches', () => {
    expect(nameOnCard([full], 'Arjun', 'Tendulkar', 'pan')).toBe(true);
    expect(nameOnCard([full], 'Sachin', 'Tendulkar', 'pan')).toBe(false);
  });
});

describe('N2: more than one card in one Aadhaar / PAN text', () => {
  const stacked = [
    'भारत सरकार', 'Government of India', 'SACHIN TENDULKAR', 'DOB: 24/04/1999', 'MALE',
    'ARJUN TENDULKAR', 'DOB: 24/04/1999', 'MALE', '2341 2341 2346', 'आधार - आम आदमी का अधिकार',
  ].join('\n');
  it('child header covered under a parent card → oneCardOnly', async () => {
    expect(hasMultipleCards(stacked, 'aadhaar')).toBe(true);
    expect(await reader([stacked]).read(file('aadhaar'), 'aadhaar', { strict: false, name: { first: 'Sachin', last: 'Tendulkar' } }))
      .toEqual({ ok: false, reason: 'unreadable', message: DOC_MESSAGES.oneCardOnly });
  });
  it('the holder name is only the line above the number\'s own DOB / gender lines', () => {
    expect(nameOnCard([stacked], 'Sachin', 'Tendulkar', 'aadhaar')).toBe(false);
    expect(nameOnCard([stacked], 'Arjun', 'Tendulkar', 'aadhaar')).toBe(true);
    // the child's name line covered too: the parent's name above another DOB line never counts
    const noChildName = stacked.replace('ARJUN TENDULKAR\n', '');
    expect(nameOnCard([noChildName], 'Sachin', 'Tendulkar', 'aadhaar')).toBeNull();
    expect(hasMultipleCards(noChildName, 'aadhaar')).toBe(true);
  });
  it('a second DOB / year-of-birth line or a second gender line counts', () => {
    expect(hasMultipleCards('Aadhaar\nNITISH SANA\nDOB: 01/01/1985\nYear of Birth: 2015\n2341 2341 2346', 'aadhaar')).toBe(true);
    expect(hasMultipleCards('Aadhaar\nNITISH SANA\nDOB: 01/01/1985\nMALE\nFEMALE\n2341 2341 2346', 'aadhaar')).toBe(true);
    expect(hasMultipleCards('Aadhaar\nNITISH SANA\nपुरुष\nDOB: 01/01/1985\nमहिला\n2341 2341 2346', 'aadhaar')).toBe(true);
  });
  it('two name lines before the number without a relation line between them count', () => {
    expect(hasMultipleCards('Government of India\nSACHIN TENDULKAR\nARJUN TENDULKAR\nDOB: 01/01/2015\nMALE\n2341 2341 2346', 'aadhaar')).toBe(true);
    // a relation line between them: one card (the old front prints the father)
    expect(hasMultipleCards('Government of India\nARJUN TENDULKAR\nS/O: SACHIN TENDULKAR\nDOB: 01/01/2015\nMALE\n2341 2341 2346', 'aadhaar')).toBe(false);
  });
  it('one card (Hindi + English on one line or two) is not flagged', () => {
    expect(hasMultipleCards(AADHAAR_TEXT, 'aadhaar')).toBe(false);
    expect(hasMultipleCards('भारत सरकार\nGovernment of India\nनितीश साना\nNitish Sana\nजन्म तिथि / DOB: 01/01/1990\nपुरुष / MALE\n2341 2341 2346', 'aadhaar')).toBe(false);
    expect(hasMultipleCards('भारत सरकार\nGovernment of India\nNitish Sana\nजन्म तिथि\nDOB: 01/01/1990\nपुरुष\nMALE\n2341 2341 2346', 'aadhaar')).toBe(false);
    const eAadhaar = [
      'Unique Identification Authority of India', 'Enrolment No.: 1234/56789/01234', 'To', 'Nitish Sana',
      'S/O: Mohan Sana', 'Near Temple Road', 'Pune Maharashtra', 'Your Aadhaar No.:', '2341 2341 2346',
      'Government of India', 'Nitish Sana', 'DOB: 01/01/1990', 'MALE', '2341 2341 2346', 'Issue Date: 01/02/2020',
    ].join('\n');
    expect(hasMultipleCards(eAadhaar, 'aadhaar')).toBe(false);
    expect(nameOnCard([eAadhaar], 'Nitish', 'Sana', 'aadhaar')).toBe(true);
  });
  it('PAN: a second date of birth counts', () => {
    const two = 'INCOME TAX DEPARTMENT GOVT. OF INDIA\nARJUN TENDULKAR\nSACHIN TENDULKAR\n15/08/2010\n24/04/1973\nABCPS1234K';
    expect(hasMultipleCards(two, 'pan')).toBe(true);
    expect(hasMultipleCards(PAN_TEXT, 'pan')).toBe(false);
    expect(hasMultipleCards(CHILD_PAN_LABELLED, 'pan')).toBe(false);
  });
});

describe('N3: every typed first-name word must lead the holder name', () => {
  const amir = (t: string) => nameOnCard([`Government of India\n${t}\nMALE`], 'Mohammed Asif', 'Khan', 'aadhaar');
  it('a sibling sharing the first word never passes', () => {
    expect(amir('MOHAMMED AMIR KHAN')).toBe(false);
    expect(nameOnCard([panCard('ABCPE1234F', 'MOHAMMED AMIR KHAN', 'IQBAL KHAN')], 'Mohammed Asif', 'Khan', 'pan')).toBe(false);
    expect(nameOnCard(['Government of India\nNITISH RAJ SANA\nMALE'], 'Nitish Kumar', 'Sana', 'aadhaar')).toBe(false);
  });
  it('all typed words in order still match', () => {
    expect(amir('MOHAMMED ASIF KHAN')).toBe(true);
    expect(nameOnCard(['Government of India\nNITISH KUMAR SANA\nMALE'], 'Nitish Kumar', 'Sana', 'aadhaar')).toBe(true);
    expect(nameOnCard(['Government of India\nNITISH KUMAR SANA\nMALE'], 'Kumar Nitish', 'Sana', 'aadhaar')).toBe(false);
  });
  it('only a shared prefix typed, card has more words before the surname → null (review)', () => {
    for (const p of ['Mohammed', 'Mohd', 'Md', 'Syed', 'Shaik', 'Sk', 'Sri', 'Shri']) {
      expect(nameOnCard([`Government of India\n${p.toUpperCase()} AMIR KHAN\nMALE`], p, 'Khan', 'aadhaar')).toBeNull();
      // no more words: the holder is exactly the typed name
      expect(nameOnCard([`Government of India\n${p.toUpperCase()} KHAN\nMALE`], p, 'Khan', 'aadhaar')).toBe(true);
      // another surname is still a plain mismatch
      expect(nameOnCard([`Government of India\n${p.toUpperCase()} AMIR SHAH\nMALE`], p, 'Khan', 'aadhaar')).toBe(false);
    }
  });
  it('Nitish / Sana on NITISH KUMAR SANA stays a match', () => {
    expect(nameOnCard(['Government of India\nNITISH KUMAR SANA\nMALE'], 'Nitish', 'Sana', 'aadhaar')).toBe(true);
    expect(nameOnCard([panCard('ABCPE1234F', 'NITISH KUMAR SANA', 'MOHAN SANA')], 'Nitish', 'Sana', 'pan')).toBe(true);
  });
});

describe('minor: "5 0" / "S 0" relation forms', () => {
  for (const rel of ['5 0', 'S 0', '50', '5O', '$ O']) {
    it(`"${rel}" is a relation line`, () => {
      expect(nameOnCard([`Aadhaar\nARJUN TENDULKAR\n${rel} SACHIN TENDULKAR`], 'Sachin', 'Tendulkar', 'aadhaar')).toBe(false);
      expect(nameOnCard([`Aadhaar\nARJUN TENDULKAR\n${rel} SACHIN TENDULKAR`], 'Arjun', 'Tendulkar', 'aadhaar')).toBe(true);
    });
  }
  it('an address number starting with 5 is not a relation', () => {
    expect(nameOnCard(['Aadhaar\n500001\nNITISH SANA\nMALE'], 'Nitish', 'Sana', 'aadhaar')).toBe(true);
  });
});

describe('Pre-verified done message', () => {
  it('text', () => {
    expect(DOC_MESSAGES.donePreVerified).toBe('Your documents match. A final KYC check confirms your account before you can invest.');
  });
  it('verified text (after final KYC approval)', () => {
    expect(DOC_MESSAGES.doneVerified).toBe('Your final KYC check is complete. Your account is verified.');
  });
});
