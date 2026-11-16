import { Incident } from "../../domain/Incident";
import { Technician } from "../../domain/users";
import { TechnicianUnavailableException } from "../../exceptions/errors";

/** STRATEGY PATTERN: interchangeable technician-selection algorithms. */
export interface AssignmentStrategy {
  readonly name: string;
  select(incident: Incident, technicians: Technician[]): Technician;
}

function eligible(technicians: Technician[]): Technician[] {
  const free = technicians.filter((t) => t.canTakeMore());
  if (free.length === 0) throw new TechnicianUnavailableException("all technicians are unavailable or at max workload");
  return free;
}

/** Must have the skill for the category; then most experienced with this service, then most years, then least loaded. */
export class SkillBasedAssignment implements AssignmentStrategy {
  readonly name = "SKILL_BASED";

  select(incident: Incident, technicians: Technician[]): Technician {
    const category = incident.category ?? "";
    const skilled = eligible(technicians).filter((t) => t.hasSkill(category));
    if (skilled.length === 0) throw new TechnicianUnavailableException(`nobody free has the ${category} skill`);
    return skilled.sort(
      (a, b) =>
        b.experienceWith(incident.service.id) - a.experienceWith(incident.service.id) ||
        b.experienceYears - a.experienceYears ||
        a.workload - b.workload,
    )[0];
  }
}

/** Least-loaded technician; skill match only breaks ties. Good for spreading work evenly. */
export class LoadBasedAssignment implements AssignmentStrategy {
  readonly name = "LOAD_BASED";

  select(incident: Incident, technicians: Technician[]): Technician {
    const category = incident.category ?? "";
    return eligible(technicians).sort(
      (a, b) => a.workload - b.workload || Number(b.hasSkill(category)) - Number(a.hasSkill(category)),
    )[0];
  }
}

/** Rotates through eligible technicians in a fixed order. */
export class RoundRobinAssignment implements AssignmentStrategy {
  readonly name = "ROUND_ROBIN";
  private cursor = 0;

  select(_incident: Incident, technicians: Technician[]): Technician {
    const ordered = [...technicians].sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < ordered.length; i++) {
      const candidate = ordered[(this.cursor + i) % ordered.length];
      if (candidate.canTakeMore()) {
        this.cursor = (this.cursor + i + 1) % ordered.length;
        return candidate;
      }
    }
    throw new TechnicianUnavailableException("all technicians are unavailable or at max workload");
  }
}

/** FACTORY: lets an admin switch strategy by name at runtime. */
export class AssignmentStrategyFactory {
  private static readonly registry: Record<string, () => AssignmentStrategy> = {
    SKILL_BASED: () => new SkillBasedAssignment(),
    LOAD_BASED: () => new LoadBasedAssignment(),
    ROUND_ROBIN: () => new RoundRobinAssignment(),
  };

  static create(name: string): AssignmentStrategy {
    const make = this.registry[name.toUpperCase()];
    if (!make) throw new Error(`Unknown assignment strategy ${name}. Options: ${this.available().join(", ")}`);
    return make();
  }

  static available(): string[] {
    return Object.keys(this.registry);
  }
}
