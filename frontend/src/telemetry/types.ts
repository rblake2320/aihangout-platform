// Shared contract between the browser client and POST /api/analytics/batch.
// The worker keeps its own allowlist; test/session-telemetry.test.js asserts the two agree.

export const EVENT_TYPES = [
  'page_view',
  'page_leave',
  'rage_click',
  'dead_click',
  'form_abandon',
  'client_error',
  'net_fail',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export interface TelemetryEvent {
  type: EventType
  /** Client clock, epoch ms. The server stamps its own receive time as well. */
  ts: number
  /** Sanitized route (path only, no query or hash). */
  route: string
  data: Record<string, string | number | boolean>
}

export interface TelemetryBatch {
  session_id: string
  events: TelemetryEvent[]
}

export interface TelemetryConfig {
  endpoint: string
  /** 0..1, decided once per session. */
  sampleRate: number
  rage: { count: number; countIfNavigated: number; windowMs: number }
  deadClickMs: number
  /** No input for this long counts as idle time rather than active time. */
  idleMs: number
  scrollSampleMs: number
  batch: { maxEvents: number; maxBytes: number; flushIntervalMs: number; maxQueue: number }
  backoff: { baseMs: number; maxMs: number }
  maxErrorsPerPage: number
}

// Rage, scroll sampling and backoff ceiling follow behaviour recovered from the
// reference products (see docs/telemetry-reconstruction.md). deadClickMs, idleMs and
// the batch limits are our own design choices; the reference values were not recovered.
export const DEFAULT_CONFIG: TelemetryConfig = {
  endpoint: '/api/analytics/batch',
  sampleRate: 1,
  rage: { count: 5, countIfNavigated: 8, windowMs: 2000 },
  deadClickMs: 1000,
  idleMs: 30_000,
  scrollSampleMs: 50,
  batch: { maxEvents: 20, maxBytes: 48_000, flushIntervalMs: 10_000, maxQueue: 500 },
  backoff: { baseMs: 2000, maxMs: 300_000 },
  maxErrorsPerPage: 50,
}
