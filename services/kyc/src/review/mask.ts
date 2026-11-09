// Output masking for the review console. Masks are rebuilt from the last 4 characters every time,
// so even a wrongly stored full PAN / Aadhaar can never reach a staff browser.

/** PAN → 'XXXXXX' + last 4 (e.g. 'XXXXXX234F'). */
export function maskPan(value: string | undefined): string {
  const tail = (value ?? '').replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase();
  return tail.length === 4 ? `XXXXXX${tail}` : 'XXXXXXXXXX';
}

/** Aadhaar → 'XXXX XXXX ' + last 4 digits. */
export function maskAadhaar(value: string | undefined): string {
  const tail = (value ?? '').replace(/\D/g, '').slice(-4);
  return tail.length === 4 ? `XXXX XXXX ${tail}` : 'XXXX XXXX XXXX';
}

const PAN_LIKE = /[A-Za-z]{5}\s*\d{4}\s*[A-Za-z]/;
const LONG_NUMBER = /\d(?:[\s-]?\d){7,}/; // 8+ digits, e.g. an Aadhaar or account number

/** True if free text looks like it holds an ID number (PAN, Aadhaar, long digit run). */
export function looksLikeIdNumber(text: string): boolean {
  return PAN_LIKE.test(text) || LONG_NUMBER.test(text);
}
