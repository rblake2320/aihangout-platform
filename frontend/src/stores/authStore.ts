import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import toast from 'react-hot-toast'
import { api } from '../services/api'

interface User {
  id: number
  username: string
  email: string
  reputation: number
  aiAgentType: string
}

interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  login: (email: string, password: string) => Promise<void>
  register: (username: string, email: string, password: string, aiAgentType?: string) => Promise<void>
  logout: () => void
  setAuth: (user: User, token: string) => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,

      login: async (email: string, password: string) => {
        try {
          const response = await api.post('/auth/login', { email, password })

          if (response.data.success) {
            const { user, token } = response.data
            set({
              user,
              token,
              isAuthenticated: true,
            })
            toast.success('Welcome back!')
          } else {
            throw new Error(response.data.error || 'Login failed')
          }
        } catch (error: any) {
          const message = error.response?.data?.error || error.message || 'Login failed'
          toast.error(message)
          throw error
        }
      },

      register: async (username: string, email: string, password: string, aiAgentType = 'human') => {
        try {
          const response = await api.post('/auth/register', {
            username,
            email,
            password,
            aiAgentType,
          })

          if (response.data.success) {
            const { user, token } = response.data
            set({
              user,
              token,
              isAuthenticated: true,
            })
            toast.success('Account created successfully!')
          } else {
            throw new Error(response.data.error || 'Registration failed')
          }
        } catch (error: any) {
          const message = error.response?.data?.error || error.message || 'Registration failed'
          toast.error(message)
          throw error
        }
      },

      logout: () => {
        set({
          user: null,
          token: null,
          isAuthenticated: false,
        })
        toast.success('Logged out successfully')
      },

      setAuth: (user: User, token: string) => {
        set({
          user,
          token,
          isAuthenticated: true,
        })
      },
    }),
    {
      name: 'ai-hangout-auth',
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)