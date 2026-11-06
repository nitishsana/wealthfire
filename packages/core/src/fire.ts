import type { Assumptions, Profile } from './types';
import { fvLump, fvSip, requiredSip } from './finance';

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  inflation: 6,
  equityReturn: 12,
  debtReturn: 7,
  cashReturn: 4,
  safeWithdrawalRate: 3.5, // India: lower than the US 4% rule because of higher inflation
  sipStepUp: 10,
  lastYearEquityReturn: 0,
};

export type FireStatus = 'on_track' | 'close' | 'off_track';

export interface ProjectionPoint {
  year: number; // years from now
  age: number;
  corpus: number;
  target: number;
}

export interface FirePlan {
  yearsToFire: number;
  /** What you spend now each month */
  monthlyExpenseToday: number;
  /** Monthly spend the corpus must cover after FIRE, today's rupees */
  targetMonthlySpend: number;
  /** targetMonthlySpend grown by inflation to FIRE day */
  monthlyExpenseAtFire: number;
  /** Corpus needed on FIRE day, in future rupees */
  fireNumber: number;
  /** Same target in today's rupees, for an easy-to-read number */
  fireNumberToday: number;
  projectedCorpus: number;
  /** First-year monthly SIP needed (steps up yearly) */
  requiredMonthlySip: number;
  extraSipNeeded: number;
  /** Earliest age the current SIP reaches FIRE, null if not by 80 */
  earliestFireAgeWithCurrentSip: number | null;
  /** Investable today / FIRE number in today's rupees */
  progressPct: number;
  monthlySurplus: number;
  savingsRatePct: number;
  status: FireStatus;
  messages: string[];
  projection: ProjectionPoint[];
}

export interface FireInput {
  profile: Profile;
  monthlyLiving: number;
  monthlyEmi: number;
  investable: number;
  /** Expected yearly return of the suggested portfolio, % */
  portfolioReturn: number;
  assumptions: Assumptions;
  /**
   * Monthly spend (today's rupees) the corpus must pay for after FIRE.
   * Differs from current spend for Lean / Fat / Barista FIRE. Default: current spend.
   */
  targetMonthlySpend?: number;
}

function targetAt(years: number, monthlyToday: number, a: Assumptions): number {
  return (fvLump(monthlyToday * 12, a.inflation, years) * 100) / a.safeWithdrawalRate;
}

function corpusAt(years: number, investable: number, sip: number, r: number, a: Assumptions): number {
  return fvLump(investable, r, years) + fvSip(sip, r, years, a.sipStepUp);
}

export function computeFirePlan(input: FireInput): FirePlan {
  const { profile, monthlyLiving, monthlyEmi, investable, portfolioReturn: r, assumptions: a } = input;
  const monthlyExpenseToday = profile.monthlyExpenseOverride ?? monthlyLiving;
  const target = Math.max(0, input.targetMonthlySpend ?? monthlyExpenseToday);
  const yearsToFire = Math.max(0, profile.targetRetireAge - profile.age);
  const monthlyExpenseAtFire = fvLump(target, a.inflation, yearsToFire);
  const fireNumber = targetAt(yearsToFire, target, a);
  const fireNumberToday = (target * 12 * 100) / a.safeWithdrawalRate;
  const sip = profile.currentMonthlySip;
  const projectedCorpus = corpusAt(yearsToFire, investable, sip, r, a);

  const lumpGrowth = fvLump(investable, r, yearsToFire);
  const requiredMonthlySip = yearsToFire === 0 ? 0 : requiredSip(Math.max(0, fireNumber - lumpGrowth), r, yearsToFire, a.sipStepUp);
  const extraSipNeeded = Math.max(0, requiredMonthlySip - sip);

  let earliest: number | null = null;
  for (let y = 0; profile.age + y <= 80; y++) {
    if (corpusAt(y, investable, sip, r, a) >= targetAt(y, target, a)) {
      earliest = profile.age + y;
      break;
    }
  }

  const projection: ProjectionPoint[] = [];
  const horizon = Math.max(yearsToFire, (earliest ?? profile.age) - profile.age) + 2;
  for (let y = 0; y <= Math.min(horizon, 60); y++) {
    projection.push({ year: y, age: profile.age + y, corpus: Math.round(corpusAt(y, investable, sip, r, a)), target: Math.round(targetAt(y, target, a)) });
  }

  const monthlySurplus = profile.monthlyIncome - monthlyExpenseToday - monthlyEmi;
  const savingsRatePct = profile.monthlyIncome > 0 ? (monthlySurplus / profile.monthlyIncome) * 100 : 0;
  const ratio = fireNumber > 0 ? projectedCorpus / fireNumber : 1;
  const status: FireStatus = ratio >= 1 ? 'on_track' : ratio >= 0.85 ? 'close' : 'off_track';

  const messages: string[] = [];
  if (status === 'on_track') messages.push(`Your current SIP reaches FIRE by age ${profile.targetRetireAge}.`);
  else messages.push(`Add about ₹${Math.round(extraSipNeeded).toLocaleString('en-IN')} a month to your SIP to retire at ${profile.targetRetireAge}.`);
  if (earliest !== null && earliest !== profile.targetRetireAge) messages.push(`With your current SIP, you reach FIRE at age ${earliest}.`);
  if (earliest === null) messages.push('With your current SIP, you do not reach FIRE by age 80.');
  if (requiredMonthlySip > monthlySurplus && monthlySurplus >= 0) messages.push('The SIP needed is more than you save each month. Cut spending, earn more, or pick a later age.');
  if (monthlySurplus < 0) messages.push('You spend more than you earn. Fix this before investing more.');
  if (savingsRatePct >= 50) messages.push('Savings rate above 50% — strong FIRE pace.');
  if (monthlyEmi > 0) messages.push('EMIs are left out of retirement spending. This assumes loans close before FIRE.');

  return {
    yearsToFire,
    monthlyExpenseToday,
    targetMonthlySpend: target,
    monthlyExpenseAtFire,
    fireNumber,
    fireNumberToday,
    projectedCorpus,
    requiredMonthlySip,
    extraSipNeeded,
    earliestFireAgeWithCurrentSip: earliest,
    progressPct: fireNumberToday > 0 ? Math.min(100, (investable / fireNumberToday) * 100) : 0,
    monthlySurplus,
    savingsRatePct,
    status,
    messages,
    projection,
  };
}
