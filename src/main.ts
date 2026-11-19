import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createApp } from "./api/app";
import { GeminiCategorizer, GeminiDecisionCategorizer, LiveChannel } from "./api/integrations";
import { KeywordCategorizer } from "./intelligence/intelligence";
import { SqliteStore } from "./persistence/SqliteStore";
import { seedWithHistory } from "./seedHistory";
import { FakeClock, SystemClock } from "./services/Clock";
import { AssignmentStrategyFactory } from "./strategies/assignment/AssignmentStrategy";
import { buildSystem } from "./system";

async function main() {
  try { process.loadEnvFile(); } catch { /* no .env file: use defaults */ }
  const dbPath = process.env.DB_PATH ?? "data/itsm.db";
  const port = Number(process.env.PORT ?? 3000);
  mkdirSync(dirname(dbPath), { recursive: true });

  let store = new SqliteStore(dbPath);
  if (store.isEmpty) {
    console.log("Empty database: seeding reference data and 10 days of history...");
    const past = new FakeClock(new Date(Date.now() - 8.5 * 86_400_000));
    await seedWithHistory(buildSystem(past, { store }), past);
    store.relinkAll();
    store.db.close();
    store = new SqliteStore(dbPath); // reload cleanly with the real clock
  }

  const keyword = new KeywordCategorizer();
  // GEMINI_MODE=decisions (default) uses the Decisions API; GEMINI_MODE=generate uses a chat model via generateContent.
  const key = process.env.GEMINI_API_KEY;
  const categorizer = !key
    ? keyword
    : process.env.GEMINI_MODE === "generate"
      ? new GeminiCategorizer(key, process.env.GEMINI_MODEL ?? "gemini-3.8-flash", keyword)
      : new GeminiDecisionCategorizer(key, keyword, process.env.GEMINI_DECISION_MODEL ?? "gemini-decision-1");

  const live = new LiveChannel();
  // RESEND_API_KEY + EMAIL_FROM switch email from simulated to real; without them every email is only logged.
  const sys = buildSystem(new SystemClock(), {
    store, categorizer, extraChannels: [live],
    email: { resendApiKey: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM },
  });
  sys.bus.subscribe(live);

  // restore admin-chosen strategies
  const admin = sys.users.findAll().find((u) => u.role === "ADMIN" && u.active)!;
  const a = store.getSetting("assignment_strategy");
  const p = store.getSetting("priority_strategy");
  if (a) sys.incidentService.setAssignmentStrategy(admin, a);
  if (p) sys.incidentService.setPriorityStrategy(admin, p);

  let secret = process.env.JWT_SECRET ?? store.getSetting("jwt_secret");
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    store.setSetting("jwt_secret", secret);
  }

  const app = createApp(sys, live, secret, {
    settings: { set: (k, v) => store.setSetting(k, v) },
    corsOrigins: (process.env.CORS_ORIGIN ?? "").split(",").map((o) => o.trim()).filter(Boolean),
    trustProxy: process.env.TRUST_PROXY === "1" || !!process.env.RENDER,
  });

  // background monitor: SLA warnings, violations, escalation, and another try at incidents nobody could take
  const monitor = () => {
    try {
      const r = sys.sla.checkAll();
      const picked = sys.incidentService.retryUnassigned();
      if (r.warnings || r.breaches || r.escalations || picked) {
        console.log(`[monitor] warnings=${r.warnings} breaches=${r.breaches} escalations=${r.escalations} newly assigned=${picked}`);
      }
    } catch (e) {
      console.error("[monitor] failed:", (e as Error).message);
    }
  };
  const interval = Math.max(5, Number(process.env.SLA_CHECK_SECONDS) || 30);
  setInterval(monitor, interval * 1000);
  monitor();

  app.listen(port, () => {
    console.log(`I-ITSM running at http://localhost:${port}`);
    console.log(`Categorizer: ${categorizer.name} | Email: ${sys.email.name} | Strategies: ${JSON.stringify(sys.incidentService.currentStrategies)} | DB: ${dbPath}`);
    console.log(`Assignment options: ${AssignmentStrategyFactory.available().join(", ")}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
