import type { TelemetryConfig } from './types'

export interface RageHit { count: number; navigated: boolean }

/**
 * Repeated clicks on one target inside a sliding window. The threshold is higher when
 * the route changed during the burst, because a user clicking a nav item that did
 * navigate is not frustrated. After firing, the detector stays quiet until the target
 * has been left alone for a full window.
 */
export class RageDetector {
  private target: string | null = null
  private stamps: number[] = []
  private routeAtStart = ''
  private fired = false

  constructor(private cfg: TelemetryConfig['rage']) {}

  onClick(target: string, ts: number, route: string): RageHit | null {
    const last = this.stamps[this.stamps.length - 1]
    if (this.target !== target || (last !== undefined && ts - last > this.cfg.windowMs)) {
      this.target = target
      this.stamps = []
      this.routeAtStart = route
      this.fired = false
    }
    this.stamps.push(ts)
    this.stamps = this.stamps.filter(t => ts - t <= this.cfg.windowMs)
    if (this.fired) return null
    const navigated = route !== this.routeAtStart
    const needed = navigated ? this.cfg.countIfNavigated : this.cfg.count
    if (this.stamps.length >= needed) {
      this.fired = true
      return { count: this.stamps.length, navigated }
    }
    return null
  }
}
