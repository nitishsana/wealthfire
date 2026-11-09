import { describe, expect, it } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { DOC_URL_TTL_SEC, reviewRoutes, type Handler } from '../../src/review/routes';
import { contentDispositionFor, S3DownloadSigner } from '../../src/review/s3';
import { FULL_AADHAAR, FULL_PAN, makeCase, REVIEWER, req, setup } from './fakes';
import type { ReviewCase } from '../../src/review/ports';
import type { KycCase } from '../../src/types';

const ID = '11111111-1111-4111-8111-111111111111';

/** The three documents R1 requires before an Approve. */
function withDocs(s: ReturnType<typeof setup>, kinds: readonly ('selfie' | 'aadhaar' | 'pan')[] = ['selfie', 'aadhaar', 'pan']) {
  s.documents.docs.set(ID, kinds.map((k) => ({ kind: k, key: `kyc/${ID}/${k}-1.${k === 'selfie' ? 'jpg' : 'pdf'}` })));
}

function route(s: ReturnType<typeof setup>, key: string): Handler {
  const h = s.routes[key];
  if (!h) throw new Error(`missing route ${key}`);
  return h;
}

function noFullIds(body: unknown) {
  const text = JSON.stringify(body);
  expect(text).not.toContain(FULL_PAN);
  expect(text).not.toContain(FULL_AADHAAR);
  expect(text).not.toMatch(/[A-Z]{5}\d{4}[A-Z]/);
  // a 12-digit run that is not part of a UUID segment
  expect(text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '')).not.toMatch(/\d{12}/);
}

describe('review routes: access', () => {
  const keys = ['GET /review/cases', 'GET /review/cases/{id}', 'POST /review/cases/{id}'];

  it('exposes the contract keys', () => {
    expect(Object.keys(setup().routes).sort()).toEqual([...keys].sort());
  });

  for (const key of keys) {
    it(`${key}: 403 without the reviewer group`, async () => {
      const s = setup();
      s.cases.put(makeCase());
      const r = await route(s, key)(req({
        params: { id: ID }, body: { action: 'approve' }, staff: { id: 'staff-2', groups: ['admin'] },
      }));
      expect(r.status).toBe(403);
      expect(s.audit.rows).toHaveLength(0);
      expect(s.cases.map.get(ID)?.status).toBe('under-review');
    });

    it(`${key}: 403 with an empty staff id or missing staff`, async () => {
      const s = setup();
      s.cases.put(makeCase());
      const h = route(s, key);
      expect((await h(req({ params: { id: ID }, staff: { id: ' ', groups: ['reviewer'] } }))).status).toBe(403);
      expect((await h(req({ params: { id: ID }, staff: undefined as never }))).status).toBe(403);
    });
  }
});

describe('GET /review/cases', () => {
  it('lists only under-review cases, newest first, masked', async () => {
    const s = setup();
    s.cases.put(makeCase({ userId: 'a', updatedAt: '2026-11-01T00:00:00.000Z' }));
    s.cases.put(makeCase({ userId: 'b', updatedAt: '2026-11-03T00:00:00.000Z' }));
    s.cases.put(makeCase({ userId: 'c', status: 'verified', updatedAt: '2026-11-04T00:00:00.000Z' }));
    const r = await route(s, 'GET /review/cases')(req());
    expect(r.status).toBe(200);
    const body = r.body as { items: { id: string; masks: { pan: string; aadhaar: string }; unclear: string[] }[] };
    expect(body.items.map((i) => i.id)).toEqual(['b', 'a']);
    expect(body.items[0]?.masks).toEqual({ pan: 'XXXXXX234F', aadhaar: 'XXXX XXXX 1234' });
    expect(body.items[0]?.unclear).toEqual(['face-match']);
    noFullIds(r.body);
  });

  it('paginates with an opaque cursor', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.cases.put(makeCase({ userId: `u${i}`, updatedAt: `2026-11-0${i + 1}T00:00:00.000Z` }));
    const list = route(s, 'GET /review/cases');
    const p1 = (await list(req({ query: { limit: '2' } }))).body as { items: { id: string }[]; nextCursor?: string };
    expect(p1.items.map((i) => i.id)).toEqual(['u4', 'u3']);
    const p2 = (await list(req({ query: { limit: '2', cursor: p1.nextCursor } }))).body as typeof p1;
    expect(p2.items.map((i) => i.id)).toEqual(['u2', 'u1']);
    const p3 = (await list(req({ query: { limit: '2', cursor: p2.nextCursor } }))).body as typeof p1;
    expect(p3.items.map((i) => i.id)).toEqual(['u0']);
    expect(p3.nextCursor).toBeUndefined();
  });

  it('caps the page size and rejects bad limits / cursors', async () => {
    const s = setup();
    const list = route(s, 'GET /review/cases');
    expect((await list(req({ query: { limit: '999' } }))).status).toBe(200);
    expect((await list(req({ query: { limit: 'ten' } }))).status).toBe(400);
    expect((await list(req({ query: { cursor: 'forged' } }))).status).toBe(400);
  });
});

describe('GET /review/cases/{id}', () => {
  it('returns checks, masked values, 5-minute document links and history; audits the view', async () => {
    const s = setup();
    s.cases.put(makeCase());
    s.documents.docs.set(ID, [
      { kind: 'selfie', key: `kyc/${ID}/selfie.jpg` },
      { kind: 'pan', key: `kyc/${ID}/pan.pdf` },
    ]);
    const r = await route(s, 'GET /review/cases/{id}')(req({ params: { id: ID } }));
    expect(r.status).toBe(200);
    const body = r.body as {
      case: { checks: Record<string, string>; masks: unknown };
      documents: { kind: string; url: string; expiresAt: string }[];
      history: { action: string; actor: string }[];
    };
    expect(body.case.checks).toEqual({ aadhaar: 'pass', pan: 'pass', 'face-match': 'unclear' });
    expect(body.documents.map((d) => d.kind)).toEqual(['selfie', 'pan']);
    expect(s.signer.calls.every((c) => c.expiresInSec === DOC_URL_TTL_SEC && c.expiresInSec === 300)).toBe(true);
    expect(body.documents[0]?.expiresAt).toBe(new Date(s.clock.now() + 300_000).toISOString());
    expect(JSON.stringify(body)).not.toContain('kyc/'); // S3 keys stay server-side
    expect(s.audit.rows).toHaveLength(1);
    expect(s.audit.rows[0]).toMatchObject({ userId: ID, actor: 'staff:staff-sub-1', action: 'review.view' });
    expect(body.history[0]).toMatchObject({ action: 'review.view', actor: 'staff:staff-sub-1' });
    expect(Object.keys(body.case)).not.toContain('partnerRefs');
    noFullIds(r.body);
  });

  it('404 for an unknown case, 400 for a bad id', async () => {
    const s = setup();
    const h = route(s, 'GET /review/cases/{id}');
    expect((await h(req({ params: { id: 'nope' } }))).status).toBe(404);
    expect((await h(req({ params: { id: '../etc' } }))).status).toBe(400);
    expect(s.audit.rows).toHaveLength(0);
  });

  it('drops unknown check names and results', async () => {
    const s = setup();
    s.cases.put(makeCase({ checks: { pan: 'pass', bogus: 'x', aadhaar: 'maybe' } as never }));
    const r = await route(s, 'GET /review/cases/{id}')(req({ params: { id: ID } }));
    expect((r.body as { case: { checks: unknown } }).case.checks).toEqual({ pan: 'pass' });
  });
});

describe('POST /review/cases/{id}', () => {
  const post = (s: ReturnType<typeof setup>, body: unknown, staff = REVIEWER) =>
    route(s, 'POST /review/cases/{id}')(req({ params: { id: ID }, body, staff }));

  it('approve -> verified, keeps checks, bumps version, writes audit with before/after', async () => {
    const s = setup();
    s.cases.put(makeCase());
    withDocs(s);
    const r = await post(s, { action: 'approve', note: 'Selfie checked by hand', version: 3 });
    expect(r.status).toBe(200);
    const stored = s.cases.map.get(ID);
    expect(stored).toMatchObject({ status: 'verified', reason: 'staff-approved', version: 4, note: 'Selfie checked by hand' });
    expect(stored?.checks).toEqual({ aadhaar: 'pass', pan: 'pass', 'face-match': 'unclear' });
    expect(stored?.updatedAt).toBe(new Date(s.clock.now()).toISOString());
    expect(s.audit.rows).toEqual([
      {
        userId: ID,
        ts: `${new Date(s.clock.now()).toISOString()}#n1`,
        actor: 'staff:staff-sub-1',
        action: 'review.approve',
        before: { status: 'under-review', path: 'full-kyc', reason: 'check-unclear', version: 3 },
        after: { status: 'verified', path: 'full-kyc', reason: 'staff-approved', version: 4 },
        note: 'Selfie checked by hand',
      },
    ]);
    noFullIds(r.body);
  });

  it('reject with a reason -> rejected and audited; accepts a JSON string body', async () => {
    const s = setup();
    s.cases.put(makeCase({ path: null }));
    const r = await post(s, JSON.stringify({ action: 'reject', reason: '  Selfie does not match the PAN photo ' }));
    expect(r.status).toBe(200);
    expect(s.cases.map.get(ID)).toMatchObject({
      status: 'rejected', path: 'hand-check', reason: 'staff-rejected', note: 'Selfie does not match the PAN photo',
    });
    expect(s.audit.rows[0]).toMatchObject({ action: 'review.reject', after: { status: 'rejected' } });
  });

  it.each([
    ['missing', { action: 'reject' }],
    ['empty', { action: 'reject', reason: '   ' }],
    ['too long', { action: 'reject', reason: 'x'.repeat(201) }],
    ['not a string', { action: 'reject', reason: 42 }],
    ['holding a PAN', { action: 'reject', reason: 'PAN ABCPE1234F is fake' }],
    ['holding an Aadhaar', { action: 'reject', reason: 'aadhaar 2345 6789 1234 mismatch' }],
  ])('reject with a reason %s -> 400, nothing written', async (_label, body) => {
    const s = setup();
    s.cases.put(makeCase());
    const r = await post(s, body);
    expect(r.status).toBe(400);
    expect(s.cases.map.get(ID)?.status).toBe('under-review');
    expect(s.audit.rows).toHaveLength(0);
  });

  it('accepts a 200-character reason', async () => {
    const s = setup();
    s.cases.put(makeCase());
    expect((await post(s, { action: 'reject', reason: 'y'.repeat(200) })).status).toBe(200);
  });

  it.each(['verified', 'rejected', 'pre-verified'] as const)('illegal transition from %s -> 409, no audit', async (status) => {
    const s = setup();
    s.cases.put(makeCase({ status }));
    const r = await post(s, { action: 'approve' });
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toBe('illegal_transition');
    expect(s.cases.map.get(ID)?.status).toBe(status);
    expect(s.audit.rows).toHaveLength(0);
  });

  it('409 when the case changed (stale version or store conflict)', async () => {
    const s = setup();
    s.cases.put(makeCase());
    expect((await post(s, { action: 'approve', version: 2 })).status).toBe(409);
    withDocs(s);
    s.cases.forceConflict = true;
    const r = await post(s, { action: 'approve' });
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toBe('conflict');
    expect(s.audit.rows).toHaveLength(0);
  });

  it('400 for a bad action, bad body or bad version; 404 for an unknown case', async () => {
    const s = setup();
    s.cases.put(makeCase());
    expect((await post(s, { action: 'delete' })).status).toBe(400);
    expect((await post(s, '{not json')).status).toBe(400);
    expect((await post(s, [1, 2])).status).toBe(400);
    expect((await post(s, { action: 'approve', version: '3' })).status).toBe(400);
    expect((await post(s, { action: 'approve', note: 'x'.repeat(201) })).status).toBe(400);
    const missing = await route(s, 'POST /review/cases/{id}')(req({ params: { id: 'other' }, body: { action: 'approve' } }));
    expect(missing.status).toBe(404);
  });

  it('500 without leaking the store error', async () => {
    const s = setup();
    s.cases.put(makeCase());
    withDocs(s);
    s.cases.saveDecision = async () => {
      throw new Error(`db exploded ${FULL_PAN}`);
    };
    const r = await post(s, { action: 'approve' });
    expect(r.status).toBe(500);
    noFullIds(r.body);
  });
});

describe('R1: staff Approve needs documents; KRA upload only after e-sign', () => {
  const post = (s: ReturnType<typeof setup>, body: unknown) =>
    route(s, 'POST /review/cases/{id}')(req({ params: { id: ID }, body }));
  const withUpload = () => {
    const s = setup();
    const uploads: string[] = [];
    const routes = reviewRoutes({
      cases: s.cases, audit: s.audit, documents: s.documents, signer: s.signer, clock: s.clock,
      onApproved: async (userId) => void uploads.push(userId),
    });
    return { ...s, routes, uploads };
  };

  it.each([
    [[], 'selfie, Aadhaar, PAN'],
    [['selfie'], 'Aadhaar, PAN'],
    [['selfie', 'aadhaar'], 'PAN'],
    [['aadhaar', 'pan'], 'selfie'],
  ] as const)('approve with documents %j -> 409 documents_missing, nothing written', async (kinds, missing) => {
    const s = setup();
    s.cases.put(makeCase());
    withDocs(s, kinds);
    const r = await post(s, { action: 'approve' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'documents_missing', message: `Approve needs the selfie, Aadhaar and PAN documents. Missing: ${missing}.` });
    expect(s.cases.map.get(ID)?.status).toBe('under-review');
    expect(s.audit.rows).toHaveLength(0);
  });

  it('a document refused by the type check does not count for approve', async () => {
    const s = setup();
    const refused: ReviewCase = { ...makeCase(), documents: { pan: { uploadId: 'u-pan', state: 'rejected' } } };
    s.cases.put(refused as KycCase);
    withDocs(s, ['selfie', 'aadhaar', 'pan']);
    const r = await post(s, { action: 'approve' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'documents_missing', message: 'Approve needs the selfie, Aadhaar and PAN documents. Missing: PAN.' });
    expect(s.cases.map.get(ID)?.status).toBe('under-review');
  });

  it('an "other" file does not count as a required document', async () => {
    const s = setup();
    s.cases.put(makeCase());
    s.documents.docs.set(ID, [
      { kind: 'selfie', key: 'k1' }, { kind: 'aadhaar', key: 'k2' }, { kind: 'other', key: 'k3' },
    ]);
    expect((await post(s, { action: 'approve' })).status).toBe(409);
  });

  it('reject does not need documents', async () => {
    const s = setup();
    s.cases.put(makeCase());
    expect((await post(s, { action: 'reject', reason: 'No documents sent' })).status).toBe(200);
  });

  it('approve on a case that was not e-signed -> verified with next esign; no KRA upload', async () => {
    const s = withUpload();
    s.cases.put(makeCase({ path: 'hand-check', reason: 'device-hand-check', checks: {} }));
    withDocs(s);
    const r = await post(s, { action: 'approve' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ case: { status: 'verified' }, next: 'esign' });
    expect(s.cases.map.get(ID)).toMatchObject({ status: 'verified', reason: 'staff-approved', next: 'esign' });
    expect(s.uploads).toEqual([]);
  });

  it.each([
    ['evidence.esign done', { evidence: { esign: 'done' } }],
    ['checks.esign pass', { checks: { esign: 'pass' as const } }],
  ])('approve on an e-signed case (%s) -> next kra-upload and the upload runs', async (_label, over) => {
    const s = withUpload();
    s.cases.put({ ...makeCase(), ...over } as never);
    withDocs(s);
    const r = await post(s, { action: 'approve' });
    expect(r.body).toMatchObject({ next: 'kra-upload' });
    expect(s.cases.map.get(ID)).toMatchObject({ status: 'verified', next: 'kra-upload' });
    expect(s.uploads).toEqual([ID]);
  });

  it('an illegal move is reported before missing documents', async () => {
    const s = setup();
    s.cases.put(makeCase({ status: 'verified' }));
    expect((await post(s, { action: 'approve' })).body).toMatchObject({ error: 'illegal_transition' });
  });
});

describe('S16: document links only for Under-review cases', () => {
  it.each(['verified', 'rejected', 'pre-verified'] as const)('a %s case shows no document links (still audited)', async (status) => {
    const s = setup();
    s.cases.put(makeCase({ status }));
    withDocs(s);
    const r = await route(s, 'GET /review/cases/{id}')(req({ params: { id: ID } }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ documents: [], documentsAvailable: false });
    expect(s.signer.calls).toHaveLength(0);
    expect(s.audit.rows[0]).toMatchObject({ action: 'review.view' });
  });

  it('an Under-review case gets signed links', async () => {
    const s = setup();
    s.cases.put(makeCase());
    withDocs(s);
    const r = await route(s, 'GET /review/cases/{id}')(req({ params: { id: ID } }));
    expect(r.body).toMatchObject({ documentsAvailable: true });
    expect((r.body as { documents: unknown[] }).documents).toHaveLength(3);
    expect(s.signer.calls).toHaveLength(3);
  });
});

describe('S14: PDFs are served as attachments', () => {
  it('contentDispositionFor: attachment with a fixed name for PDFs only', () => {
    expect(contentDispositionFor(`kyc/${ID}/pan-abc123.pdf`)).toBe('attachment; filename="pan.pdf"');
    expect(contentDispositionFor(`kyc/${ID}/aadhaar-x.PDF`)).toBe('attachment; filename="aadhaar.pdf"');
    expect(contentDispositionFor(`kyc/${ID}/weird"name.pdf`)).toBe('attachment; filename="other.pdf"');
    expect(contentDispositionFor(`kyc/${ID}/selfie-1.jpg`)).toBeUndefined();
    expect(contentDispositionFor(`kyc/${ID}/pan-1.png`)).toBeUndefined();
  });

  it('S3DownloadSigner puts response-content-disposition=attachment in signed PDF URLs only', async () => {
    const s3 = new S3Client({ region: 'ap-south-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' } });
    const signer = new S3DownloadSigner(s3, 'docs-bucket');
    const pdf = new URL(await signer.sign(`kyc/${ID}/pan-1.pdf`, 300));
    expect(pdf.searchParams.get('response-content-disposition')).toBe('attachment; filename="pan.pdf"');
    expect(pdf.searchParams.get('response-cache-control')).toBe('no-store');
    expect(pdf.searchParams.get('X-Amz-Expires')).toBe('300');
    const jpg = new URL(await signer.sign(`kyc/${ID}/selfie-1.jpg`, 300));
    expect(jpg.searchParams.get('response-content-disposition')).toBeNull();
  });
});
