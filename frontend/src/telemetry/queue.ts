import type { TelemetryConfig, TelemetryEvent } from './types'

/** Bounded in-memory queue with byte-capped batching and exponential backoff. */
export class EventQueue {
  private items: TelemetryEvent[] = []
  private failures = 0
  private retryAt = 0
  dropped = 0

  constructor(private cfg: TelemetryConfig) {}

  get size(): number { return this.items.length }

  push(ev: TelemetryEvent): void {
    if (this.items.length >= this.cfg.batch.maxQueue) {
      this.items.shift() // drop oldest: recent behaviour is more useful than stale
      this.dropped++
    }
    this.items.push(ev)
  }

  shouldFlush(now: number): boolean {
    return this.items.length >= this.cfg.batch.maxEvents && now >= this.retryAt
  }

  canSend(now: number): boolean {
    return this.items.length > 0 && now >= this.retryAt
  }

  /** Takes up to maxEvents / maxBytes from the front. Caller must ack() or fail(). */
  take(): TelemetryEvent[] {
    const out: TelemetryEvent[] = []
    let bytes = 0
    while (this.items.length && out.length < this.cfg.batch.maxEvents) {
      const size = JSON.stringify(this.items[0]).length
      if (out.length && bytes + size > this.cfg.batch.maxBytes) break
      bytes += size
      out.push(this.items.shift()!)
    }
    return out
  }

  fail(batch: TelemetryEvent[], now: number): void {
    this.failures++
    const delay = Math.min(this.cfg.backoff.baseMs * 2 ** (this.failures - 1), this.cfg.backoff.maxMs)
    this.retryAt = now + delay
    this.items = [...batch, ...this.items].slice(-this.cfg.batch.maxQueue)
  }

  ack(): void {
    this.failures = 0
    this.retryAt = 0
  }
}
