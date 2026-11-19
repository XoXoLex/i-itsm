export type Role = "EMPLOYEE" | "TECHNICIAN" | "ADMIN";
export type Priority = "P1" | "P2" | "P3" | "P4";
export type SlaStatus = "ON_TRACK" | "AT_RISK" | "BREACHED" | "MET";

export interface User {
  id: string; name: string; email: string; role: Role; active: boolean; department?: string;
  skills?: string[]; experienceYears?: number; workload?: number; maxActive?: number; available?: boolean;
}

export interface Incident {
  id: string; title: string; description: string; status: string; isOpen: boolean;
  category: string | null; priority: Priority | null; priorityScore: number;
  impact: number; impactLabel: string; urgency: number; urgencyLabel: string; affectedUsers: number;
  createdAt: string;
  service: { id: string; name: string; criticality: string; userBase: number };
  reporter: { id: string; name: string };
  assignee: { id: string; name: string } | null;
  sla: { responseBy: string | null; resolveBy: string | null; status: SlaStatus; responseBreached: boolean; resolutionBreached: boolean };
  acknowledgedAt: string | null; resolvedAt: string | null; closedAt: string | null;
  resolution: string | null; feedback: { rating: number; comment: string } | null;
  escalationLevel: number; escalatedTo: string | null; related: string[];
}

export interface IncidentDetail extends Incident {
  timeline: { author: { id: string; name: string; role: Role }; kind: string; text: string; at: string }[];
  canEdit: boolean;
  audit?: AuditEntry[];
  suggestions?: { from: string; resolution: string; similarity: number; canOpen: boolean }[];
}

export interface AuditEntry {
  id: string; at: string; actor: string; action: string; incidentId: string;
  previousState: string | null; newState: string | null; description: string;
}

export interface Meta {
  services: Service[];
  categories: { name: string; keywords: string[] }[];
  levels: { value: number; label: string }[];
  statuses: string[]; priorities: Priority[]; slaStatuses: SlaStatus[];
  technicians: { id: string; name: string; available: boolean }[];
  slaPolicies: { priority: Priority; responseMinutes: number; resolutionMinutes: number }[];
  strategies: { priority: string; assignment: string; assignmentOptions: string[]; priorityOptions: string[] };
  categorizer: string;
  emailChannel: "EMAIL_SIMULATED" | "EMAIL_RESEND";
}

export interface Service { id: string; name: string; criticality: number; userBase: number; active: boolean }
export interface EmailEntry { id: string; to: string; subject: string; body: string; incidentId: string; at: string; status: "SIMULATED" | "QUEUED" | "SENT" | "FAILED"; detail: string }

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

type LiveHandlers = {
  incident: (e: { id: string; type: string }) => void;
  notification: (n: { subject: string; body: string; incidentId: string }) => void;
};

/**
 * Subscribes to the server's event stream; returns an unsubscribe function.
 * The stream is read with fetch rather than EventSource so the token goes in the
 * Authorization header and never appears in a URL, a log or the browser history.
 */
export function subscribe(onIncident: LiveHandlers["incident"], onNotify: LiveHandlers["notification"]) {
  const ctrl = new AbortController();
  const handlers: Record<string, (data: never) => void> = { incident: onIncident, notification: onNotify };

  (async () => {
    while (!ctrl.signal.aborted && token) {
      try {
        const res = await fetch("/api/events", { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
        if (res.status === 401) return; // signed out or session expired: the next API call handles it
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const event = /^event: (.+)$/m.exec(frame)?.[1];
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (event && data && handlers[event]) handlers[event](JSON.parse(data) as never);
          }
        }
      } catch {
        if (ctrl.signal.aborted) return;
      }
      await new Promise((r) => setTimeout(r, 3000)); // dropped connection: try again shortly
    }
  })();
  return () => ctrl.abort();
}

/** Start or end of a calendar day in the viewer's own time zone, as an ISO instant the server can compare. */
export const dayBoundary = (date: string, end = false) => (date ? new Date(`${date}T${end ? "23:59:59.999" : "00:00:00"}`).toISOString() : "");

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
