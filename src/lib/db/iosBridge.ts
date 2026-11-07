/**
 * iOS Bridge storage — snapshots pushed by the iPhone (calendar, reminders,
 * location, health) and the queue of actions Claude asks the iPhone to run.
 *
 * Everything lives in the `key_value` table under the `ios_bridge` namespace.
 * Values are encrypted at rest (AES-256-GCM) whenever STORAGE_ENCRYPTION_KEY is set —
 * health and location data are personal, so never log payloads from this module.
 */
import { randomUUID } from "crypto";

import { getDbInstance } from "./core";
import { decrypt, encrypt, isEncryptionEnabled } from "./encryption";
import type {
  CalendarEvent,
  HealthSample,
  IosActionResults,
  IosActionType,
  IosBridgeSyncPayload,
  IosLocation,
  Reminder,
} from "../iosBridge/schemas";

const NAMESPACE = "ios_bridge";
const ACTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const IOS_ACTION_QUEUE_MAX = 500;

export type IosSnapshotKind = "calendar" | "reminders" | "location" | "health";

export interface IosSnapshot<T> {
  syncedAt: string;
  device: string | null;
  data: T;
}

export type IosActionStatus = "pending" | "done" | "failed";

export interface IosAction {
  id: string;
  type: IosActionType;
  payload: Record<string, unknown>;
  status: IosActionStatus;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
}

type KeyValueRow = { value?: string };

function readValue<T>(key: string): T | null {
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, key) as KeyValueRow | undefined;
  if (typeof row?.value !== "string") return null;
  try {
    const stored = JSON.parse(row.value);
    if (typeof stored !== "string") return null;
    const plain = decrypt(stored, { quiet: true });
    if (typeof plain !== "string") return null;
    return JSON.parse(plain) as T;
  } catch {
    return null;
  }
}

function writeValue(key: string, value: unknown): void {
  const plain = JSON.stringify(value);
  const stored = isEncryptionEnabled() ? (encrypt(plain) ?? plain) : plain;
  getDbInstance()
    .prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
    .run(NAMESPACE, key, JSON.stringify(stored));
}

// ── Snapshots ────────────────────────────────────────────────────────────────

export interface IosSyncSummary {
  syncedAt: string;
  updated: IosSnapshotKind[];
  counts: Partial<Record<IosSnapshotKind, number>>;
}

/** Replace each category present in the payload with the new snapshot. */
export function saveIosSnapshot(payload: IosBridgeSyncPayload, now = new Date()): IosSyncSummary {
  const syncedAt = now.toISOString();
  const device = payload.device || null;
  const summary: IosSyncSummary = { syncedAt, updated: [], counts: {} };
  const db = getDbInstance();

  db.transaction(() => {
    if (payload.calendar) {
      const events = [...payload.calendar.events].sort((a, b) => a.start.localeCompare(b.start));
      writeValue("calendar", { syncedAt, device, data: events });
      summary.updated.push("calendar");
      summary.counts.calendar = events.length;
    }
    if (payload.reminders) {
      writeValue("reminders", { syncedAt, device, data: payload.reminders.items });
      summary.updated.push("reminders");
      summary.counts.reminders = payload.reminders.items.length;
    }
    if (payload.location) {
      const location = { ...payload.location, timestamp: payload.location.timestamp ?? syncedAt };
      writeValue("location", { syncedAt, device, data: location });
      summary.updated.push("location");
      summary.counts.location = 1;
    }
    if (payload.health) {
      const samples = [...payload.health.samples].sort((a, b) => a.start.localeCompare(b.start));
      writeValue("health", { syncedAt, device, data: samples });
      summary.updated.push("health");
      summary.counts.health = samples.length;
    }
  })();

  return summary;
}

export function getIosCalendarSnapshot(): IosSnapshot<CalendarEvent[]> | null {
  return readValue<IosSnapshot<CalendarEvent[]>>("calendar");
}

export function getIosRemindersSnapshot(): IosSnapshot<Reminder[]> | null {
  return readValue<IosSnapshot<Reminder[]>>("reminders");
}

export function getIosLocationSnapshot(): IosSnapshot<IosLocation> | null {
  return readValue<IosSnapshot<IosLocation>>("location");
}

export function getIosHealthSnapshot(): IosSnapshot<HealthSample[]> | null {
  return readValue<IosSnapshot<HealthSample[]>>("health");
}

/** Delete every snapshot and queued action (operator reset). */
export function clearIosBridgeData(): void {
  getDbInstance().prepare("DELETE FROM key_value WHERE namespace = ?").run(NAMESPACE);
}

// ── Action queue ─────────────────────────────────────────────────────────────

function readActions(): IosAction[] {
  const actions = readValue<IosAction[]>("actions");
  return Array.isArray(actions) ? actions : [];
}

function pruneActions(actions: IosAction[], nowMs: number): IosAction[] {
  return actions.filter(
    (a) => a.status === "pending" || nowMs - Date.parse(a.updatedAt) < ACTION_RETENTION_MS
  );
}

export class IosActionQueueFullError extends Error {
  constructor() {
    super(
      `iOS action queue is full (${IOS_ACTION_QUEUE_MAX} pending). Run the OmniRoute shortcut on the iPhone to drain it.`
    );
    this.name = "IosActionQueueFullError";
  }
}

export function enqueueIosAction(
  type: IosActionType,
  payload: Record<string, unknown>,
  now = new Date()
): IosAction {
  const nowIso = now.toISOString();
  const action: IosAction = {
    id: randomUUID(),
    type,
    payload,
    status: "pending",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const db = getDbInstance();
  db.transaction(() => {
    let actions = pruneActions(readActions(), now.getTime());
    if (actions.length >= IOS_ACTION_QUEUE_MAX) {
      const finished = actions.filter((a) => a.status !== "pending");
      if (finished.length === 0) throw new IosActionQueueFullError();
      const dropId = finished[0].id;
      actions = actions.filter((a) => a.id !== dropId);
    }
    actions.push(action);
    writeValue("actions", actions);
  })();
  return action;
}

export function listIosActions(status?: IosActionStatus): IosAction[] {
  const actions = readActions();
  return status ? actions.filter((a) => a.status === status) : actions;
}

export function getIosAction(id: string): IosAction | null {
  return readActions().find((a) => a.id === id) ?? null;
}

/** Record what the iPhone did with each action. Unknown ids are reported, not stored. */
export function applyIosActionResults(
  input: IosActionResults,
  now = new Date()
): { updated: string[]; unknown: string[] } {
  const updated: string[] = [];
  const unknown: string[] = [];
  const nowIso = now.toISOString();
  const db = getDbInstance();
  db.transaction(() => {
    const actions = readActions();
    const byId = new Map(actions.map((a) => [a.id, a]));
    for (const r of input.results) {
      const action = byId.get(r.id);
      if (!action) {
        unknown.push(r.id);
        continue;
      }
      action.status = r.status;
      action.updatedAt = nowIso;
      if (r.result !== undefined) action.result = r.result;
      if (r.error !== undefined) action.error = r.error;
      updated.push(r.id);
    }
    writeValue("actions", pruneActions(actions, now.getTime()));
  })();
  return { updated, unknown };
}

// ── Status ───────────────────────────────────────────────────────────────────

export interface IosBridgeStatus {
  connected: boolean;
  device: string | null;
  lastSyncAt: string | null;
  snapshots: Record<IosSnapshotKind, { syncedAt: string; count: number } | null>;
  actions: { pending: number; done: number; failed: number };
}

export function getIosBridgeStatus(): IosBridgeStatus {
  const calendar = getIosCalendarSnapshot();
  const reminders = getIosRemindersSnapshot();
  const location = getIosLocationSnapshot();
  const health = getIosHealthSnapshot();
  const all = [calendar, reminders, location, health].filter(Boolean) as IosSnapshot<unknown>[];
  const latest = all.sort((a, b) => b.syncedAt.localeCompare(a.syncedAt))[0] ?? null;
  const actions = readActions();
  const count = (s: IosActionStatus) => actions.filter((a) => a.status === s).length;
  return {
    connected: latest !== null,
    device: latest?.device ?? null,
    lastSyncAt: latest?.syncedAt ?? null,
    snapshots: {
      calendar: calendar ? { syncedAt: calendar.syncedAt, count: calendar.data.length } : null,
      reminders: reminders ? { syncedAt: reminders.syncedAt, count: reminders.data.length } : null,
      location: location ? { syncedAt: location.syncedAt, count: 1 } : null,
      health: health ? { syncedAt: health.syncedAt, count: health.data.length } : null,
    },
    actions: { pending: count("pending"), done: count("done"), failed: count("failed") },
  };
}
