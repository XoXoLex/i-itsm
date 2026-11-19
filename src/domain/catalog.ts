import { Level, Priority } from "./enums";
import { InvalidInputException } from "../exceptions/errors";

/** An IT service the organization runs (Payment App, VPN, Email...). */
export class ITService {
  private _active = true;

  constructor(
    readonly id: string,
    private _name: string,
    private _criticality: Level,
    private _userBase: number,
  ) {
    ITService.validate(_name, _criticality, _userBase);
  }

  get name(): string { return this._name; }
  get criticality(): Level { return this._criticality; }
  get userBase(): number { return this._userBase; }
  /** A retired service stays on old incidents but cannot be picked for new ones. */
  get active(): boolean { return this._active; }

  setCriticality(level: Level): void {
    ITService.validate(this._name, level, this._userBase);
    this._criticality = level;
  }

  update(name: string, userBase: number): void {
    ITService.validate(name, this._criticality, userBase);
    this._name = name.trim();
    this._userBase = userBase;
  }

  setActive(active: boolean): void { this._active = active; }

  static validate(name: string, criticality: Level, userBase: number): void {
    if (!name?.trim()) throw new InvalidInputException("Service name is required");
    if (!Number.isInteger(criticality) || criticality < 1 || criticality > 4) throw new InvalidInputException("Criticality must be 1–4");
    if (!Number.isInteger(userBase) || userBase < 1) throw new InvalidInputException("User base must be a whole number of at least 1");
  }
}

/**
 * Categories are data, not an enum, so an admin can add "IoT" at runtime
 * without touching any code (open/closed principle). Keywords feed auto-categorization.
 */
export class Category {
  readonly name: string;
  private keywords = new Set<string>();

  constructor(name: string, keywords: string[]) {
    if (!name?.trim()) throw new InvalidInputException("Category name is required");
    if (!/^[A-Za-z][A-Za-z0-9 _-]{1,29}$/.test(name.trim())) throw new InvalidInputException("Category name must be 2–30 letters, digits, spaces, - or _");
    this.name = name.trim().toUpperCase();
    this.setKeywords(keywords);
  }

  setKeywords(keywords: string[]): void {
    this.keywords = new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean));
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
    if (!Number.isInteger(responseMinutes) || !Number.isInteger(resolutionMinutes)) {
      throw new InvalidInputException("SLA targets must be whole numbers of minutes");
    }
    if (responseMinutes <= 0 || resolutionMinutes < responseMinutes) {
      throw new InvalidInputException("SLA resolution target must be >= response target and both > 0");
    }
    if (!(warningThreshold > 0 && warningThreshold < 1)) throw new InvalidInputException("Warning threshold must be between 0 and 1");
  }

  get id(): string { return this.priority; }
}
