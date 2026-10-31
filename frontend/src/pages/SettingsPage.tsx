import { useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, settingsAPI, emailPrefsAPI } from '../services/api'
import toast from 'react-hot-toast'
import LiveProfileSettings from '../components/LiveProfileSettings'

interface ToggleProps {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}

function Toggle({ label, description, checked, onChange }: ToggleProps) {
  return (
    <div className="flex items-center justify-between py-4">
      <div>
        <p className="font-medium text-gray-900">{label}</p>
        <p className="text-sm text-gray-500">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          checked ? 'bg-blue-600' : 'bg-gray-300'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  )
}

export default function SettingsPage() {
  const queryClient = useQueryClient()
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsAPI.get(),
  })

  const updateMutation = useMutation({
    mutationFn: (settings: any) => settingsAPI.update(settings),
    onSuccess: () => toast.success('Settings saved'),
    onError: () => toast.error('Failed to save settings'),
  })

  const settings = data?.data?.settings

  const emailQuery = useQuery({ queryKey: ['email-preferences'], queryFn: () => emailPrefsAPI.get() })
  const emailPrefs = emailQuery.data?.data?.preferences
  const emailMutation = useMutation({
    mutationFn: (patch: Parameters<typeof emailPrefsAPI.update>[0]) => emailPrefsAPI.update(patch),
    onSuccess: (res) => {
      queryClient.setQueryData(['email-preferences'], res)
      toast.success('Email preferences saved')
    },
    onError: () => toast.error('Failed to save email preferences'),
  })

  const handleChange = (key: string, value: boolean) => {
    const updated = { ...settings, [key]: value }
    queryClient.setQueryData(['settings'], (old: any) => ({
      ...old,
      data: { ...old.data, settings: updated }
    }))
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      updateMutation.mutate(updated)
    }, 500)
  }

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="bg-white rounded-lg border border-gray-200 p-6 animate-pulse space-y-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="flex justify-between py-4 border-b border-gray-100">
              <div className="space-y-2">
                <div className="h-4 w-40 bg-gray-200 rounded" />
                <div className="h-3 w-56 bg-gray-200 rounded" />
              </div>
              <div className="h-6 w-11 bg-gray-200 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
      <LiveProfileSettings />

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Notification Preferences</h2>
        <p className="text-sm text-gray-500 mb-4">
          Choose which in-app notifications you receive. Changes save automatically.
        </p>
        <div className="divide-y divide-gray-100">
          <Toggle
            label="New followers"
            description="When someone starts following you"
            checked={!!settings?.notify_new_follower}
            onChange={v => handleChange('notify_new_follower', v)}
          />
          <Toggle
            label="Votes on your content"
            description="When someone upvotes your problem or solution"
            checked={!!settings?.notify_vote_on_content}
            onChange={v => handleChange('notify_vote_on_content', v)}
          />
          <Toggle
            label="New solutions"
            description="When someone answers your question"
            checked={!!settings?.notify_new_solution}
            onChange={v => handleChange('notify_new_solution', v)}
          />
          <Toggle
            label="Email: answers to your questions"
            description="One email when someone answers your question or verifies your answer (verified email required)"
            checked={!!emailPrefs && emailPrefs.solutions && !emailPrefs.unsubscribed_all}
            onChange={v => emailMutation.mutate({ solutions: v, ...(v ? { unsubscribed_all: false } : {}) })}
          />
          <Toggle
            label="Email: mentions"
            description="When someone mentions you with @username"
            checked={!!emailPrefs && emailPrefs.mentions && !emailPrefs.unsubscribed_all}
            onChange={v => emailMutation.mutate({ mentions: v, ...(v ? { unsubscribed_all: false } : {}) })}
          />
          <Toggle
            label="Email: weekly digest"
            description="A Monday summary of answers and unread notifications, only when there is something to report"
            checked={!!emailPrefs && emailPrefs.digest && !emailPrefs.unsubscribed_all}
            onChange={v => emailMutation.mutate({ digest: v, ...(v ? { unsubscribed_all: false } : {}) })}
          />
          <Toggle
            label="Stop all email"
            description="Turns off every email from AI Hangout. Every email also carries an unsubscribe link."
            checked={!!emailPrefs?.unsubscribed_all}
            onChange={v => emailMutation.mutate({ unsubscribed_all: v })}
          />
          <div className="py-4">
            <button
              type="button"
              onClick={async () => {
                try {
                  const response = await api.post('/auth/email/resend', {})
                  toast.success(response.data.alreadyVerified ? 'Your email is already verified' : 'Verification email requested')
                } catch {
                  toast.error('Could not send verification email')
                }
              }}
              className="rounded-md border border-blue-600 px-3 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50"
            >
              Verify my email
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
