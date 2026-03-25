import { useState } from 'react'
import { FlagIcon } from '@heroicons/react/24/outline'
import { useMutation } from '@tanstack/react-query'
import { reportsAPI } from '../services/api'
import { useAuthStore } from '../stores/authStore'
import toast from 'react-hot-toast'

const REASONS = [
  { value: 'spam', label: 'Spam or self-promotion' },
  { value: 'misleading', label: 'Misleading or inaccurate' },
  { value: 'offensive', label: 'Offensive or inappropriate' },
  { value: 'injection', label: 'Prompt injection attempt' },
  { value: 'other', label: 'Other' },
]

interface ReportButtonProps {
  contentType: 'problem' | 'solution'
  contentId: number
}

export default function ReportButton({ contentType, contentId }: ReportButtonProps) {
  const { isAuthenticated } = useAuthStore()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [details, setDetails] = useState('')

  const reportMutation = useMutation({
    mutationFn: () => reportsAPI.submit({ content_type: contentType, content_id: contentId, reason, details }),
    onSuccess: () => {
      toast.success('Report submitted. Thank you.')
      setOpen(false)
      setReason('')
      setDetails('')
    },
    onError: () => toast.error('Failed to submit report'),
  })

  if (!isAuthenticated) return null

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center space-x-1 text-xs text-gray-400 hover:text-red-500 transition-colors"
        aria-label="Report content"
      >
        <FlagIcon className="w-3.5 h-3.5" />
        <span>Report</span>
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-72 bg-white rounded-lg shadow-lg border border-gray-200 p-4 z-50">
          <h4 className="font-semibold text-gray-900 text-sm mb-3">Report this {contentType}</h4>
          <div className="space-y-2 mb-3">
            {REASONS.map(r => (
              <label key={r.value} className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="radio"
                  name="report-reason"
                  value={r.value}
                  checked={reason === r.value}
                  onChange={() => setReason(r.value)}
                  className="text-blue-600"
                />
                <span className="text-sm text-gray-700">{r.label}</span>
              </label>
            ))}
          </div>
          {reason === 'other' && (
            <textarea
              value={details}
              onChange={e => setDetails(e.target.value)}
              placeholder="Tell us more..."
              className="w-full text-sm border border-gray-200 rounded p-2 mb-3 h-16 resize-none"
              maxLength={500}
            />
          )}
          <div className="flex gap-2">
            <button
              onClick={() => reportMutation.mutate()}
              disabled={!reason || reportMutation.isPending}
              className="flex-1 py-1.5 bg-red-500 text-white text-sm rounded hover:bg-red-600 disabled:opacity-50 transition-colors"
            >
              {reportMutation.isPending ? 'Sending...' : 'Submit Report'}
            </button>
            <button
              onClick={() => setOpen(false)}
              className="py-1.5 px-3 text-sm text-gray-600 hover:text-gray-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
