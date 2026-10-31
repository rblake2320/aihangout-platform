import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { api } from '../services/api'
import { parseApiDate } from '../utils/date'

type Failure = { timestamp: string; user_id: number | null; username: string | null; ip_address: string | null; path: string | null; kind: string; reason: string; [k: string]: any }
type Summary = {
  window_hours: number
  failures: { total: number; by_kind: Array<{ kind: string; reason: string; count: number }>; recent: Failure[] }
  logins: { logins: number; distinct_users: number; recent: Array<{ timestamp: string; user_id: number; username: string | null; ai_agent_type: string | null; ip_address: string | null }> }
  registrations: { registrations: number; verified: number }
  active_sessions: Array<{ user_id: number; username: string | null; user_type: string; last_seen: string; page_count: number; activity_score: number; ip_address: string | null }>
  client_errors: number
  telemetry?: {
    events: number
    sessions: number
    sessions_by_duration: Array<{ label: string; sessions: number }>
    median_active_ms: number | null
    frustration_by_page: Array<{ page: string; rage_clicks: number; dead_clicks: number }>
    top_client_errors: Array<{ fingerprint: string | null; message: string | null; count: number; sessions: number; last_page: string | null }>
    scroll_depth_by_page: Array<{ page: string; views: number; avg_max_scroll_pct: number | null }>
  }
}

const dur = (ms: number | null) => {
  if (ms === null) return '–'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

const ago = (ts: string) => { try { return formatDistanceToNow(parseApiDate(ts), { addSuffix: true }) } catch { return ts } }

export default function OpsSummary() {
  const [hours, setHours] = useState(24)
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin-ops-summary', hours],
    queryFn: async () => (await api.get<Summary>(`/admin/ops-summary?hours=${hours}`)).data,
    refetchInterval: 60_000,
  })

  if (isLoading) return <p role="status">Loading ops summary…</p>
  if (isError || !data) return <p className="text-red-700">Could not load ops summary. <button className="underline" onClick={() => refetch()}>Retry</button></p>

  const stat = (label: string, value: number | string, tone = 'text-gray-900') => (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-2xl font-bold ${tone}`}>{value}</div>
    </div>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Ops — last {data.window_hours}h</h2>
        <select value={hours} onChange={e => setHours(Number(e.target.value))} className="border border-gray-300 rounded-md text-sm px-2 py-1">
          {[1, 6, 24, 72, 168].map(h => <option key={h} value={h}>{h}h</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {stat('Failures', data.failures.total, data.failures.total ? 'text-red-700' : 'text-green-700')}
        {stat('Client errors', data.client_errors, data.client_errors ? 'text-red-700' : 'text-green-700')}
        {stat('Logins', `${data.logins.logins} / ${data.logins.distinct_users} users`)}
        {stat('Registrations', `${data.registrations.registrations} (${data.registrations.verified} verified)`)}
        {stat('Active sessions', data.active_sessions.length)}
      </div>

      {data.telemetry && (
        <section className="space-y-4">
          <h3 className="font-medium text-gray-900">Session telemetry</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {stat('Sessions measured', data.telemetry.sessions)}
            {stat('Median active time', dur(data.telemetry.median_active_ms))}
            {stat('Telemetry events', data.telemetry.events)}
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-3">
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">Sessions by duration</div>
            <ul className="space-y-1 text-sm">{data.telemetry.sessions_by_duration.map(b => {
              const max = Math.max(1, ...data.telemetry!.sessions_by_duration.map(x => x.sessions))
              return (
                <li key={b.label} className="flex items-center gap-2">
                  <span className="w-16 text-gray-500">{b.label}</span>
                  <span className="h-3 bg-blue-500 rounded" style={{ width: `${(b.sessions / max) * 60}%` }} />
                  <span>{b.sessions}</span>
                </li>
              )
            })}</ul>
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h4 className="text-sm font-medium text-gray-900 mb-1">Rage / dead clicks per page</h4>
              {data.telemetry.frustration_by_page.length === 0 ? <p className="text-sm text-gray-500">None.</p> : (
                <table className="w-full text-sm bg-white rounded-lg border border-gray-200">
                  <thead><tr className="text-left text-gray-500"><th className="p-2">Page</th><th className="p-2 text-right">Rage</th><th className="p-2 text-right">Dead</th></tr></thead>
                  <tbody>{data.telemetry.frustration_by_page.map((r, i) => (
                    <tr key={i} className="border-t border-gray-100"><td className="p-2 font-mono text-xs break-all">{r.page}</td><td className="p-2 text-right">{r.rage_clicks}</td><td className="p-2 text-right">{r.dead_clicks}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </div>
            <div>
              <h4 className="text-sm font-medium text-gray-900 mb-1">Scroll depth by page</h4>
              {data.telemetry.scroll_depth_by_page.length === 0 ? <p className="text-sm text-gray-500">None.</p> : (
                <table className="w-full text-sm bg-white rounded-lg border border-gray-200">
                  <thead><tr className="text-left text-gray-500"><th className="p-2">Page</th><th className="p-2 text-right">Views</th><th className="p-2 text-right">Avg max scroll</th></tr></thead>
                  <tbody>{data.telemetry.scroll_depth_by_page.map((r, i) => (
                    <tr key={i} className="border-t border-gray-100"><td className="p-2 font-mono text-xs break-all">{r.page}</td><td className="p-2 text-right">{r.views}</td><td className="p-2 text-right">{r.avg_max_scroll_pct ?? '–'}%</td></tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          </div>
          <div>
            <h4 className="text-sm font-medium text-gray-900 mb-1">Top client errors</h4>
            {data.telemetry.top_client_errors.length === 0 ? <p className="text-sm text-gray-500">None in this window.</p> : (
              <ul className="space-y-1 text-sm">{data.telemetry.top_client_errors.map((e, i) => (
                <li key={i} className="bg-white rounded border border-gray-200 p-2 flex flex-wrap gap-x-3">
                  <span className="font-medium">{e.count}×</span>
                  <span className="font-mono text-xs break-all">{e.message}</span>
                  <span className="text-gray-500">{e.sessions} session{e.sessions === 1 ? '' : 's'}</span>
                  {e.last_page && <span className="text-gray-400">{e.last_page}</span>}
                </li>
              ))}</ul>
            )}
          </div>
        </section>
      )}

      <section>
        <h3 className="font-medium text-gray-900 mb-2">Failures by kind</h3>
        {data.failures.by_kind.length === 0 ? <p className="text-sm text-gray-500">None in this window.</p> : (
          <table className="w-full text-sm bg-white rounded-lg border border-gray-200">
            <thead><tr className="text-left text-gray-500"><th className="p-2">Kind</th><th className="p-2">Reason</th><th className="p-2 text-right">Count</th></tr></thead>
            <tbody>{data.failures.by_kind.map((r, i) => (
              <tr key={i} className="border-t border-gray-100"><td className="p-2">{r.kind}</td><td className="p-2 font-mono text-xs">{r.reason}</td><td className="p-2 text-right">{r.count}</td></tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section>
        <h3 className="font-medium text-gray-900 mb-2">Recent failures</h3>
        {data.failures.recent.length === 0 ? <p className="text-sm text-gray-500">None.</p> : (
          <ul className="space-y-1 text-sm">{data.failures.recent.map((f, i) => (
            <li key={i} className="bg-white rounded border border-gray-200 p-2 flex flex-wrap gap-x-3">
              <span className="text-gray-500">{ago(f.timestamp)}</span>
              <span className="font-medium">{f.kind}</span>
              <span className="font-mono text-xs break-all">{f.reason}</span>
              {f.username && <span>user: {f.username}</span>}
              {f.identifier && <span>tried: {f.identifier}</span>}
              {f.ip_address && <span className="text-gray-400">{f.ip_address}</span>}
            </li>
          ))}</ul>
        )}
      </section>

      <div className="grid md:grid-cols-2 gap-6">
        <section>
          <h3 className="font-medium text-gray-900 mb-2">Recent logins</h3>
          {data.logins.recent.length === 0 ? <p className="text-sm text-gray-500">None.</p> : (
            <ul className="space-y-1 text-sm">{data.logins.recent.map((l, i) => (
              <li key={i} className="bg-white rounded border border-gray-200 p-2 flex gap-x-3">
                <span className="text-gray-500">{ago(l.timestamp)}</span>
                <span className="font-medium">{l.username ?? `#${l.user_id}`}</span>
                <span className="text-gray-400">{l.ai_agent_type}</span>
                <span className="text-gray-400">{l.ip_address}</span>
              </li>
            ))}</ul>
          )}
        </section>
        <section>
          <h3 className="font-medium text-gray-900 mb-2">Active sessions</h3>
          {data.active_sessions.length === 0 ? <p className="text-sm text-gray-500">None.</p> : (
            <ul className="space-y-1 text-sm">{data.active_sessions.map((s, i) => (
              <li key={i} className="bg-white rounded border border-gray-200 p-2 flex gap-x-3">
                <span className="font-medium">{s.username ?? `#${s.user_id}`}</span>
                <span className="text-gray-400">{s.user_type}</span>
                <span>{s.page_count} heartbeats</span>
                <span className="text-gray-500">last seen {ago(s.last_seen)}</span>
              </li>
            ))}</ul>
          )}
        </section>
      </div>
    </div>
  )
}
