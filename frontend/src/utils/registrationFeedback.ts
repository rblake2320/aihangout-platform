export function registrationErrorMessage(error: unknown): string {
  const failure = error as { code?: string; response?: { status?: number; headers?: Record<string, unknown>; data?: { error?: string } } }
  const status = failure?.response?.status
  if (status === 409) {
    return 'We could not use those account details. Your email or username may already be registered. Try signing in or resetting your password; otherwise choose a different username and check your email address.'
  }
  if (status === 429) {
    const seconds = Number(failure.response?.headers?.['retry-after'])
    const wait = Number.isFinite(seconds) && seconds > 0 ? `at least ${Math.ceil(seconds / 60)} minute${seconds > 60 ? 's' : ''}` : 'a few minutes'
    return `Too many signup attempts from this network. Wait ${wait} without trying again, then submit once. Repeated attempts can extend the wait. If you are still blocked, wait longer or report the problem.`
  }
  if (failure?.code === 'ECONNABORTED' || failure?.code === 'ETIMEDOUT') {
    return 'The signup request timed out. Check your connection, then try signing in first in case your account was created. If you cannot sign in, try signup again.'
  }
  if (!failure?.response) {
    return 'We could not reach AIHangout. Check your internet connection and try again. If you submitted already, try signing in first in case your account was created.'
  }
  if (status && status >= 500) {
    return 'AIHangout could not finish signup right now. Try signing in first in case your account was created. If that does not work, wait a few minutes and try again, or report the problem.'
  }
  if (status === 403) {
    return 'The signup request was blocked. Refresh the page and try again. If it continues, report the problem and include your browser and the time of the attempt.'
  }
  const detail = failure.response?.data?.error
  // Only display the known, public field-validation messages from this API.
  if (typeof detail === 'string' && /^(Username (must|may)|Invalid email|Password (must|is|cannot|too)|Choose a less common password|This username is not available)/i.test(detail)) {
    return `${detail} Check the field and try again.`
  }
  return 'Signup could not be completed. Check your username, email and password below. If you already have an account, sign in or reset your password; otherwise report the problem.'
}

export function registrationValidation(data: { username: string; email: string; password: string; confirmPassword: string }): string {
  const username = data.username.trim()
  if (!username || username.length > 50) return 'Choose a username between 1 and 50 characters.'
  if (!/^[A-Za-z0-9_.-]+$/.test(username)) return 'Your username can contain letters, numbers, underscores (_), periods (.) and hyphens (-). Remove spaces or other symbols.'
  if (!data.email.trim() || data.email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) return 'Enter a valid email address, such as name@example.com.'
  if (data.password.length < 12) return 'Use a password with at least 12 characters. A longer passphrase is welcome.'
  if (data.password.length > 128) return 'Use a password with no more than 128 characters.'
  if (data.password !== data.confirmPassword) return 'The two passwords do not match. Enter the same password in both fields.'
  return ''
}
