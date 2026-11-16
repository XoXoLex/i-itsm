import { FormEvent, useState } from "react";
import { api, AuditEntry, fmtTime, Meta, STATUS_LABEL, titleCase, User } from "./api";
import { Field, useAction, useLoad, useToast } from "./ui";

const LEVEL = ["", "Low", "Medium", "High", "Critical"];

export function Settings({ meta, reloadMeta }: { meta: Meta; reloadMeta: () => void }) {
  const { run, busy } = useAction();
  const toast = useToast();
  const [svc, setSvc] = useState({ id: "", name: "", criticality: 2, userBase: 100 });
  const [cat, setCat] = useState({ name: "", keywords: "" });
  const [sla, setSla] = useState(Object.fromEntries(meta.slaPolicies.map((p) => [p.priority, { ...p }])));

  const save = async (fn: () => Promise<unknown>, ok: string) => { if (await run(fn, ok)) reloadMeta(); };

  return (
    <div className="page">
      <h1 className="page-title">Settings</h1>
      <div className="settings-grid">
        <section className="panel">
          <h2 className="h2">How incidents are handled</h2>
          <div className="stack">
            <Field label="Technician assignment" hint="Skill-based picks the best-qualified free technician; load-based spreads work evenly; round-robin takes turns.">
              <select value={meta.strategies.assignment} disabled={busy} onChange={(e) => save(() => api("/admin/strategies", { method: "PUT", body: { assignment: e.target.value } }), `Assignment now ${titleCase(e.target.value)}`)}>
                {meta.strategies.assignmentOptions.map((o) => <option key={o} value={o}>{titleCase(o)}</option>)}
              </select>
            </Field>
            <Field label="Priority calculation" hint="Weighted score multiplies impact, urgency and service criticality; the ITIL matrix looks up impact against urgency.">
              <select value={meta.strategies.priority} disabled={busy} onChange={(e) => save(() => api("/admin/strategies", { method: "PUT", body: { priority: e.target.value } }), `Priority now ${titleCase(e.target.value)}`)}>
                {meta.strategies.priorityOptions.map((o) => <option key={o} value={o}>{titleCase(o)}</option>)}
              </select>
            </Field>
            <p className="muted small">Category classifier: {meta.categorizer === "GEMINI_DECISIONS" ? "Gemini Decisions API (gemini-decision-1), with keyword fallback" : meta.categorizer === "GEMINI" ? "Gemini 4 Hydrogen, with keyword fallback" : "keyword matching (add a Gemini API key to switch to AI)"}.</p>
            <button className="btn" disabled={busy} onClick={() => run(() => api<{ warnings: number; breaches: number }>("/admin/sla-check", { method: "POST" })).then((r) => r && toast(`SLA check done: ${r.warnings} new warning(s), ${r.breaches} new breach(es)`, "info"))}>Run SLA check now</button>
          </div>
        </section>

        <section className="panel">
          <h2 className="h2">SLA targets (minutes)</h2>
          <table className="mini">
            <thead><tr><th>Priority</th><th>Respond within</th><th>Resolve within</th><th /></tr></thead>
            <tbody>
              {meta.priorities.map((p) => (
                <tr key={p}>
                  <td><span className={`dot dot-${p}`}>{p}</span></td>
                  <td><input type="number" min={1} className="num" value={sla[p]?.responseMinutes ?? ""} onChange={(e) => setSla({ ...sla, [p]: { ...sla[p], responseMinutes: Number(e.target.value) } })} aria-label={`${p} response minutes`} /></td>
                  <td><input type="number" min={1} className="num" value={sla[p]?.resolutionMinutes ?? ""} onChange={(e) => setSla({ ...sla, [p]: { ...sla[p], resolutionMinutes: Number(e.target.value) } })} aria-label={`${p} resolution minutes`} /></td>
                  <td><button className="btn btn-small" disabled={busy} onClick={() => save(() => api(`/admin/sla/${p}`, { method: "PUT", body: sla[p] }), `${p} targets saved`)}>Save</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">New targets apply to incidents reported from now on.</p>
        </section>

        <section className="panel">
          <h2 className="h2">IT services</h2>
          <table className="mini">
            <thead><tr><th>Service</th><th>Users</th><th>Criticality</th></tr></thead>
            <tbody>
              {meta.services.map((s) => (
                <tr key={s.id}>
                  <td>{s.name} <span className="muted small">{s.id}</span></td>
                  <td>{s.userBase}</td>
                  <td>
                    <select value={s.criticality} disabled={busy} aria-label={`${s.name} criticality`} onChange={(e) => save(() => api(`/admin/services/${s.id}`, { method: "PATCH", body: { criticality: Number(e.target.value) } }), `${s.name} criticality updated`)}>
                      {[1, 2, 3, 4].map((l) => <option key={l} value={l}>{LEVEL[l]}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form className="inline-form" onSubmit={(e: FormEvent) => { e.preventDefault(); save(() => api("/admin/services", { body: svc }), `${svc.name} added`).then(() => setSvc({ id: "", name: "", criticality: 2, userBase: 100 })); }}>
            <input placeholder="ID, e.g. SVC-HR" value={svc.id} onChange={(e) => setSvc({ ...svc, id: e.target.value })} required aria-label="Service ID" />
            <input placeholder="Name" value={svc.name} onChange={(e) => setSvc({ ...svc, name: e.target.value })} required aria-label="Service name" />
            <select value={svc.criticality} onChange={(e) => setSvc({ ...svc, criticality: Number(e.target.value) })} aria-label="Criticality">
              {[1, 2, 3, 4].map((l) => <option key={l} value={l}>{LEVEL[l]}</option>)}
            </select>
            <input type="number" min={1} value={svc.userBase} onChange={(e) => setSvc({ ...svc, userBase: Number(e.target.value) })} aria-label="User base" className="num" />
            <button className="btn btn-small" disabled={busy}>Add service</button>
          </form>
        </section>

        <section className="panel">
          <h2 className="h2">Incident categories</h2>
          <ul className="cats">
            {meta.categories.map((c) => <li key={c.name}><strong>{titleCase(c.name)}</strong> <span className="muted small">{c.keywords.slice(0, 6).join(", ")}</span></li>)}
          </ul>
          <form className="inline-form" onSubmit={(e: FormEvent) => { e.preventDefault(); save(() => api("/admin/categories", { body: cat }), `${cat.name} added`).then(() => setCat({ name: "", keywords: "" })); }}>
            <input placeholder="New category" value={cat.name} onChange={(e) => setCat({ ...cat, name: e.target.value })} required aria-label="Category name" />
            <input placeholder="Keywords, comma separated" value={cat.keywords} onChange={(e) => setCat({ ...cat, keywords: e.target.value })} aria-label="Keywords" className="grow" />
            <button className="btn btn-small" disabled={busy}>Add category</button>
          </form>
          <p className="muted small">The automatic classifier starts using a new category straight away.</p>
        </section>
      </div>
    </div>
  );
}

export function People({ refreshKey, reloadMeta }: { refreshKey: number; reloadMeta: () => void }) {
  const { data, reload } = useLoad(() => api<User[]>("/admin/users"), [refreshKey]);
  const { run, busy } = useAction();
  const [f, setF] = useState({ role: "TECHNICIAN", name: "", email: "", password: "", skills: "", experienceYears: 1, maxActive: 5 });

  async function add(e: FormEvent) {
    e.preventDefault();
    if (await run(() => api("/admin/users", { body: f }), `${f.name} added`)) {
      setF({ ...f, name: "", email: "", password: "", skills: "" });
      reload(); reloadMeta();
    }
  }

  return (
    <div className="page">
      <h1 className="page-title">People</h1>
      <div className="settings-grid">
        <section className="panel span-2">
          <table className="mini people">
            <thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Skills</th><th>Workload</th><th>Available</th></tr></thead>
            <tbody>
              {data?.map((u) => (
                <tr key={u.id}>
                  <td>{u.name} <span className="muted small">{u.id}</span></td>
                  <td>{titleCase(u.role)}</td>
                  <td>{u.email}</td>
                  <td className="small">{u.skills?.map(titleCase).join(", ") ?? (u.department || "—")}</td>
                  <td>{u.role === "TECHNICIAN" ? `${u.workload}/${u.maxActive}` : "—"}</td>
                  <td>
                    {u.role === "TECHNICIAN" && (
                      <label className="switch">
                        <input type="checkbox" checked={!!u.available} disabled={busy}
                          onChange={(e) => run(() => api(`/admin/technicians/${u.id}`, { method: "PATCH", body: { available: e.target.checked } }), `${u.name} marked ${e.target.checked ? "available" : "away"}`).then(reload)} />
                        <span>{u.available ? "Available" : "Away"}</span>
                      </label>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="panel">
          <h2 className="h2">Add staff account</h2>
          <form className="stack" onSubmit={add}>
            <Field label="Role">
              <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                <option value="TECHNICIAN">Technician</option><option value="ADMIN">Administrator</option>
              </select>
            </Field>
            <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
            <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
            <Field label="Temporary password" hint="At least 8 characters"><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={8} /></Field>
            {f.role === "TECHNICIAN" && (
              <>
                <Field label="Skills" hint="Category names, comma separated, e.g. network, security"><input value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} /></Field>
                <div className="grid-2">
                  <Field label="Years of experience"><input type="number" min={0} value={f.experienceYears} onChange={(e) => setF({ ...f, experienceYears: Number(e.target.value) })} /></Field>
                  <Field label="Max active incidents"><input type="number" min={1} value={f.maxActive} onChange={(e) => setF({ ...f, maxActive: Number(e.target.value) })} /></Field>
                </div>
              </>
            )}
            <button className="btn btn-primary" disabled={busy}>Add {f.role === "ADMIN" ? "administrator" : "technician"}</button>
          </form>
        </section>
      </div>
    </div>
  );
}

export function AuditLog({ refreshKey }: { refreshKey: number }) {
  const [id, setId] = useState("");
  const { data } = useLoad(() => api<AuditEntry[]>(`/reports/audit${id ? `?incidentId=${encodeURIComponent(id.toUpperCase())}` : ""}`), [id, refreshKey]);
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Audit log</h1>
        <input placeholder="Filter by incident ID" value={id} onChange={(e) => setId(e.target.value)} aria-label="Filter by incident ID" />
      </div>
      <div className="table-wrap panel flush">
        <table className="audit">
          <thead><tr><th>Time</th><th>Incident</th><th>Who</th><th>Action</th><th>What happened</th><th>State change</th></tr></thead>
          <tbody>
            {data?.map((a) => (
              <tr key={a.id}>
                <td className="nowrap">{fmtTime(a.at)}</td>
                <td><a href={`#/incidents/${a.incidentId}`}>{a.incidentId}</a></td>
                <td>{a.actor}</td>
                <td className="small">{titleCase(a.action)}</td>
                <td>{a.description}</td>
                <td className="nowrap muted">{a.previousState !== a.newState && a.newState ? `${STATUS_LABEL[a.previousState ?? ""] ?? "—"} → ${STATUS_LABEL[a.newState]}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
