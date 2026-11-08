/**
 * Shortcut-friendly view of a queued iOS action.
 *
 * Apple Shortcuts needs one "Get Dictionary Value" step per nesting level, so the
 * fields a shortcut needs (title, list, dates, …) are lifted to the top level. Dates
 * drop milliseconds ("2026-11-08T13:00:00Z") so Shortcuts reliably reads them as dates.
 * Missing values are empty strings, never absent keys.
 */
import type { IosAction } from "../db/iosBridge";

type Obj = Record<string, unknown>;

const asObj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (...vals: unknown[]): string => {
  for (const v of vals) if (typeof v === "string" && v.trim() !== "") return v;
  return "";
};
const date = (...vals: unknown[]): string => str(...vals).replace(/\.\d{3}Z$/, "Z");

export interface IosActionView {
  id: string;
  type: IosAction["type"];
  status: IosAction["status"];
  createdAt: string;
  title: string;
  newTitle: string;
  list: string;
  calendar: string;
  start: string;
  end: string;
  due: string;
  location: string;
  notes: string;
  priority: string;
  payload: Obj;
}

export function toIosActionView(action: IosAction): IosActionView {
  const p = asObj(action.payload);
  const match = asObj(p.match);
  const changes = asObj(p.changes);
  return {
    id: action.id,
    type: action.type,
    status: action.status,
    createdAt: action.createdAt,
    title: str(p.title, match.title),
    newTitle: str(changes.newTitle),
    list: str(p.list, match.list, changes.moveToList),
    calendar: str(p.calendar),
    start: date(p.start),
    end: date(p.end),
    due: date(p.due, changes.due),
    location: str(p.location),
    notes: str(p.notes, changes.notes),
    priority: str(p.priority, changes.priority),
    payload: p,
  };
}
