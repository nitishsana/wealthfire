import { describe, expect, it } from 'vitest';
import { dobMatches, isIndividualPan, nameMatches, nameWords, parseDob } from '../../src/match';

describe('nameWords', () => {
  it('uppercases, keeps Latin letters only, collapses spaces', () => {
    expect(nameWords("  d'souza-  anne 2 ")).toEqual(['D', 'SOUZA', 'ANNE']);
    expect(nameWords('नितीश')).toEqual([]);
  });
});

describe('nameMatches (typed first, typed last, KRA name)', () => {
  it('pass: exact first + surname', () => {
    expect(nameMatches('Nitish', 'Sana', 'NITISH SANA')).toBe('pass');
  });
  it('pass: middle name on KRA only', () => {
    expect(nameMatches('Nitish', 'Sana', 'NITISH KUMAR SANA')).toBe('pass');
  });
  it('pass: two first-name words and two surname words, in order', () => {
    expect(nameMatches('Anne Marie', 'De Souza', 'ANNE MARIE DE SOUZA')).toBe('pass');
  });
  it('pass: case and punctuation ignored', () => {
    expect(nameMatches('nitish', "sana.", 'Nitish  Sana')).toBe('pass');
  });
  it('unclear: typed first name has no Latin letters', () => {
    expect(nameMatches('नितीश', 'Sana', 'NITISH SANA')).toBe('unclear');
  });
  it('unclear: typed last name has no Latin letters', () => {
    expect(nameMatches('Nitish', 'साना', 'NITISH SANA')).toBe('unclear');
  });
  it('fail: one-letter typed first name', () => {
    expect(nameMatches('N', 'Sana', 'N SANA')).toBe('fail');
  });
  it('fail: KRA name shorter than the typed name', () => {
    expect(nameMatches('Nitish Kumar', 'Sana', 'NITISH SANA')).toBe('fail');
  });
  it('fail: surname not the last word', () => {
    expect(nameMatches('Nitish', 'Sana', 'NITISH SANA KUMAR')).toBe('fail');
    expect(nameMatches('Nitish', 'Sana', 'SANA NITISH')).toBe('fail');
  });
  it('unclear: KRA shows an initial that agrees with the typed first name', () => {
    expect(nameMatches('Nitish', 'Sana', 'N K SANA')).toBe('unclear');
  });
  it('fail: KRA initial that disagrees', () => {
    expect(nameMatches('Nitish', 'Sana', 'R K SANA')).toBe('fail');
  });
  it('fail: different first name, no typo allowance (siblings)', () => {
    expect(nameMatches('Rakesh', 'Sana', 'RAJESH SANA')).toBe('fail');
  });
  it('fail: father first name in the middle never counts', () => {
    expect(nameMatches('Kumar', 'Sana', 'NITISH KUMAR SANA')).toBe('fail');
  });
  it('fail: no OCR leniency (L vs I, RN vs M, digits)', () => {
    expect(nameMatches('Lalit', 'Sana', 'IAIIT SANA')).toBe('fail');
    expect(nameMatches('Kamal', 'Sana', 'KARNAL SANA')).toBe('fail');
  });
  it('unclear: only a shared prefix typed and KRA has more words before the surname', () => {
    expect(nameMatches('Mohammed', 'Khan', 'MOHAMMED AMIR KHAN')).toBe('unclear');
  });
  it('pass: shared prefix typed and KRA has nothing more before the surname', () => {
    expect(nameMatches('Mohammed', 'Khan', 'MOHAMMED KHAN')).toBe('pass');
  });
  it('pass: shared prefix plus a second first-name word', () => {
    expect(nameMatches('Mohammed Amir', 'Khan', 'MOHAMMED AMIR KHAN')).toBe('pass');
  });
  it('pass: one non-shared first word with more words before the surname', () => {
    expect(nameMatches('Amir', 'Khan', 'AMIR HUSSAIN KHAN')).toBe('pass');
  });
});

describe('parseDob / dobMatches', () => {
  it('parses dd/mm/yyyy and yyyy-mm-dd', () => {
    expect(parseDob('05/03/1990')).toBe('1990-03-05');
    expect(parseDob(' 1990-03-05 ')).toBe('1990-03-05');
  });
  it('rejects other shapes and impossible dates', () => {
    expect(parseDob('5/3/1990')).toBeNull();
    expect(parseDob('05-03-1990')).toBeNull();
    expect(parseDob('31/02/1990')).toBeNull();
    expect(parseDob('1990-13-01')).toBeNull();
    expect(parseDob('')).toBeNull();
  });
  it('matches across formats', () => {
    expect(dobMatches('05/03/1990', '1990-03-05')).toBe(true);
    expect(dobMatches('1990-03-05', '1990-03-05')).toBe(true);
  });
  it('does not match different dates, dd/mm swaps, invalid or missing values', () => {
    expect(dobMatches('05/03/1990', '1990-05-03')).toBe(false);
    expect(dobMatches('05/03/1990', '06/03/1990')).toBe(false);
    expect(dobMatches('31/02/1990', '31/02/1990')).toBe(false);
    expect(dobMatches(undefined, '1990-03-05')).toBe(false);
    expect(dobMatches('1990-03-05', undefined)).toBe(false);
  });
});

describe('isIndividualPan', () => {
  it('true only for a valid individual PAN', () => {
    expect(isIndividualPan('abcpe1234f')).toBe(true);
    expect(isIndividualPan('ABCCE1234F')).toBe(false); // company
    expect(isIndividualPan('ABC')).toBe(false);
  });
});
