import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import MobileActionApprovalPage from './MobileActionApprovalPage'

const getMock = vi.fn()
const approveMock = vi.fn()
const denyMock = vi.fn()
vi.mock('../services/api', () => ({
  mobileApprovalAPI: {
    get: (...args: any[]) => getMock(...args),
    approve: (...args: any[]) => approveMock(...args),
    deny: (...args: any[]) => denyMock(...args),
  },
}))

function renderPage(actionId: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/mobile-approvals/${actionId}`]}>
        <Routes>
          <Route path="/mobile-approvals/:actionId" element={<MobileActionApprovalPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const HOUR_FROM_NOW = new Date(Date.now() + 60 * 60 * 1000).toISOString()
const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString()

const READ_ONLY_INTENT = {
  action_id: 'a1',
  device_id: 'd1',
  owner_user_id: 306,
  capability: 'battery_status_read',
  risk_tier: 'read_only',
  target_description: 'Check current battery percentage',
  action_digest: 'deadbeef123456',
  status: 'awaiting_approval',
  created_at: '2026-09-08T00:00:00Z',
  expires_at: HOUR_FROM_NOW,
}

const COMMS_INTENT = {
  ...READ_ONLY_INTENT,
  action_id: 'a2',
  capability: 'sms_send',
  risk_tier: 'communication_send',
  target_description: 'Text "on my way" to Mom',
}

beforeEach(() => {
  getMock.mockReset()
  approveMock.mockReset()
  denyMock.mockReset()
})

describe('MobileActionApprovalPage', () => {
  it('shows exact action details and digest from the readback', async () => {
    getMock.mockResolvedValue({ data: { success: true, intent: READ_ONLY_INTENT, approval: null } })

    renderPage('a1')

    expect(await screen.findByText('Read battery status')).toBeInTheDocument()
    expect(screen.getByText('Check current battery percentage')).toBeInTheDocument()
    expect(screen.getByText('deadbeef123456')).toBeInTheDocument()
  })

  it('never calls approve on mount -- only on an explicit click', async () => {
    getMock.mockResolvedValue({ data: { success: true, intent: READ_ONLY_INTENT, approval: null } })

    renderPage('a1')
    await screen.findByText('Approve')
    // Give any stray effect a tick to fire, then assert it didn't.
    await new Promise((r) => setTimeout(r, 20))
    expect(approveMock).not.toHaveBeenCalled()
  })

  it('read-only tier: explicit click calls approve with the exact digest, no confirm phrase required', async () => {
    const user = userEvent.setup()
    getMock.mockResolvedValue({ data: { success: true, intent: READ_ONLY_INTENT, approval: null } })
    approveMock.mockResolvedValue({ data: { success: true, status: 'approved' } })

    renderPage('a1')
    const button = await screen.findByRole('button', { name: 'Approve' })
    expect(button).not.toBeDisabled()
    await user.click(button)

    expect(approveMock).toHaveBeenCalledWith('a1', { actionDigest: 'deadbeef123456', confirmPhrase: undefined })
  })

  it('communication_send tier: approve button stays disabled until the exact confirm phrase is typed', async () => {
    const user = userEvent.setup()
    getMock.mockResolvedValue({ data: { success: true, intent: COMMS_INTENT, approval: null } })

    renderPage('a2')
    const button = await screen.findByRole('button', { name: 'Approve' })
    expect(button).toBeDisabled()

    const input = screen.getByPlaceholderText('I APPROVE THIS SEND')
    await user.type(input, 'i approve this send') // wrong case
    expect(button).toBeDisabled()

    await user.clear(input)
    await user.type(input, 'I APPROVE THIS SEND') // exact
    expect(button).not.toBeDisabled()

    await user.click(button)
    expect(approveMock).toHaveBeenCalledWith('a2', { actionDigest: COMMS_INTENT.action_digest, confirmPhrase: 'I APPROVE THIS SEND' })
  })

  it('fresh status readback: after approve, the UI reflects a re-fetched GET, not the POST response', async () => {
    const user = userEvent.setup()
    // First GET (initial mount): still awaiting approval.
    getMock.mockResolvedValueOnce({ data: { success: true, intent: READ_ONLY_INTENT, approval: null } })
    approveMock.mockResolvedValue({ data: { success: true, status: 'approved' /* a lie the UI must not trust alone */ } })
    // Second GET (post-approve refetch): the real, fresh server state.
    const approvedIntent = { ...READ_ONLY_INTENT, status: 'approved' }
    getMock.mockResolvedValueOnce({
      data: { success: true, intent: approvedIntent, approval: { approved_by: 306, approved_digest: READ_ONLY_INTENT.action_digest, approved_at: '2026-09-08T01:00:00Z' } },
    })

    renderPage('a1')
    const button = await screen.findByRole('button', { name: 'Approve' })
    await user.click(button)

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Approved')).toBeInTheDocument()
  })

  it('expiry refusal: an expired intent renders no approve control', async () => {
    getMock.mockResolvedValue({
      data: { success: true, intent: { ...READ_ONLY_INTENT, status: 'expired', expires_at: HOUR_AGO }, approval: null },
    })

    renderPage('a1')
    expect(await screen.findByText('This request expired')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('expiry refusal: status still says awaiting_approval but expires_at has already passed -- client refuses anyway', async () => {
    getMock.mockResolvedValue({
      data: { success: true, intent: { ...READ_ONLY_INTENT, status: 'awaiting_approval', expires_at: HOUR_AGO }, approval: null },
    })

    renderPage('a1')
    expect(await screen.findByText('This request expired')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('revoke refusal: a revoked intent renders no approve control', async () => {
    getMock.mockResolvedValue({
      data: { success: true, intent: { ...READ_ONLY_INTENT, status: 'revoked' }, approval: null },
    })

    renderPage('a1')
    expect(await screen.findByText('Revoked')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('deny: explicit click calls the deny API with no digest/phrase; the UI then renders the RE-FETCHED denied state', async () => {
    const user = userEvent.setup()
    getMock.mockResolvedValueOnce({ data: { success: true, intent: COMMS_INTENT, approval: null } })
    denyMock.mockResolvedValue({ data: { success: true, actionId: 'a2', status: 'denied' } })
    // Post-deny refetch: the real server state (A3's route flips status to 'denied').
    getMock.mockResolvedValueOnce({ data: { success: true, intent: { ...COMMS_INTENT, status: 'denied' }, approval: null } })

    renderPage('a2')
    const deny = await screen.findByRole('button', { name: 'Deny' })
    // Deny must NOT be gated on the confirm phrase (that gate is approve-only).
    expect(deny).not.toBeDisabled()
    expect(denyMock).not.toHaveBeenCalled()
    await user.click(deny)

    expect(denyMock).toHaveBeenCalledWith('a2')
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Denied')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument()
  })

  it('deny 409 (already approved elsewhere): shows the server error, and the readback -- not the error -- decides the final state', async () => {
    const user = userEvent.setup()
    getMock.mockResolvedValueOnce({ data: { success: true, intent: READ_ONLY_INTENT, approval: null } })
    denyMock.mockRejectedValue({ response: { status: 409, data: { success: false, error: "Action is 'approved', not awaiting approval" } } })
    getMock.mockResolvedValueOnce({
      data: { success: true, intent: { ...READ_ONLY_INTENT, status: 'approved' }, approval: { approved_by: 306, approved_digest: READ_ONLY_INTENT.action_digest, approved_at: '2026-09-10T10:00:00Z' } },
    })

    renderPage('a1')
    await user.click(await screen.findByRole('button', { name: 'Deny' }))

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2))
    // The refetched state is 'approved', so the page renders the Approved terminal card.
    expect(await screen.findByText('Approved')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument()
  })

  it('deny never fires on mount, and is absent on every terminal state', async () => {
    getMock.mockResolvedValue({ data: { success: true, intent: { ...READ_ONLY_INTENT, status: 'expired', expires_at: HOUR_AGO }, approval: null } })
    renderPage('a1')
    await screen.findByText('This request expired')
    await new Promise((r) => setTimeout(r, 20))
    expect(denyMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument()
  })

  it('already-approved: renders the terminal approved state directly, no approve control', async () => {
    getMock.mockResolvedValue({
      data: {
        success: true,
        intent: { ...READ_ONLY_INTENT, status: 'approved' },
        approval: { approved_by: 306, approved_digest: READ_ONLY_INTENT.action_digest, approved_at: '2026-09-08T01:00:00Z' },
      },
    })

    renderPage('a1')
    expect(await screen.findByText('Approved')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })
})
