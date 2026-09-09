/**
 * Session History Manager
 *
 * Saves completed task sessions to chrome.storage.local so users can
 * browse, search, and re-run past conversations. Like ChatGPT's sidebar.
 */

import type { TranscriptEntry } from "../shared/types";

export interface Session {
  id: string;
  task: string;
  startedAt: number;
  completedAt: number;
  status: "completed" | "failed" | "stopped";
  transcript: TranscriptEntry[];
  /** Summary of what happened (first assistant message or result). */
  summary: string;
  /** Total PII items redacted during the session. */
  piiRedacted: number;
  /** Duration in ms. */
  durationMs: number;
}

const STORAGE_KEY = "pry-session-history";
const MAX_SESSIONS = 50;

/**
 * Save a completed session to history.
 */
export async function saveSession(session: Session): Promise<void> {
  const { [STORAGE_KEY]: existing } = await chrome.storage.local.get(STORAGE_KEY);
  const sessions: Session[] = existing ?? [];

  // Add new session at the beginning.
  sessions.unshift(session);

  // Trim to max.
  if (sessions.length > MAX_SESSIONS) {
    sessions.length = MAX_SESSIONS;
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
}

/**
 * Get all sessions from history.
 */
export async function getSessions(): Promise<Session[]> {
  const { [STORAGE_KEY]: sessions } = await chrome.storage.local.get(STORAGE_KEY);
  return sessions ?? [];
}

/**
 * Delete a session by ID.
 */
export async function deleteSession(id: string): Promise<void> {
  const { [STORAGE_KEY]: existing } = await chrome.storage.local.get(STORAGE_KEY);
  const sessions: Session[] = existing ?? [];
  const filtered = sessions.filter((s) => s.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEY]: filtered });
}

/**
 * Clear all history.
 */
export async function clearHistory(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

