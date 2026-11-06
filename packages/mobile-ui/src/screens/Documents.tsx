// Onboarding Part B on Android / iOS: Upload documents → (reading) → Check your numbers.
// Same steps, rules and wording as apps/web/src/pages/Onboarding.tsx (design B5, B6).
// Privacy: documents and FieldChecks (which hold the full Aadhaar) live in screen state only. Picked files sit in the
// app cache and are deleted on Remove / Replace / done / unmount (design B6). Nothing here is written to AppData.
import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import {
  applyReread, canReread, confirmAadhaarRetype, DOC_MESSAGES, groupAadhaar, initialChecks, maskAadhaar, MAX_REREADS, normalizeAadhaar, normalizePan, validateAadhaar,
  readBlocked, sameDocument, takeDocumentNumber, validateDocFile, validatePan, type DocFile, type DocKind, type DocMime, type FieldCheck, type KycField,
  type KycState, type ReadResult,
} from '@wealthfire/core';
import { useDocReader } from '../reader';
import { theme } from '../theme';
import { Btn, Card, s, Screen } from '../ui';
import { Input, Link, Msg, ob } from './onboardUi';
import { deleteUri, fileSize, guessMime, TakePhoto } from './TakePhoto';

export type Docs = Partial<Record<DocKind, DocFile>>;
/** Name from Your details, sent with every PAN and Aadhaar read (name check). */
export type CardName = { first: string; last: string };
const BY_HAND = "We'll check this by hand.";

// ---------- Wording (same as web, design B5 / Req 7-8; shared texts in DOC_MESSAGES) ----------
export const CAMERA_DENIED = DOC_MESSAGES.cameraDenied;
/** Match labels without the emoji, read by screen readers (Bug 10). */
const spoken = (label: string) => label.replace(/^\S+\s+/, '');
const SELFIE_HINT = 'Face the camera in good light. No cap or sunglasses.';
const CARD_HINT = 'Fit the whole card in the frame. Avoid glare.';
const READING = 'Reading your documents…';
const RETYPE_LABEL = 'Enter your Aadhaar number again';
const SLOT_TITLE: Record<DocKind, string> = { selfie: 'Your selfie', aadhaar: 'Aadhaar card', pan: 'PAN card' };
const FIELD_DOC: Record<KycField, DocKind> = { pan: 'pan', aadhaar: 'aadhaar' };
const FIELD_LABEL: Record<KycField, string> = { pan: 'PAN', aadhaar: 'Aadhaar' };
const cantRead = (f: KycField) => DOC_MESSAGES.unreadable(f);
/** The other card slot, for the same-file check (both card slots, not the selfie). */
const OTHER_CARD: Partial<Record<DocKind, DocKind>> = { aadhaar: 'pan', pan: 'aadhaar' };

/** Message for a failed read, shown under that document's slot. Phones cannot take a PDF password. */
function readFailMessage(f: KycField, r: Extract<ReadResult, { ok: false }>): string {
  if (r.reason === 'locked') return DOC_MESSAGES.pdfLockedPhone;
  return r.message || cantRead(f);
}

/** Valid individual PAN / Aadhaar read: null. A company (non-individual) PAN card gets its own message (review bug 4). */
function readValueError(f: KycField, v: string): string | null {
  if (f === 'aadhaar') return validateAadhaar(v) === null ? null : cantRead(f);
  if (validatePan(v) === null) return null;
  return PAN_SHAPE.test(v) ? DOC_MESSAGES.companyPan : cantRead(f);
}
/** Any valid PAN shape, including non-individual ones (4th letter other than P). */
const PAN_SHAPE = /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/;
const doesntMatch = (f: KycField) => `The number you typed doesn't match your ${SLOT_TITLE[FIELD_DOC[f]]}.`;

// ---------- Files ----------

/** Deletes a picked file from the app cache. Safe to call twice. */
export function deleteDoc(d: DocFile | undefined): void {
  deleteUri(d?.uri);
}
export function dropDocs(docs: Docs): void {
  Object.values(docs).forEach(deleteDoc);
}

const PICKER_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'], quality: 0.8, exif: false, allowsEditing: false,
  preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};

export function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// "Take photo" (selfie only, Req 7.2) has its own flow in TakePhoto.tsx.
type Source = 'gallery' | 'file';
type PickResult = { ok: true; doc: DocFile } | { ok: false; error: string } | null; // null = cancelled

async function pickDoc(kind: DocKind, source: Source): Promise<PickResult> {
  let uri: string; let name: string; let mime: string; let size: number;
  if (source === 'file') {
    // Review bug 8: the selfie takes photos only, so its file chooser lists JPG / PNG only.
    const types = kind === 'selfie' ? ['image/jpeg', 'image/png'] : ['image/jpeg', 'image/png', 'application/pdf'];
    const r = await DocumentPicker.getDocumentAsync({ type: types, copyToCacheDirectory: true });
    const a = r.canceled ? undefined : r.assets[0];
    if (!a) return null;
    uri = a.uri; name = a.name; mime = guessMime(a.mimeType, a.name); size = fileSize(a.uri, a.size);
  } else {
    const r = await ImagePicker.launchImageLibraryAsync(PICKER_OPTIONS);
    const a = r.canceled ? undefined : r.assets[0];
    if (!a) return null;
    uri = a.uri; name = a.fileName ?? (kind === 'selfie' ? 'selfie.jpg' : 'card.jpg'); mime = guessMime(a.mimeType, name); size = fileSize(a.uri, a.fileSize);
  }
  const doc: DocFile = { kind, name, mime: mime as DocMime, size, uri };
  const err = validateDocFile(doc);
  if (err) { deleteDoc(doc); return { ok: false, error: err }; }
  return { ok: true, doc };
}

// ---------- One slot ----------

function Preview({ doc, small }: { doc: DocFile; small?: boolean }) {
  if (doc.mime === 'application/pdf') {
    return (
      <View style={st.pdf} accessible accessibilityLabel={`PDF ${doc.name}, ${sizeText(doc.size)}`}>
        <Text style={{ fontSize: small ? 22 : 30 }} importantForAccessibility="no" accessibilityElementsHidden>📄</Text>
        {small ? null : <Text style={[s.small, { flex: 1 }]} numberOfLines={2}>{doc.name} · {sizeText(doc.size)}</Text>}
      </View>
    );
  }
  return <Image source={{ uri: doc.uri }} style={small ? st.thumbSmall : st.thumb} accessibilityLabel={`${SLOT_TITLE[doc.kind]} preview`} />;
}

export function DocSlot({ kind, doc, onChange, number, error: parentError, removable = true, disabled, reject, locked }: {
  kind: DocKind; doc: DocFile | undefined; onChange: (d: DocFile | undefined) => void; number?: number;
  /** Read error for this document from the parent (e.g. "We couldn't read your PAN card..."). */
  error?: string;
  /** Show Remove (Upload documents) or not (Upload again on Check numbers), same as web. */
  removable?: boolean;
  disabled?: boolean;
  /** Error text when this file can't go in this slot (e.g. the same file as the other card), else null. */
  reject?: (d: DocFile) => string | null;
  /** Message when the file can't be changed any more (no re-reads left): Replace and Remove are off. */
  locked?: string;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [choosing, setChoosing] = useState(false); // "Upload" chooser: gallery or file
  const shownError = error || parentError || '';
  const off = busy || !!disabled;
  const title = number ? `${number}. ${SLOT_TITLE[kind]}` : SLOT_TITLE[kind];

  function accept(next: DocFile) {
    const bad = reject?.(next) ?? null;
    if (bad) { deleteDoc(next); setChoosing(false); setError(bad); return; } // keep the current file
    deleteDoc(doc); // Replace: drop the old cache file
    setReplacing(false); setChoosing(false); setError('');
    onChange(next);
  }

  async function pick(source: Source) {
    setBusy(true); setError(''); setChoosing(false);
    let r: PickResult;
    try { r = await pickDoc(kind, source); } catch { r = { ok: false, error: DOC_MESSAGES.couldNotReadFile }; }
    setBusy(false);
    if (!r) return;
    if (!r.ok) { setError(r.error); return; }
    accept(r.doc);
  }

  // Selfie: "Take photo" (front camera, TakePhoto.tsx) + "Upload". Cards: "Upload" only (Req 7.2, changed 2026-11-06).
  // With a file added, these sit behind "Replace" (wording item 4, same as web).
  const options = (
    <>
      {kind === 'selfie' ? <TakePhoto disabled={off} onPhoto={accept} /> : null}
      <Btn title="Upload" disabled={off} onPress={() => setChoosing((v) => !v)} />
      {choosing ? (
        <View style={st.chooser} accessibilityLabel={`Upload ${SLOT_TITLE[kind]}`}>
          <Btn title="Choose from gallery" disabled={busy} onPress={() => void pick('gallery')} />
          {/* The file picker lists Google Drive when the Drive app is installed. */}
          <Btn title="Choose a file" disabled={busy} onPress={() => void pick('file')} />
          <Btn title="Cancel" disabled={busy} onPress={() => setChoosing(false)} />
        </View>
      ) : null}
    </>
  );

  return (
    <View accessibilityLabel={title}>
      {number ? <Text style={s.h2} accessibilityRole="header">{title}</Text> : null}
      <Text style={s.small}>{kind === 'selfie' ? SELFIE_HINT : CARD_HINT}</Text>
      {doc ? (
        <View style={{ marginTop: 10 }}>
          <Preview doc={doc} />
          {replacing && !locked ? (
            <>
              {options}
              {/* Bug 9: a way back out of Replace without picking a file. */}
              {choosing ? null : <Btn title="Cancel" disabled={busy} onPress={() => { setReplacing(false); setError(''); }} />}
            </>
          ) : (
            <View style={ob.row}>
              <View style={{ flex: 1 }}><Btn title="Replace" disabled={off || !!locked} onPress={() => setReplacing(true)} /></View>
              {removable ? <View style={{ flex: 1, marginLeft: 8 }}><Btn danger title="Remove" disabled={off || !!locked} onPress={() => { deleteDoc(doc); onChange(undefined); }} /></View> : null}
            </View>
          )}
          {/* Review bug 7: the earlier read of this file is reused, so the file itself can't change. */}
          {locked ? <Msg text={locked} tone="muted" /> : null}
        </View>
      ) : options}
      {shownError ? <Msg text={shownError} /> : null}
    </View>
  );
}

// ---------- Upload documents step ----------

export function DocumentsStep({ docs, setDoc, typed, name, verifiedLast4, kyc, previous, onRead }: {
  docs: Docs;
  /** Entered name (Your details), checked against the name on each card. */
  name: CardName | undefined;
  setDoc: (k: DocKind, d: DocFile | undefined) => void;
  /** `aadhaar` is the OTP-verified full number from screen memory, or '' after a reload / Redo documents. */
  typed: { pan: string; aadhaar: string };
  /** Last 4 of the OTP-verified Aadhaar (stored). The re-typed number must end in these (design C1). */
  verifiedLast4: string;
  /** Stored KYC state, for the re-read limit after Back (Bug 1, readBlocked). */
  kyc: KycState;
  /** Checks from before Back to Upload documents (screen state only), reused for fields whose reads are used up. */
  previous: FieldCheck[] | null;
  /** `aadhaar`: the full number used for the checks (memory only; the parent keeps it for this session). */
  onRead: (checks: FieldCheck[], aadhaar: string) => void;
}) {
  // No demo UI on this step (Req 7.2): the demo reader mode comes only from dev config (reader.tsx).
  const reader = useDocReader();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); // general error (network)
  const [errors, setErrors] = useState<Partial<Record<KycField, string>>>({}); // read error under its slot, like web
  // Full Aadhaar gone from memory (reload / Redo documents): ask for it again, no second OTP (design C1).
  const needRetype = !typed.aadhaar;
  const [retype, setRetype] = useState(''); // full number: this screen's memory only
  const [retypeTouched, setRetypeTouched] = useState(false);
  const [retypeHidden, setRetypeHidden] = useState(true);
  const retypeErr = needRetype ? confirmAadhaarRetype(retype, verifiedLast4) : null;
  const aadhaarTyped = needRetype ? normalizeAadhaar(retype) : typed.aadhaar;
  const ready = Boolean(docs.selfie && docs.aadhaar && docs.pan) && !retypeErr;

  async function readOne(field: KycField, expected: string): Promise<{ value: string; nameMatch: boolean | null } | null> {
    const doc = docs[FIELD_DOC[field]];
    if (!doc) return null;
    const r = await reader.read(doc, field, { strict: false, expected, name });
    // Reader messages (not a PAN card, masked Aadhaar, reading unavailable, unreadable) go under that document's slot.
    if (!r.ok) { if (r.reason === 'network') setError(r.message); else setErrors((e) => ({ ...e, [field]: readFailMessage(field, r) })); return null; }
    const v = field === 'pan' ? normalizePan(r.value) : normalizeAadhaar(r.value);
    const bad = readValueError(field, v);
    if (bad) { setErrors((e) => ({ ...e, [field]: bad })); return null; }
    return { value: v, nameMatch: r.nameMatch };
  }

  // A field whose re-reads are used up keeps its earlier read, so its file is locked (review bug 7).
  const keptFor = (f: KycField) => (readBlocked(kyc, f) ? previous?.find((c) => c.field === f) : undefined);
  const sameAsOther = (k: DocKind) => (d: DocFile): string | null => {
    const other = OTHER_CARD[k] ? docs[OTHER_CARD[k]!] : undefined;
    return other && sameDocument(d, other) ? DOC_MESSAGES.sameFile : null;
  };

  async function continueOn() {
    setBusy(true); setError(''); setErrors({});
    try {
      // Bug 1: after Back, a field with its re-reads used up is not read again; its earlier result is kept.
      // The reducer counts this read on 'documents-ready', so no 'reread-used' is dispatched here.
      const keptPan = keptFor('pan');
      const keptAadhaar = keptFor('aadhaar');
      // Read both so each unreadable document gets its own message (Req 8.2).
      const pan = keptPan ? { value: keptPan.read, nameMatch: keptPan.nameMatch } : await readOne('pan', typed.pan);
      const aadhaar = keptAadhaar ? { value: keptAadhaar.read, nameMatch: keptAadhaar.nameMatch } : await readOne('aadhaar', aadhaarTyped);
      if (pan !== null && aadhaar !== null) {
        const fresh = initialChecks({ pan: typed.pan, aadhaar: aadhaarTyped }, { pan: pan.value, aadhaar: aadhaar.value },
          { pan: pan.nameMatch, aadhaar: aadhaar.nameMatch });
        setRetype('');
        onRead(fresh.map((c) => (c.field === 'pan' ? keptPan : keptAadhaar) ?? c), aadhaarTyped);
      }
    } catch {
      setError(DOC_MESSAGES.couldNotReadDocs);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen feature="onboard-documents" title="Upload documents" intro={DOC_MESSAGES.uploadIntro}>
      {(['selfie', 'aadhaar', 'pan'] as const).map((k, i) => (
        <Card key={k}><DocSlot kind={k} number={i + 1} doc={docs[k]} disabled={busy} error={k === 'selfie' ? undefined : errors[k]}
          reject={k === 'selfie' ? undefined : sameAsOther(k)}
          locked={k !== 'selfie' && keptFor(k) ? DOC_MESSAGES.noRereadsLeft : undefined}
          onChange={(d) => { setDoc(k, d); if (k !== 'selfie') setErrors((e) => ({ ...e, [k]: undefined })); }} /></Card>
      ))}
      {/* After the slots, same place as web. */}
      {needRetype ? (
        <Card>
          <Input label={RETYPE_LABEL} value={groupAadhaar(retype)} onChangeText={(t) => setRetype(normalizeAadhaar(t).slice(0, 12))}
            onBlur={() => setRetypeTouched(true)} keyboardType="number-pad" secureTextEntry={retypeHidden} textContentType="none"
            autoComplete="off" importantForAutofill="no" autoCorrect={false} maxLength={14} placeholder="XXXX XXXX XXXX" editable={!busy}
            error={retypeTouched && retype !== '' ? retypeErr : null} />
          <View style={ob.row}>
            <Text style={[s.small, { flex: 1 }]}>Verified Aadhaar {maskAadhaar(verifiedLast4)}</Text>
            <Link title={retypeHidden ? 'Show' : 'Hide'} label={retypeHidden ? 'Show Aadhaar number' : 'Hide Aadhaar number'}
              onPress={() => setRetypeHidden((h) => !h)} />
          </View>
        </Card>
      ) : null}
      {busy ? <Msg text={READING} tone="muted" /> : null}
      {error ? <Msg text={error} /> : null}
      <Btn primary title="Continue" disabled={!ready || busy} onPress={() => void continueOn()} />
    </Screen>
  );
}

// ---------- Check your numbers step ----------

function FieldCard({ check, doc, otherDoc, name, typedField, hidden, setHidden, onChange, onDoc }: {
  check: FieldCheck;
  name: CardName | undefined;
  doc: DocFile | undefined;
  /** The other card's file: "Upload again" must not take the same file (sameFile). */
  otherDoc: DocFile | undefined;
  typedField: KycField;
  hidden: boolean;
  setHidden: (h: boolean) => void;
  onChange: (c: FieldCheck, reread: boolean) => void;
  onDoc: (d: DocFile | undefined) => void;
}) {
  const reader = useDocReader();
  const f = typedField;
  const [mode, setMode] = useState<'idle' | 'edit' | 'upload'>('idle');
  const [draft, setDraft] = useState(check.final);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const left = MAX_REREADS - check.rereads;
  const show = (v: string) => (f === 'pan' ? v : hidden ? `XXXX XXXX ${v.slice(-4)}` : groupAadhaar(v));
  const draftN = f === 'pan' ? normalizePan(draft) : normalizeAadhaar(draft);
  const draftErr = f === 'pan' ? validatePan(draftN) : validateAadhaar(draftN);
  const locked = f === 'aadhaar';

  async function reread(final: string, withDoc: DocFile | undefined) {
    if (!withDoc) return;
    setBusy(true); setError('');
    try {
      const r = await reader.read(withDoc, f, { strict: true, expected: check.typed, name });
      if (!r.ok) { setError(readFailMessage(f, r)); return; }
      const v = f === 'pan' ? normalizePan(r.value) : normalizeAadhaar(r.value);
      const bad = readValueError(f, v);
      if (bad) { setError(bad); return; }
      setMode('idle');
      onChange(applyReread(check, final, v, r.nameMatch), true);
    } catch {
      setError(DOC_MESSAGES.couldNotReadDocs);
    } finally {
      setBusy(false);
    }
  }

  // "Use number from document" makes the numbers equal, but it counts as matched only when the name matched too
  // (takeDocumentNumber). Otherwise this card goes to the hand check.
  const tookDocument = check.source === 'document';
  const numbersMatch = check.matched || tookDocument;
  const matchText = numbersMatch ? DOC_MESSAGES.matchLabel : DOC_MESSAGES.mismatchLabel;

  return (
    <Card title={FIELD_LABEL[f]}>
      <View style={ob.row}>
        {doc ? <Preview doc={doc} small /> : null}
        <View style={{ flex: 1, marginLeft: doc ? 12 : 0 }}>
          {/* Aadhaar is the OTP-verified number, not one typed here (design C1). */}
          <Text style={s.small}>{f === 'aadhaar' ? DOC_MESSAGES.verifiedNumberLabel : 'You typed'}</Text>
          <Text style={[s.text, st.num]}>{show(check.final)}</Text>
          <Text style={[s.small, { marginTop: 6 }]}>Read from document</Text>
          <Text style={[s.text, st.num]}>{show(check.read)}</Text>
        </View>
        {/* Shared label (wording item 5); the emoji is not read out (Bug 10). */}
        <Text style={[st.badge, { color: numbersMatch ? theme.good : theme.bad }]} accessibilityLabel={spoken(matchText)}>{matchText}</Text>
      </View>
      {f === 'aadhaar' ? <Link title={hidden ? 'Show' : 'Hide'} label={hidden ? 'Show Aadhaar number' : 'Hide Aadhaar number'} onPress={() => setHidden(!hidden)} /> : null}
      {/* Name check, per card (same wording as web). Msg is a polite live region. Nothing when no name was checked. */}
      {check.nameMatch === true ? <Msg text={DOC_MESSAGES.nameMatches} tone="good" /> : null}
      {check.nameMatch === false ? <Msg text={DOC_MESSAGES.nameMismatch} tone="warn" /> : null}
      {tookDocument && !check.matched && check.nameMatch !== false ? <Msg text={BY_HAND} tone="warn" /> : null}
      {!numbersMatch ? (
        <>
          <Msg text={doesntMatch(f)} />
          {(check.rereads > 0 || (locked && !canReread(check))) && check.nameMatch !== false ? <Msg text={BY_HAND} tone="warn" /> : null}
          {/* Locked Aadhaar with no re-reads left: nothing to choose, it goes to manual review (same as web). */}
          {mode === 'idle' && (!locked || canReread(check)) ? (
            <>
              {/* Aadhaar is locked to the OTP-verified number (design C1): only "Upload again". PAN keeps all three. */}
              {locked ? null : <Btn title="Use number from document" disabled={busy} onPress={() => onChange(takeDocumentNumber(check), false)} />}
              {/* After 2 re-reads only "Use number from document" stays for PAN (Req 8.8); Aadhaar goes to manual review. */}
              {canReread(check) ? (
                <>
                  {locked ? null : <Btn title="Edit number" disabled={busy} onPress={() => { setDraft(check.final); setError(''); setMode('edit'); }} />}
                  <Btn title="Upload again" disabled={busy} onPress={() => { setError(''); setMode('upload'); }} />
                </>
              ) : null}
              <Text style={[s.small, { marginTop: 6 }]}>{left} re-check{left === 1 ? '' : 's'} left</Text>
            </>
          ) : null}
          {mode === 'edit' ? (
            <View style={{ marginTop: 10 }}>
              <Input label={f === 'pan' ? 'PAN' : 'Aadhaar number'} value={f === 'pan' ? draft : groupAadhaar(draftN)}
                onChangeText={(t) => setDraft(f === 'pan' ? t.toUpperCase() : normalizeAadhaar(t).slice(0, 12))}
                autoCapitalize="characters" autoCorrect={false} autoComplete="off" importantForAutofill="no" textContentType="none"
                keyboardType={f === 'pan' ? 'default' : 'number-pad'} secureTextEntry={f === 'aadhaar' && hidden} maxLength={f === 'pan' ? 10 : 14}
                error={draft && draftErr ? draftErr : null} />
              <Btn primary title="Check again" disabled={busy || draftErr !== null} onPress={() => void reread(draftN, doc)} />
              <Btn title="Cancel" disabled={busy} onPress={() => setMode('idle')} />
            </View>
          ) : null}
          {mode === 'upload' ? (
            <View style={{ marginTop: 10 }}>
              <DocSlot kind={FIELD_DOC[f]} doc={doc} removable={false} disabled={busy}
                reject={(d) => (otherDoc && sameDocument(d, otherDoc) ? DOC_MESSAGES.sameFile : null)}
                onChange={(d) => { if (!d) return; onDoc(d); void reread(check.final, d); }} />
              <Btn title="Cancel" disabled={busy} onPress={() => setMode('idle')} />
            </View>
          ) : null}
          {busy ? <Msg text={READING} tone="muted" /> : null}
          {error ? <Msg text={error} /> : null}
        </>
      ) : null}
    </Card>
  );
}

export function CheckStep({ checks, setChecks, docs, setDoc, name, onRereadUsed, onConfirm, onBack, confirming, error }: {
  checks: FieldCheck[];
  /** Entered name, sent with re-reads for the name check. */
  name: CardName | undefined;
  setChecks: (cs: FieldCheck[]) => void;
  docs: Docs;
  setDoc: (k: DocKind, d: DocFile | undefined) => void;
  /** Counts a strict re-read in the store (Req 8.8). */
  onRereadUsed: (f: KycField) => void;
  onConfirm: () => void;
  onBack: () => void;
  confirming: boolean;
  error: string;
}) {
  const [hidden, setHidden] = useState(false); // Aadhaar shows in full on this screen only, with Hide (Req 8.3)
  const allMatch = checks.every((c) => c.matched);
  // Confirm is allowed straight away (same as web): any field still differing goes to manual review.

  return (
    <Screen feature="onboard-check" title="Check your numbers">
      {allMatch ? <Msg text="Both numbers match your documents." tone="good" /> : null}
      {checks.map((c, i) => (
        <FieldCard key={c.field} check={c} typedField={c.field} doc={docs[FIELD_DOC[c.field]]} hidden={hidden} setHidden={setHidden}
          otherDoc={docs[c.field === 'pan' ? 'aadhaar' : 'pan']} name={name}
          onDoc={(d) => setDoc(FIELD_DOC[c.field], d)}
          onChange={(next, reread) => {
            setChecks(checks.map((x, j) => (j === i ? next : x)));
            if (reread) onRereadUsed(c.field);
          }} />
      ))}
      {error ? <Msg text={error} /> : null}
      <Btn primary title="Confirm" disabled={confirming} onPress={onConfirm} />
      <Link title="Back" onPress={onBack} />
    </Screen>
  );
}

const st = StyleSheet.create({
  thumb: { width: 120, height: 90, borderRadius: 8, backgroundColor: theme.panel2, borderColor: theme.line, borderWidth: 1 },
  thumbSmall: { width: 56, height: 42, borderRadius: 6, backgroundColor: theme.panel2, borderColor: theme.line, borderWidth: 1 },
  pdf: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 8, backgroundColor: theme.panel2, borderColor: theme.line, borderWidth: 1 },
  num: { fontVariant: ['tabular-nums'], fontWeight: '700' },
  chooser: { marginTop: 6, paddingLeft: 12, borderLeftColor: theme.line, borderLeftWidth: 2 },
  badge: { fontSize: 13, fontWeight: '700', marginLeft: 8 },
});
