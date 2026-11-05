import type { Expense, ExpenseCategory } from './types';

/** Merchant keywords -> category. First match wins. Lower-case. */
const RULES: [ExpenseCategory, string[]][] = [
  ['Food', ['swiggy', 'zomato', 'restaurant', 'cafe', 'starbucks', 'dominos', 'mcdonald', 'kfc', 'pizza', 'eatclub', 'dineout']],
  ['Groceries', ['bigbasket', 'blinkit', 'zepto', 'dmart', 'instamart', 'more retail', 'reliance fresh', 'jiomart', 'grocery', 'supermarket', 'ratnadeep']],
  ['Fuel', ['petrol', 'fuel', 'hpcl', 'bpcl', 'iocl', 'indian oil', 'shell', 'bharat petroleum']],
  ['Transport', ['uber', ' ola ', ' ola', 'rapido', 'metro', 'irctc', 'redbus', 'fastag', 'parking']],
  ['Travel', ['makemytrip', 'goibibo', 'indigo', 'air india', 'vistara', 'akasa', 'cleartrip', 'oyo', 'airbnb', 'booking.com', 'hotel']],
  ['Shopping', ['amazon', 'flipkart', 'myntra', 'ajio', 'nykaa', 'meesho', 'croma', 'reliance digital', 'decathlon', 'ikea']],
  ['Bills', ['airtel', 'jio', 'vodafone', 'vi ', 'bescom', 'tsspdcl', 'electricity', ' gas', 'broadband', 'act fibernet', 'water bill', 'recharge', 'insurance', ' lic ']],
  ['Entertainment', ['netflix', 'hotstar', 'prime video', 'spotify', 'bookmyshow', 'pvr', 'inox', 'youtube', 'sonyliv', 'zee5']],
  ['Health', ['apollo', 'pharmeasy', '1mg', 'netmeds', 'hospital', 'clinic', 'medplus', 'pharmacy', 'diagnostic', 'cult.fit', 'cultfit']],
  ['Education', ['udemy', 'coursera', 'byju', 'school', 'college', 'tuition', 'unacademy']],
  ['Rent', [' rent', 'nobroker', 'housing.com']],
  ['EMI', [' emi', 'loan']],
];

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  'Food', 'Groceries', 'Shopping', 'Transport', 'Fuel', 'Bills', 'Entertainment',
  'Travel', 'Health', 'Education', 'Rent', 'EMI', 'Other',
];

export function categorize(description: string): ExpenseCategory {
  const d = ` ${description.toLowerCase()} `;
  for (const [cat, words] of RULES) if (words.some((w) => d.includes(w))) return cat;
  return 'Other';
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse common Indian statement date forms into yyyy-mm-dd, or null. */
export function parseDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/); // dd/mm/yyyy
  if (m) return iso(+m[3]!, +m[2]!, +m[1]!);
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); // yyyy-mm-dd
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = t.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{2,4})$/); // 05 Oct 2026
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase()];
    if (mon) return iso(+m[3]!, mon, +m[1]!);
  }
  return null;
}

function iso(y: number, mo: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseAmount(s: string): number | null {
  const n = Number(s.replace(/[₹,\s]|rs\.?|inr/gi, ''));
  return Number.isFinite(n) ? n : null;
}

const CREDIT_HINT = /\b(cr|credit|payment received|refund|reversal|cashback)\b/i;

export interface ParseResult {
  expenses: Expense[];
  skipped: number;
}

let counter = 0;
const newId = () => `exp_${Date.now().toString(36)}_${(counter++).toString(36)}`;

/**
 * Parse a credit card statement pasted as text or CSV.
 * Accepts lines like:
 *   05/10/2026, SWIGGY BANGALORE, 450.00
 *   05 Oct 2026  AMAZON PAY INDIA  1,299.00 Dr
 * Credits, refunds and payments are skipped.
 */
export function parseStatement(text: string, source: Expense['source'] = 'statement'): ParseResult {
  const expenses: Expense[] = [];
  let skipped = 0;
  const dateRe = /(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\s-][A-Za-z]{3,9}[\s-,]+\d{2,4})/;
  const amountRe = /(?:₹|rs\.?|inr)?\s*(-?[\d,]+(?:\.\d{1,2})?)\s*(dr|cr)?\s*$/i;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const dm = line.match(dateRe);
    if (!dm) { skipped++; continue; }
    const date = parseDate(dm[1]!);
    const cleaned = line.replace(/,\s*$/, '');
    const am = cleaned.match(amountRe);
    if (!date || !am) { skipped++; continue; }
    const amount = parseAmount(am[1]!);
    if (amount === null || amount === 0) { skipped++; continue; }
    const isCredit = am[2]?.toLowerCase() === 'cr' || amount < 0 || CREDIT_HINT.test(line.replace(/\bdr\b/i, ''));
    if (isCredit) { skipped++; continue; }
    const description = cleaned
      .replace(dm[0], '')
      .replace(am[0], '')
      .replace(/^[\s,;|]+|[\s,;|]+$/g, '')
      .replace(/\s*[,;|]\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim() || 'Unknown';
    expenses.push({ id: newId(), date, description, amount: Math.abs(amount), category: categorize(description), source });
  }
  return { expenses, skipped };
}

export interface ExpenseSummary {
  months: number;
  monthlyAverage: number;
  /** Average excluding EMI (loans are assumed closed before FIRE) */
  monthlyLiving: number;
  byCategory: { category: ExpenseCategory; monthly: number }[];
}

/** Average monthly spend over the distinct months present (min 1). */
export function summarizeExpenses(expenses: Expense[]): ExpenseSummary {
  const months = Math.max(1, new Set(expenses.map((e) => e.date.slice(0, 7))).size);
  const totals = new Map<ExpenseCategory, number>();
  for (const e of expenses) totals.set(e.category, (totals.get(e.category) ?? 0) + e.amount);
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  const emi = totals.get('EMI') ?? 0;
  const byCategory = [...totals.entries()]
    .map(([category, t]) => ({ category, monthly: Math.round(t / months) }))
    .sort((a, b) => b.monthly - a.monthly);
  return {
    months: expenses.length ? months : 0,
    monthlyAverage: Math.round(total / months),
    monthlyLiving: Math.round((total - emi) / months),
    byCategory,
  };
}
