import type { RiskProfileName, RiskResult } from './types';

export interface RiskOption {
  label: string;
  points: number; // 0-4
}

export interface RiskQuestion {
  id: string;
  text: string;
  options: RiskOption[];
}

/** One questionnaire for every platform. Order and points must not drift. */
export const RISK_QUESTIONS: RiskQuestion[] = [
  {
    id: 'horizon',
    text: 'When will you need most of this money?',
    options: [
      { label: 'Within 3 years', points: 0 },
      { label: '3 to 5 years', points: 1 },
      { label: '5 to 10 years', points: 2 },
      { label: '10 to 15 years', points: 3 },
      { label: 'More than 15 years', points: 4 },
    ],
  },
  {
    id: 'drop',
    text: 'Your portfolio falls 25% in a year. What do you do?',
    options: [
      { label: 'Sell everything', points: 0 },
      { label: 'Sell some', points: 1 },
      { label: 'Do nothing', points: 2 },
      { label: 'Buy a little more', points: 3 },
      { label: 'Buy a lot more', points: 4 },
    ],
  },
  {
    id: 'income_stability',
    text: 'How steady is your income?',
    options: [
      { label: 'Very unsteady', points: 0 },
      { label: 'Somewhat unsteady', points: 1 },
      { label: 'Steady', points: 2 },
      { label: 'Very steady', points: 3 },
      { label: 'Very steady with extra income', points: 4 },
    ],
  },
  {
    id: 'emergency',
    text: 'How many months of expenses do you have in an emergency fund?',
    options: [
      { label: 'None', points: 0 },
      { label: '1 to 2 months', points: 1 },
      { label: '3 to 5 months', points: 2 },
      { label: '6 to 11 months', points: 3 },
      { label: '12+ months', points: 4 },
    ],
  },
  {
    id: 'experience',
    text: 'How long have you invested in stocks or equity funds?',
    options: [
      { label: 'Never', points: 0 },
      { label: 'Under 1 year', points: 1 },
      { label: '1 to 3 years', points: 2 },
      { label: '3 to 7 years', points: 3 },
      { label: '7+ years', points: 4 },
    ],
  },
  {
    id: 'goal',
    text: 'What matters most to you?',
    options: [
      { label: 'Never lose money', points: 0 },
      { label: 'Beat FD returns safely', points: 1 },
      { label: 'Balance of growth and safety', points: 2 },
      { label: 'Mostly growth', points: 3 },
      { label: 'Maximum growth', points: 4 },
    ],
  },
];

const MAX_POINTS = RISK_QUESTIONS.length * 4;

/** Age adjustment: younger users can carry more risk. Range -10..+10. */
export function ageAdjustment(age: number): number {
  if (age < 30) return 10;
  if (age < 40) return 5;
  if (age < 50) return 0;
  if (age < 60) return -5;
  return -10;
}

export function profileFromScore(score: number): RiskProfileName {
  if (score < 20) return 'Conservative';
  if (score < 40) return 'Moderate';
  if (score < 60) return 'Balanced';
  if (score < 80) return 'Growth';
  return 'Aggressive';
}

/**
 * Score 0-100 from answers (question id -> option index) plus age.
 * Unanswered questions count as the middle option.
 */
export function computeRiskScore(answers: Record<string, number>, age: number): RiskResult {
  let points = 0;
  for (const q of RISK_QUESTIONS) {
    const idx = answers[q.id];
    const opt = idx === undefined ? undefined : q.options[idx];
    points += opt ? opt.points : 2;
  }
  const raw = (points / MAX_POINTS) * 100;
  const score = Math.round(Math.min(100, Math.max(0, raw + ageAdjustment(age))));
  return { score, profile: profileFromScore(score) };
}

/** Shown instead of a score until every question is answered (web and phones). */
export const RISK_INCOMPLETE_TEXT = `Answer all ${RISK_QUESTIONS.length} questions to see your risk profile.`;

/** The result to show: null until all questions are answered (no estimate from middle answers). */
export function shownRiskResult(answers: Record<string, number>, age: number): RiskResult | null {
  return isRiskComplete(answers) ? computeRiskScore(answers, age) : null;
}

export function isRiskComplete(answers: Record<string, number>): boolean {
  return RISK_QUESTIONS.every((q) => answers[q.id] !== undefined);
}
