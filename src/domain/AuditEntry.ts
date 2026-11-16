/** Immutable record of one important action. */
export class AuditEntry {
  constructor(
    readonly id: string,
    readonly at: Date,
    readonly actor: string, // user id or "SYSTEM"
    readonly action: string,
    readonly incidentId: string,
    readonly previousState: string | null,
    readonly newState: string | null,
    readonly description: string,
  ) {
    Object.freeze(this);
  }

  toString(): string {
    const hh = this.at.toTimeString().substring(0, 5);
    const transition = this.previousState !== this.newState && this.newState ? ` [${this.previousState ?? "-"} → ${this.newState}]` : "";
    return `${hh} – ${this.incidentId} ${this.description} (by ${this.actor})${transition}`;
  }
}
