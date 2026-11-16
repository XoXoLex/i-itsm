import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { ApiError, fmtDuration, Incident, Priority, PRIORITY_LABEL, STATUS_LABEL } from "./api";

// ---------------------------------------------------------------- routing (hash based)
export function useRoute(): [string, (to: string) => void] {
  const [route, setRoute] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const on = () => setRoute(location.hash.slice(1) || "/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, (to: string) => { location.hash = to; }];
}

// ---------------------------------------------------------------- live clock (drives SLA bars)
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// ---------------------------------------------------------------- data loading
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load().then((d) => { if (live) { setData(d); setError(null); } }).catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []) };
}

// ---------------------------------------------------------------- toasts
type Toast = { id: number; text: string; tone: "ok" | "error" | "info" };
const ToastCtx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 7000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.tone}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/** Wraps an async action: shows the server's error message in a toast instead of failing silently. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (okText) toast(okText);
      return r;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : (e as Error).message, "error");
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { run, busy };
}

// ---------------------------------------------------------------- small pieces
export function PriorityTag({ p, full }: { p: Priority | null; full?: boolean }) {
  if (!p) return <span className="ptag ptag-none">—</span>;
  return <span className={`ptag ptag-${p}`}>{p}{full && <span className="ptag-label">{PRIORITY_LABEL[p]}</span>}</span>;
}

export function StatusText({ s }: { s: string }) {
  return <span className={`status status-${s}`}>{STATUS_LABEL[s] ?? s}</span>;
}

/**
 * The SLA fuse: remaining resolution time drawn as a bar that burns down.
 * Teal while on track, amber once 80% is spent, red once breached.
 */
export function SlaFuse({ inc, now, compact }: { inc: Incident; now: number; compact?: boolean }) {
  const { resolveBy } = inc.sla;
  if (!resolveBy) return <span className="muted">No SLA</span>;
  const start = new Date(inc.createdAt).getTime();
  const end = new Date(resolveBy).getTime();
  const stop = inc.resolvedAt ? new Date(inc.resolvedAt).getTime() : now;
  const used = Math.min(1, Math.max(0, (stop - start) / (end - start)));
  const breached = inc.sla.resolutionBreached || inc.sla.responseBreached || stop > end;
  const tone = !inc.isOpen ? (breached ? "breached" : "met") : breached ? "breached" : inc.sla.status === "AT_RISK" || used >= 0.8 ? "risk" : "ok";
  const label = !inc.isOpen
    ? breached ? "Missed SLA" : `Met · ${fmtDuration(end - stop)} spare`
    : stop > end ? `Overdue by ${fmtDuration(stop - end)}` : `${fmtDuration(end - stop)} left`;
  return (
    <div className={`fuse fuse-${tone} ${compact ? "fuse-compact" : ""}`} title={`Resolve by ${new Date(resolveBy).toLocaleString()}`}>
      <div className="fuse-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((1 - used) * 100)} aria-label="SLA time remaining">
        <div className="fuse-fill" style={{ width: `${(1 - used) * 100}%` }} />
      </div>
      <span className="fuse-label">{label}</span>
    </div>
  );
}

const STAGES = ["NEW", "CLASSIFIED", "ASSIGNED", "ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED", "VERIFIED", "CLOSED"];

/** The lifecycle really is a sequence, so it is drawn as numbered steps. */
export function Lifecycle({ status }: { status: string }) {
  const current = status === "PENDING_INFO" ? STAGES.indexOf("IN_PROGRESS") : STAGES.indexOf(status);
  return (
    <ol className="lifecycle" aria-label="Incident lifecycle">
      {STAGES.map((s, i) => (
        <li key={s} className={i < current ? "done" : i === current ? "current" : ""} aria-current={i === current ? "step" : undefined}>
          <span className="step-n">{i + 1}</span>
          <span className="step-t">{i === current && status === "PENDING_INFO" ? "Waiting on reporter" : STATUS_LABEL[s]}</span>
        </li>
      ))}
    </ol>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><p className="empty-title">{title}</p>{children}</div>;
}
