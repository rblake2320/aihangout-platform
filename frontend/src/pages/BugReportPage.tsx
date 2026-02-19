import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { bugReportAPI } from '../services/api'
import { useAuthStore } from '../stores/authStore'
import toast from 'react-hot-toast'
import { ExclamationTriangleIcon, BugAntIcon } from '@heroicons/react/24/outline'

const BUG_TYPES = [
  'UI/UX Issue',
  'Functionality Error',
  'Performance Issue',
  'Security Concern',
  'Data Loss',
  'Authentication Problem',
  'Chat System',
  'Online Counter',
  'Navigation Issue',
  'Other'
]

const PRIORITIES = [
  { value: 'low', label: 'Low - Minor issue', color: 'text-green-600' },
  { value: 'medium', label: 'Medium - Standard bug', color: 'text-yellow-600' },
  { value: 'high', label: 'High - Major functionality', color: 'text-orange-600' },
  { value: 'critical', label: 'Critical - System breaking', color: 'text-red-600' }
]

export default function BugReportPage() {
  const { isAuthenticated, user } = useAuthStore()
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    bugType: '',
    priority: 'medium',
    stepsToReproduce: '',
    expectedBehavior: '',
    actualBehavior: '',
    userAgent: navigator.userAgent,
    url: window.location.href,
    additionalInfo: ''
  })
  const navigate = useNavigate()

  const submitBugReportMutation = useMutation({
    mutationFn: bugReportAPI.create,
    onSuccess: () => {
      toast.success('Bug report submitted successfully! Thank you for helping us improve the platform.')
      navigate('/')
    },
    onError: (error: any) => {
      console.error('Bug report submission error:', error)
      const errorMessage = error.response?.data?.error || error.message || 'Failed to submit bug report'
      toast.error(errorMessage, { duration: 5000 })
    },
  })

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    // Validate required fields
    if (!formData.title.trim()) {
      toast.error('Bug title is required')
      return
    }
    if (!formData.description.trim()) {
      toast.error('Bug description is required')
      return
    }
    if (!formData.bugType.trim()) {
      toast.error('Please select a bug type')
      return
    }

    const submitData = {
      title: formData.title.trim(),
      description: formData.description.trim(),
      bugType: formData.bugType,
      priority: formData.priority,
      stepsToReproduce: formData.stepsToReproduce.trim() || undefined,
      expectedBehavior: formData.expectedBehavior.trim() || undefined,
      actualBehavior: formData.actualBehavior.trim() || undefined,
      userAgent: formData.userAgent,
      url: formData.url,
      additionalInfo: formData.additionalInfo.trim() || undefined,
      userId: isAuthenticated ? user?.id : null,
      username: isAuthenticated ? user?.username : 'Anonymous'
    }

    submitBugReportMutation.mutate(submitData)
  }

  const selectedPriority = PRIORITIES.find(p => p.value === formData.priority)

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center space-x-3 mb-4">
          <BugAntIcon className="w-8 h-8 text-red-500" />
          <h1 className="text-3xl font-bold text-gray-900">
            Report a Bug
          </h1>
        </div>
        <p className="text-lg text-gray-600">
          Help us improve AI Hangout by reporting bugs and issues you encounter
        </p>
        <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start space-x-2">
            <ExclamationTriangleIcon className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm text-blue-800">
                <strong>Before reporting:</strong> Check if the issue persists after refreshing the page.
                Include as much detail as possible to help us reproduce and fix the issue quickly.
              </p>
            </div>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 space-y-6">
        {/* Bug Title */}
        <div>
          <label htmlFor="title" className="block text-sm font-medium text-gray-700 mb-2">
            Bug Title *
          </label>
          <input
            type="text"
            id="title"
            name="title"
            required
            value={formData.title}
            onChange={handleChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="Brief summary of the bug..."
          />
          <p className="mt-1 text-sm text-gray-500">
            Be clear and specific about what's broken or not working
          </p>
        </div>

        {/* Bug Type and Priority */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="bugType" className="block text-sm font-medium text-gray-700 mb-2">
              Bug Type *
            </label>
            <select
              id="bugType"
              name="bugType"
              required
              value={formData.bugType}
              onChange={handleChange}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">Select bug type</option>
              {BUG_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="priority" className="block text-sm font-medium text-gray-700 mb-2">
              Priority
            </label>
            <select
              id="priority"
              name="priority"
              value={formData.priority}
              onChange={handleChange}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              {PRIORITIES.map((priority) => (
                <option key={priority.value} value={priority.value}>
                  {priority.label}
                </option>
              ))}
            </select>
            {selectedPriority && (
              <p className={`mt-1 text-sm ${selectedPriority.color} font-medium`}>
                {selectedPriority.label}
              </p>
            )}
          </div>
        </div>

        {/* Bug Description */}
        <div>
          <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-2">
            Bug Description *
          </label>
          <textarea
            id="description"
            name="description"
            required
            rows={4}
            value={formData.description}
            onChange={handleChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="Detailed description of the bug..."
          />
          <p className="mt-1 text-sm text-gray-500">
            Describe what went wrong and when it happens
          </p>
        </div>

        {/* Steps to Reproduce */}
        <div>
          <label htmlFor="stepsToReproduce" className="block text-sm font-medium text-gray-700 mb-2">
            Steps to Reproduce
          </label>
          <textarea
            id="stepsToReproduce"
            name="stepsToReproduce"
            rows={4}
            value={formData.stepsToReproduce}
            onChange={handleChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="1. Go to...&#10;2. Click on...&#10;3. See error..."
          />
          <p className="mt-1 text-sm text-gray-500">
            Step-by-step instructions to reproduce the issue
          </p>
        </div>

        {/* Expected vs Actual Behavior */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="expectedBehavior" className="block text-sm font-medium text-gray-700 mb-2">
              Expected Behavior
            </label>
            <textarea
              id="expectedBehavior"
              name="expectedBehavior"
              rows={3}
              value={formData.expectedBehavior}
              onChange={handleChange}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="What should happen..."
            />
          </div>

          <div>
            <label htmlFor="actualBehavior" className="block text-sm font-medium text-gray-700 mb-2">
              Actual Behavior
            </label>
            <textarea
              id="actualBehavior"
              name="actualBehavior"
              rows={3}
              value={formData.actualBehavior}
              onChange={handleChange}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="What actually happens..."
            />
          </div>
        </div>

        {/* System Information */}
        <div className="bg-gray-50 rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-700 mb-3">System Information</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="url" className="block text-sm font-medium text-gray-700 mb-1">
                Current URL
              </label>
              <input
                type="url"
                id="url"
                name="url"
                value={formData.url}
                onChange={handleChange}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label htmlFor="userAgent" className="block text-sm font-medium text-gray-700 mb-1">
                Browser Info
              </label>
              <input
                type="text"
                id="userAgent"
                name="userAgent"
                value={formData.userAgent}
                onChange={handleChange}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50"
                readOnly
              />
            </div>
          </div>
        </div>

        {/* Additional Information */}
        <div>
          <label htmlFor="additionalInfo" className="block text-sm font-medium text-gray-700 mb-2">
            Additional Information
          </label>
          <textarea
            id="additionalInfo"
            name="additionalInfo"
            rows={3}
            value={formData.additionalInfo}
            onChange={handleChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="Any additional context, screenshots descriptions, or related issues..."
          />
          <p className="mt-1 text-sm text-gray-500">
            Include any other relevant details that might help us fix the issue
          </p>
        </div>

        {/* Submit Buttons */}
        <div className="flex justify-end space-x-4">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="px-6 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitBugReportMutation.isPending}
            className="px-6 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center space-x-2"
          >
            {submitBugReportMutation.isPending ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                <span>Submitting...</span>
              </>
            ) : (
              <>
                <BugAntIcon className="w-5 h-5" />
                <span>Submit Bug Report</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  )
}