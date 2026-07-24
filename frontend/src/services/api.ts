import axios from 'axios'
import { useAuthStore } from '../stores/authStore'

// Create axios instance
export const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
})

// Request interceptor to add auth token
api.interceptors.request.use(
  (config) => {
    const token = useAuthStore.getState().token
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = error.config?.url || ''
    const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/register')
    if (error.response?.status === 401 && !isAuthEndpoint) {
      // Session expired — clear state and redirect to login
      useAuthStore.getState().logout()
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

// API endpoints
export const problemsAPI = {
  list: (params?: {
    category?: string;
    search?: string;
    solutionStatus?: string;
    authorType?: string;
    contentSource?: 'community' | 'digest' | 'all';
    sortBy?: string;
    limit?: number;
    offset?: number
  }) =>
    api.get('/problems', { params }),

  get: (id: string) =>
    api.get(`/problems/${id}`),

  create: (data: {
    title: string
    description: string
    category?: string
    difficulty?: string
    aiContext?: any
    spofIndicators?: any
  }) =>
    api.post('/problems', data),

  addSolution: (problemId: string, data: {
    solutionText: string
    codeSnippet?: string
    whyExplanation: string
  }) =>
    api.post(`/problems/${problemId}/solutions`, data),

  acceptSolution: (problemId: string, solutionId: number) =>
    api.post(`/problems/${problemId}/solutions/${solutionId}/accept`, {}),
}

export const votingAPI = {
  vote: (targetType: 'problem' | 'solution', targetId: string, voteType: 'up' | 'down') =>
    api.post('/vote', { targetType, targetId, voteType }),
}

export const analyticsAPI = {
  dashboard: () =>
    api.get('/analytics/dashboard'),
}

export const bugReportAPI = {
  create: (data: {
    title: string
    description: string
    bugType: string
    priority: string
    stepsToReproduce?: string
    expectedBehavior?: string
    actualBehavior?: string
    userAgent: string
    url: string
    additionalInfo?: string
    userId?: number | null
    username?: string
  }) =>
    api.post('/bug-reports', data),

  list: (params?: {
    status?: string
    priority?: string
    bugType?: string
    limit?: number
    offset?: number
  }) =>
    api.get('/bug-reports', { params }),

  get: (id: string) =>
    api.get(`/bug-reports/${id}`),

  updateStatus: (id: string, status: string) =>
    api.patch(`/bug-reports/${id}/status`, { status }),
}

export const notificationsAPI = {
  list: (params?: { unread_only?: boolean; limit?: number; offset?: number }) =>
    api.get('/notifications', { params }),
  unreadCount: () => api.get('/notifications/count'),
  markRead: (data: { notification_ids?: number[]; all?: boolean }) =>
    api.post('/notifications/read', data),
  delete: (id: number) => api.delete(`/notifications/${id}`),
}

export const followAPI = {
  toggle: (userId: number) => api.post(`/users/${userId}/follow`),
  followers: (userId: number) => api.get(`/users/${userId}/followers`),
  following: (userId: number) => api.get(`/users/${userId}/following`),
  isFollowingBatch: (userIds: number[]) =>
    api.post('/users/is-following-batch', { user_ids: userIds }),
  isFollowing: (userId: number) => api.get(`/users/${userId}/is-following`),
}

export const bookmarksAPI = {
  list: () => api.get('/bookmarks'),
  add: (type: string, id: number) =>
    api.post('/bookmarks', { content_type: type, content_id: id }),
  remove: (type: string, id: number) =>
    api.delete(`/bookmarks/${type}/${id}`),
  check: (type: string, ids: number[]) =>
    api.post('/bookmarks/check', { content_type: type, content_ids: ids }),
}

export const settingsAPI = {
  get: () => api.get('/users/me/settings'),
  update: (data: any) => api.put('/users/me/settings', data),
}

export const reportsAPI = {
  submit: (data: { content_type: string; content_id: number; reason: string; details?: string }) =>
    api.post('/reports', data),
}

export const pathbooksAPI = {
  list: (params?: {
    q?: string
    runtime?: string
    trust_tier?: string
    limit?: number
    offset?: number
  }) => api.get('/pathbooks', { params }),

  lookup: (data: {
    error?: string
    error_message?: string
    stderr?: string
    runtime?: string
    package_name?: string
    limit?: number
  }) => api.post('/pathbooks/lookup', data),

  get: (id: string) => api.get(`/pathbooks/${id}`),
  spec: () => api.get('/pathbooks/spec'),
  execute: (id: string, data?: {
    confirm_risk?: boolean
    allow_untrusted?: boolean
  }) => api.post(`/pathbooks/${encodeURIComponent(id)}/execute`, data || {}),
  verify: (id: string, data: {
    application_id: string
    outcome: 'success' | 'failure' | 'dangerous'
    verify_passed?: boolean
    environment?: string
    notes?: string
    verification?: {
      check_id: string
      exit_code: number
      output_digest: string
      environment_digest: string
      observed_at: string
    }
  }) => api.post(`/pathbooks/${encodeURIComponent(id)}/verify`, data),
}

export default api
