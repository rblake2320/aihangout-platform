/**
 * Splits wall-clock time on a page into active and idle. Time between two input events
 * counts as active up to `idleMs`; anything past that is idle. Pure and clock-injected.
 */
export class ActivityClock {
  private startedAt: number
  private lastInput: number
  private activeMs = 0

  constructor(private idleMs: number, now: number) {
    this.startedAt = now
    this.lastInput = now
  }

  input(now: number): void {
    const gap = now - this.lastInput
    if (gap > 0) this.activeMs += Math.min(gap, this.idleMs)
    this.lastInput = now
  }

  snapshot(now: number): { durationMs: number; activeMs: number; idleMs: number } {
    const tail = Math.min(Math.max(now - this.lastInput, 0), this.idleMs)
    const durationMs = Math.max(now - this.startedAt, 0)
    const activeMs = Math.min(this.activeMs + tail, durationMs)
    return { durationMs, activeMs, idleMs: durationMs - activeMs }
  }

  reset(now: number): void {
    this.startedAt = now
    this.lastInput = now
    this.activeMs = 0
  }
}
