// Local test users for the local KYC preview (.kiro/specs/final-kyc-service/local-mode.md,
// "Local test home"). Shared by the local server's home page and the web app's localkyc build, so
// both agree. Made-up people: no real PAN, mobile or Aadhaar. Each set of values drives the
// network-free FakePartner (services/kyc/src/partner/fake.ts: digits 6-9 of the PAN pick the
// scenario) and the core validators to one outcome.
//   PAN digits 0001 -> KRA record found (KRA person ASHA RAO, 1990-08-15)
//              0003 -> PAN name only partly matches -> staff hand check
//              0005 -> every KRA lookup times out
//              other -> no KRA record, every full-KYC check passes

export interface LocalPersona {
  /** `?persona=<id>` on the app URL */
  id: string;
  /** display name on the home page */
  name: string;
  /** what this user tests (one line) */
  tests: string;
  /** 10-digit Indian mobile, distinct per persona */
  mobile: string;
  firstName: string;
  lastName: string;
  pan: string;
  /** DD/MM/YYYY as the app types it */
  dob: string;
  aadhaarLast4: string;
}

export const LOCAL_PERSONAS: readonly LocalPersona[] = Object.freeze([
  {
    id: 'fast',
    name: 'Asha Rao',
    tests: 'KYC record found: goes straight to Verified.',
    mobile: '9000000001',
    firstName: 'Asha',
    lastName: 'Rao',
    pan: 'AFKPR0001A',
    dob: '15/08/1990',
    aadhaarLast4: '1001',
  },
  {
    id: 'full',
    name: 'Ravi Kumar',
    tests: 'No KYC record: DigiLocker, selfie and e-sign, then Verified.',
    mobile: '9000000002',
    firstName: 'Ravi',
    lastName: 'Kumar',
    pan: 'AFKPK0002B',
    dob: '10/02/1988',
    aadhaarLast4: '1002',
  },
  {
    id: 'handcheck',
    name: 'Meera Iyer',
    tests: 'PAN name only partly matches: after DigiLocker the case waits for a staff hand check.',
    mobile: '9000000003',
    firstName: 'Meera',
    lastName: 'Iyer',
    pan: 'AFKPI0003C',
    dob: '22/11/1992',
    aadhaarLast4: '1003',
  },
  {
    id: 'panused',
    name: 'Kiran Rao',
    tests: 'PAN already used by another user (Asha Rao): sign in as Asha Rao and start KYC first; this case goes to staff.',
    mobile: '9000000004',
    firstName: 'Kiran',
    lastName: 'Rao',
    // the same PAN as `fast`: the second user to start KYC with it gets pan-in-use
    pan: 'AFKPR0001A',
    dob: '05/05/1991',
    aadhaarLast4: '1004',
  },
  {
    id: 'slow',
    name: 'Sunil Shah',
    tests: 'Partner does not answer in time: the app shows Try again.',
    mobile: '9000000005',
    firstName: 'Sunil',
    lastName: 'Shah',
    pan: 'AFKPS0005D',
    dob: '01/03/1985',
    aadhaarLast4: '1005',
  },
  {
    id: 'minor',
    name: 'Anya Das',
    tests: 'Under 18: the date of birth is refused (You must be 18 or older to invest).',
    mobile: '9000000006',
    firstName: 'Anya',
    lastName: 'Das',
    pan: 'AFKPD0006E',
    // under 18 until 2033
    dob: '01/01/2015',
    aadhaarLast4: '1006',
  },
].map((p) => Object.freeze(p)));

/** The persona with this id, or undefined (unknown id -> the normal app). */
export function localPersona(id: unknown): LocalPersona | undefined {
  return typeof id === 'string' ? LOCAL_PERSONAS.find((p) => p.id === id) : undefined;
}
