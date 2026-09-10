import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import VoteButtons from './VoteButtons'

// Defect a5-c0910: a vote appeared applied, then reverted after the feed refetch
// (home) or a reload (detail page). VoteButtons is a pure reflection of the
// `userVote` prop: its effect resets the highlight to `userVote` whenever
// `upvotes` changes. The reversal happened because no API response carried the
// caller's own vote, so every refetch re-rendered with userVote={null}.
// The real fix is the API attaching `user_vote`; these tests pin the component
// contract that makes that fix effective.

const voteMock = vi.fn()
vi.mock('../services/api', () => ({
  votingAPI: { vote: (...args: unknown[]) => voteMock(...args) },
}))
vi.mock('../stores/authStore', () => ({
  useAuthStore: () => ({ isAuthenticated: true }),
}))
vi.mock('../hooks/useAnalytics', () => ({
  useAnalytics: () => ({ track: () => {} }),
}))
vi.mock('react-hot-toast', () => ({
  default: { error: () => {}, success: () => {} },
}))

const HIGHLIGHT = 'bg-orange-500'

function renderVote(props: { upvotes: number; userVote: 'up' | 'down' | null }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidateSpy = vi.spyOn(client, 'invalidateQueries')
  const ui = (p: typeof props) => (
    <QueryClientProvider client={client}>
      {/* Real callers pass the API's numeric id at runtime despite the string type. */}
      <VoteButtons targetType="problem" targetId={42 as unknown as string} upvotes={p.upvotes} userVote={p.userVote} />
    </QueryClientProvider>
  )
  const result = render(ui(props))
  return { ...result, rerenderWith: (p: typeof props) => result.rerender(ui(p)), invalidateSpy }
}

beforeEach(() => {
  voteMock.mockReset()
  voteMock.mockResolvedValue({ data: { upvotes: 6, currentVote: 'up' } })
})

describe('VoteButtons highlight across a refetch', () => {
  it('keeps the highlight when the refetched data carries user_vote "up" (fixed API contract)', async () => {
    const { rerenderWith } = renderVote({ upvotes: 5, userVote: null })
    const up = screen.getByRole('button', { name: 'Upvote' })
    expect(up.className).not.toContain(HIGHLIGHT)

    await userEvent.click(up)
    await waitFor(() => expect(voteMock).toHaveBeenCalledWith('problem', 42, 'up'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upvote' }).className).toContain(HIGHLIGHT))
    expect(screen.getByText('6')).toBeInTheDocument()

    // Simulate the react-query refetch after invalidation: upvotes changed AND
    // the (fixed) API now tells us our own vote.
    rerenderWith({ upvotes: 6, userVote: 'up' })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Upvote' }).className).toContain(HIGHLIGHT))
    expect(screen.getByText('6')).toBeInTheDocument()
  })

  it('drops the highlight when the refetched data omits the vote (documents the old failure mode)', async () => {
    const { rerenderWith } = renderVote({ upvotes: 5, userVote: null })
    const up = screen.getByRole('button', { name: 'Upvote' })

    await userEvent.click(up)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upvote' }).className).toContain(HIGHLIGHT))

    // Old API shape: upvotes changed, user_vote missing -> effect resets to null.
    // This is exactly the "vote reverts" symptom, and why the API must carry user_vote.
    rerenderWith({ upvotes: 6, userVote: null })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Upvote' }).className).not.toContain(HIGHLIGHT))
  })

  it('invalidates the detail-page key with a string id so the detail page refetches', async () => {
    const { invalidateSpy } = renderVote({ upvotes: 5, userVote: null })
    await userEvent.click(screen.getByRole('button', { name: 'Upvote' }))
    await waitFor(() => expect(voteMock).toHaveBeenCalled())

    // ProblemDetailPage keys on useParams() id (a string). Before the fix only
    // ['problems'] and ['problem', <number>] were invalidated, so a reload was the
    // first time the page saw the vote -- and then without user_vote it lost it.
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['problem', '42'] })
    )
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['problem', 42] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['problems'] })
  })
})
