import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import '@fontsource-variable/inter'
import App from './App.tsx'
import { AnalyticsProvider } from './contexts/AnalyticsProvider'
import './index.css'
import { createTelemetry } from './telemetry'
import { featureFlags } from './utils/featureFlags'
import { useAuthStore } from './stores/authStore'
import { analyticsAllowed, onConsentChange } from './consent'

// Session telemetry: page/route timing, rage/dead clicks, form abandonment, client errors,
// network failures. Batched to POST /api/analytics/batch. Never reads input values.
// AIH-R4: runs only while the visitor has an explicit "allow analytics" decision and no
// Do Not Track / Global Privacy Control signal; revoking stops it and clears its session id.
let telemetry: ReturnType<typeof createTelemetry> | null = null
const applyConsent = (): void => {
  if (analyticsAllowed()) {
    if (!telemetry) {
      telemetry = createTelemetry({
        enabled: featureFlags.sessionTelemetry,
        getToken: () => useAuthStore.getState().token,
      })
      telemetry.start()
    }
  } else if (telemetry) {
    telemetry.stop()
    telemetry = null
    try { sessionStorage.removeItem('aih_tel_session') } catch { /* ignore */ }
  }
}
applyConsent()
onConsentChange(applyConsent)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5 * 60 * 1000, // 5 minutes
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <AnalyticsProvider>
          <App />
        </AnalyticsProvider>
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 4000,
            style: {
              background: '#363636',
              color: '#fff',
            },
          }}
        />
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
