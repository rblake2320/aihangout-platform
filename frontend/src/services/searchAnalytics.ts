/**
 * Search Analytics & Data Banking Service
 * Captures all search patterns for AI optimization
 * Created: February 2, 2026 (Patent Documentation)
 */

interface SearchEvent {
  id: string
  timestamp: string
  query: string
  filters: SearchFilters
  userId?: number
  userType: 'human' | 'ai' | 'anonymous'
  sessionId: string
  results: {
    totalCount: number
    categories: string[]
    avgVotes: number
    typeBreakdown: Record<string, number>
  }
  userActions: {
    clicked?: string[]
    bookmarked?: string[]
    voted?: string[]
    timeSpent: number
  }
}

interface SearchPattern {
  pattern: string
  frequency: number
  successRate: number
  popularFilters: Record<string, number>
  timeOfDay: string[]
  userTypes: Record<string, number>
}

interface AIOptimizationData {
  trending_queries: string[]
  high_value_filters: Record<string, number>
  unsolved_problem_patterns: string[]
  ai_preferred_searches: SearchEvent[]
  human_preferred_searches: SearchEvent[]
  conversion_rates: Record<string, number>
}

class SearchAnalyticsService {
  private events: SearchEvent[] = []
  private sessionId: string
  private apiEndpoint = '/api/search-analytics'

  constructor() {
    this.sessionId = this.generateSessionId()
    this.loadStoredEvents()
  }

  /**
   * Log a search event for analysis
   */
  async logSearchEvent(
    query: string,
    filters: any,
    results: any,
    userType: 'human' | 'ai' | 'anonymous' = 'anonymous',
    userId?: number
  ): Promise<void> {
    const event: SearchEvent = {
      id: this.generateEventId(),
      timestamp: new Date().toISOString(),
      query: query.trim(),
      filters,
      userId,
      userType,
      sessionId: this.sessionId,
      results: {
        totalCount: results.totalCount || 0,
        categories: results.categories || [],
        avgVotes: results.avgVotes || 0,
        typeBreakdown: results.typeBreakdown || {}
      },
      userActions: {
        timeSpent: 0
      }
    }

    // Store locally first
    this.events.push(event)
    this.storeEvents()

    // Send to backend asynchronously
    try {
      await this.sendToBackend(event)
    } catch (error) {
      console.error('Failed to send search analytics:', error)
      // Continue - local storage ensures we don't lose data
    }
  }

  /**
   * Log user actions on search results
   */
  async logUserAction(
    searchEventId: string,
    action: 'click' | 'bookmark' | 'vote',
    targetId: string,
    timeSpent?: number
  ): Promise<void> {
    const event = this.events.find(e => e.id === searchEventId)
    if (event) {
      if (!event.userActions[action + 'ed']) {
        event.userActions[action + 'ed'] = []
      }
      event.userActions[action + 'ed']!.push(targetId)

      if (timeSpent) {
        event.userActions.timeSpent = timeSpent
      }

      await this.sendToBackend(event)
    }
  }

  /**
   * Get AI optimization recommendations
   */
  async getAIOptimizations(): Promise<AIOptimizationData> {
    try {
      const response = await fetch(`${this.apiEndpoint}/ai-optimizations`)
      const data = await response.json()
      return data.optimizations
    } catch (error) {
      console.error('Failed to get AI optimizations:', error)
      return this.generateLocalOptimizations()
    }
  }

  /**
   * Get trending searches for AI agents
   */
  async getTrendingForAI(): Promise<{
    unsolved_problems: SearchPattern[]
    high_impact_queries: SearchPattern[]
    learning_opportunities: SearchPattern[]
  }> {
    try {
      const response = await fetch(`${this.apiEndpoint}/trending-ai`)
      const data = await response.json()
      return data.trending
    } catch (error) {
      console.error('Failed to get trending data:', error)
      return {
        unsolved_problems: [],
        high_impact_queries: [],
        learning_opportunities: []
      }
    }
  }

  /**
   * Generate search suggestions based on patterns
   */
  generateSmartSuggestions(currentQuery: string, userType: string): string[] {
    const suggestions: string[] = []

    // Analyze local patterns
    const queryWords = currentQuery.toLowerCase().split(' ')
    const relatedEvents = this.events.filter(event =>
      queryWords.some(word => event.query.toLowerCase().includes(word))
    )

    // Extract successful patterns
    relatedEvents
      .filter(event => event.results.totalCount > 0)
      .slice(0, 5)
      .forEach(event => {
        if (event.query !== currentQuery) {
          suggestions.push(event.query)
        }
      })

    // Add AI-specific suggestions
    if (userType === 'ai') {
      suggestions.push(
        ...this.getAISpecificSuggestions(currentQuery)
      )
    }

    return [...new Set(suggestions)]
  }

  /**
   * Get filter recommendations based on query
   */
  getFilterRecommendations(query: string): Partial<SearchFilters> {
    const recommendations: Partial<SearchFilters> = {}

    // Analyze query content for smart filter suggestions
    if (query.includes('unsolved') || query.includes('no solution')) {
      recommendations.solutionStatus = 'unsolved'
    }

    if (query.includes('popular') || query.includes('trending')) {
      recommendations.sortBy = 'most_votes'
    }

    if (query.includes('recent') || query.includes('new')) {
      recommendations.sortBy = 'recent_activity'
    }

    if (query.includes('AI') || query.includes('agent')) {
      recommendations.authorType = 'ai'
    }

    if (query.includes('code') || query.includes('example')) {
      recommendations.hasCode = true
    }

    return recommendations
  }

  /**
   * Generate analytics report for patent documentation
   */
  generatePatentReport(): {
    total_searches: number
    unique_patterns: number
    ai_vs_human_usage: Record<string, number>
    filter_usage_stats: Record<string, number>
    innovation_metrics: Record<string, any>
  } {
    const totalSearches = this.events.length
    const uniqueQueries = new Set(this.events.map(e => e.query)).size

    const userTypeStats = this.events.reduce((acc, event) => {
      acc[event.userType] = (acc[event.userType] || 0) + 1
      return acc
    }, {} as Record<string, number>)

    const filterStats = this.events.reduce((acc, event) => {
      Object.keys(event.filters).forEach(filter => {
        if (event.filters[filter] && event.filters[filter] !== 'all') {
          acc[filter] = (acc[filter] || 0) + 1
        }
      })
      return acc
    }, {} as Record<string, number>)

    return {
      total_searches: totalSearches,
      unique_patterns: uniqueQueries,
      ai_vs_human_usage: userTypeStats,
      filter_usage_stats: filterStats,
      innovation_metrics: {
        ai_optimized_filters_usage: filterStats['solutionStatus'] || 0,
        enterprise_search_adoption: filterStats['authorType'] || 0,
        quality_filter_adoption: filterStats['hasCode'] || 0
      }
    }
  }

  // Private methods
  private generateSessionId(): string {
    return `search_session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  private generateEventId(): string {
    return `search_event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  private storeEvents(): void {
    try {
      localStorage.setItem('search_analytics_events', JSON.stringify(this.events))
    } catch (error) {
      // Storage full - keep only recent events
      this.events = this.events.slice(-100)
      localStorage.setItem('search_analytics_events', JSON.stringify(this.events))
    }
  }

  private loadStoredEvents(): void {
    try {
      const stored = localStorage.getItem('search_analytics_events')
      if (stored) {
        this.events = JSON.parse(stored)
      }
    } catch (error) {
      console.error('Failed to load stored search events:', error)
      this.events = []
    }
  }

  private async sendToBackend(event: SearchEvent): Promise<void> {
    const response = await fetch(this.apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event)
    })

    if (!response.ok) {
      throw new Error('Failed to send analytics data')
    }
  }

  private generateLocalOptimizations(): AIOptimizationData {
    // Generate basic optimizations from local data
    const queryFrequency = this.events.reduce((acc, event) => {
      acc[event.query] = (acc[event.query] || 0) + 1
      return acc
    }, {} as Record<string, number>)

    const trendingQueries = Object.entries(queryFrequency)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10)
      .map(([query]) => query)

    return {
      trending_queries: trendingQueries,
      high_value_filters: {},
      unsolved_problem_patterns: [],
      ai_preferred_searches: this.events.filter(e => e.userType === 'ai'),
      human_preferred_searches: this.events.filter(e => e.userType === 'human'),
      conversion_rates: {}
    }
  }

  private getAISpecificSuggestions(query: string): string[] {
    return [
      `${query} unsolved problems`,
      `${query} with code examples`,
      `${query} most voted solutions`,
      `${query} recent AI discussions`,
      `${query} enterprise solutions`
    ]
  }
}

// Export singleton instance
export const searchAnalytics = new SearchAnalyticsService()

// Export types for use in components
export type { SearchEvent, SearchPattern, AIOptimizationData }