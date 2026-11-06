// "Take photo" for the selfie slot on Android / iOS (Req 7.11, design B6 "Take photo flow, phones").
// Press -> (only when not granted yet) reason line, then the system permission prompt -> OS camera (front)
// -> "Retake" / "Crop" / "Use photo".
// "Crop" is an in-app square crop (drag to move, pinch to zoom, +/- buttons and screen-reader actions), saved with
// expo-image-manipulator as a JPEG. Privacy: capture and crop files sit in the app cache and are deleted as soon as
// they are not needed (Retake, Cancel, Crop cancel, Use photo, unmount). Nothing here is written to AppData.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Image, Linking, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions,
  type AccessibilityActionEvent, type GestureResponderEvent, type PanResponderGestureState,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import { deleteAsync } from 'expo-file-system/legacy';
import { DOC_MESSAGES, validateDocFile, type DocFile, type DocMime } from '@wealthfire/core';
import { theme } from '../theme';
import { Btn, s } from '../ui';
import { Link, Msg } from './onboardUi';

// ---------- Wording (shared with web through DOC_MESSAGES) ----------
const WAITING = DOC_MESSAGES.waitingForCamera;
const CAMERA_IN_USE = DOC_MESSAGES.cameraInUse;

// ---------- Files (shared with Documents.tsx) ----------

/** Deletes a file from the app cache. Safe to call twice. */
export function deleteUri(uri: string | null | undefined): void {
  if (uri) deleteAsync(uri, { idempotent: true }).catch(() => {});
}

export function guessMime(mime: string | null | undefined, name: string): string {
  const m = (mime ?? '').toLowerCase();
  if (m === 'image/jpg') return 'image/jpeg';
  if (m) return m;
  const ext = name.toLowerCase().split('.').pop();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : ext === 'pdf' ? 'application/pdf' : '';
}

export function fileSize(uri: string, known: number | null | undefined): number {
  if (typeof known === 'number' && known > 0) return known;
  try { return new File(uri).size ?? 0; } catch { return 0; }
}

/** Maps a thrown camera error to user text. */
function cameraError(e: unknown): string {
  const text = e instanceof Error ? `${(e as { code?: string }).code ?? ''} ${e.message}` : String(e);
  if (/in use|busy|already|ERR_CAMERA_IN_USE/i.test(text)) return CAMERA_IN_USE;
  if (/no camera|not available|unavailable|simulator/i.test(text)) return DOC_MESSAGES.noCamera;
  return DOC_MESSAGES.cameraDenied;
}

interface Shot { uri: string; width: number; height: number; mime: string; size: number }

/** How long the camera reason line is on screen before the system prompt covers it (R7.11.1). */
const REASON_LEAD_MS = 600;
/** Resolves once the reason line has been drawn and had a moment to be read. */
function reasonShown(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, REASON_LEAD_MS)));
}

// ---------- Square crop ----------

const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
interface View3 { z: number; tx: number; ty: number }

type CropRect = { originX: number; originY: number; width: number; height: number };

function CropView({ shot, initial, busy, onDone, onCancel }: {
  shot: Shot;
  /** The committed crop when "Crop" is pressed again: it is re-edited, not discarded (same as web). */
  initial: View3 | null;
  busy: boolean; onDone: (rect: CropRect, view: View3) => void; onCancel: () => void;
}) {
  const { width: winW } = useWindowDimensions();
  const S = Math.max(160, Math.min(winW - 48, 340)); // frame side in points
  const base = S / Math.min(shot.width, shot.height); // zoom 1: the photo just covers the frame
  const clampView = (v: View3): View3 => {
    const z = Math.min(MAX_ZOOM, Math.max(1, v.z));
    const maxX = (shot.width * base * z - S) / 2;
    const maxY = (shot.height * base * z - S) / 2;
    return { z, tx: Math.min(maxX, Math.max(-maxX, v.tx)), ty: Math.min(maxY, Math.max(-maxY, v.ty)) };
  };
  const [view, setViewState] = useState<View3>(() => clampView(initial ?? { z: 1, tx: 0, ty: 0 }));
  const viewRef = useRef(view);
  const last = useRef<{ x: number | null; y: number | null; dist: number | null }>({ x: null, y: null, dist: null });

  const setView = (fn: (v: View3) => View3) => {
    const next = clampView(fn(viewRef.current));
    viewRef.current = next;
    setViewState(next);
  };
  // Zoom about the frame centre: offsets scale with the zoom so the centre point stays put.
  const zoomTo = (z: number) => setView((v) => {
    const nz = Math.min(MAX_ZOOM, Math.max(1, z));
    return { z: nz, tx: v.tx * (nz / v.z), ty: v.ty * (nz / v.z) };
  });
  const moveBy = (dx: number, dy: number) => setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { last.current = { x: null, y: null, dist: null }; },
    onPanResponderMove: (e: GestureResponderEvent, g: PanResponderGestureState) => {
      const t = e.nativeEvent.touches;
      const a = t[0]; const b = t[1];
      if (a && b) {
        const d = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
        if (last.current.dist && d > 0) zoomTo(viewRef.current.z * (d / last.current.dist));
        last.current = { x: null, y: null, dist: d };
      } else {
        if (last.current.x !== null && last.current.y !== null) moveBy(g.moveX - last.current.x, g.moveY - last.current.y);
        last.current = { x: g.moveX, y: g.moveY, dist: null };
      }
    },
    onPanResponderRelease: () => { last.current = { x: null, y: null, dist: null }; },
    onPanResponderTerminate: () => { last.current = { x: null, y: null, dist: null }; },
  }), [S, base, shot.width, shot.height]); // zoomTo / moveBy read the latest view from viewRef

  const dispW = shot.width * base * view.z;
  const dispH = shot.height * base * view.z;
  const left = (S - dispW) / 2 + view.tx;
  const top = (S - dispH) / 2 + view.ty;

  function done() {
    const scale = base * view.z; // points per photo pixel
    const side = Math.max(1, Math.min(shot.width, shot.height, Math.round(S / scale)));
    const originX = Math.min(shot.width - side, Math.max(0, Math.round(-left / scale)));
    const originY = Math.min(shot.height - side, Math.max(0, Math.round(-top / scale)));
    onDone({ originX, originY, width: side, height: side }, viewRef.current);
  }

  const step = S / 10;
  const onAction = (e: AccessibilityActionEvent) => {
    switch (e.nativeEvent.actionName) {
      case 'increment': zoomTo(viewRef.current.z + ZOOM_STEP); break;
      case 'decrement': zoomTo(viewRef.current.z - ZOOM_STEP); break;
      case 'left': moveBy(step, 0); break; // show more of the left side
      case 'right': moveBy(-step, 0); break;
      case 'up': moveBy(0, step); break;
      case 'down': moveBy(0, -step); break;
    }
  };

  return (
    <View>
      <View style={[st.frame, { width: S, height: S }]} {...pan.panHandlers}
        accessible accessibilityRole="adjustable" accessibilityLabel="Crop area"
        accessibilityValue={{ text: `Zoom ${Math.round(view.z * 100)}%` }}
        accessibilityActions={[
          { name: 'increment', label: 'Zoom in' }, { name: 'decrement', label: 'Zoom out' },
          { name: 'left', label: 'Move left' }, { name: 'right', label: 'Move right' },
          { name: 'up', label: 'Move up' }, { name: 'down', label: 'Move down' },
        ]}
        onAccessibilityAction={onAction}>
        <Image source={{ uri: shot.uri }} style={{ position: 'absolute', left, top, width: dispW, height: dispH }}
          accessibilityIgnoresInvertColors />
      </View>
      <View style={st.zoomRow}>
        <ZoomBtn label="Zoom out" glyph="-" disabled={busy || view.z <= 1} onPress={() => zoomTo(view.z - ZOOM_STEP)} />
        <ZoomBtn label="Zoom in" glyph="+" disabled={busy || view.z >= MAX_ZOOM} onPress={() => zoomTo(view.z + ZOOM_STEP)} />
      </View>
      <Btn primary title="Done" disabled={busy} onPress={done} />
      <Btn title="Cancel" disabled={busy} onPress={onCancel} />
    </View>
  );
}

function ZoomBtn({ label, glyph, disabled, onPress }: { label: string; glyph: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      hitSlop={6} style={({ pressed }) => [st.zoomBtn, (pressed || disabled) && { opacity: 0.5 }]}>
      <Text style={st.zoomGlyph} importantForAccessibility="no" accessibilityElementsHidden>{glyph}</Text>
    </Pressable>
  );
}

// ---------- Take photo ----------

type Phase = 'idle' | 'waiting' | 'review' | 'crop';

/** The selfie "Take photo" button and its flow. onPhoto gets a JPEG DocFile the caller then owns (and deletes). */
export function TakePhoto({ disabled, onPhoto }: { disabled?: boolean; onPhoto: (d: DocFile) => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [shot, setShot] = useState<Shot | null>(null); // as captured
  const [crop, setCrop] = useState<Shot | null>(null); // cropped copy, if any
  const [cropView, setCropView] = useState<View3 | null>(null); // frame position of the committed crop, for re-editing
  const [asking, setAsking] = useState(false); // the system camera prompt is up (never while access is already granted)
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false); // show "Open settings" (denied and the OS won't ask again)
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const temp = useRef<{ shot: string | null; crop: string | null }>({ shot: null, crop: null });
  temp.current = { shot: shot?.uri ?? null, crop: crop?.uri ?? null };

  // Files not handed to the slot are deleted when this goes away.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; deleteUri(temp.current.shot); deleteUri(temp.current.crop); };
  }, []);

  /** Press handler for "Take photo" and "Retake": asks for permission only when not granted yet, then opens the camera. */
  async function open() {
    if (busy) return;
    setBusy(true); setError(''); setSettings(false);
    const hadShot = phase === 'review';
    try {
      let granted = false;
      try { granted = (await ImagePicker.getCameraPermissionsAsync()).granted; } catch { granted = false; }
      if (!alive.current) return;
      if (!granted) {
        // R7.11.1: the reason line shows first, then the system prompt. Bug 10: none of this when already granted.
        setAsking(true);
        if (!hadShot) setPhase('waiting');
        await reasonShown();
        if (!alive.current) return;
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!alive.current) return;
        setAsking(false);
        if (!perm.granted) {
          setError(DOC_MESSAGES.cameraDenied);
          setSettings(!perm.canAskAgain);
          if (!hadShot) setPhase('idle');
          return;
        }
      }
      const r = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'], cameraType: ImagePicker.CameraType.front, allowsEditing: false, quality: 0.8, exif: false,
      });
      const a = r.canceled ? undefined : r.assets[0];
      if (!alive.current) { deleteUri(a?.uri); return; }
      if (!a) { if (!hadShot) setPhase('idle'); return; } // cancelled: keep the earlier photo on Retake
      deleteUri(temp.current.shot); deleteUri(temp.current.crop); // Retake: drop the old capture
      const name = a.fileName ?? 'selfie.jpg';
      setShot({ uri: a.uri, width: a.width, height: a.height, mime: guessMime(a.mimeType, name), size: fileSize(a.uri, a.fileSize) });
      setCrop(null); setCropView(null);
      setPhase('review');
    } catch (e) {
      if (!alive.current) return;
      setError(cameraError(e));
      if (!hadShot) setPhase('idle');
    } finally {
      if (alive.current) { setBusy(false); setAsking(false); }
    }
  }

  async function applyCrop(rect: CropRect, view: View3) {
    if (!shot) return;
    setBusy(true); setError('');
    try {
      const r = await manipulateAsync(shot.uri, [{ crop: rect }], { compress: 0.8, format: SaveFormat.JPEG });
      if (!alive.current) { deleteUri(r.uri); return; }
      deleteUri(temp.current.crop);
      setCrop({ uri: r.uri, width: r.width, height: r.height, mime: 'image/jpeg', size: fileSize(r.uri, null) });
      setCropView(view);
      setPhase('review');
    } catch {
      if (alive.current) setError(DOC_MESSAGES.couldNotReadFile);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  // Crop "Cancel": back to the photo as it was before this crop edit (uncropped the first time,
  // the earlier crop when re-editing), same as web (Req 7.11.4).
  function cancelCrop() {
    setError(''); setPhase('review');
  }

  /** Leaves the flow and deletes every temp file. */
  function close() {
    deleteUri(temp.current.shot); deleteUri(temp.current.crop);
    setShot(null); setCrop(null); setCropView(null); setError(''); setPhase('idle');
  }

  function usePhoto() {
    const final = crop ?? shot;
    if (!final) return;
    const doc: DocFile = { kind: 'selfie', name: 'selfie.jpg', mime: final.mime as DocMime, size: final.size, uri: final.uri };
    const err = validateDocFile(doc);
    if (err) { setError(err); return; }
    if (crop && shot) deleteUri(shot.uri); // only the cropped copy is kept
    temp.current = { shot: null, crop: null };
    setShot(null); setCrop(null); setCropView(null); setError(''); setPhase('idle');
    onPhoto(doc); // the slot owns the file from here (deleted on Remove / Replace / done)
  }

  const shown = crop ?? shot;
  const inModal = phase === 'review' || phase === 'crop';

  return (
    <View>
      <Btn title="Take photo" disabled={!!disabled || busy} onPress={() => void open()} />
      {phase === 'waiting' ? (
        <>
          <Msg text={DOC_MESSAGES.cameraReason} tone="muted" />
          <Msg text={WAITING} tone="muted" />
        </>
      ) : null}
      {!inModal && error ? <Msg text={error} /> : null}
      {!inModal && settings ? <Link title="Open settings" onPress={() => void Linking.openSettings().catch(() => {})} /> : null}

      <Modal visible={inModal && !!shown} animationType="slide" onRequestClose={phase === 'crop' ? cancelCrop : close}>
        <ScrollView style={st.modal} contentContainerStyle={st.modalBody} scrollEnabled={phase !== 'crop'}>
          <Text style={s.h1} accessibilityRole="header">Take photo</Text>
          {shown && phase === 'crop' && shot ? (
            <CropView shot={shot} initial={crop ? cropView : null} busy={busy} onDone={(r, v) => void applyCrop(r, v)} onCancel={cancelCrop} />
          ) : shown ? (
            <>
              <Image source={{ uri: shown.uri }} style={st.still} resizeMode="contain" accessibilityLabel="Your selfie preview" />
              {/* Bug 10: only while the system prompt is really pending, never on a Retake with access granted. */}
              {asking ? (
                <>
                  <Msg text={DOC_MESSAGES.cameraReason} tone="muted" />
                  <Msg text={WAITING} tone="muted" />
                </>
              ) : null}
              {/* Same buttons and order as the web dialog (apps/web/src/components/TakePhotoDialog.tsx). */}
              <Btn title="Retake" disabled={busy} onPress={() => void open()} />
              {/* Bug 9: "Crop" again re-edits the committed crop (kept until Done replaces it), same as web. */}
              <Btn title="Crop" disabled={busy} onPress={() => { setError(''); setPhase('crop'); }} />
              <Btn primary title="Use photo" disabled={busy} onPress={usePhoto} />
              <Btn title="Cancel" disabled={busy} onPress={close} />
            </>
          ) : null}
          {inModal && error ? <Msg text={error} /> : null}
          {inModal && settings ? <Link title="Open settings" onPress={() => void Linking.openSettings().catch(() => {})} /> : null}
        </ScrollView>
      </Modal>
    </View>
  );
}

const st = StyleSheet.create({
  modal: { flex: 1, backgroundColor: theme.bg },
  modalBody: { padding: 20, paddingTop: 56, alignItems: 'stretch' },
  still: { width: '100%', aspectRatio: 3 / 4, borderRadius: 10, backgroundColor: theme.panel2, marginBottom: 12 },
  frame: { alignSelf: 'center', overflow: 'hidden', borderRadius: 8, borderWidth: 2, borderColor: theme.accent, backgroundColor: theme.panel2 },
  zoomRow: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginVertical: 12 },
  zoomBtn: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.line, backgroundColor: theme.panel2 },
  zoomGlyph: { color: theme.text, fontSize: 24, fontWeight: '700' },
});
