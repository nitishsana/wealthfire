// Take photo flow, web (Req 7.11, design B6): reason line -> camera prompt -> live video + "Capture"
// -> still with "Retake" / "Crop" / "Use photo" -> square crop with "Done" / "Cancel".
// Images stay in memory (canvas + blob: URLs). Every object URL is revoked and every stream track is
// stopped on close and unmount. Native <dialog> + showModal() gives the focus trap and inert background.
import {
  useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type SyntheticEvent,
} from 'react';
import { DOC_MESSAGES } from '@wealthfire/core';
import './TakePhotoDialog.css';


const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
const MOVE_STEP = 0.05; // share of the crop square per arrow key press
const MAX_OUT = 1080; // longest side of the exported JPEG
const JPEG_QUALITY = 0.85;

/** True when the browser can open a camera stream at all (needs a secure context). */
export function canUseCamera(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

function errName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
}

/**
 * Ask for the front camera. Call this straight from a click handler so the browser shows its
 * permission prompt. If no camera fits the front-camera constraint, retry once with any camera.
 */
export function openCamera(): Promise<MediaStream> {
  const md = navigator.mediaDevices;
  return md.getUserMedia({ video: { facingMode: 'user' }, audio: false }).catch((e: unknown) => {
    const n = errName(e);
    if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') {
      return md.getUserMedia({ video: true, audio: false });
    }
    throw e;
  });
}

/** Map a getUserMedia failure to the text shown under the selfie slot. */
export function cameraErrorText(e: unknown): string {
  switch (errName(e)) {
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return DOC_MESSAGES.noCamera;
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return DOC_MESSAGES.cameraInUse;
    default: // NotAllowedError, SecurityError, PermissionDeniedError, anything else
      return DOC_MESSAGES.cameraDenied;
  }
}

function stopStream(s: MediaStream | null) {
  s?.getTracks().forEach((t) => t.stop());
}

function toJpeg(c: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', JPEG_QUALITY));
}

/** Crop square in image pixels: centre + zoom. Side = shorter image side / zoom. */
interface Crop { cx: number; cy: number; z: number }

function clampCrop(c: Crop, w: number, h: number): Crop {
  const z = Math.min(MAX_ZOOM, Math.max(1, c.z));
  const half = Math.min(w, h) / z / 2;
  return { z, cx: Math.min(w - half, Math.max(half, c.cx)), cy: Math.min(h - half, Math.max(half, c.cy)) };
}

type Step = 'waiting' | 'live' | 'still' | 'crop';

interface Props {
  /** The pending stream from openCamera() (asked for once the reason line is shown, when `reason`). */
  stream: Promise<MediaStream>;
  /** R7.11.1: show "Wealthfire needs your camera…" while waiting (camera access not granted yet). */
  reason?: boolean;
  /** Closed with no photo (Cancel / Esc). */
  onClose: () => void;
  /** Camera could not start; the slot shows `message`. */
  onError: (message: string) => void;
  /** "Use photo": the final (cropped) JPEG. */
  onPhoto: (photo: Blob) => void;
}

export function TakePhotoDialog({ stream, reason = false, onClose, onError, onPhoto }: Props) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const live = useRef<MediaStream | null>(null);
  const shot = useRef<HTMLCanvasElement | null>(null); // full captured frame
  const urls = useRef<string[]>([]);
  const captureBtn = useRef<HTMLButtonElement>(null);
  const useBtn = useRef<HTMLButtonElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; z: number } | null>(null);

  const [step, setStep] = useState<Step>('waiting');
  /** Reason line shown until the first stream arrives (R7.11.1). */
  const [asking, setAsking] = useState(reason);
  const [ready, setReady] = useState(false); // video has real frames
  const [busy, setBusy] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [origUrl, setOrigUrl] = useState('');
  const [cropUrl, setCropUrl] = useState(''); // preview of the committed crop
  const [crop, setCrop] = useState<Crop | null>(null); // committed crop (null = uncropped)
  const [draft, setDraft] = useState<Crop>({ cx: 0, cy: 0, z: 1 }); // crop being edited
  const [frameSize, setFrameSize] = useState(280);

  const mounted = useRef(true);
  const attempt = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const newUrl = useCallback((b: Blob) => {
    const u = URL.createObjectURL(b);
    urls.current.push(u);
    return u;
  }, []);
  const dropUrl = useCallback((u: string) => {
    if (!u) return;
    URL.revokeObjectURL(u);
    urls.current = urls.current.filter((x) => x !== u);
  }, []);

  /** Attach a stream to the <video>, play it, and enable Capture once frames arrive. */
  const attach = useCallback(async (p: Promise<MediaStream>) => {
    const token = ++attempt.current; // only the latest attach may use its stream
    setReady(false);
    setStep('waiting');
    let s: MediaStream;
    try {
      s = await p;
    } catch (e) {
      if (mounted.current && token === attempt.current) onErrorRef.current(cameraErrorText(e));
      return;
    }
    if (!mounted.current || token !== attempt.current) {
      // Unmounted: stop it. Superseded while mounted (Strict Mode remount, Retake): the newer attach owns it.
      if (!mounted.current) stopStream(s);
      return;
    }
    stopStream(live.current);
    live.current = s;
    setAsking(false); // access granted: no reason line on Retake
    setStep('live');
    const v = video.current;
    if (!v) return;
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.srcObject = s;
    try {
      await v.play();
    } catch {
      // Autoplay of a muted inline video is allowed; if play() still rejects, 'playing' may follow later.
    }
    if (mounted.current && v.videoWidth > 0 && !v.paused) setReady(true);
  }, []);

  // Open as a modal; start the stream given by the click handler.
  useEffect(() => {
    mounted.current = true;
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    void attach(stream);
    return () => {
      mounted.current = false;
      stopStream(live.current);
      live.current = null;
      urls.current.forEach((u) => URL.revokeObjectURL(u));
      urls.current = [];
      shot.current = null;
      if (d?.open) d.close();
    };
  }, [attach, stream]);

  // Focus the main control of each step.
  useEffect(() => {
    if (step === 'still') useBtn.current?.focus();
    else if (step === 'crop') frame.current?.focus();
  }, [step]);
  useEffect(() => { if (ready && step === 'live') captureBtn.current?.focus(); }, [ready, step]);

  // Measure the crop frame (CSS decides its size).
  useEffect(() => {
    if (step !== 'crop' || !frame.current) return;
    const el = frame.current;
    const measure = () => setFrameSize(el.clientWidth || 280);
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [step]);

  // Wheel zoom: native listener so preventDefault works (React's wheel listener is passive).
  useEffect(() => {
    if (step !== 'crop' || !frame.current) return;
    const el = frame.current;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setDraft((c) => clampCrop({ ...c, z: c.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1) }, size.w, size.h));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [step, size]);

  function onVideoFrames() {
    const v = video.current;
    if (v && v.videoWidth > 0 && v.videoHeight > 0) setReady(true);
  }

  async function capture() {
    const v = video.current;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    setBusy(true);
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
    // The camera is not needed while the user looks at the still.
    stopStream(live.current);
    live.current = null;
    v.srcObject = null;
    const b = await toJpeg(c);
    if (!mounted.current) return;
    setBusy(false);
    if (!b) return;
    shot.current = c;
    dropUrl(origUrl);
    dropUrl(cropUrl);
    setOrigUrl(newUrl(b));
    setCropUrl('');
    setCrop(null);
    setSize({ w: c.width, h: c.height });
    setStep('still');
  }

  function retake() {
    // Called from a click, so a new permission prompt (if any) is allowed.
    if (!canUseCamera()) { onError(DOC_MESSAGES.cameraDenied); return; }
    dropUrl(origUrl);
    dropUrl(cropUrl);
    setOrigUrl('');
    setCropUrl('');
    setCrop(null);
    shot.current = null;
    void attach(openCamera());
  }

  function startCrop() {
    setDraft(crop ?? { cx: size.w / 2, cy: size.h / 2, z: 1 });
    setStep('crop');
  }

  /** Draw the image (cropped or full) to a canvas, at most MAX_OUT px on the long side. */
  function render(c: Crop | null): HTMLCanvasElement | null {
    const src = shot.current;
    if (!src) return null;
    const out = document.createElement('canvas');
    let sx = 0, sy = 0, sw = src.width, sh = src.height;
    if (c) {
      const side = Math.min(src.width, src.height) / c.z;
      sx = c.cx - side / 2; sy = c.cy - side / 2; sw = side; sh = side;
    }
    const k = Math.min(1, MAX_OUT / Math.max(sw, sh));
    out.width = Math.max(1, Math.round(sw * k));
    out.height = Math.max(1, Math.round(sh * k));
    out.getContext('2d')?.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return out;
  }

  async function doneCrop() {
    const c = clampCrop(draft, size.w, size.h);
    const canvas = render(c);
    if (!canvas) return;
    setBusy(true);
    const b = await toJpeg(canvas);
    if (!mounted.current) return;
    setBusy(false);
    if (!b) return;
    dropUrl(cropUrl);
    setCropUrl(newUrl(b));
    setCrop(c);
    setStep('still');
  }

  async function usePhoto() {
    const canvas = render(crop);
    if (!canvas) return;
    setBusy(true);
    const b = await toJpeg(canvas);
    if (!mounted.current) return;
    setBusy(false);
    if (b) onPhoto(b);
  }

  // ---- crop interaction ----
  const side = size.w && size.h ? Math.min(size.w, size.h) / draft.z : 1;
  const scale = frameSize / side; // display px per image px

  function moveBy(dxImg: number, dyImg: number) {
    setDraft((c) => clampCrop({ ...c, cx: c.cx + dxImg, cy: c.cy + dyImg }, size.w, size.h));
  }
  function zoomTo(z: number) {
    setDraft((c) => clampCrop({ ...c, z }, size.w, size.h));
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: draft.z };
    }
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) zoomTo(pinch.current.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.dist));
      return;
    }
    // Dragging the photo right shows more of its left side.
    moveBy(-(e.clientX - prev.x) / scale, -(e.clientY - prev.y) / scale);
  }
  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  }
  function onCropKey(e: KeyboardEvent<HTMLDivElement>) {
    const d = side * MOVE_STEP;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => moveBy(-d, 0),
      ArrowRight: () => moveBy(d, 0),
      ArrowUp: () => moveBy(0, -d),
      ArrowDown: () => moveBy(0, d),
      '+': () => zoomTo(draft.z + ZOOM_STEP),
      '=': () => zoomTo(draft.z + ZOOM_STEP),
      '-': () => zoomTo(draft.z - ZOOM_STEP),
      _: () => zoomTo(draft.z - ZOOM_STEP),
    };
    const act = keys[e.key];
    if (act) { e.preventDefault(); act(); }
  }

  /** Esc: leave Crop (same as its Cancel), otherwise close the dialog. */
  function onCancel(e: SyntheticEvent<HTMLDialogElement>) {
    e.preventDefault();
    if (step === 'crop') setStep('still');
    else onClose();
  }

  const status =
    step === 'waiting' ? DOC_MESSAGES.waitingForCamera
      : step === 'live' ? (ready ? 'Camera is on. Select Capture when you are ready.' : 'Starting camera…')
        : step === 'still' ? (crop ? 'Photo cropped. Use it, crop again or retake.' : 'Photo taken. Use it, crop it or retake.')
          : `Crop. Drag or use arrow keys to move, plus and minus to zoom. Zoom ${Math.round(draft.z * 100)}%.`;

  const titleId = `${id}-title`;
  const statusId = `${id}-status`;
  const cropHelpId = `${id}-crophelp`;

  return (
    <dialog ref={dialog} className="tp-dialog" aria-labelledby={titleId} aria-describedby={statusId} onCancel={onCancel}>
      <h2 id={titleId}>Take photo</h2>
      {step === 'waiting' && asking && <p className="muted small">{DOC_MESSAGES.cameraReason}</p>}
      <p id={statusId} role="status" className="small tp-status">{status}</p>

      {/* Kept mounted while waiting so the stream can attach as soon as it arrives. */}
      <video ref={video} className="tp-video" hidden={step !== 'live'} muted playsInline autoPlay
        onLoadedMetadata={onVideoFrames} onPlaying={onVideoFrames} aria-label="Camera preview" />

      {step === 'still' && (
        <img className="tp-still" src={cropUrl || origUrl} alt={crop ? 'Cropped photo' : 'Captured photo'} />
      )}

      {step === 'crop' && (
        <>
          <div ref={frame} className="tp-frame" tabIndex={0} role="group" aria-label="Crop area"
            aria-describedby={cropHelpId} onKeyDown={onCropKey}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            <img src={origUrl} alt="" draggable={false} className="tp-crop-img"
              style={{
                width: size.w * scale, height: size.h * scale,
                transform: `translate(${frameSize / 2 - draft.cx * scale}px, ${frameSize / 2 - draft.cy * scale}px)`,
              }} />
          </div>
          <p id={cropHelpId} className="muted small">Drag to move. Arrow keys move, plus and minus zoom.</p>
          <label className="tp-zoom small">
            Zoom
            <input type="range" min={1} max={MAX_ZOOM} step={0.05} value={draft.z}
              aria-valuetext={`${Math.round(draft.z * 100)}%`} onChange={(e) => zoomTo(Number(e.target.value))} />
          </label>
          <div className="row">
            <button type="button" className="btn" aria-label="Zoom out" disabled={draft.z <= 1} onClick={() => zoomTo(draft.z - ZOOM_STEP)}>−</button>
            <button type="button" className="btn" aria-label="Zoom in" disabled={draft.z >= MAX_ZOOM} onClick={() => zoomTo(draft.z + ZOOM_STEP)}>+</button>
          </div>
        </>
      )}

      <div className="row">
        {(step === 'waiting' || step === 'live') && (
          <>
            <button ref={captureBtn} type="button" className="btn primary" disabled={step !== 'live' || !ready || busy} onClick={() => void capture()}>Capture</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </>
        )}
        {step === 'still' && (
          <>
            <button type="button" className="btn" disabled={busy} onClick={retake}>Retake</button>
            <button type="button" className="btn" disabled={busy} onClick={startCrop}>Crop</button>
            <button ref={useBtn} type="button" className="btn primary" disabled={busy} onClick={() => void usePhoto()}>Use photo</button>
            <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          </>
        )}
        {step === 'crop' && (
          <>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void doneCrop()}>Done</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setStep('still')}>Cancel</button>
          </>
        )}
      </div>
    </dialog>
  );
}
