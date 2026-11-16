import { FormEvent, useState } from "react";
import { api, fmtTime, IncidentDetail, Meta, PRIORITY_LABEL, titleCase } from "./api";
import { Field, PriorityTag, useAction } from "./ui";

type Result = { incident: IncidentDetail; duplicates: { id: string; title: string; similarity: number }[] };

const IMPACT_HINT: Record<number, string> = { 1: "Just me", 2: "My team", 3: "A department", 4: "The whole organisation" };
const URGENCY_HINT: Record<number, string> = { 1: "Whenever possible", 2: "Today", 3: "Blocking my work", 4: "Business is stopped" };

export function ReportForm({ meta, go }: { meta: Meta; go: (to: string) => void }) {
  const [f, setF] = useState({ title: "", description: "", serviceId: "", impact: 2, urgency: 2, affectedUsers: 1, category: "" });
  const [result, setResult] = useState<Result | null>(null);
  const { run, busy } = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await run(() => api<Result>("/incidents", { body: f }));
    if (r) setResult(r);
  }

  if (result) {
    const i = result.incident;
    return (
      <div className="page narrow">
        <h1 className="page-title">Reported as {i.id}</h1>
        <div className="panel triage">
          <p className="triage-lede">Here is what the desk did with your report:</p>
          <dl className="triage-list">
            <div><dt>Category</dt><dd>{i.category ? titleCase(i.category) : "—"}</dd></div>
            <div><dt>Priority</dt><dd><PriorityTag p={i.priority} full /> <span className="muted">score {i.priorityScore}</span></dd></div>
            <div><dt>Assigned to</dt><dd>{i.assignee?.name ?? "Waiting for a free technician"}</dd></div>
            <div><dt>Fix due by</dt><dd>{fmtTime(i.sla.resolveBy)}</dd></div>
          </dl>
          {result.duplicates.length > 0 && (
            <div className="callout callout-info">
              <strong>Others reported something similar.</strong> Your report has been linked to{" "}
              {result.duplicates.map((d, k) => (
                <span key={d.id}>{k > 0 && ", "}<a href={`#/incidents/${d.id}`}>{d.id}</a> ({Math.round(d.similarity * 100)}% match)</span>
              ))} so the technician sees them together.
            </div>
          )}
          <div className="row gap">
            <button className="btn btn-primary" onClick={() => go(`/incidents/${i.id}`)}>Open {i.id}</button>
            <button className="btn" onClick={() => { setResult(null); setF({ ...f, title: "", description: "" }); }}>Report another problem</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page narrow">
      <h1 className="page-title">Report a problem</h1>
      <form className="panel stack" onSubmit={submit}>
        <Field label="What is wrong?" hint="One line, e.g. “Payment page shows error 503”">
          <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={5} maxLength={120} />
        </Field>
        <Field label="Details" hint="What you were doing, what you saw, since when">
          <textarea rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required minLength={10} />
        </Field>
        <div className="grid-2">
          <Field label="Affected service">
            <select value={f.serviceId} onChange={(e) => setF({ ...f, serviceId: e.target.value })} required>
              <option value="">Choose a service</option>
              {meta.services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Category" hint={`Leave on automatic and the desk will classify it (${meta.categorizer.startsWith("GEMINI") ? "Gemini AI" : "keyword"} classifier)`}>
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              <option value="">Automatic</option>
              {meta.categories.map((c) => <option key={c.name} value={c.name}>{c.name.charAt(0) + c.name.slice(1).toLowerCase()}</option>)}
            </select>
          </Field>
        </div>
        <fieldset className="scale">
          <legend>Who is affected?</legend>
          {[1, 2, 3, 4].map((n) => (
            <label key={n} className={f.impact === n ? "on" : ""}>
              <input type="radio" name="impact" checked={f.impact === n} onChange={() => setF({ ...f, impact: n })} />{IMPACT_HINT[n]}
            </label>
          ))}
        </fieldset>
        <fieldset className="scale">
          <legend>How urgent is it?</legend>
          {[1, 2, 3, 4].map((n) => (
            <label key={n} className={f.urgency === n ? "on" : ""}>
              <input type="radio" name="urgency" checked={f.urgency === n} onChange={() => setF({ ...f, urgency: n })} />{URGENCY_HINT[n]}
            </label>
          ))}
        </fieldset>
        <Field label="Roughly how many people are affected?">
          <input type="number" min={1} value={f.affectedUsers} onChange={(e) => setF({ ...f, affectedUsers: Math.max(1, Number(e.target.value)) })} />
        </Field>
        <p className="muted small">Priority is worked out from these answers and how critical the service is. P1 ({PRIORITY_LABEL.P1}) gets a technician within {meta.slaPolicies.find((p) => p.priority === "P1")?.responseMinutes ?? 5} minutes.</p>
        <button className="btn btn-primary" disabled={busy}>{busy ? "Filing…" : "Report problem"}</button>
      </form>
    </div>
  );
}
