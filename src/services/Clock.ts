/** Injected time source so SLA logic can be tested by moving time forward. */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date { return new Date(); }
}

export class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date { return new Date(this.current); }
  advanceMinutes(min: number): void { this.current = new Date(this.current.getTime() + min * 60_000); }
  /** Jump forward to a moment (never backwards: time cannot run in reverse). */
  jumpTo(at: Date): void {
    if (at.getTime() < this.current.getTime()) throw new Error("FakeClock cannot move backwards");
    this.current = new Date(at);
  }
}
