import { useContext } from 'react'
import { AnalyticsContext } from '../contexts/AnalyticsProvider'

export function useAnalytics() {
  return useContext(AnalyticsContext)
}
