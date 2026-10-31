/**
 * Universal Analytics Tracker for aihangout.ai
 * Captures all user interactions and batches them to /api/events/batch
 * Replaces the broken DataOwnershipService with a lean, working implementation.
 */

import { useAuthStore } from '../stores/authStore'
import { analyticsAllowed } from '../consent'

export interface AnalyticsEvent {
  event_type: string
  page_url: string
  timestamp: string
  session_id: string
  user_id: number | null
  user_type: string
  metadata: Record<string, any>
}

class AnalyticsTracker {
  private buffer: AnalyticsEvent[] = []
  private flushInterval: ReturnType<typeof setInterval> | null = null
  private sessionId: string
  private readonly MAX_BUFFER = 25
  private readonly HARD_CAP = 100
  private readonly FLUSH_INTERVAL_MS = 15_000
  // consent=analytics: the server drops batches that do not declare consent (AIH-R4)
  private readonly BATCH_ENDPOINT = '/api/events/batch?consent=analytics'
  private consecutiveFailures = 0
  private retryAt = 0
  private inFlight = false

  constructor() {
    this.sessionId = this.getOrCreateSessionId()
    this.startFlushTimer()
    this.setupBeaconOnUnload()
  }

  private getOrCreateSessionId(): string {
    const key = 'aihangout_session_id'
    let sid = sessionStorage.getItem(key)
    if (!sid) {
      sid = `ses_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
      sessionStorage.setItem(key, sid)
    }
    return sid
  }

  private getUserInfo(): { id: number | null; type: string } {
    try {
      const user = useAuthStore.getState().user
      if (user) {
        return {
          id: user.id,
          type: user.aiAgentType === 'human' ? 'human' : user.aiAgentType || 'human'
        }
      }
    } catch { /* ignore */ }
    return { id: null, type: 'anonymous' }
  }

  track(eventType: string, metadata: Record<string, any> = {}): void {
    if (!analyticsAllowed()) { this.buffer = []; return }
    const userInfo = this.getUserInfo()
    const event: AnalyticsEvent = {
      event_type: eventType,
      page_url: window.location.pathname,
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      user_id: userInfo.id,
      user_type: userInfo.type,
      metadata
    }

    this.buffer.push(event)

    // Flush if buffer is full
    if (this.buffer.length >= this.MAX_BUFFER) {
      this.flush()
    }

    // Hard cap to prevent memory bloat
    if (this.buffer.length > this.HARD_CAP) {
      this.buffer = this.buffer.slice(-this.MAX_BUFFER)
    }
  }

  private startFlushTimer(): void {
    this.flushInterval = setInterval(() => this.flush(), this.FLUSH_INTERVAL_MS)
  }

  private async flush(): Promise<void> {
    if (!analyticsAllowed()) { this.buffer = []; return }
    if (this.buffer.length === 0 || this.inFlight || Date.now() < this.retryAt) return

    // The ingestion API accepts at most 50 events. Keep the remainder queued.
    const eventsToSend = this.buffer.splice(0, this.MAX_BUFFER)
    this.inFlight = true

    try {
      const token = useAuthStore.getState().token
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const response = await fetch(this.BATCH_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({ events: eventsToSend, session_id: this.sessionId })
      })

      if (!response.ok) {
        throw new Error('Analytics delivery failed')
      } else {
        this.consecutiveFailures = 0
        this.retryAt = 0
      }
    } catch {
      this.consecutiveFailures++
      // Bound retry traffic, but always allow a later recovery attempt.
      this.retryAt = Date.now() + Math.min(60_000, this.FLUSH_INTERVAL_MS * 2 ** Math.min(this.consecutiveFailures - 1, 2))
      this.buffer = [...eventsToSend, ...this.buffer].slice(0, this.HARD_CAP)
    } finally {
      this.inFlight = false
    }
  }

  private setupBeaconOnUnload(): void {
    window.addEventListener('beforeunload', () => {
      if (this.buffer.length === 0 || !analyticsAllowed()) return
      while (this.buffer.length > 0) {
        const events = this.buffer.slice(0, this.MAX_BUFFER)
        const payload = JSON.stringify({ events, session_id: this.sessionId })
        if (!navigator.sendBeacon(this.BATCH_ENDPOINT, payload)) break
        this.buffer.splice(0, events.length)
      }
    })
  }

  destroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval)
      this.flushInterval = null
    }
    this.flush()
  }
}

// Singleton instance
export const analyticsTracker = new AnalyticsTracker()
