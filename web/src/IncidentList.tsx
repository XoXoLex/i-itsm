import { useMemo, useState } from "react";
import { api, dayBoundary, ESCALATION_LABEL, fmtTime, Incident, Meta, STATUS_LABEL, titleCase, User } from "./api";
import { Empty, PriorityTag, SlaFuse, StatusText, useLoad, useNow } from "./ui";

type Filters = {
  text: string; id: string; status: string; priority: string; category: string; serviceId: string;
  technicianId: string; from: string; to: string; slaStatus: string; openOnly: boolean;
};
const BLANK: Filters = { text: "", id: "", status: "", priority: "", category: "", serviceId: "", technicianId: "", from: "", to: "", slaStatus: "", openOnly: false };

export type { Filters };

export function IncidentList({ me, meta, refreshKey, title, preset, initial }: { me: User; meta: Meta; refreshKey: number; title: string; preset?: Partial<Filters>; initial?: Partial<Filters> }) {
  const [f, setF] = useState<Filters>({ ...BLANK, ...preset, ...initial });
  const now = useNow();
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    // Dates are sent as the start and end of the day on the viewer's clock, so "today" means the viewer's today.
    Object.entries(f).forEach(([k, v]) => { if (v) p.set(k, k === "from" ? dayBoundary(f.from) : k === "to" ? dayBoundary(f.to, true) : String(v)); });
    return p.toString();
  }, [f]);
  const { data, error } = useLoad(() => api<Incident[]>(`/incidents?${qs}`), [qs, refreshKey]);
  const isEmployee = me.role === "EMPLOYEE";

  // Technicians see their queue ordered by how close each incident is to its deadline.
  const rows = useMemo(() => {
    if (!data) return [];
    if (me.role !== "TECHNICIAN") return data;
    return [...data].sort((a, b) => Number(b.isOpen) - Number(a.isOpen) || remaining(a) - remaining(b));
  }, [data, me.role]);

  const active = Object.entries(f).filter(([k, v]) => v && !(preset && k in preset)).length;
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{title}</h1>
        {me.role === "TECHNICIAN" && <Workload me={me} rows={data ?? []} />}
      </div>

      <div className="filters" role="search">
        <input className="f-text" placeholder="Search titles and descriptions" value={f.text} onChange={set("text")} aria-label="Search text" />
        {!isEmployee && <input className="f-id" placeholder="Incident ID" value={f.id} onChange={set("id")} aria-label="Incident ID" />}
        <select value={f.status} onChange={set("status")} aria-label="Status">
          <option value="">Any status</option>
          {meta.statuses.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <select value={f.priority} onChange={set("priority")} aria-label="Priority">
          <option value="">Any priority</option>
          {meta.priorities.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {!isEmployee && (
          <>
            <select value={f.category} onChange={set("category")} aria-label="Category">
              <option value="">Any category</option>
              {meta.categories.map((c) => <option key={c.name} value={c.name}>{titleCase(c.name)}</option>)}
            </select>
            <select value={f.serviceId} onChange={set("serviceId")} aria-label="Service">
              <option value="">Any service</option>
              {meta.services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {me.role === "ADMIN" && (
              <select value={f.technicianId} onChange={set("technicianId")} aria-label="Technician">
                <option value="">Any technician</option>
                {meta.technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
            <select value={f.slaStatus} onChange={set("slaStatus")} aria-label="SLA status">
              <option value="">Any SLA state</option>
              {meta.slaStatuses.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </select>
            <label className="f-date">From <input type="date" value={f.from} onChange={set("from")} /></label>
            <label className="f-date">To <input type="date" value={f.to} onChange={set("to")} /></label>
          </>
        )}
        <label className="f-check"><input type="checkbox" checked={f.openOnly} onChange={(e) => setF({ ...f, openOnly: e.target.checked })} /> Open only</label>
        {active > 0 && <button className="btn btn-ghost" onClick={() => setF({ ...BLANK, ...preset })}>Clear {active} filter{active > 1 ? "s" : ""}</button>}
      </div>

      {error && <div className="callout callout-error">{error}</div>}
      {data && rows.length === 0 && (
        <Empty title={active ? "Nothing matches these filters." : isEmployee ? "You haven't reported anything yet." : "No incidents here."}>
          {isEmployee && !active && <a className="btn btn-primary" href="#/report">Report a problem</a>}
        </Empty>
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="incidents">
            <thead>
              <tr>
                <th scope="col">Priority</th><th scope="col">Incident</th><th scope="col">Status</th>
                {!isEmployee && <th scope="col">Owner</th>}<th scope="col" className="col-sla">Time to fix</th><th scope="col">Reported</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className={i.isOpen ? "" : "is-done"} onClick={() => { location.hash = `/incidents/${i.id}`; }}>
                  <td><PriorityTag p={i.priority} /></td>
                  <td className="cell-title">
                    <a href={`#/incidents/${i.id}`} onClick={(e) => e.stopPropagation()}><span className="inc-id">{i.id}</span> {i.title}</a>
                    <span className="sub">{i.service.name}{i.category ? `, ${titleCase(i.category)}` : ""}{i.related.length > 0 && <span className="linked"> · linked to {i.related.length}</span>}{i.escalatedTo && <span className="escalated"> · escalated to the {ESCALATION_LABEL[i.escalatedTo] ?? i.escalatedTo}</span>}</span>
                  </td>
                  <td><StatusText s={i.status} /></td>
                  {!isEmployee && <td>{i.assignee?.name ?? <span className={i.isOpen ? "escalated" : "muted"}>Unassigned</span>}</td>}
                  <td className="col-sla"><SlaFuse inc={i} now={now} compact /></td>
                  <td className="nowrap muted">{fmtTime(i.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function remaining(i: Incident): number {
  return i.sla.resolveBy ? new Date(i.sla.resolveBy).getTime() - Date.now() : Number.MAX_SAFE_INTEGER;
}

function Workload({ me, rows }: { me: User; rows: Incident[] }) {
  const active = rows.filter((r) => r.isOpen && r.assignee?.id === me.id && !["RESOLVED", "VERIFIED", "CLOSED"].includes(r.status)).length;
  const max = me.maxActive ?? 5;
  return (
    <div className="workload" aria-label={`Workload ${active} of ${max}`}>
      <span className="workload-n">{active}<span className="muted"> / {max}</span></span>
      <span className="workload-l">active incidents</span>
      <span className="workload-cells" aria-hidden="true">
        {Array.from({ length: max }, (_, k) => <span key={k} className={k < active ? "on" : ""} />)}
      </span>
    </div>
  );
}
