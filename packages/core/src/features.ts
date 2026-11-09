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
  { id: 'onboard-signin', name: 'Onboarding: sign in with mobile number or email' },
  { id: 'onboard-otp', name: 'Onboarding: verify mobile or email with an OTP' },
  { id: 'onboard-identity', name: 'Onboarding: your details (name, PAN, Aadhaar)' },
  { id: 'onboard-aadhaar-otp', name: 'Onboarding: mandatory Aadhaar OTP and "You\'re all set"' },
  { id: 'onboard-account', name: 'Onboarding: Settings Account card with sign out' },
  { id: 'onboard-documents', name: 'Onboarding: upload selfie, Aadhaar card and PAN card' },
  { id: 'onboard-check', name: 'Onboarding: check typed numbers against the documents' },
  { id: 'onboard-review', name: 'Onboarding: account status and manual review (approve / reject, redo documents)' },
  { id: 'kyc-final-status', name: 'Final KYC: server status in Settings' },
  { id: 'kyc-data-controls', name: 'Final KYC: withdraw consent and delete my KYC data in Profile' },
] as const;

export type FeatureId = (typeof FEATURES)[number]['id'];
