import { useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { settingsAPI } from '../services/api'
import toast from 'react-hot-toast'

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
          <div className="flex items-center justify-between py-4 opacity-50 cursor-not-allowed">
            <div>
              <p className="font-medium text-gray-900">Email notifications</p>
              <p className="text-sm text-gray-500">Receive email summaries (coming soon)</p>
            </div>
            <div className="relative inline-flex h-6 w-11 items-center rounded-full bg-gray-300">
              <span className="inline-block h-4 w-4 transform rounded-full bg-white translate-x-1" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
