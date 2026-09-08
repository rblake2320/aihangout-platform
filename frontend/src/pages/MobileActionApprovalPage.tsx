import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheckIcon, ClockIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { formatDistanceToNow } from 'date-fns'
import { mobileApprovalAPI } from '../services/api'
import { parseApiDate } from '../utils/date'

// Fixed, shared literal with src/worker.js's REQUIRED_CONFIRM_PHRASE constant
// (POST /api/mobile/actions/:actionId/approve). Not fetched from any API --
// it's a hardcoded server constant, so it's hardcoded here too. Displaying it
// as an on-screen instruction is the legitimate path: the adversarial-review
// fix on the backend only stops a *scripted* caller from discovering it via
// a failed API response; a real human reading this screen is exactly who is
// meant to read and type it.
const REQUIRED_CONFIRM_PHRASE = 'I APPROVE THIS SEND'

const CAPABILITY_LABELS: Record<string, string> = {
  device_diagnostics_read: 'Read device diagnostics',
  battery_status_read: 'Read battery status',
  network_status_read: 'Read network status',
  ui_read_screen: 'Read what is on screen',
  ui_click: 'Tap on screen',
  ui_type: 'Type text',
  screenshot_capture: 'Capture a screenshot',
  sms_send: 'Send a text message',
  call_make: 'Make a phone call',
  email_send: 'Send an email',
}

const RISK_TIER_STYLES: Record<string, string> = {
  read_only: 'bg-green-100 text-green-800',
  device_ui_action: 'bg-yellow-100 text-yellow-800',
  communication_send: 'bg-red-100 text-red-800',
}

const RISK_TIER_LABELS: Record<string, string> = {
  read_only: 'Read-only',
  device_ui_action: 'On-device action',
  communication_send: 'Leaves the device (real-world effect)',
}

function TerminalState({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
      <div className="flex justify-center mb-3">{icon}</div>
      <h2 className="text-lg font-semibold text-gray-900 mb-1">{title}</h2>
      <p className="text-sm text-gray-500">{detail}</p>
    </div>
  )
}

export default function MobileActionApprovalPage() {
  const { actionId } = useParams<{ actionId: string }>()
  const queryClient = useQueryClient()
  const [confirmPhraseInput, setConfirmPhraseInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [approveError, setApproveError] = useState<string | null>(null)

  const queryKey = ['mobile-action', actionId]
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await mobileApprovalAPI.get(actionId!)
      return res.data
    },
    enabled: !!actionId,
    // This screen only matters while a decision hasn't been made yet -- once
    // the intent is in a terminal state there is nothing to keep polling for.
    // TanStack Query v4 (this project's version) passes the query's *data*
    // as the first argument here, not a v5-style query object.
    refetchInterval: (fetchedData: any) => {
      const s = fetchedData?.intent?.status
      return s === 'awaiting_approval' ? 15000 : false
    },
  })

  if (isLoading) {
    return (
      <div className="max-w-xl mx-auto mt-8">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 animate-pulse space-y-3">
          <div className="h-5 w-2/3 bg-gray-200 rounded" />
          <div className="h-4 w-1/3 bg-gray-200 rounded" />
          <div className="h-20 bg-gray-200 rounded" />
        </div>
      </div>
    )
  }

  if (isError || !data?.success || !data?.intent) {
    return (
      <div className="max-w-xl mx-auto mt-8">
        <TerminalState
          icon={<ExclamationTriangleIcon className="w-10 h-10 text-gray-400" />}
          title="Action not found"
          detail="This isn't a pending action on your account, or the link is invalid."
        />
      </div>
    )
  }

  const { intent, approval } = data
  const isExpiredByTime = new Date(intent.expires_at) < new Date()
  // Client-side refusal is defense-in-depth, not the real enforcement -- the
  // server re-checks status/digest/expiry/confirm-phrase on every approve
  // call regardless of what this screen renders.
  const isActionable = intent.status === 'awaiting_approval' && !isExpiredByTime
  const requiresConfirmPhrase = intent.risk_tier === 'communication_send'
  const confirmPhraseSatisfied = !requiresConfirmPhrase || confirmPhraseInput === REQUIRED_CONFIRM_PHRASE

  async function handleApprove() {
    setSubmitting(true)
    setApproveError(null)
    try {
      await mobileApprovalAPI.approve(actionId!, {
        actionDigest: intent.action_digest,
        confirmPhrase: requiresConfirmPhrase ? confirmPhraseInput : undefined,
      })
    } catch (err: any) {
      setApproveError(err?.response?.data?.error || 'Approval failed -- see status below.')
    } finally {
      // Fresh status readback: re-fetch the real server state after the
      // approve attempt (success, failure, or already-approved race) rather
      // than trusting the POST response's own echoed status. The rendered
      // outcome below always reflects this refetch, not the mutation result.
      await queryClient.refetchQueries({ queryKey })
      setSubmitting(false)
    }
  }

  if (intent.status === 'approved') {
    return (
      <div className="max-w-xl mx-auto mt-8">
        <TerminalState
          icon={<ShieldCheckIcon className="w-10 h-10 text-green-600" />}
          title="Approved"
          detail={
            approval?.approved_at
              ? `You approved this ${formatDistanceToNow(parseApiDate(approval.approved_at), { addSuffix: true })}.`
              : 'You approved this action.'
          }
        />
      </div>
    )
  }

  if (intent.status === 'expired' || (intent.status === 'awaiting_approval' && isExpiredByTime)) {
    return (
      <div className="max-w-xl mx-auto mt-8">
        <TerminalState
          icon={<ClockIcon className="w-10 h-10 text-gray-400" />}
          title="This request expired"
          detail="Action requests are only valid for 15 minutes. Ask the device to create a new one if it's still needed."
        />
      </div>
    )
  }

  if (intent.status === 'denied') {
    return (
      <div className="max-w-xl mx-auto mt-8">
        <TerminalState
          icon={<ExclamationTriangleIcon className="w-10 h-10 text-gray-400" />}
          title="Denied"
          detail="This action request was denied and will not run."
        />
      </div>
    )
  }

  if (intent.status === 'revoked') {
    return (
      <div className="max-w-xl mx-auto mt-8">
        <TerminalState
          icon={<ExclamationTriangleIcon className="w-10 h-10 text-gray-400" />}
          title="Revoked"
          detail="This action request was revoked and will not run."
        />
      </div>
    )
  }

  return (
    <div className="max-w-xl mx-auto mt-8 space-y-4">
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-lg font-semibold text-gray-900">Approve this action?</h1>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${RISK_TIER_STYLES[intent.risk_tier] || 'bg-gray-100 text-gray-700'}`}>
            {RISK_TIER_LABELS[intent.risk_tier] || intent.risk_tier}
          </span>
        </div>

        <dl className="space-y-3 text-sm mb-4">
          <div>
            <dt className="text-gray-500">Your device wants to</dt>
            <dd className="font-medium text-gray-900">{CAPABILITY_LABELS[intent.capability] || intent.capability}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Exactly</dt>
            <dd className="text-gray-900">{intent.target_description}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Action digest</dt>
            <dd className="font-mono text-xs text-gray-700 break-all">{intent.action_digest}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Expires</dt>
            <dd className="text-gray-900">{formatDistanceToNow(parseApiDate(intent.expires_at), { addSuffix: true })}</dd>
          </div>
        </dl>

        {requiresConfirmPhrase && (
          <div className="mb-4 rounded-md bg-red-50 border border-red-200 p-3">
            <p className="text-sm text-red-800 mb-2">
              This leaves the device (real message/call). Type exactly <strong>{REQUIRED_CONFIRM_PHRASE}</strong> to confirm you intend this.
            </p>
            <input
              type="text"
              value={confirmPhraseInput}
              onChange={(e) => setConfirmPhraseInput(e.target.value)}
              placeholder={REQUIRED_CONFIRM_PHRASE}
              className="w-full rounded border border-red-300 px-3 py-2 text-sm"
              disabled={!isActionable || submitting}
            />
          </div>
        )}

        {approveError && (
          <p className="text-sm text-red-600 mb-3">{approveError}</p>
        )}

        <button
          onClick={handleApprove}
          disabled={!isActionable || !confirmPhraseSatisfied || submitting}
          className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          {submitting ? 'Approving…' : 'Approve'}
        </button>
      </div>

      <p className="text-xs text-gray-400 text-center">
        <Link to="/" className="hover:underline">Back to home</Link>
      </p>
    </div>
  )
}
