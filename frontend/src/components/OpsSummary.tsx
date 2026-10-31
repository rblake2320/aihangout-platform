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
