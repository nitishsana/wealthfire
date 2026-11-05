/**
 * The feature list every platform must ship. scripts/check-parity.mjs reads this
 * and fails if web, Android or iOS is missing a screen tagged with the id.
 * Add a feature here first, then build it on all three platforms.
 */
export const FEATURES = [
  { id: 'dashboard', name: 'Home: net worth, FIRE status, SIP, bucket and progress tips' },
  { id: 'onboarding', name: 'Profile: name, age, income, target retire age' },
  { id: 'risk', name: 'Risk score questionnaire' },
  { id: 'networth', name: 'Assets and liabilities, net worth' },
  { id: 'expenses', name: 'Expenses: manual entry and statement upload, auto-categorized' },
  { id: 'fire', name: 'FIRE plan: FIRE number, retire age, SIP needed' },
  { id: 'portfolio', name: 'Suggested mutual fund portfolio by risk and time' },
  { id: 'buckets', name: '3-bucket plan with timed move suggestions' },
  { id: 'progress', name: 'Monthly check-ins and progress vs plan' },
  { id: 'firetypes', name: 'FIRE types: Lean, FIRE, Barista, Fat side by side, plus Coast FIRE milestone' },
  { id: 'firetype-pick', name: 'Pick your FIRE type (and part-time income for Barista) in Profile' },
  { id: 'connect', name: 'Connect apps (bank, CAS, broker: coming soon)' },
  { id: 'gmail', name: 'Connect Gmail inside Expenses: card spend alerts become expenses' },
  { id: 'demo', name: 'Load demo data / reset' },
] as const;

export type FeatureId = (typeof FEATURES)[number]['id'];
