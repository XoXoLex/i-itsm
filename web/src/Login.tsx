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
        <h1 className="login-title">Service Desk</h1>
        <p className="login-lede">
          Report an IT problem and follow it until it is fixed. Every incident gets a priority, an owner and a deadline the moment you file it.
        </p>
        <div className="login-fuse" aria-hidden="true">
          <div className="fuse fuse-risk"><div className="fuse-track"><div className="fuse-fill" style={{ width: "22%" }} /></div><span className="fuse-label">6m left</span></div>
          <div className="fuse fuse-ok"><div className="fuse-track"><div className="fuse-fill" style={{ width: "71%" }} /></div><span className="fuse-label">1h 25m left</span></div>
          <div className="fuse fuse-met"><div className="fuse-track"><div className="fuse-fill" style={{ width: "40%" }} /></div><span className="fuse-label">Met · 3h spare</span></div>
        </div>
      </section>

      <section className="login-panel">
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
          <p className="demo-title">Demo accounts</p>
          {DEMO.map((d) => (
            <button key={d.email} className="demo-row" onClick={() => go(d.email, d.password)} disabled={busy}>
              <strong>{d.label}</strong><span>{d.who}</span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
