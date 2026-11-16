import { ReactNode, useState } from "react";
import { api, fmtTime, IncidentDetail, Meta, STATUS_LABEL, titleCase, User } from "./api";
import { Empty, Field, Lifecycle, PriorityTag, SlaFuse, StatusText, useAction, useLoad, useNow } from "./ui";

export function IncidentView({ id, me, meta, refreshKey }: { id: string; me: User; meta: Meta; refreshKey: number }) {
  const { data: inc, error, reload } = useLoad(() => api<IncidentDetail>(`/incidents/${id}`), [id, refreshKey]);
  const now = useNow(10_000);
  if (error) return <div className="page"><Empty title={error}><a href="#/">Back to incidents</a></Empty></div>;
  if (!inc) return <div className="page"><p className="muted">Loading {id}…</p></div>;

  const isAssignee = inc.assignee?.id === me.id;
  const isReporter = inc.reporter.id === me.id;
  const isAdmin = me.role === "ADMIN";

  return (
    <div className="page">
      <a href="#/" className="back">{me.role === "ADMIN" ? "Operations" : me.role === "TECHNICIAN" ? "My queue" : "My incidents"}</a>
      <header className="inc-head">
        <PriorityTag p={inc.priority} full />
        <div>
          <h1 className="inc-title"><span className="inc-id">{inc.id}</span> {inc.title}</h1>
          <p className="muted">
            {inc.service.name} · reported by {inc.reporter.name} on {fmtTime(inc.createdAt)}
          </p>
        </div>
        <StatusText s={inc.status} />
      </header>

      <Lifecycle status={inc.status} />

      <div className="inc-grid">
        <div className="stack">
          <section className="panel">
            <div className="sla-big">
              <h2 className="h2">Time to fix</h2>
              <SlaFuse inc={inc} now={now} />
              <p className="muted small">
                Respond by {fmtTime(inc.sla.responseBy)}{inc.acknowledgedAt ? ` (acknowledged ${fmtTime(inc.acknowledgedAt)})` : ""}. Resolve by {fmtTime(inc.sla.resolveBy)}.
                {inc.sla.responseBreached && <strong className="danger"> Response target missed.</strong>}
                {inc.escalatedTo && <strong className="danger"> Escalated to {titleCase(inc.escalatedTo)}.</strong>}
              </p>
            </div>
            <p className="desc">{inc.description}</p>
            <dl className="facts">
              <div><dt>Category</dt><dd>{inc.category ? titleCase(inc.category) : "—"}</dd></div>
              <div><dt>Impact</dt><dd>{titleCase(inc.impactLabel)}</dd></div>
              <div><dt>Urgency</dt><dd>{titleCase(inc.urgencyLabel)}</dd></div>
              <div><dt>Service criticality</dt><dd>{titleCase(inc.service.criticality)}</dd></div>
              <div><dt>People affected</dt><dd>{inc.affectedUsers}</dd></div>
              <div><dt>Priority score</dt><dd>{inc.priorityScore}</dd></div>
              <div><dt>Technician</dt><dd>{inc.assignee?.name ?? "Unassigned"}</dd></div>
            </dl>
            {inc.related.length > 0 && (
              <p className="callout callout-info">
                Possibly the same problem as {inc.related.map((r, k) => <span key={r}>{k > 0 && ", "}<a href={`#/incidents/${r}`}>{r}</a></span>)}.
              </p>
            )}
            {inc.resolution && (
              <div className="resolution">
                <h2 className="h2">Resolution</h2>
                <p>{inc.resolution}</p>
                <p className="muted small">Resolved {fmtTime(inc.resolvedAt)}{inc.closedAt ? `, closed ${fmtTime(inc.closedAt)}` : ""}</p>
              </div>
            )}
            {inc.feedback && <p className="feedback">Reporter rated the fix {inc.feedback.rating} out of 5{inc.feedback.comment ? `: “${inc.feedback.comment}”` : ""}</p>}
          </section>

          <section className="panel">
            <h2 className="h2">Conversation and investigation</h2>
            {inc.timeline.length === 0 ? <p className="muted">No notes yet.</p> : (
              <ul className="timeline">
                {inc.timeline.map((n, k) => (
                  <li key={k} className={`note note-${n.kind}`}>
                    <p className="note-meta"><strong>{n.author.name}</strong> {NOTE_VERB[n.kind]} · {fmtTime(n.at)}</p>
                    <p>{n.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {inc.audit && (
            <section className="panel">
              <h2 className="h2">Audit trail</h2>
              <table className="audit">
                <thead><tr><th>Time</th><th>Who</th><th>What happened</th><th>State</th></tr></thead>
                <tbody>
                  {inc.audit.map((a) => (
                    <tr key={a.id}>
                      <td className="nowrap">{fmtTime(a.at)}</td>
                      <td>{a.actor}</td>
                      <td>{a.description}</td>
                      <td className="nowrap muted">{a.previousState !== a.newState && a.newState ? `${STATUS_LABEL[a.previousState ?? ""] ?? "—"} → ${STATUS_LABEL[a.newState]}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>

        <aside className="stack">
          <Actions inc={inc} me={me} meta={meta} reload={reload} isAssignee={isAssignee} isReporter={isReporter} isAdmin={isAdmin} />
          {inc.suggestions && inc.isOpen && (
            <section className="panel">
              <h2 className="h2">Fixes that worked before</h2>
              {inc.suggestions.length === 0 ? <p className="muted small">No similar resolved incidents yet.</p> : (
                <ul className="suggest">
                  {inc.suggestions.map((s) => (
                    <li key={s.from}>
                      <p>{s.resolution}</p>
                      <p className="muted small">From <a href={`#/incidents/${s.from}`}>{s.from}</a>, {Math.round(s.similarity * 100)}% similar</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

const NOTE_VERB: Record<string, string> = {
  INVESTIGATION: "noted", INFO_REQUEST: "asked", INFO_RESPONSE: "replied", COMMENT: "added",
};

function Actions(props: { inc: IncidentDetail; me: User; meta: Meta; reload: () => void; isAssignee: boolean; isReporter: boolean; isAdmin: boolean }) {
  const { inc, meta, reload, isAssignee, isReporter, isAdmin } = props;
  const { run, busy } = useAction();
  const [text, setText] = useState<Record<string, string>>({});
  const [tech, setTech] = useState("");
  const [rating, setRating] = useState(5);

  const post = async (path: string, ok: string, body?: unknown, clear?: string) => {
    const r = await run(() => api(`/incidents/${inc.id}/${path}`, { method: "POST", body: body ?? {} }), ok);
    if (r) { if (clear) setText({ ...text, [clear]: "" }); reload(); }
  };
  const box = (key: string, label: string, placeholder: string, button: string, path: string, ok: string, primary = false) => (
    <div className="stack-s" key={key}>
      <Field label={label}><textarea rows={3} placeholder={placeholder} value={text[key] ?? ""} onChange={(e) => setText({ ...text, [key]: e.target.value })} /></Field>
      <button className={`btn ${primary ? "btn-primary" : ""}`} disabled={busy || !(text[key] ?? "").trim()} onClick={() => post(path, ok, { text: text[key] }, key)}>{button}</button>
    </div>
  );

  const blocks: ReactNode[] = [];
  const s = inc.status;
  const worker = isAssignee || isAdmin;

  if (worker && s === "ASSIGNED") blocks.push(<button key="ack" className="btn btn-primary" disabled={busy} onClick={() => post("acknowledge", "Incident acknowledged")}>Acknowledge</button>);
  if (worker && s === "ACKNOWLEDGED") blocks.push(<button key="start" className="btn btn-primary" disabled={busy} onClick={() => post("start", "Investigation started")}>Start investigation</button>);
  if (worker && s === "IN_PROGRESS") {
    blocks.push(box("resolve", "Resolution", "What fixed it?", "Resolve incident", "resolve", "Incident resolved", true));
    if (inc.suggestions?.length) blocks.push(
      <button key="usesug" className="btn btn-ghost" onClick={() => setText({ ...text, resolve: inc.suggestions![0].resolution })}>Use top suggested fix</button>,
    );
    blocks.push(box("note", "Investigation note", "What you checked or found", "Add note", "notes", "Note added"));
    blocks.push(box("ask", "Ask the reporter", "Question for the reporter (pauses until they reply)", "Send question", "request-info", "Question sent"));
  }
  if ((isReporter || isAdmin) && s === "PENDING_INFO") blocks.push(box("reply", "Reply to the technician", "Your answer", "Send reply", "provide-info", "Reply sent", true));
  if (isReporter && inc.isOpen && s !== "PENDING_INFO") blocks.push(box("info", "Add information", "Anything the technician should know", "Add to incident", "provide-info", "Information added"));
  if ((isReporter || isAdmin) && s === "RESOLVED") {
    blocks.push(<button key="verify" className="btn btn-primary" disabled={busy} onClick={() => post("verify", "Fix confirmed")}>Confirm it's fixed</button>);
    blocks.push(box("reopen", "Still broken?", "What is still wrong", "Reopen incident", "reopen", "Incident reopened"));
  }
  if (isAdmin && s === "VERIFIED") blocks.push(<button key="close" className="btn btn-primary" disabled={busy} onClick={() => post("close", "Incident closed")}>Close incident</button>);
  if ((isReporter || isAdmin) && s === "VERIFIED") blocks.push(box("reopen", "Still broken?", "What is still wrong", "Reopen incident", "reopen", "Incident reopened"));
  if (isAdmin && ["CLASSIFIED", "ASSIGNED", "ACKNOWLEDGED"].includes(s)) blocks.push(
    <div key="assign" className="stack-s">
      <Field label={inc.assignee ? "Reassign" : "Assign"}>
        <select value={tech} onChange={(e) => setTech(e.target.value)}>
          <option value="">Pick automatically ({titleCase(meta.strategies.assignment)})</option>
          {meta.technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>
      <button className="btn" disabled={busy} onClick={() => post("assign", "Technician assigned", { technicianId: tech || undefined })}>Assign</button>
    </div>,
  );
  if (isReporter && !inc.isOpen && !inc.feedback) blocks.push(
    <div key="fb" className="stack-s">
      <Field label="How did we do?">
        <div className="stars" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={rating === n} className={n <= rating ? "on" : ""} onClick={() => setRating(n)}>{n}</button>)}
        </div>
      </Field>
      <textarea rows={2} placeholder="Optional comment" value={text.fb ?? ""} onChange={(e) => setText({ ...text, fb: e.target.value })} />
      <button className="btn" disabled={busy} onClick={() => post("feedback", "Thanks for the feedback", { rating, comment: text.fb ?? "" }, "fb")}>Send feedback</button>
    </div>,
  );

  return (
    <section className="panel actions">
      <h2 className="h2">Next step</h2>
      {blocks.length ? <div className="stack">{blocks}</div> : <p className="muted small">{waitingText(inc, isAssignee, isReporter)}</p>}
    </section>
  );
}

function waitingText(inc: IncidentDetail, isAssignee: boolean, isReporter: boolean): string {
  if (inc.status === "CLOSED") return "This incident is closed.";
  if (inc.status === "PENDING_INFO") return isAssignee ? "Waiting for the reporter to reply." : "Waiting for the reporter.";
  if (inc.status === "RESOLVED") return "Waiting for the reporter to confirm the fix.";
  if (inc.status === "VERIFIED") return "Fix confirmed. An administrator will close it.";
  if (isReporter) return inc.assignee ? `${inc.assignee.name} is working on it.` : "Waiting for a technician.";
  return "Nothing for you to do here.";
}
