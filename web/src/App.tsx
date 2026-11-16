import { useEffect, useRef, useState } from "react";
import { api, fmtTime, getToken, InboxItem, Meta, setToken, subscribe, User } from "./api";
import { Dashboard } from "./Dashboard";
import { IncidentList } from "./IncidentList";
import { IncidentView } from "./IncidentView";
import { Login } from "./Login";
import { ReportForm } from "./ReportForm";
import { AuditLog, People, Settings } from "./Admin";
import { ToastHost, useLoad, useRoute, useToast } from "./ui";

type NavItem = { to: string; label: string };

const ROLE_LABEL: Record<User["role"], string> = { EMPLOYEE: "Employee", TECHNICIAN: "Technician", ADMIN: "IT manager" };

const NAV: Record<User["role"], NavItem[]> = {
  EMPLOYEE: [
    { to: "/", label: "My incidents" },
    { to: "/report", label: "Report a problem" },
  ],
  TECHNICIAN: [
    { to: "/", label: "My queue" },
    { to: "/report", label: "Report a problem" },
  ],
  ADMIN: [
    { to: "/", label: "Operations" },
    { to: "/all", label: "All incidents" },
    { to: "/report", label: "Report a problem" },
    { to: "/people", label: "People" },
    { to: "/settings", label: "Settings" },
    { to: "/audit", label: "Audit log" },
  ],
};

export function App() {
  return <ToastHost><Root /></ToastHost>;
}

function Root() {
  const [me, setMe] = useState<User | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (!getToken()) { setChecked(true); return; }
    api<User>("/me").then(setMe).catch(() => setToken(null)).finally(() => setChecked(true));
  }, []);
  if (!checked) return null;
  if (!me) return <Login onLogin={(u) => { location.hash = "/"; setMe(u); }} />;
  return <Shell me={me} onLogout={() => { setToken(null); setMe(null); location.hash = "/"; }} />;
}

function Shell({ me, onLogout }: { me: User; onLogout: () => void }) {
  const [route, go] = useRoute();
  const [refreshKey, setRefreshKey] = useState(0);
  const [metaTick, setMetaTick] = useState(0);
  const toast = useToast();
  const { data: meta } = useLoad(() => api<Meta>("/meta"), [metaTick]);

  // Live updates: any incident change refreshes the open screen; personal notifications pop a toast.
  useEffect(() => subscribe(
    () => setRefreshKey((k) => k + 1),
    (n) => toast(`${n.subject.replace(/^\[(\w+)\]\s*/, "$1: ")}`, "info"),
  ), [toast]);

  const path = route.split("?")[0];
  const incidentMatch = path.match(/^\/incidents\/([\w-]+)$/);
  const nav = NAV[me.role];

  let page = null;
  if (!meta) page = <div className="page"><p className="muted">Loading…</p></div>;
  else if (incidentMatch) page = <IncidentView id={incidentMatch[1]} me={me} meta={meta} refreshKey={refreshKey} />;
  else if (path === "/report") page = <ReportForm meta={meta} go={go} />;
  else if (me.role === "ADMIN" && path === "/all") page = <IncidentList me={me} meta={meta} refreshKey={refreshKey} title="All incidents" />;
  else if (me.role === "ADMIN" && path === "/settings") page = <Settings meta={meta} reloadMeta={() => setMetaTick((t) => t + 1)} />;
  else if (me.role === "ADMIN" && path === "/people") page = <People refreshKey={refreshKey} reloadMeta={() => setMetaTick((t) => t + 1)} />;
  else if (me.role === "ADMIN" && path === "/audit") page = <AuditLog refreshKey={refreshKey} />;
  else if (me.role === "ADMIN") page = <Dashboard refreshKey={refreshKey} />;
  else page = <IncidentList me={me} meta={meta} refreshKey={refreshKey} title={me.role === "TECHNICIAN" ? "My queue" : "My incidents"} />;

  return (
    <div className={`shell role-${me.role.toLowerCase()}`}>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <nav className="rail" aria-label="Main">
        <div className="rail-brand">
          <span className="rail-name">Service Desk</span>
          <span className="rail-role">{ROLE_LABEL[me.role]}</span>
        </div>
        <ul className="rail-nav">
          {nav.map((n) => (
            <li key={n.to}><a href={`#${n.to}`} aria-current={path === n.to || (n.to === "/" && !!incidentMatch) ? "page" : undefined}>{n.label}</a></li>
          ))}
        </ul>
        <div className="rail-foot">
          <Inbox me={me} refreshKey={refreshKey} />
          <p className="rail-user">{me.name}<span>{me.email}</span></p>
          <button className="btn btn-rail" onClick={onLogout}>Sign out</button>
        </div>
      </nav>
      <main id="main" tabIndex={-1} className="main">{page}</main>
    </div>
  );
}

function Inbox({ me, refreshKey }: { me: User; refreshKey: number }) {
  const [open, setOpen] = useState(false);
  const { data, reload } = useLoad(() => api<InboxItem[]>("/notifications"), [refreshKey, me.id]);
  const unread = data?.filter((n) => !n.read).length ?? 0;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && unread) { await api("/notifications/read", { method: "POST" }); reload(); }
  };

  return (
    <div className="inbox" ref={ref}>
      <button className="btn btn-rail inbox-btn" onClick={toggle} aria-expanded={open} aria-haspopup="true">
        Notifications {unread > 0 && <span className="badge" aria-label={`${unread} unread`}>{unread}</span>}
      </button>
      {open && (
        <div className="inbox-panel" role="dialog" aria-label="Notifications">
          {!data?.length ? <p className="muted">Nothing yet. You'll hear about your incidents here.</p> : (
            <ul>
              {data.map((n) => (
                <li key={n.id} className={n.read ? "" : "unread"}>
                  <a href={`#/incidents/${n.incidentId}`} onClick={() => setOpen(false)}>
                    <span className="inbox-subj">{n.subject.replace(/^\[(\w+)\]\s*/, "$1 · ")}</span>
                    <span className="inbox-body">{n.body}</span>
                    <span className="inbox-at">{fmtTime(n.at)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
