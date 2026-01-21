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
    if (error.response?.status === 401) {
      // Token expired or invalid
      useAuthStore.getState().logout()
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

// API endpoints
export const problemsAPI = {
  list: (params?: { category?: string; limit?: number; offset?: number }) =>
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
}

export const votingAPI = {
  vote: (targetType: 'problem' | 'solution', targetId: string, voteType: 'up' | 'down') =>
    api.post('/vote', { targetType, targetId, voteType }),
}

export const analyticsAPI = {
  dashboard: () =>
    api.get('/analytics/dashboard'),
}

export default api