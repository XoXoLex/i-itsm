import { Level, Priority } from "../../domain/enums";
import { Incident } from "../../domain/Incident";

export interface PriorityResult {
  priority: Priority;
  score: number;
  rationale: string;
}

/** STRATEGY PATTERN: interchangeable priority algorithms. */
export interface PriorityStrategy {
  readonly name: string;
  calculate(incident: Incident): PriorityResult;
}

/**
 * Weighted score: Impact × Urgency × Business criticality (each 1–4, so 1–64),
 * bumped one level when the outage hits a large share of the service's users.
 *   score ≥ 36 → P1,  ≥ 18 → P2,  ≥ 6 → P3,  else P4
 */
export class WeightedScorePriorityStrategy implements PriorityStrategy {
  readonly name = "WEIGHTED_SCORE";

  calculate(incident: Incident): PriorityResult {
    const score = incident.impact * incident.urgency * incident.service.criticality;
    let priority = score >= 36 ? Priority.P1 : score >= 18 ? Priority.P2 : score >= 6 ? Priority.P3 : Priority.P4;

    const share = incident.affectedUsers / Math.max(incident.service.userBase, 1);
    let rationale = `${incident.impact}×${incident.urgency}×${incident.service.criticality} = ${score}`;
    if (share >= 0.25 && priority !== Priority.P1) {
      priority = bump(priority);
      rationale += `; bumped because ${(share * 100).toFixed(0)}% of service users affected`;
    }
    return { priority, score, rationale };
  }
}

/**
 * Classic ITIL impact/urgency matrix (rule-based), then capped by service
 * criticality: a LOW-criticality service can never produce a P1.
 */
export class MatrixPriorityStrategy implements PriorityStrategy {
  readonly name = "ITIL_MATRIX";

  private static readonly MATRIX: Priority[][] = [
    //            urgency: LOW          MEDIUM       HIGH         CRITICAL
    /* LOW */      [Priority.P4, Priority.P4, Priority.P3, Priority.P3],
    /* MEDIUM */   [Priority.P4, Priority.P3, Priority.P3, Priority.P2],
    /* HIGH */     [Priority.P3, Priority.P3, Priority.P2, Priority.P1],
    /* CRITICAL */ [Priority.P3, Priority.P2, Priority.P1, Priority.P1],
  ];

  calculate(incident: Incident): PriorityResult {
    let priority = MatrixPriorityStrategy.MATRIX[incident.impact - 1][incident.urgency - 1];
    let rationale = `matrix(impact=${Level[incident.impact]}, urgency=${Level[incident.urgency]}) = ${priority}`;
    if (incident.service.criticality === Level.LOW && priority === Priority.P1) {
      priority = Priority.P2;
      rationale += "; capped at P2 for low-criticality service";
    }
    return { priority, score: incident.impact * incident.urgency, rationale };
  }
}

function bump(p: Priority): Priority {
  const order = [Priority.P4, Priority.P3, Priority.P2, Priority.P1];
  return order[Math.min(order.indexOf(p) + 1, order.length - 1)];
}

/** FACTORY: pick a priority strategy by name (admin configuration). */
export class PriorityStrategyFactory {
  private static readonly registry: Record<string, () => PriorityStrategy> = {
    WEIGHTED_SCORE: () => new WeightedScorePriorityStrategy(),
    ITIL_MATRIX: () => new MatrixPriorityStrategy(),
  };

  static create(name: string): PriorityStrategy {
    const make = this.registry[name.toUpperCase()];
    if (!make) throw new Error(`Unknown priority strategy ${name}. Options: ${this.available().join(", ")}`);
    return make();
  }

  static available(): string[] {
    return Object.keys(this.registry);
  }
}
