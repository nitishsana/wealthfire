// Bug 2: picked and cropped documents (PAN, Aadhaar, selfie) must not linger on the phone.
// Expo copies them into these subfolders of the app cache (FileSystem.cacheDirectory):
// - ImagePicker/       expo-image-picker writes camera shots and library picks here.
// - DocumentPicker/    expo-document-picker copies picked files here (copyToCacheDirectory: true).
// - ImageManipulator/  expo-image-manipulator writes crop output here (used by the selfie crop).
// Each folder is deleted whole; Expo creates it again on the next pick.
import { cacheDirectory, deleteAsync } from 'expo-file-system/legacy';

export const PICKER_CACHE_FOLDERS = ['ImagePicker', 'DocumentPicker', 'ImageManipulator'] as const;

/** Best effort: deletes leftover picker / crop files. Never throws. Call at launch and on Sign out. */
export async function clearPickerCache(): Promise<void> {
  if (!cacheDirectory) return;
  const base = cacheDirectory.endsWith('/') ? cacheDirectory : `${cacheDirectory}/`;
  await Promise.all(
    PICKER_CACHE_FOLDERS.map((folder) => deleteAsync(`${base}${folder}`, { idempotent: true }).catch(() => undefined)),
  );
}
