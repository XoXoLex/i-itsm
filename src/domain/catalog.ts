import { Level, Priority } from "./enums";
import { InvalidInputException } from "../exceptions/errors";

/** An IT service the organization runs (Payment App, VPN, Email...). */
export class ITService {
  constructor(
    readonly id: string,
    readonly name: string,
    private _criticality: Level,
    private _userBase: number,
  ) {}

  get criticality(): Level { return this._criticality; }
  get userBase(): number { return this._userBase; }

  setCriticality(level: Level): void { this._criticality = level; }
}

/**
 * Categories are data, not an enum, so an admin can add "IoT" at runtime
 * without touching any code (open/closed principle). Keywords feed auto-categorization.
 */
export class Category {
  readonly name: string;
  private readonly keywords: Set<string>;

  constructor(name: string, keywords: string[]) {
    if (!name.trim()) throw new InvalidInputException("Category name is required");
    this.name = name.trim().toUpperCase();
    this.keywords = new Set(keywords.map((k) => k.toLowerCase()));
  }

  get id(): string { return this.name; }
  get keywordList(): string[] { return [...this.keywords]; }

  keywordHits(tokens: string[]): number {
    return tokens.filter((t) => this.keywords.has(t)).length;
  }
}

/** Response/resolution targets for one priority level. */
export class SLAPolicy {
  constructor(
    readonly priority: Priority,
    readonly responseMinutes: number,
    readonly resolutionMinutes: number,
    readonly warningThreshold = 0.8, // warn once 80% of the window has elapsed
  ) {
    if (responseMinutes <= 0 || resolutionMinutes < responseMinutes) {
      throw new InvalidInputException("SLA resolution target must be >= response target and both > 0");
    }
  }

  get id(): string { return this.priority; }
}
