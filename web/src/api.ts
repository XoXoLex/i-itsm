export type Role = "EMPLOYEE" | "TECHNICIAN" | "ADMIN";
export type Priority = "P1" | "P2" | "P3" | "P4";
export type SlaStatus = "ON_TRACK" | "AT_RISK" | "BREACHED" | "MET";

export interface User {
  id: string; name: string; email: string; role: Role; department?: string;
  skills?: string[]; experienceYears?: number; workload?: number; maxActive?: number; available?: boolean;
}

export interface Incident {
  id: string; title: string; description: string; status: string; isOpen: boolean;
  category: string | null; priority: Priority | null; priorityScore: number;
  impact: number; impactLabel: string; urgency: number; urgencyLabel: string; affectedUsers: number;
  createdAt: string;
  service: { id: string; name: string; criticality: string };
  reporter: { id: string; name: string };
  assignee: { id: string; name: string } | null;
  sla: { responseBy: string | null; resolveBy: string | null; status: SlaStatus; responseBreached: boolean; resolutionBreached: boolean };
  acknowledgedAt: string | null; resolvedAt: string | null; closedAt: string | null;
  resolution: string | null; feedback: { rating: number; comment: string } | null;
  escalationLevel: number; escalatedTo: string | null; related: string[];
}

export interface IncidentDetail extends Incident {
  timeline: { author: { id: string; name: string; role: Role }; kind: string; text: string; at: string }[];
  audit?: AuditEntry[];
  suggestions?: { from: string; resolution: string; similarity: number }[];
}

export interface AuditEntry {
  id: string; at: string; actor: string; action: string; incidentId: string;
  previousState: string | null; newState: string | null; description: string;
}

export interface Meta {
  services: { id: string; name: string; criticality: number; userBase: number }[];
  categories: { name: string; keywords: string[] }[];
  levels: { value: number; label: string }[];
  statuses: string[]; priorities: Priority[]; slaStatuses: SlaStatus[];
  technicians: { id: string; name: string }[];
  slaPolicies: { priority: Priority; responseMinutes: number; resolutionMinutes: number }[];
  strategies: { priority: string; assignment: string; assignmentOptions: string[]; priorityOptions: string[] };
  categorizer: string;
}

export interface InboxItem { id: string; subject: string; body: string; incidentId: string; at: string; read: boolean }

export class ApiError extends Error {
  constructor(readonly status: number, readonly kind: string, message: string) { super(message); }
}

let token: string | null = sessionStorage.getItem("itsm.token");
export const getToken = () => token;
export const setToken = (t: string | null) => {
  token = t;
  if (t) sessionStorage.setItem("itsm.token", t);
  else sessionStorage.removeItem("itsm.token");
};

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) { setToken(null); location.reload(); }
    throw new ApiError(res.status, data.error ?? "Error", data.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

/** Subscribes to server-sent events; returns an unsubscribe function. */
export function subscribe(onIncident: (e: { id: string; type: string }) => void, onNotify: (n: { subject: string; body: string; incidentId: string }) => void) {
  if (!token) return () => {};
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  es.addEventListener("incident", (e) => onIncident(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("notification", (e) => onNotify(JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}

// ---------- formatting helpers ----------
export const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

export function fmtDuration(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const STATUS_LABEL: Record<string, string> = {
  NEW: "New", CLASSIFIED: "Classified", ASSIGNED: "Assigned", ACKNOWLEDGED: "Acknowledged",
  IN_PROGRESS: "In progress", PENDING_INFO: "Waiting on reporter", RESOLVED: "Resolved", VERIFIED: "Verified", CLOSED: "Closed",
};

export const PRIORITY_LABEL: Record<Priority, string> = { P1: "Critical", P2: "High", P3: "Medium", P4: "Low" };
export const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");
