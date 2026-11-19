import { FormEvent, useState } from "react";
import { api, AuditEntry, EmailEntry, fmtTime, Meta, Service, STATUS_LABEL, titleCase, User } from "./api";
import { Empty, Field, useAction, useLoad, useToast } from "./ui";

const LEVEL = ["", "Low", "Medium", "High", "Critical"];
type Moved = { moved: number; kept: number };
const movedText = (r: Moved) =>
  r.moved + r.kept === 0 ? "" : ` ${r.moved} open incident${r.moved === 1 ? "" : "s"} handed to colleagues${r.kept ? `, ${r.kept} kept because nobody else was free` : ""}.`;

// ============================================================================ settings
export function Settings({ meta, reloadMeta }: { meta: Meta; reloadMeta: () => void }) {
  const { run, busy } = useAction();
  const toast = useToast();
  const [svc, setSvc] = useState({ id: "", name: "", criticality: 2, userBase: 100 });
  const [cat, setCat] = useState({ name: "", keywords: "" });
  const [sla, setSla] = useState(Object.fromEntries(meta.slaPolicies.map((p) => [p.priority, { ...p }])));

  const save = async (fn: () => Promise<unknown>, ok?: string) => { const r = await run(fn, ok); if (r) reloadMeta(); return r; };

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
            <p className="muted small">
              Category classifier: {meta.categorizer.startsWith("GEMINI") ? "Google Gemini, with keyword matching as the fallback" : "keyword matching (set GEMINI_API_KEY to use Google Gemini)"}.
              {" "}Email: {meta.emailChannel === "EMAIL_RESEND" ? "sent through Resend" : "simulated, see the Email log (set RESEND_API_KEY to send for real)"}.
            </p>
            <button className="btn" disabled={busy} onClick={() => run(() => api<{ warnings: number; breaches: number; escalations: number }>("/admin/sla-check", { method: "POST" })).then((r) => r && toast(`SLA check done: ${r.warnings} new warning(s), ${r.breaches} new violation(s), ${r.escalations} escalation(s)`, "info"))}>Run SLA check now</button>
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
                  <td><input type="number" min={1} step={1} className="num" value={sla[p]?.responseMinutes ?? ""} onChange={(e) => setSla({ ...sla, [p]: { ...sla[p], responseMinutes: Number(e.target.value) } })} aria-label={`${p} response minutes`} /></td>
                  <td><input type="number" min={1} step={1} className="num" value={sla[p]?.resolutionMinutes ?? ""} onChange={(e) => setSla({ ...sla, [p]: { ...sla[p], resolutionMinutes: Number(e.target.value) } })} aria-label={`${p} resolution minutes`} /></td>
                  <td><button className="btn btn-small" disabled={busy} onClick={() => save(() => api(`/admin/sla/${p}`, { method: "PUT", body: sla[p] }), `${p} targets saved`)}>Save</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">New targets apply to incidents reported, or re-prioritised, from now on.</p>
        </section>

        <section className="panel">
          <h2 className="h2">IT services</h2>
          <table className="mini">
            <thead><tr><th>Service</th><th>Users</th><th>Criticality</th><th /></tr></thead>
            <tbody>
              {meta.services.map((s) => <ServiceRow key={s.id} s={s} busy={busy} save={save} />)}
            </tbody>
          </table>
          <p className="muted small">Changing criticality re-prioritises that service's open incidents. A retired service stays on old incidents but cannot be chosen for new ones.</p>
          <form className="inline-form" onSubmit={(e: FormEvent) => { e.preventDefault(); save(() => api("/admin/services", { body: svc }), `${svc.name} added`).then((r) => r && setSvc({ id: "", name: "", criticality: 2, userBase: 100 })); }}>
            <input placeholder="ID, e.g. SVC-HR" value={svc.id} onChange={(e) => setSvc({ ...svc, id: e.target.value })} required aria-label="Service ID" />
            <input placeholder="Name" value={svc.name} onChange={(e) => setSvc({ ...svc, name: e.target.value })} required aria-label="Service name" />
            <select value={svc.criticality} onChange={(e) => setSvc({ ...svc, criticality: Number(e.target.value) })} aria-label="Criticality">
              {[1, 2, 3, 4].map((l) => <option key={l} value={l}>{LEVEL[l]}</option>)}
            </select>
            <input type="number" min={1} step={1} value={svc.userBase} onChange={(e) => setSvc({ ...svc, userBase: Number(e.target.value) })} aria-label="User base" className="num" />
            <button className="btn btn-small" disabled={busy}>Add service</button>
          </form>
        </section>

        <section className="panel">
          <h2 className="h2">Incident categories</h2>
          <ul className="cats">
            {meta.categories.map((c) => <CategoryRow key={c.name} c={c} busy={busy} save={save} only={meta.categories.length === 1} />)}
          </ul>
          <form className="inline-form" onSubmit={(e: FormEvent) => { e.preventDefault(); save(() => api("/admin/categories", { body: cat }), `${cat.name} added`).then((r) => r && setCat({ name: "", keywords: "" })); }}>
            <input placeholder="New category" value={cat.name} onChange={(e) => setCat({ ...cat, name: e.target.value })} required aria-label="Category name" />
            <input placeholder="Keywords, comma separated" value={cat.keywords} onChange={(e) => setCat({ ...cat, keywords: e.target.value })} aria-label="Keywords" className="grow" />
            <button className="btn btn-small" disabled={busy}>Add category</button>
          </form>
          <p className="muted small">The classifier uses new categories and keywords straight away. Removing a category leaves it on incidents already filed under it.</p>
        </section>
      </div>
    </div>
  );
}

type Save = (fn: () => Promise<unknown>, ok?: string) => Promise<unknown>;

function ServiceRow({ s, busy, save }: { s: Service; busy: boolean; save: Save }) {
  const toast = useToast();
  const [edit, setEdit] = useState<{ name: string; userBase: number } | null>(null);
  const patch = (body: unknown, ok?: string) => save(() => api<Service & { reprioritised: number }>(`/admin/services/${s.id}`, { method: "PATCH", body }), ok);

  if (edit) {
    return (
      <tr>
        <td><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} aria-label={`${s.id} name`} /></td>
        <td><input type="number" min={1} step={1} className="num" value={edit.userBase} onChange={(e) => setEdit({ ...edit, userBase: Number(e.target.value) })} aria-label={`${s.id} users`} /></td>
        <td colSpan={2}>
          <div className="row gap">
            <button className="btn btn-small btn-primary" disabled={busy} onClick={() => patch(edit, `${edit.name} saved`).then((r) => r && setEdit(null))}>Save</button>
            <button className="btn btn-small" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </td>
      </tr>
    );
  }
  return (
    <tr className={s.active ? "" : "is-off"}>
      <td>{s.name} <span className="muted small">{s.id}{s.active ? "" : " · retired"}</span></td>
      <td>{s.userBase}</td>
      <td>
        <select value={s.criticality} disabled={busy || !s.active} aria-label={`${s.name} criticality`}
          onChange={(e) => patch({ criticality: Number(e.target.value) }).then((r) => r && toast(`${s.name} criticality updated. ${(r as { reprioritised: number }).reprioritised} open incident(s) re-prioritised.`))}>
          {[1, 2, 3, 4].map((l) => <option key={l} value={l}>{LEVEL[l]}</option>)}
        </select>
      </td>
      <td>
        <div className="row gap">
          <button className="btn btn-small" disabled={busy} onClick={() => setEdit({ name: s.name, userBase: s.userBase })}>Edit</button>
          <button className="btn btn-small" disabled={busy} onClick={() => patch({ active: !s.active }, `${s.name} ${s.active ? "retired" : "restored"}`)}>{s.active ? "Retire" : "Restore"}</button>
        </div>
      </td>
    </tr>
  );
}

function CategoryRow({ c, busy, save, only }: { c: Meta["categories"][number]; busy: boolean; save: Save; only: boolean }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  if (edit !== null) {
    return (
      <li className="cat-edit">
        <strong>{titleCase(c.name)}</strong>
        <input value={edit} onChange={(e) => setEdit(e.target.value)} aria-label={`${c.name} keywords`} placeholder="Keywords, comma separated" />
        <button className="btn btn-small btn-primary" disabled={busy} onClick={() => save(() => api(`/admin/categories/${c.name}`, { method: "PUT", body: { keywords: edit } }), `${titleCase(c.name)} keywords saved`).then((r) => r && setEdit(null))}>Save</button>
        <button className="btn btn-small" onClick={() => setEdit(null)}>Cancel</button>
      </li>
    );
  }
  return (
    <li className="cat-row">
      <span><strong>{titleCase(c.name)}</strong> <span className="muted small">{c.keywords.slice(0, 8).join(", ")}{c.keywords.length > 8 ? ` +${c.keywords.length - 8}` : ""}</span></span>
      <span className="row gap">
        <button className="btn btn-small" disabled={busy} onClick={() => setEdit(c.keywords.join(", "))}>Edit keywords</button>
        {confirm
          ? <button className="btn btn-small btn-danger" disabled={busy} onClick={() => save(() => api(`/admin/categories/${c.name}`, { method: "DELETE" }), `${titleCase(c.name)} removed`)} onBlur={() => setConfirm(false)}>Confirm remove</button>
          : <button className="btn btn-small" disabled={busy || only} onClick={() => setConfirm(true)}>Remove</button>}
      </span>
    </li>
  );
}

// ============================================================================ people
export function People({ me, meta, refreshKey, reloadMeta }: { me: User; meta: Meta; refreshKey: number; reloadMeta: () => void }) {
  const { data, reload } = useLoad(() => api<User[]>("/admin/users"), [refreshKey]);
  const { run, busy } = useAction();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [f, setF] = useState({ role: "TECHNICIAN", name: "", email: "", password: "", skills: [] as string[], experienceYears: 1, maxActive: 5 });
  const refresh = () => { reload(); reloadMeta(); };

  async function add(e: FormEvent) {
    e.preventDefault();
    if (await run(() => api("/admin/users", { body: f }), `${f.name} added`)) {
      setF({ ...f, name: "", email: "", password: "", skills: [] });
      refresh();
    }
  }
  const setAvailable = async (u: User, available: boolean) => {
    const r = await run(() => api<Moved>(`/admin/technicians/${u.id}`, { method: "PATCH", body: { available } }));
    if (r) { toast(`${u.name} marked ${available ? "available" : "away"}.${movedText(r)}`); refresh(); }
  };
  const setActive = async (u: User, active: boolean) => {
    const r = await run(() => api<Moved>(`/admin/users/${u.id}/active`, { method: "PATCH", body: { active } }));
    if (r) { toast(`${u.name} ${active ? "restored" : "deactivated"}.${movedText(r)}`); refresh(); }
  };

  return (
    <div className="page">
      <h1 className="page-title">People</h1>
      <div className="settings-grid">
        <section className="panel span-2 flush">
          <div className="table-wrap bare">
            <table className="mini people">
              <thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Skills / department</th><th>Workload</th><th>Status</th><th /></tr></thead>
              <tbody>
                {data?.map((u) => editing === u.id
                  ? <EditUser key={u.id} u={u} meta={meta} done={(saved) => { setEditing(null); if (saved) refresh(); }} />
                  : (
                    <tr key={u.id} className={u.active ? "" : "is-off"}>
                      <td>{u.name} <span className="muted small">{u.id}</span></td>
                      <td>{titleCase(u.role)}</td>
                      <td>{u.email}</td>
                      <td className="small">{u.skills?.map(titleCase).join(", ") || u.department || "—"}{u.role === "TECHNICIAN" && <span className="muted"> · {u.experienceYears} yr</span>}</td>
                      <td>{u.role === "TECHNICIAN" ? `${u.workload}/${u.maxActive}` : "—"}</td>
                      <td>
                        {!u.active ? <span className="muted">Deactivated</span> : u.role === "TECHNICIAN" ? (
                          <label className="switch">
                            <input type="checkbox" checked={!!u.available} disabled={busy} onChange={(e) => setAvailable(u, e.target.checked)} />
                            <span>{u.available ? "Available" : "Away"}</span>
                          </label>
                        ) : "Active"}
                      </td>
                      <td>
                        <div className="row gap">
                          <button className="btn btn-small" disabled={busy} onClick={() => setEditing(u.id)}>Edit</button>
                          {u.id !== me.id && <button className="btn btn-small" disabled={busy} onClick={() => setActive(u, !u.active)}>{u.active ? "Deactivate" : "Restore"}</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <h2 className="h2">Add staff account</h2>
          <form className="stack" onSubmit={add}>
            <Field label="Role">
              <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                <option value="TECHNICIAN">Technician</option><option value="ADMIN">Administrator</option>
              </select>
            </Field>
            <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} /></Field>
            <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
            <Field label="Temporary password" hint="At least 8 characters"><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={8} autoComplete="new-password" /></Field>
            {f.role === "TECHNICIAN" && (
              <>
                <SkillPicker meta={meta} value={f.skills} onChange={(skills) => setF({ ...f, skills })} />
                <div className="grid-2">
                  <Field label="Years of experience"><input type="number" min={0} max={60} value={f.experienceYears} onChange={(e) => setF({ ...f, experienceYears: Number(e.target.value) })} /></Field>
                  <Field label="Max active incidents"><input type="number" min={1} max={50} step={1} value={f.maxActive} onChange={(e) => setF({ ...f, maxActive: Number(e.target.value) })} /></Field>
                </div>
              </>
            )}
            <button className="btn btn-primary" disabled={busy}>Add {f.role === "ADMIN" ? "administrator" : "technician"}</button>
          </form>
        </section>

        <section className="panel">
          <h2 className="h2">What these controls do</h2>
          <ul className="notes">
            <li><strong>Away</strong> stops new assignments and hands the technician's open incidents to colleagues.</li>
            <li><strong>Deactivate</strong> ends the account's access at once. Its incidents and audit history stay. It can be restored.</li>
            <li><strong>Edit</strong> also lets you set a new temporary password for someone who is locked out.</li>
            <li>Employees create their own accounts from the sign-in page.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

/** Skills are category names, so they are picked from the categories instead of typed. */
function SkillPicker({ meta, value, onChange }: { meta: Meta; value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (name: string) => onChange(value.includes(name) ? value.filter((v) => v !== name) : [...value, name]);
  return (
    <fieldset className="chips">
      <legend>Skills</legend>
      {meta.categories.map((c) => (
        <label key={c.name} className={value.includes(c.name) ? "on" : ""}>
          <input type="checkbox" checked={value.includes(c.name)} onChange={() => toggle(c.name)} />{titleCase(c.name)}
        </label>
      ))}
    </fieldset>
  );
}

function EditUser({ u, meta, done }: { u: User; meta: Meta; done: (saved: boolean) => void }) {
  const { run, busy } = useAction();
  const known = meta.categories.map((c) => c.name);
  const [f, setF] = useState({ name: u.name, email: u.email, department: u.department ?? "", skills: (u.skills ?? []).filter((s) => known.includes(s)), experienceYears: u.experienceYears ?? 0, maxActive: u.maxActive ?? 5 });
  const [password, setPassword] = useState("");

  async function save(e: FormEvent) {
    e.preventDefault();
    const body = u.role === "TECHNICIAN" ? { name: f.name, email: f.email, skills: f.skills, experienceYears: f.experienceYears, maxActive: f.maxActive }
      : u.role === "EMPLOYEE" ? { name: f.name, email: f.email, department: f.department } : { name: f.name, email: f.email };
    if (!(await run(() => api(`/admin/users/${u.id}`, { method: "PATCH", body })))) return;
    if (password && !(await run(() => api(`/admin/users/${u.id}/password`, { body: { password } }), `${f.name} saved, password reset`))) return;
    done(true);
  }

  return (
    <tr className="edit-row">
      <td colSpan={7}>
        <form className="edit-user" onSubmit={save}>
          <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} /></Field>
          <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
          {u.role === "EMPLOYEE" && <Field label="Department"><input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} maxLength={80} /></Field>}
          {u.role === "TECHNICIAN" && (
            <>
              <Field label="Years of experience"><input type="number" min={0} max={60} value={f.experienceYears} onChange={(e) => setF({ ...f, experienceYears: Number(e.target.value) })} /></Field>
              <Field label="Max active incidents" hint={`Has ${u.workload} now`}><input type="number" min={Math.max(1, u.workload ?? 1)} max={50} step={1} value={f.maxActive} onChange={(e) => setF({ ...f, maxActive: Number(e.target.value) })} /></Field>
              <div className="span-all"><SkillPicker meta={meta} value={f.skills} onChange={(skills) => setF({ ...f, skills })} /></div>
            </>
          )}
          <Field label="New temporary password" hint="Leave empty to keep the current one"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} autoComplete="new-password" /></Field>
          <div className="row gap span-all">
            <button className="btn btn-primary" disabled={busy}>Save {u.name.split(" ")[0]}</button>
            <button type="button" className="btn" onClick={() => done(false)}>Cancel</button>
          </div>
        </form>
      </td>
    </tr>
  );
}

// ============================================================================ own account
export function Account({ me }: { me: User }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const mismatch = f.again !== "" && f.next !== f.again;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mismatch) return;
    if (await run(() => api("/me/password", { body: { current: f.current, next: f.next } }), "Password changed")) setF({ current: "", next: "", again: "" });
  }

  return (
    <div className="page narrow">
      <h1 className="page-title">Your account</h1>
      <div className="panel stack">
        <dl className="facts">
          <div><dt>Name</dt><dd>{me.name}</dd></div>
          <div><dt>Email</dt><dd>{me.email}</dd></div>
          <div><dt>Role</dt><dd>{titleCase(me.role)}</dd></div>
        </dl>
        <form className="stack" onSubmit={submit}>
          <h2 className="h2">Change password</h2>
          <Field label="Current password"><input type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required autoComplete="current-password" /></Field>
          <Field label="New password" hint="At least 8 characters"><input type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required minLength={8} autoComplete="new-password" /></Field>
          <Field label="New password again" hint={mismatch ? "The two new passwords do not match" : undefined}><input type="password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} required autoComplete="new-password" aria-invalid={mismatch} /></Field>
          <button className="btn btn-primary" disabled={busy || mismatch}>Change password</button>
        </form>
      </div>
    </div>
  );
}

// ============================================================================ logs
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

const EMAIL_STATUS: Record<EmailEntry["status"], string> = { SIMULATED: "Simulated", QUEUED: "Sending", SENT: "Sent", FAILED: "Failed" };

/** Every email the system produced. Simulated ones were written here instead of being sent. */
export function EmailLog({ refreshKey, meta }: { refreshKey: number; meta: Meta }) {
  const [q, setQ] = useState("");
  const { data } = useLoad(() => api<EmailEntry[]>("/reports/emails"), [refreshKey]);
  const rows = data?.filter((e) => !q || `${e.to} ${e.subject} ${e.incidentId}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Email log</h1>
        <input placeholder="Filter by recipient or incident" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter emails" />
      </div>
      <p className="muted">
        {meta.emailChannel === "EMAIL_RESEND"
          ? "Emails are sent through Resend. Each row shows what the provider answered."
          : "Email is simulated: each message is recorded here exactly as it would be sent. Set RESEND_API_KEY and EMAIL_FROM to send for real."}
      </p>
      {rows && rows.length === 0 ? <Empty title={q ? "No emails match." : "No emails yet."} /> : (
        <div className="table-wrap panel flush">
          <table className="audit">
            <thead><tr><th>Time</th><th>To</th><th>Subject</th><th>Message</th><th>Status</th></tr></thead>
            <tbody>
              {rows?.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{fmtTime(e.at)}</td>
                  <td>{e.to}</td>
                  <td><a href={`#/incidents/${e.incidentId}`}>{e.subject}</a></td>
                  <td>{e.body}</td>
                  <td className="nowrap" title={e.detail}><span className={`mail mail-${e.status}`}>{EMAIL_STATUS[e.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
