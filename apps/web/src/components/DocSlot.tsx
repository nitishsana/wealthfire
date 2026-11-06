// One KYC document slot (design B6): upload from computer, Google Drive (cards), camera (selfie, Req 7.11).
// Files stay in memory as blob: URLs. The parent owns them and revokes the URL on Replace/Remove/unmount.
import { useEffect, useId, useRef, useState, type ChangeEvent, type MouseEvent } from 'react';
import { DOC_MESSAGES, validateDocFile, type DocFile, type DocKind, type DocMime } from '@wealthfire/core';
import { DRIVE_NOT_SET_UP, isDriveConfigured, pickFromDrive } from '../drive';
import { TakePhotoDialog, canUseCamera, openCamera } from './TakePhotoDialog';

export const CAMERA_DENIED = DOC_MESSAGES.cameraDenied;
export const SELFIE_HINT = 'Face the camera in good light. No cap or sunglasses.';
export const CARD_HINT = 'Fit the whole card in the frame. Avoid glare.';

export const DOC_LABEL: Record<DocKind, string> = { selfie: 'Your selfie', aadhaar: 'Aadhaar card', pan: 'PAN card' };

/** Wrap a browser File as a DocFile. The caller must revoke `uri` when done with it. */
export function toDocFile(kind: DocKind, f: Blob, name: string): DocFile {
  return { kind, name, mime: f.type as DocMime, size: f.size, uri: URL.createObjectURL(f) };
}

export function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Image thumbnail, or a document icon with name and size for a PDF. */
export function DocPreview({ doc, small }: { doc: DocFile; small?: boolean }) {
  if (doc.mime === 'application/pdf') {
    return (
      <span className={`doc-pdf ${small ? 'small' : ''}`}>
        <span aria-hidden="true">📄</span> {doc.name} <span className="muted small">{fileSize(doc.size)}</span>
      </span>
    );
  }
  return <img className={small ? 'doc-thumb small' : 'doc-thumb'} src={doc.uri} alt={`${DOC_LABEL[doc.kind]} preview`} />;
}

interface Props {
  kind: DocKind;
  doc: DocFile | null;
  /** Read error from the parent (e.g. "We couldn't read your PAN card…"). */
  error?: string;
  /** New file chosen (already validated). The parent revokes the previous one. */
  onChange: (doc: DocFile | null) => void;
  /** Show Remove (Upload documents) or not (Upload again on Check numbers). */
  removable?: boolean;
  disabled?: boolean;
  /** Section number shown before the label on Upload documents ("1. Your selfie"). */
  number?: number;
  /** Set when the document can't be changed (no re-reads left): Replace/Remove/Drive are off and this text shows. */
  frozen?: string;
}

type CameraPermission = PermissionState | 'unknown';

/** Current camera permission, kept up to date; 'unknown' where the Permissions API can't tell. */
function useCameraPermission(active: boolean): CameraPermission {
  const [state, setState] = useState<CameraPermission>('unknown');
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    let status: PermissionStatus | null = null;
    let live = true;
    const sync = () => { if (live && status) setState(status.state); };
    navigator.permissions.query({ name: 'camera' as PermissionName }).then((s) => {
      status = s;
      sync();
      s.addEventListener('change', sync);
    }, () => undefined); // 'camera' not supported here (e.g. older Firefox): stays 'unknown'
    return () => { live = false; status?.removeEventListener('change', sync); };
  }, [active]);
  return state;
}

export function DocSlot({ kind, doc, error, onChange, removable = true, disabled, number, frozen }: Props) {
  const id = useId();
  const upload = useRef<HTMLInputElement>(null);
  const camInput = useRef<HTMLInputElement>(null);
  const replaceBtn = useRef<HTMLButtonElement>(null);
  /** The "Take photo" button that opened the camera; focus goes back to it on close. */
  const trigger = useRef<HTMLButtonElement | null>(null);
  const refocus = useRef(false);
  const [localError, setLocalError] = useState('');
  /** Pending camera stream, started inside the click handler. Non-null = dialog open. */
  const [camera, setCamera] = useState<Promise<MediaStream> | null>(null);
  /** Selfie with a photo: "Replace" opens this small chooser ("Take photo" / "Upload"). */
  const [chooser, setChooser] = useState(false);
  const [busy, setBusy] = useState(false);
  const isSelfie = kind === 'selfie';
  const permission = useCameraPermission(isSelfie);
  /** R7.11.1: the camera reason line is shown in the dialog (permission not granted yet). */
  const [explain, setExplain] = useState(false);
  /** Starts getUserMedia once the reason line is on screen. */
  const startCamera = useRef<(() => void) | null>(null);
  const accept = isSelfie ? 'image/jpeg,image/png' : 'image/jpeg,image/png,application/pdf';
  const driveReady = isDriveConfigured();

  // Return focus after the dialog closes: to "Take photo" if it is still shown, otherwise to "Replace".
  useEffect(() => {
    if (camera || !refocus.current) return;
    refocus.current = false;
    const t = trigger.current;
    if (t?.isConnected && !t.disabled) t.focus();
    else replaceBtn.current?.focus();
  }, [camera, chooser, doc]);

  // R7.11.1: ask for the camera only after the dialog with the reason line has been painted.
  useEffect(() => {
    const start = startCamera.current;
    if (!camera || !start) return;
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        if (startCamera.current !== start) return; // closed meanwhile
        startCamera.current = null;
        start();
      }, 0);
    });
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [camera]);

  function take(f: Blob, name: string) {
    const err = validateDocFile({ kind, mime: f.type as DocMime, size: f.size });
    if (err) { setLocalError(err); return; }
    setLocalError('');
    setChooser(false);
    onChange(toDocFile(kind, f, name));
  }

  /**
   * "Take photo". Camera access already granted: getUserMedia is called right here. Otherwise (R7.11.1)
   * the dialog opens first with "Wealthfire needs your camera…", and getUserMedia runs once that line is
   * on screen, so the reason shows before the browser's permission prompt. When the Permissions API
   * can't tell, the reason is shown. No enumerateDevices() pre-check (lists can be empty before permission).
   * Only when the browser has no getUserMedia at all (e.g. not a secure context) fall back to the file
   * input with capture="user", which opens the front camera on a phone browser.
   */
  function takePhoto(e: MouseEvent<HTMLButtonElement>) {
    setLocalError('');
    trigger.current = e.currentTarget;
    if (!canUseCamera()) { camInput.current?.click(); return; }
    let p: Promise<MediaStream>;
    if (permission === 'granted') {
      startCamera.current = null;
      setExplain(false);
      p = openCamera();
    } else {
      let start!: () => void;
      p = new Promise<void>((resolve) => { start = resolve; }).then(openCamera);
      startCamera.current = start;
      setExplain(true);
    }
    p.catch(() => undefined); // handled by the dialog; avoids an unhandled rejection if it closes first
    setCamera(p);
  }

  function closeCamera(message?: string) {
    startCamera.current = null; // closed before the camera was asked for: never ask
    refocus.current = true;
    setCamera(null);
    if (message) setLocalError(message);
  }

  async function fromDrive() {
    setBusy(true); setLocalError('');
    try {
      const f = await pickFromDrive();
      if (f) take(f, f.name);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Could not open Google Drive.');
    } finally {
      setBusy(false);
    }
  }

  const err = localError || error || '';
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  const chooserId = `${id}-chooser`;
  const off = disabled || busy || camera !== null || !!frozen;
  const frozenId = `${id}-frozen`;
  const onFile = (e: ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) take(f, f.name); };
  const takeBtn = <button type="button" className="btn" disabled={off} onClick={takePhoto}>Take photo</button>;
  const uploadBtn = (label: string) => (
    <button type="button" className="btn" disabled={off} onClick={() => upload.current?.click()}>{label}</button>
  );

  return (
    <div className="doc-slot" role="group" aria-labelledby={`${id}-label`} aria-describedby={[hintId, err ? errId : ''].filter(Boolean).join(' ')}>
      <h2 id={`${id}-label`}>{number ? `${number}. ` : ''}{DOC_LABEL[kind]}</h2>
      <p id={hintId} className="muted small">{isSelfie ? SELFIE_HINT : CARD_HINT}</p>
      {doc && <div className="doc-preview"><DocPreview doc={doc} /></div>}
      <input ref={upload} type="file" className="sr-only" tabIndex={-1} aria-hidden="true" accept={accept} onChange={onFile} />
      {isSelfie && (
        <input ref={camInput} type="file" className="sr-only" tabIndex={-1} aria-hidden="true" accept="image/jpeg,image/png" capture="user" onChange={onFile} />
      )}
      <div className="row">
        {isSelfie && !doc && takeBtn}
        {isSelfie && doc ? (
          <button ref={replaceBtn} type="button" className="btn" disabled={off} aria-expanded={chooser} aria-controls={chooserId}
            onClick={() => setChooser((c) => !c)}>Replace</button>
        ) : (
          <button ref={replaceBtn} type="button" className="btn" disabled={off} aria-describedby={frozen ? frozenId : undefined}
            onClick={() => upload.current?.click()}>{doc ? 'Replace' : 'Upload'}</button>
        )}
        {doc && removable && (
          <button type="button" className="btn" disabled={off} onClick={() => { setLocalError(''); setChooser(false); onChange(null); }}>Remove</button>
        )}
      </div>
      {isSelfie && doc && chooser && (
        <div id={chooserId} className="row" role="group" aria-label="Replace your selfie">
          {takeBtn}
          {uploadBtn('Upload')}
          <button type="button" className="btn" disabled={off} onClick={() => { setChooser(false); replaceBtn.current?.focus(); }}>Cancel</button>
        </div>
      )}
      {!isSelfie && (
        <p className="small drive-link">
          <button type="button" className="link-btn" disabled={off || !driveReady} onClick={fromDrive}
            aria-describedby={driveReady ? undefined : `${id}-drive`}>or choose from Google Drive</button>
          {!driveReady && <span id={`${id}-drive`} className="muted"> {DRIVE_NOT_SET_UP}</span>}
        </p>
      )}
      {frozen && <p id={frozenId} className="muted small">{frozen}</p>}
      {err && <p id={errId} className="error" role="status">{err}</p>}
      {camera && (
        <TakePhotoDialog stream={camera} reason={explain} onClose={() => closeCamera()} onError={(m) => closeCamera(m)}
          onPhoto={(b) => { take(b, `selfie-${Date.now()}.jpg`); closeCamera(); }} />
      )}
    </div>
  );
}
