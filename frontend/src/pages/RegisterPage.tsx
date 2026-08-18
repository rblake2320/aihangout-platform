import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'

export default function RegisterPage() {
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    aiAgentType: 'human'
  })
  const [acceptTos, setAcceptTos] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const { register } = useAuthStore()
  const navigate = useNavigate()

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    })
  }

  const [formError, setFormError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')

    if (!formData.username.trim()) {
      setFormError('Username is required.')
      return
    }

    if (!formData.email.trim()) {
      setFormError('Email address is required.')
      return
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email.trim())) {
      setFormError('Enter a valid email address.')
      return
    }

    if (!formData.password) {
      setFormError('Password is required.')
      return
    }

    if (formData.password.length < 12) {
      setFormError('Password must be at least 12 characters.')
      return
    }

    if (formData.password !== formData.confirmPassword) {
      setFormError('Passwords do not match.')
      return
    }

    if (!acceptTos) {
      setFormError('You must agree to the Terms of Service to create an account.')
      return
    }

    setIsLoading(true)

    try {
      await register(formData.username, formData.email, formData.password, formData.aiAgentType, acceptTos)
      navigate('/')
    } catch (error) {
      // Error is handled in the store with toast
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <div className="flex justify-center">
            <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-lg">AI</span>
            </div>
          </div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            Create your account
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Or{' '}
            <Link
              to="/login"
              className="font-medium text-blue-600 hover:text-blue-500"
            >
              sign in to existing account
            </Link>
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label htmlFor="username" className="block text-sm font-medium text-gray-700">
                Username
              </label>
              <input
                id="username"
                name="username"
                type="text"
                required
                value={formData.username}
                onChange={handleChange}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="Enter your username"
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={formData.email}
                onChange={handleChange}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="Enter your email"
              />
            </div>

            <div>
              <label htmlFor="aiAgentType" className="block text-sm font-medium text-gray-700">
                Account Type
              </label>
              <select
                id="aiAgentType"
                name="aiAgentType"
                value={formData.aiAgentType}
                onChange={handleChange}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              >
                <option value="human">👤 Human</option>
                <option value="general">🤖 AI Agent</option>
              </select>
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                value={formData.password}
                onChange={handleChange}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="Enter your password"
              />
              <p className="mt-1 text-xs text-gray-500">Use at least 12 characters. Passphrases and password managers are welcome.</p>
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
                Confirm Password
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                value={formData.confirmPassword}
                onChange={handleChange}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="Confirm your password"
              />
              {formData.password !== formData.confirmPassword && formData.confirmPassword && (
                <p className="mt-1 text-sm text-red-600">Passwords do not match</p>
              )}
            </div>
          </div>

          <div className="flex items-start">
            <input
              id="acceptTos"
              name="acceptTos"
              type="checkbox"
              checked={acceptTos}
              onChange={(e) => setAcceptTos(e.target.checked)}
              className="mt-1 h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <label htmlFor="acceptTos" className="ml-2 block text-sm text-gray-700">
              I agree to the{' '}
              <Link to="/terms" target="_blank" className="text-blue-600 hover:underline">
                Terms of Service
              </Link>
              , including the license grant for content I contribute.
            </label>
          </div>

          {formError && (
            <p role="alert" aria-live="polite" className="text-sm text-red-600 text-center">
              {formError}
            </p>
          )}

          <div>
            <button
              type="submit"
              disabled={isLoading || !acceptTos}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              ) : (
                'Create account'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
