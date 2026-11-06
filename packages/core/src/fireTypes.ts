// The kinds of FIRE. All use the same math (yearly spend ÷ safe withdrawal rate);
// they differ in how much the corpus must pay for each month, and whether you still work.
// Sources (paraphrased): Bajaj Finserv "Coast FIRE, Lean FIRE and Fat FIRE" (Oct 2026),
// expensesorted.com FIRE variants comparison, financialaha.com Lean vs Fat vs Coast FIRE.
import type { Assumptions, FireTypeId, Profile } from './types';
import { computeFirePlan, type FireInput, type FirePlan } from './fire';
import { fvLump, fvSip } from './finance';

export interface FireTypeInfo {
  id: FireTypeId;
  name: string;
  emoji: string;
  /** One short line for chips and tables */
  tagline: string;
  /** Two or three plain sentences for explainer cards */
  about: string;
  lifestyle: string;
  watchOut: string;
  /** Corpus pays for this share of your current monthly spend (before part-time income) */
  spendFactor: number;
  worksAfterFire: boolean;
}

export const FIRE_TYPES: FireTypeInfo[] = [
  {
    id: 'lean', name: 'Lean FIRE', emoji: '🥗', spendFactor: 0.7, worksAfterFire: false,
    tagline: 'Retire early on a tight budget',
    about: 'You plan to live on about 70% of what you spend today: needs, not wants. A smaller corpus means you can stop working sooner.',
    lifestyle: 'Simple and frugal',
    watchOut: 'Little room for big surprises like health bills or family needs.',
  },
  {
    id: 'regular', name: 'FIRE', emoji: '🔥', spendFactor: 1, worksAfterFire: false,
    tagline: 'Keep your current lifestyle',
    about: 'Your corpus pays for the life you live today, for good. This is the classic FIRE goal.',
    lifestyle: 'Same as today',
    watchOut: 'Spending tends to creep up. Check your number every year.',
  },
  {
    id: 'barista', name: 'Barista FIRE', emoji: '☕', spendFactor: 1, worksAfterFire: true,
    tagline: 'Quit the full-time job, keep a light one',
    about: 'You leave full-time work but earn a little from part-time work, consulting or a hobby. Your corpus only has to cover the rest.',
    lifestyle: 'Same as today, with some part-time income',
    watchOut: 'Depends on that side income lasting. Have a plan if it stops.',
  },
  {
    id: 'fat', name: 'Fat FIRE', emoji: '🥂', spendFactor: 1.5, worksAfterFire: false,
    tagline: 'Retire rich, spend freely',
    about: 'You plan for about 1.5 times what you spend today, with room for travel, hobbies and treats. It needs a much bigger corpus.',
    lifestyle: 'More comfort than today',
    watchOut: 'Takes longer and needs high income or a high savings rate.',
  },
];

export const fireTypeInfo = (id: FireTypeId): FireTypeInfo => FIRE_TYPES.find((t) => t.id === id) ?? FIRE_TYPES[1]!;

/** Default part-time income for Barista FIRE when the user hasn't set one: 40% of spend. */
export const DEFAULT_BARISTA_SHARE = 0.4;

export function partTimeIncome(profile: Profile, monthlySpend: number): number {
  return Math.max(0, profile.partTimeIncome ?? Math.round(monthlySpend * DEFAULT_BARISTA_SHARE));
}

/** Monthly spend (today's rupees) the corpus must cover for this FIRE type. */
export function corpusFundedSpend(id: FireTypeId, profile: Profile, monthlySpend: number): number {
  const t = fireTypeInfo(id);
  const spend = monthlySpend * t.spendFactor;
  return Math.max(0, Math.round(t.worksAfterFire ? spend - partTimeIncome(profile, monthlySpend) : spend));
}

export interface FireTypePlan {
  type: FireTypeInfo;
  /** What the corpus pays each month, today's rupees */
  corpusSpend: number;
  plan: FirePlan;
}

/** Plans for every FIRE type, with the same inputs. */
export function planAllFireTypes(base: Omit<FireInput, 'targetMonthlySpend'>): FireTypePlan[] {
  const spend = base.profile.monthlyExpenseOverride ?? base.monthlyLiving;
  return FIRE_TYPES.map((type) => {
    const corpusSpend = corpusFundedSpend(type.id, base.profile, spend);
    const plan = computeFirePlan({ ...base, targetMonthlySpend: corpusSpend });
    if (type.id === 'lean') plan.messages.push(`Lean FIRE plans for ₹${corpusSpend.toLocaleString('en-IN')} a month, about 70% of today's spend.`);
    if (type.id === 'fat') plan.messages.push(`Fat FIRE plans for ₹${corpusSpend.toLocaleString('en-IN')} a month, about 1.5× today's spend.`);
    if (type.worksAfterFire) plan.messages.push(`Barista FIRE assumes ₹${partTimeIncome(base.profile, spend).toLocaleString('en-IN')} a month from part-time work after you quit.`);
    return { type, corpusSpend, plan };
  });
}

/**
 * Coast FIRE: a milestone, not a lifestyle. Once you have this much invested, it grows
 * on its own to your full FIRE number by a normal retirement age, even if you stop adding.
 * After that you only need to earn enough to cover today's bills.
 */
export interface CoastFire {
  coastAge: number; // the "normal" retirement age it coasts to
  targetAtCoastAge: number; // FIRE number at coastAge, future rupees
  neededToday: number; // corpus needed now to coast
  reached: boolean;
  progressPct: number;
  /** First age the current SIP gets you to Coast FIRE, null if not by coastAge */
  ageReached: number | null;
}

export function computeCoastFire(
  profile: Profile, monthlySpend: number, investable: number, returnPct: number, a: Assumptions, coastAge = 60,
): CoastFire {
  const target = (fvLump(monthlySpend * 12, a.inflation, Math.max(0, coastAge - profile.age)) * 100) / a.safeWithdrawalRate;
  const neededAt = (age: number) => target / Math.pow(1 + returnPct / 100, Math.max(0, coastAge - age));
  const neededToday = neededAt(profile.age);
  let ageReached: number | null = null;
  for (let y = 0; profile.age + y <= coastAge; y++) {
    const corpus = fvLump(investable, returnPct, y) + fvSip(profile.currentMonthlySip, returnPct, y, a.sipStepUp);
    if (corpus >= neededAt(profile.age + y)) { ageReached = profile.age + y; break; }
  }
  return {
    coastAge,
    targetAtCoastAge: target,
    neededToday,
    reached: investable >= neededToday,
    progressPct: neededToday > 0 ? Math.min(100, (investable / neededToday) * 100) : 100,
    ageReached,
  };
}
