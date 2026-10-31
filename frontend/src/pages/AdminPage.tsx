import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api, bugReportAPI } from '../services/api'
import { ShieldCheckIcon, FlagIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { formatDistanceToNow } from 'date-fns'
import BugReportsReview from '../components/BugReportsReview'
import OpsSummary from '../components/OpsSummary'
import CampaignsAdmin from '../components/CampaignsAdmin'

export default function AdminPage() {
  const [tab, setTab] = useState<'reports' | 'flagged' | 'bugs' | 'ops' | 'campaigns'>('ops')
  // Login's user DTO omits is_admin. Use the existing server-enforced admin
  // endpoint rather than trusting a missing or stale browser-stored flag.
  const access = useQuery({ queryKey: ['admin-bug-reports'], queryFn: () => bugReportAPI.list({ limit: 50 }), retry: false })
  if (access.isLoading) return <p role="status">Checking admin access…</p>

  if (access.isError) {
    return (
      <div className="max-w-2xl mx-auto text-center py-20">
        <ShieldCheckIcon className="w-16 h-16 mx-auto text-gray-300 mb-4" />
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Admin access unavailable</h1>
        <p className="text-gray-500">{(access.error as any)?.response?.status === 403 ? 'You need admin privileges to access this page.' : 'Could not check access. Please retry.'}</p>
        <button onClick={() => access.refetch()} className="mt-3 underline">Retry</button>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center space-x-3">
        <ShieldCheckIcon className="w-8 h-8 text-blue-600" />
        <h1 className="text-2xl font-bold text-gray-900">Moderation Dashboard</h1>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200">
        <button onClick={() => setTab('ops')} className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'ops' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500'}`}>Ops</button>
        <button onClick={() => setTab('bugs')} className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'bugs' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500'}`}>Bug Reports</button>
        <button onClick={() => setTab('campaigns')} className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'campaigns' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500'}`}>Campaigns</button>
        <button
          onClick={() => setTab('reports')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === 'reports' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
        >
          <span className="flex items-center space-x-1">
            <FlagIcon className="w-4 h-4" />
            <span>User Reports</span>
          </span>
        </button>
        <button
          onClick={() => setTab('flagged')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === 'flagged' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
        >
          <span className="flex items-center space-x-1">
            <ExclamationTriangleIcon className="w-4 h-4" />
            <span>Injection Flags</span>
          </span>
        </button>
      </div>

      {tab === 'reports' && <ReportsTab />}
      {tab === 'flagged' && <FlaggedTab />}
      {tab === 'bugs' && <BugReportsReview />}
      {tab === 'ops' && <OpsSummary />}
      {tab === 'campaigns' && <CampaignsAdmin />}
    </div>
  )
}

function ReportsTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-reports'],
    queryFn: () => api.get('/admin/reports?status=pending&limit=50'),
  })

  const reports = data?.data?.reports || []

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading reports...</div>
  if (reports.length === 0) return (
    <div className="text-center py-12 text-gray-500">
      <FlagIcon className="w-12 h-12 mx-auto mb-3 text-gray-300" />
      <p>No pending reports</p>
    </div>
  )

  return (
    <div className="space-y-3">
      {reports.map((r: any) => (
        <div key={r.id} className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-start justify-between">
            <div>
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${r.content_type === 'problem' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'}`}>
                {r.content_type} #{r.content_id}
              </span>
              <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                {r.reason}
              </span>
            </div>
            <span className="text-xs text-gray-400">{formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}</span>
          </div>
          {r.details && <p className="text-sm text-gray-600 mt-2 italic">"{r.details}"</p>}
          <div className="flex items-center justify-between mt-3">
            <span className="text-xs text-gray-500">Reported by: <span className="font-medium">{r.reporter_username}</span></span>
            <Link
              to={r.content_type === 'problem' ? `/problem/${r.content_id}` : `/problem/${r.content_id}`}
              className="text-xs text-blue-600 hover:underline"
            >
              View content →
            </Link>
          </div>
        </div>
      ))}
    </div>
  )
}

function FlaggedTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-flagged'],
    queryFn: () => api.get('/admin/flagged-content'),
  })

  const flaggedProblems = data?.data?.problems || []
  const flaggedSolutions = data?.data?.solutions || []

  if (isLoading) return <div className="text-center py-8 text-gray-400">Loading flagged content...</div>

  if (flaggedProblems.length === 0 && flaggedSolutions.length === 0) return (
    <div className="text-center py-12 text-gray-500">
      <ExclamationTriangleIcon className="w-12 h-12 mx-auto mb-3 text-gray-300" />
      <p>No flagged content</p>
    </div>
  )

  return (
    <div className="space-y-6">
      {flaggedProblems.length > 0 && (
        <div>
          <h3 className="font-semibold text-gray-700 mb-3">Flagged Problems ({flaggedProblems.length})</h3>
          <div className="space-y-3">
            {flaggedProblems.map((p: any) => (
              <div key={p.id} className="bg-white rounded-lg border border-orange-200 p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <Link to={`/problem/${p.id}`} className="font-medium text-gray-900 hover:text-blue-600 text-sm">{p.title}</Link>
                    <div className="mt-1">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800">
                        {p.moderation_flag}
                      </span>
                    </div>
                  </div>
                  <span className="text-xs text-gray-400">by {p.username}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {flaggedSolutions.length > 0 && (
        <div>
          <h3 className="font-semibold text-gray-700 mb-3">Flagged Solutions ({flaggedSolutions.length})</h3>
          <div className="space-y-3">
            {flaggedSolutions.map((s: any) => (
              <div key={s.id} className="bg-white rounded-lg border border-orange-200 p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <Link to={`/problem/${s.problem_id}`} className="text-sm text-gray-700 hover:text-blue-600 line-clamp-2">{s.solution_text?.slice(0, 120)}...</Link>
                    <div className="mt-1">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800">
                        {s.moderation_flag}
                      </span>
                    </div>
                  </div>
                  <span className="text-xs text-gray-400">by {s.username}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
