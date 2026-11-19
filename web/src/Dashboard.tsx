import { useState } from "react";
import { api, fmtTime, PRIORITY_LABEL, Priority } from "./api";
import { useLoad } from "./ui";

type Overview = {
  total: number; open: number; critical: number; resolved: number; slaViolations: number; atRisk: number;
  unassigned: number; awaitingClosure: number; escalated: number; avgRating: number | null;
};
type Load = { id: string; name: string; active: number; max: number; available: boolean }[];
type Trend = { date: string; created: number; resolved: number }[];
type Violation = { id: string; incidentId: string; kind: string; deadline: string; detectedAt: string; priority: Priority };

const SERIES = { created: "#0E8AA6", resolved: "#6A5ACD" }; // validated pair (CVD ΔE ≥ 11)

export function Dashboard({ refreshKey }: { refreshKey: number }) {
  const { data } = useLoad(async () => {
    const [overview, workload, byService, byPriority, trend, violations] = await Promise.all([
      api<Overview>("/reports/overview"), api<Load>("/reports/workload"), api<Record<string, number>>("/reports/by-service"),
      api<Record<string, number>>("/reports/by-priority"), api<Trend>(`/reports/trend?tz=${-new Date().getTimezoneOffset()}`), api<Violation[]>("/reports/sla-violations"),
    ]);
    return { overview, workload, byService, byPriority, trend, violations };
  }, [refreshKey]);
  if (!data) return <div className="page"><p className="muted">Loading dashboard…</p></div>;
  const o = data.overview;

  return (
    <div className="page">
      <h1 className="page-title">Operations</h1>

      <div className="kpis">
        <Kpi n={o.open} label="open now" href="#/all" />
        <Kpi n={o.critical} label="critical (P1) open" tone={o.critical ? "danger" : undefined} />
        <Kpi n={o.atRisk} label="at risk of missing SLA" tone={o.atRisk ? "warn" : undefined} />
        <Kpi n={o.slaViolations} label="SLA violations recorded" />
        <Kpi n={o.resolved} label={`resolved of ${o.total} total`} />
        <Kpi n={o.avgRating ?? "—"} label="average rating out of 5" />
      </div>

      {(o.unassigned > 0 || o.awaitingClosure > 0 || o.escalated > 0) && (
        <ul className="attention" aria-label="Needs your attention">
          {o.unassigned > 0 && <li><a href="#/all?status=CLASSIFIED"><strong>{o.unassigned}</strong> waiting for a technician</a><span>Nobody suitable was free. Assign by hand, or it is retried automatically.</span></li>}
          {o.escalated > 0 && <li><a href="#/all?openOnly=true"><strong>{o.escalated}</strong> escalated and still open</a><span>Past a deadline. The audit trail shows who was told.</span></li>}
          {o.awaitingClosure > 0 && <li><a href="#/all?status=VERIFIED"><strong>{o.awaitingClosure}</strong> confirmed fixed, waiting to be closed</a><span>The reporter verified the fix. Only an administrator can close.</span></li>}
        </ul>
      )}

      <div className="dash-grid">
        <section className="panel span-2">
          <h2 className="h2">Reported vs resolved, last 10 days</h2>
          <TrendChart data={data.trend} />
        </section>

        <section className="panel">
          <h2 className="h2">Incidents by service</h2>
          <Bars data={Object.entries(data.byService).sort((a, b) => b[1] - a[1])} color={SERIES.created} />
        </section>

        <section className="panel">
          <h2 className="h2">Incidents by priority</h2>
          <Bars data={(["P1", "P2", "P3", "P4"] as Priority[]).map((p) => [`${p} ${PRIORITY_LABEL[p]}`, data.byPriority[p] ?? 0])} colorFor={(k) => `var(--${k.slice(0, 2)})`} />
        </section>

        <section className="panel">
          <h2 className="h2">Technician workload</h2>
          <ul className="loads">
            {data.workload.map((t) => (
              <li key={t.id}>
                <span className="load-name">{t.name}{!t.available && <span className="muted"> (away)</span>}</span>
                <span className="load-cells" aria-label={`${t.active} of ${t.max}`}>
                  {Array.from({ length: t.max }, (_, k) => <span key={k} className={k < t.active ? "on" : ""} />)}
                </span>
                <span className="load-n">{t.active}/{t.max}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h2 className="h2">Latest SLA violations</h2>
          {data.violations.length === 0 ? <p className="muted">None so far.</p> : (
            <table className="mini">
              <thead><tr><th>Incident</th><th>Missed</th><th>Detected</th></tr></thead>
              <tbody>
                {data.violations.slice(0, 7).map((v) => (
                  <tr key={v.id}>
                    <td><a href={`#/incidents/${v.incidentId}`}>{v.incidentId}</a> <span className={`dot dot-${v.priority}`}>{v.priority}</span></td>
                    <td>{v.kind === "RESPONSE" ? "Response" : "Resolution"}</td>
                    <td className="nowrap muted">{fmtTime(v.detectedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

function Kpi({ n, label, tone, href }: { n: number | string; label: string; tone?: "danger" | "warn"; href?: string }) {
  const body = <><span className="kpi-n">{n}</span><span className="kpi-l">{label}</span></>;
  return href ? <a className={`kpi ${tone ? `kpi-${tone}` : ""}`} href={href}>{body}</a> : <div className={`kpi ${tone ? `kpi-${tone}` : ""}`}>{body}</div>;
}

/** Horizontal bars with direct value labels; single hue for magnitude. */
function Bars({ data, color, colorFor }: { data: [string, number][]; color?: string; colorFor?: (k: string) => string }) {
  const max = Math.max(1, ...data.map((d) => d[1]));
  return (
    <table className="bars">
      <tbody>
        {data.map(([k, v]) => (
          <tr key={k} title={`${k}: ${v}`}>
            <th scope="row">{k}</th>
            <td><span className="bar" style={{ width: `${(v / max) * 100}%`, background: colorFor ? colorFor(k) : color }} /></td>
            <td className="bar-v">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Paired columns per day with a hover readout; legend + table-like readout so colour is never the only cue. */
function TrendChart({ data }: { data: Trend }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 1060, H = 220, pad = 28, gap = 2;
  const max = Math.max(1, ...data.flatMap((d) => [d.created, d.resolved]));
  const band = (W - pad) / data.length;
  const bw = Math.min(16, (band - 12) / 2);
  const y = (v: number) => H - pad - (v / max) * (H - pad - 8);
  const shown = hover ?? data.length - 1;
  const d = data[shown];

  return (
    <div className="trend">
      <div className="trend-head">
        <div className="legend">
          <span><i style={{ background: SERIES.created }} />Reported</span>
          <span><i style={{ background: SERIES.resolved }} />Resolved</span>
        </div>
        <p className="readout" aria-live="polite">
          {new Date(`${d.date}T12:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}: <strong>{d.created}</strong> reported, <strong>{d.resolved}</strong> resolved
        </p>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="trend-svg" role="img" aria-label="Incidents reported and resolved per day" onMouseLeave={() => setHover(null)}>
        {[0, Math.ceil(max / 2), max].map((t) => (
          <g key={t}>
            <line x1={pad} x2={W} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad - 6} y={y(t) + 4} className="axis" textAnchor="end">{t}</text>
          </g>
        ))}
        {data.map((p, i) => {
          const x = pad + i * band + band / 2;
          return (
            <g key={p.date} onMouseEnter={() => setHover(i)} className={hover === i ? "is-hover" : ""}>
              <rect x={pad + i * band} y={0} width={band} height={H - pad} className="hit" />
              <path d={col(x - bw - gap / 2, y(p.created), bw, H - pad)} fill={SERIES.created} />
              <path d={col(x + gap / 2, y(p.resolved), bw, H - pad)} fill={SERIES.resolved} />
              {i % 2 === data.length % 2 && <text x={x} y={H - 6} className="axis" textAnchor="middle">{p.date.slice(8)}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Column with a 3px rounded top, square at the baseline. */
function col(x: number, top: number, w: number, base: number): string {
  const h = base - top;
  if (h <= 0) return "";
  const r = Math.min(3, h, w / 2);
  return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`;
}
