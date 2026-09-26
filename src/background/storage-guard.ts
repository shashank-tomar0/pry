/**
 * Best-effort persistence that never throws.
 *
 * WHY THIS EXISTS
 *
 * A storage write can fail while the disk has space: extension quota,
 * a wedged LevelDB backend (`FILE_ERROR_NO_SPACE` on `WritableFileAppend`
 * reached a live run that way), antivirus locks, profile pressure. Every
 * writer used to `await chrome.storage.local.set(...)` raw, so one rejected
 * write propagated into the run and printed as a run-killing "IO error"
 * card. Storage pressure must degrade features (a store stays in-memory for
 * the session), never kill runs.
 */

export async function persistedSet(items: Record<string, unknown>): Promise<boolean> {
  try {
    await chrome.storage.local.set(items);
    return true;
  } catch {
    return false;
  }
}
