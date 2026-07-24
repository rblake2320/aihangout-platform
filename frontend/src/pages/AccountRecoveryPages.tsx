import { FormEvent, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../services/api'

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">{title}</h1>
        {children}
      </div>
    </div>
  )
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try {
      const response = await api.post('/auth/password/forgot', { email })
      setMessage(response.data.message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <Card title="Reset your password">
      {message ? <p className="text-sm text-green-700">{message}</p> : (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-gray-600">We’ll email a single-use link if the address belongs to an account.</p>
          <input type="email" required autoComplete="email" value={email}
            onChange={event => setEmail(event.target.value)} placeholder="Email address"
            className="w-full rounded-md border border-gray-300 px-3 py-2" />
          <button disabled={loading} className="w-full rounded-md bg-blue-600 px-4 py-2 text-white disabled:opacity-50">
            {loading ? 'Requesting…' : 'Send reset link'}
          </button>
        </form>
      )}
      <Link to="/login" className="mt-4 inline-block text-sm text-blue-600">Back to sign in</Link>
    </Card>
  )
}

export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (password.length < 12) return setError('Password must be at least 12 characters.')
    if (password !== confirm) return setError('Passwords do not match.')
    try {
      const response = await api.post('/auth/password/reset', { token: params.get('token'), password })
      setMessage(response.data.message)
    } catch (requestError: any) {
      setError(requestError?.response?.data?.error || 'The reset link is invalid or expired.')
    }
  }
  return (
    <Card title="Choose a new password">
      {message ? (
        <><p className="text-green-700">{message}</p><Link to="/login" className="mt-4 inline-block text-blue-600">Sign in</Link></>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-gray-600">Use at least 12 characters. Passphrases and password managers are welcome.</p>
          <input type="password" required autoComplete="new-password" value={password}
            onChange={event => setPassword(event.target.value)} placeholder="New password"
            className="w-full rounded-md border border-gray-300 px-3 py-2" />
          <input type="password" required autoComplete="new-password" value={confirm}
            onChange={event => setConfirm(event.target.value)} placeholder="Confirm password"
            className="w-full rounded-md border border-gray-300 px-3 py-2" />
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <button className="w-full rounded-md bg-blue-600 px-4 py-2 text-white">Update password</button>
        </form>
      )}
    </Card>
  )
}

export function VerifyEmailPage() {
  const [params] = useSearchParams()
  const [state, setState] = useState('Verifying your email…')
  const [ok, setOk] = useState(false)
  useEffect(() => {
    api.post('/auth/email/verify', { token: params.get('token') })
      .then(response => { setOk(true); setState(response.data.message) })
      .catch(error => setState(error?.response?.data?.error || 'The verification link is invalid or expired.'))
  }, [params])
  return (
    <Card title="Email verification">
      <p className={ok ? 'text-green-700' : 'text-gray-700'}>{state}</p>
      <Link to={ok ? '/' : '/login'} className="mt-4 inline-block text-blue-600">{ok ? 'Continue to AI Hangout' : 'Return to sign in'}</Link>
    </Card>
  )
}
