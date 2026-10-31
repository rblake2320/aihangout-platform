// Canonical problem URL (AIH-R2): /problem/<public_id>/<slug>. The server sends `slug`
// on feed rows and problem detail; rows without a public_id fall back to the legacy
// integer URL, which the Worker 301s to the canonical one.
export function problemPath(p: { id?: number | string; public_id?: string | null; slug?: string | null }): string {
  if (p.public_id) return `/problem/${p.public_id}/${p.slug || 'problem'}`
  return `/problem/${p.id}`
}
