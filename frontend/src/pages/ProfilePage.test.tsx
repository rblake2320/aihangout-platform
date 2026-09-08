import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ProfilePage from './ProfilePage'
import { useAuthStore } from '../stores/authStore'

// Focused on ProfilePage's own rendering logic -- these two only render extra
// network-driven widgets unrelated to the pending-review claim under test.
vi.mock('../components/FollowersList', () => ({ default: () => null }))
vi.mock('../components/FollowButton', () => ({ default: () => null }))

const apiGetMock = vi.fn()
vi.mock('../services/api', () => ({
  default: { get: (...args: any[]) => apiGetMock(...args) },
  followAPI: {
    followers: () => Promise.resolve({ data: { count: 0 } }),
    following: () => Promise.resolve({ data: { count: 0 } }),
    isFollowing: () => Promise.resolve({ data: { following: false } }),
  },
}))

function renderProfile(username: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/u/${username}`]}>
        <Routes>
          <Route path="/u/:username" element={<ProfilePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const SELF = {
  id: 306,
  username: 'surface_test_agent',
  reputation: 0,
  ai_agent_type: 'general',
  join_date: '2026-09-08T00:00:00Z',
}

const APPROVED = {
  id: 1,
  title: 'Approved question',
  status: 'approved',
  difficulty: 'easy',
  category: 'Backend',
  created_at: '2026-09-08T00:00:00Z',
  solution_count: 0,
}

const PENDING = {
  id: 2,
  title: 'My brand new question',
  status: 'pending_review',
  difficulty: 'easy',
  category: 'Backend',
  created_at: '2026-09-08T00:05:00Z',
  solution_count: 0,
}

beforeEach(() => {
  apiGetMock.mockReset()
  useAuthStore.setState({ user: null, token: null, isAuthenticated: false })
})

describe('ProfilePage pending-review visibility (A1 coordination: A3 commit 1030bc5 merges pending into the single default /problems response)', () => {
  it('own profile: a pending post from the single merged response renders exactly once, badged -- no separate section, no duplicate card', async () => {
    useAuthStore.setState({
      user: { id: 306, username: 'surface_test_agent', email: 'x', reputation: 0, aiAgentType: 'general' },
      token: 'fake',
      isAuthenticated: true,
    })
    apiGetMock.mockImplementation((url: string) => {
      if (url === '/users/by-username/surface_test_agent') return Promise.resolve({ data: { user: SELF } })
      // Single response containing both -- exactly what A3's backend fix now returns
      // for an authenticated owner from the DEFAULT (no ?status=) query.
      if (url === '/problems') return Promise.resolve({ data: { problems: [APPROVED, PENDING] } })
      return Promise.resolve({ data: {} })
    })

    renderProfile('surface_test_agent')

    expect(await screen.findByText('My brand new question')).toBeInTheDocument()
    expect(screen.getAllByText('My brand new question')).toHaveLength(1)
    expect(screen.getAllByText('⏳ Pending review')).toHaveLength(1)
    // No dedicated "Pending review (N)" section heading exists anywhere -- the earlier
    // two-query/two-section design (fec3936) was removed specifically to eliminate the
    // duplicate-card risk A1 flagged once A3's backend fix ships.
    expect(screen.queryByText(/^Pending review \(\d+\)$/)).not.toBeInTheDocument()
    expect(screen.getByText('Questions (2)')).toBeInTheDocument()
  })

  it('a different authenticated viewer never sees a pending badge or section on someone else\'s profile', async () => {
    useAuthStore.setState({
      user: { id: 999, username: 'someone_else', email: 'y', reputation: 0, aiAgentType: 'human' },
      token: 'fake2',
      isAuthenticated: true,
    })
    apiGetMock.mockImplementation((url: string) => {
      if (url === '/users/by-username/surface_test_agent') return Promise.resolve({ data: { user: SELF } })
      // Real backend (A3 1030bc5) would never actually put PENDING in this response for
      // a non-owner caller (p.user_id = callerId only matches the true owner) -- included
      // here anyway as a defensive worst-case, to prove the FRONTEND's own badge logic is
      // independently gated on isOwnProfile and adds no leak of its own even if it were.
      if (url === '/problems') return Promise.resolve({ data: { problems: [APPROVED, PENDING] } })
      return Promise.resolve({ data: {} })
    })

    renderProfile('surface_test_agent')

    await screen.findByText('Approved question')
    expect(screen.queryByText('⏳ Pending review')).not.toBeInTheDocument()
    expect(screen.queryByText(/^Pending review \(\d+\)$/)).not.toBeInTheDocument()
  })

  it('status persists across a fresh mount -- driven by real response data, not one-time toast/local state', async () => {
    useAuthStore.setState({
      user: { id: 306, username: 'surface_test_agent', email: 'x', reputation: 0, aiAgentType: 'general' },
      token: 'fake',
      isAuthenticated: true,
    })
    apiGetMock.mockImplementation((url: string) => {
      if (url === '/users/by-username/surface_test_agent') return Promise.resolve({ data: { user: SELF } })
      if (url === '/problems') return Promise.resolve({ data: { problems: [PENDING] } })
      return Promise.resolve({ data: {} })
    })

    const { unmount } = renderProfile('surface_test_agent')
    expect(await screen.findByText('⏳ Pending review')).toBeInTheDocument()
    unmount()

    // Fresh mount (new QueryClient, no cache carried over) -- same underlying "server"
    // state produces the same badge, proving it's derived from problem.status on every
    // render, not from transient state set once at creation time.
    renderProfile('surface_test_agent')
    expect(await screen.findByText('⏳ Pending review')).toBeInTheDocument()
  })
})
