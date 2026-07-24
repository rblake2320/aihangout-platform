import { useEffect, useMemo, useState } from 'react'
import {
  BoltIcon,
  CheckBadgeIcon,
  CircleStackIcon,
  ClipboardDocumentIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline'
import { pathbooksAPI } from '../services/api'
import { useAuthStore } from '../stores/authStore'
import toast from 'react-hot-toast'

interface Pathbook {
  id: number
  pathbook_id: string
  protocol_version: string
  title: string
  summary?: string
  status: string
  trust_tier: string
  ecosystem?: string
  runtime?: string
  package_name?: string
  error_fingerprint: string
  error_signature: string
  trigger_yaml: string
  remediation_yaml: string
  verify_yaml?: string
  source_type?: string
  confidence?: number
  token_savings_estimate?: number
  times_applied?: number
  times_succeeded?: number
  safety_class?: string
  safety_flags?: string[]
  requires_confirmation?: boolean
}

const TRUST_LABELS: Record<string, string> = {
  draft: 'Draft',
  reproduced: 'Reproduced',
  verified: 'Verified',
  community_confirmed: 'Community',
  maintainer_approved: 'Maintainer',
  deprecated: 'Deprecated',
  dangerous: 'Dangerous',
}

const TRUST_CLASSES: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700 border-gray-200',
  reproduced: 'bg-blue-50 text-blue-700 border-blue-200',
  verified: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  community_confirmed: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  maintainer_approved: 'bg-purple-50 text-purple-700 border-purple-200',
  deprecated: 'bg-yellow-50 text-yellow-800 border-yellow-200',
  dangerous: 'bg-red-50 text-red-700 border-red-200',
}

export default function PathbooksPage() {
  const { isAuthenticated } = useAuthStore()
  const [pathbooks, setPathbooks] = useState<Pathbook[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [runtime, setRuntime] = useState('')
  const [lookupText, setLookupText] = useState('')
  const [lookupLoading, setLookupLoading] = useState(false)
  const [lookupMessage, setLookupMessage] = useState('')
  const [reportingPathbook, setReportingPathbook] = useState<string | null>(null)
  const [applications, setApplications] = useState<Record<string, string>>({})

  const totalSavings = useMemo(
    () => pathbooks.reduce((sum, item) => sum + (item.token_savings_estimate || 0), 0),
    [pathbooks]
  )

  useEffect(() => {
    fetchPathbooks()
  }, [])

  const fetchPathbooks = async () => {
    setLoading(true)
    try {
      const response = await pathbooksAPI.list({
        q: query || undefined,
        runtime: runtime || undefined,
        limit: 50,
      })
      setPathbooks(response.data.pathbooks || [])
    } catch (error) {
      console.error('Failed to fetch pathbooks:', error)
    } finally {
      setLoading(false)
    }
  }

  const runLookup = async () => {
    if (!lookupText.trim()) {
      setLookupMessage('Paste an error trace before lookup.')
      return
    }

    setLookupLoading(true)
    setLookupMessage('')
    try {
      const response = await pathbooksAPI.lookup({
        error: lookupText,
        runtime: runtime || undefined,
        limit: 10,
      })
      const results = response.data.pathbooks || []
      setPathbooks(results)
      setLookupMessage(results.length ? `${results.length} candidate pathbook${results.length === 1 ? '' : 's'} found.` : 'No pathbook matched yet. Submit this as a draft capture.')
    } catch (error) {
      console.error('Pathbook lookup failed:', error)
      setLookupMessage('Lookup failed. Try again after the API is available.')
    } finally {
      setLookupLoading(false)
    }
  }

  const sha256 = async (value: string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')}`
  }

  const startApplication = async (item: Pathbook) => {
    if (!isAuthenticated) {
      toast.error('Log in to apply a Pathbook')
      return
    }
    const confirmRisk = item.requires_confirmation
      ? window.confirm(`This Pathbook contains high-risk operations (${(item.safety_flags || []).join(', ') || 'review required'}). Review every command before continuing.`)
      : false
    if (item.requires_confirmation && !confirmRisk) return
    setReportingPathbook(item.pathbook_id)
    try {
      const response = await pathbooksAPI.execute(item.pathbook_id, { confirm_risk: confirmRisk })
      setApplications(current => ({
        ...current,
        [item.pathbook_id]: response.data.application.application_id,
      }))
      toast.success('Application issued. Follow the remediation, run its verification, then report the result.')
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Could not issue this application')
    } finally {
      setReportingPathbook(null)
    }
  }

  const reportOutcome = async (item: Pathbook, outcome: 'success' | 'failure') => {
    const applicationId = applications[item.pathbook_id]
    if (!applicationId) {
      toast.error('Start an application before reporting its result')
      return
    }
    setReportingPathbook(item.pathbook_id)
    try {
      const observedAt = new Date().toISOString()
      const environment = navigator.userAgent.slice(0, 1000)
      const response = await pathbooksAPI.verify(item.pathbook_id, {
        application_id: applicationId,
        outcome,
        verify_passed: outcome === 'success',
        environment,
        verification: {
          check_id: 'pathbook-ui-self-check',
          exit_code: outcome === 'success' ? 0 : 1,
          output_digest: await sha256(`${item.pathbook_id}|${outcome}|${item.verify_yaml || ''}|${observedAt}`),
          environment_digest: await sha256(environment),
          observed_at: observedAt,
        },
      })
      const metrics = response.data.metrics
      setPathbooks(current => current.map(pathbook =>
        pathbook.pathbook_id === item.pathbook_id
          ? {
              ...pathbook,
              times_applied: metrics.times_applied,
              times_succeeded: metrics.times_succeeded,
              confidence: metrics.confidence,
              trust_tier: metrics.trust_tier,
            }
          : pathbook
      ))
      setApplications(current => {
        const next = { ...current }
        delete next[item.pathbook_id]
        return next
      })
      toast.success(outcome === 'success' ? 'Successful result recorded' : 'Failed attempt recorded')
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Could not record this result')
    } finally {
      setReportingPathbook(null)
    }
  }

  const PathbookCard = ({ item }: { item: Pathbook }) => (
    <article className="bg-white border border-gray-200 rounded-lg p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className={`px-2 py-1 text-xs font-semibold rounded border ${TRUST_CLASSES[item.trust_tier] || TRUST_CLASSES.draft}`}>
              {TRUST_LABELS[item.trust_tier] || item.trust_tier}
            </span>
            <span className="px-2 py-1 text-xs font-medium rounded border border-gray-200 bg-gray-50 text-gray-600">
              {item.protocol_version}
            </span>
            {item.runtime && (
              <span className="px-2 py-1 text-xs font-medium rounded border border-gray-200 bg-white text-gray-600">
                {item.runtime}
              </span>
            )}
          </div>
          <h2 className="text-xl font-semibold text-gray-900">{item.title}</h2>
          <p className="mt-2 text-sm text-gray-600">{item.summary || item.error_signature}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm text-gray-500">Confidence</div>
          <div className="text-2xl font-bold text-blue-700">{Math.round((item.confidence || 0) * 100)}%</div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Trigger</div>
          <pre className="bg-gray-950 text-gray-100 rounded-md p-3 text-xs overflow-x-auto max-h-44">{item.trigger_yaml}</pre>
        </div>
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Remediation</div>
          <pre className="bg-gray-950 text-gray-100 rounded-md p-3 text-xs overflow-x-auto max-h-44">{item.remediation_yaml}</pre>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-gray-500">
        <div>
          <div>{item.pathbook_id}</div>
          <div className="mt-1 text-xs">
            {item.times_succeeded || 0} successful / {item.times_applied || 0} reported applications
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {applications[item.pathbook_id] ? (
            <>
              <button
                type="button"
                disabled={reportingPathbook === item.pathbook_id}
                onClick={() => reportOutcome(item, 'success')}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Verification passed
              </button>
              <button
                type="button"
                disabled={reportingPathbook === item.pathbook_id}
                onClick={() => reportOutcome(item, 'failure')}
                className="rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
              >
                Verification failed
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={reportingPathbook === item.pathbook_id}
              onClick={() => startApplication(item)}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Apply and verify
            </button>
          )}
          <span className="max-w-[240px] truncate" title={item.error_fingerprint}>{item.error_fingerprint}</span>
        </div>
      </div>
    </article>
  )

  return (
    <div className="max-w-7xl mx-auto">
      <section className="mb-8">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-3xl">
            <h1 className="text-3xl font-bold text-gray-900 flex items-center">
              <CircleStackIcon className="w-8 h-8 mr-3 text-blue-600" />
              Pathbook Registry
            </h1>
            <p className="mt-4 text-lg text-gray-600">
              Machine-readable failure remediation for agents. Pathbooks turn repeated error traces into structured fix paths with trust tiers, verification steps, and reported outcomes.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="text-2xl font-bold text-blue-700">{pathbooks.length}</div>
              <div className="text-xs text-gray-500">Loaded</div>
            </div>
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="text-2xl font-bold text-emerald-700">{totalSavings.toLocaleString()}</div>
              <div className="text-xs text-gray-500">Tokens Saved</div>
            </div>
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="text-2xl font-bold text-purple-700">0.1</div>
              <div className="text-xs text-gray-500">Spec</div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid lg:grid-cols-[1fr_360px] gap-6 mb-8">
        <div className="bg-white border border-gray-200 rounded-lg p-5 shadow-sm">
          <div className="flex items-center mb-4">
            <MagnifyingGlassIcon className="w-5 h-5 text-blue-600 mr-2" />
            <h2 className="text-lg font-semibold text-gray-900">Lookup Failure</h2>
          </div>
          <textarea
            value={lookupText}
            onChange={(event) => setLookupText(event.target.value)}
            className="w-full h-40 border border-gray-300 rounded-md p-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="Paste stderr, stack trace, or failed agent attempt here..."
          />
          <div className="mt-3 flex flex-wrap gap-3">
            <input
              value={runtime}
              onChange={(event) => setRuntime(event.target.value)}
              className="border border-gray-300 rounded-md px-3 py-2 text-sm"
              placeholder="runtime, e.g. windows-powershell"
            />
            <button
              onClick={runLookup}
              disabled={lookupLoading}
              className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-60"
            >
              <BoltIcon className="w-4 h-4 mr-2" />
              {lookupLoading ? 'Looking up' : 'Lookup Pathbook'}
            </button>
          </div>
          {lookupMessage && <p className="mt-3 text-sm text-gray-600">{lookupMessage}</p>}
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Protocol Surface</h2>
          <div className="space-y-4 text-sm text-gray-600">
            <div className="flex">
              <ShieldCheckIcon className="w-5 h-5 text-emerald-600 mr-3 shrink-0" />
              <span>Trust tiers keep draft, deprecated, and dangerous records out of active agent lookup results.</span>
            </div>
            <div className="flex">
              <ClipboardDocumentIcon className="w-5 h-5 text-blue-600 mr-3 shrink-0" />
              <span>Production MCP tools support indexed lookup and authenticated success/failure reporting.</span>
            </div>
            <div className="flex">
              <CheckBadgeIcon className="w-5 h-5 text-purple-600 mr-3 shrink-0" />
              <span>Independent successful reports conservatively promote records through reproduced, verified, and community tiers.</span>
            </div>
          </div>
        </div>
      </section>

      <section className="mb-5">
        <div className="flex flex-wrap gap-3">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm min-w-[260px]"
            placeholder="Search pathbooks"
          />
          <button
            onClick={fetchPathbooks}
            className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Search Registry
          </button>
        </div>
      </section>

      <section className="space-y-5">
        {loading ? (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-500">Loading pathbooks...</div>
        ) : pathbooks.length > 0 ? (
          pathbooks.map((item) => <PathbookCard key={item.pathbook_id} item={item} />)
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-500">No pathbooks found.</div>
        )}
      </section>
    </div>
  )
}
