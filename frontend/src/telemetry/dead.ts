export interface DeadClickHit { target: string; waitMs: number }

type Timer = (fn: () => void, ms: number) => unknown
type Cancel = (handle: unknown) => void

/**
 * A click on something that looks interactive, followed by no observable reaction
 * (DOM mutation, route change, focus move, scroll) within `waitMs`, is a dead click.
 * Callers report reactions through noteReaction(); the clock is injectable for tests.
 */
export class DeadClickDetector {
  private pending: { handle: unknown; target: string } | null = null

  constructor(
    private waitMs: number,
    private onDead: (hit: DeadClickHit) => void,
    private schedule: Timer = (fn, ms) => setTimeout(fn, ms),
    private cancel: Cancel = h => clearTimeout(h as ReturnType<typeof setTimeout>),
  ) {}

  onClick(target: string): void {
    this.noteReaction()
    const handle = this.schedule(() => {
      this.pending = null
      this.onDead({ target, waitMs: this.waitMs })
    }, this.waitMs)
    this.pending = { handle, target }
  }

  noteReaction(): void {
    if (this.pending) {
      this.cancel(this.pending.handle)
      this.pending = null
    }
  }
}

const INTERACTIVE = new Set(['a', 'button', 'summary', 'select', 'label'])

export interface CandidateAttrs {
  type?: string | null
  role?: string | null
  target?: string | null
  download?: boolean
  href?: string | null
  disabled?: boolean
}

/** Elements where the browser itself reacts without touching the DOM are not candidates. */
export function isDeadClickCandidate(tag: string, attrs: CandidateAttrs): boolean {
  const t = tag.toLowerCase()
  if (attrs.disabled) return false
  if (t === 'button' && (!attrs.type || attrs.type === 'submit')) return false // submit is observed via the form
  const href = attrs.href || ''
  if (t === 'a' && (attrs.target === '_blank' || attrs.download || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:'))) return false
  return INTERACTIVE.has(t) || attrs.role === 'button' || attrs.role === 'link'
}
