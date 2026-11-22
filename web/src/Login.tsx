import { FormEvent, useState } from "react";
import { api, setToken, User } from "./api";
import { Field, useAction } from "./ui";

const DEMO = [
  { label: "Employee", who: "Ankit Sharma, Finance", email: "ankit@corp.local", password: "employee1" },
  { label: "Technician", who: "Rahul, App & DB support", email: "rahul@itsm.local", password: "tech12345" },
  { label: "IT manager", who: "Priya, administrator", email: "admin@itsm.local", password: "admin1234" },
];

export function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [form, setForm] = useState({ name: "", email: "", password: "", department: "" });
  const { run, busy } = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function go(email: string, password: string) {
    const r = await run(() => api<{ token: string; user: User }>("/auth/login", { body: { email, password } }));
    if (r) { setToken(r.token); onLogin(r.user); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === "login") return go(form.email, form.password);
    const r = await run(() => api<{ token: string; user: User }>("/auth/register", { body: form }), "Account created");
    if (r) { setToken(r.token); onLogin(r.user); }
  }

  return (
    <main className="login">
      <section className="login-brand">
        <div className="login-brand-inner">
          <h1 className="login-title">Fuse</h1>
          <div className="wordmark-fuse" aria-hidden="true"><span /></div>
          <p className="login-lede">An IT service desk. Report a problem and Fuse works out how urgent it is, who should fix it and by when.</p>

          <figure className="walk" aria-label="Example: what happens when an employee reports an outage">
            <figcaption className="walk-head">
              <span className="walk-kicker">What happens the moment you report</span>
              <span className="walk-report">Payment application unavailable</span>
              <span className="walk-meta">Payment Application · 300 people affected · business stopped</span>
            </figcaption>
            <ol className="walk-steps">
              <li style={{ animationDelay: "150ms" }}>
                <span className="walk-step">Classified</span>
                <span className="walk-value">Application, from the words in the report</span>
              </li>
              <li style={{ animationDelay: "300ms" }}>
                <span className="walk-step">Prioritised</span>
                <span className="walk-value"><span className="ptag ptag-P1">P1</span> impact 4 × urgency 4 × criticality 4 = 64</span>
              </li>
              <li style={{ animationDelay: "450ms" }}>
                <span className="walk-step">Deadlines set</span>
                <span className="walk-value">Respond in 5 min, fix in 30 min</span>
              </li>
              <li style={{ animationDelay: "600ms" }}>
                <span className="walk-step">Assigned</span>
                <span className="walk-value">Rahul, who knows this service best</span>
              </li>
            </ol>
            <div className="walk-clock" style={{ animationDelay: "750ms" }}>
              <div className="fuse"><div className="fuse-track"><div className="fuse-fill" style={{ width: "93%" }} /></div><span className="fuse-label">28 min left to fix</span></div>
              <p>If nobody acknowledges it, it climbs to the team lead, then the IT manager.</p>
            </div>
          </figure>
          <p className="login-by">Built by <strong>Ankur Jaipuriar</strong> · 2024B5A70947H · CS F213 Object Oriented Programming</p>
        </div>
      </section>

      <section className="login-panel">
        <div className="login-panel-inner">
        <h2 className="login-panel-title">{mode === "login" ? "Welcome back" : "Join Fuse"}</h2>
        <p className="login-panel-sub">{mode === "login" ? "Sign in to see your incidents." : "Employees can create their own account."}</p>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={mode === "login"} className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>Sign in</button>
          <button role="tab" aria-selected={mode === "register"} className={mode === "register" ? "on" : ""} onClick={() => setMode("register")}>Create employee account</button>
        </div>
        <form onSubmit={submit} className="stack">
          {mode === "register" && (
            <>
              <Field label="Full name"><input value={form.name} onChange={set("name")} required autoComplete="name" /></Field>
              <Field label="Department"><input value={form.department} onChange={set("department")} placeholder="Finance" /></Field>
            </>
          )}
          <Field label="Work email"><input type="email" value={form.email} onChange={set("email")} required autoComplete="email" /></Field>
          <Field label="Password" hint={mode === "register" ? "At least 8 characters" : undefined}>
            <input type="password" value={form.password} onChange={set("password")} required minLength={mode === "register" ? 8 : undefined} autoComplete={mode === "login" ? "current-password" : "new-password"} />
          </Field>
          <button className="btn btn-primary" disabled={busy}>{mode === "login" ? "Sign in" : "Create account"}</button>
        </form>

        <div className="demo">
          <p className="demo-title">Try it with a demo account</p>
          <p className="demo-hint">Sample data is already loaded. One click signs you in.</p>
          {DEMO.map((d) => (
            <button key={d.email} className="demo-row" onClick={() => go(d.email, d.password)} disabled={busy}>
              <strong>{d.label}</strong><span>{d.who}</span>
            </button>
          ))}
        </div>
        </div>
      </section>
    </main>
  );
}
