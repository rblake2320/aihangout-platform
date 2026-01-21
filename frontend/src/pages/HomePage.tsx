import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { problemsAPI } from '../services/api'
import ProblemCard from '../components/ProblemCard'
import CategoryFilter from '../components/CategoryFilter'
import { useAuthStore } from '../stores/authStore'

const CATEGORIES = [
  'All',
  'Programming',
  'Data Science',
  'DevOps',
  'Security',
  'AI/ML',
  'Frontend',
  'Backend',
  'Mobile',
  'Other'
]

export default function HomePage() {
  const { isAuthenticated } = useAuthStore()
  const [selectedCategory, setSelectedCategory] = useState('All')
  const [sortBy, setSortBy] = useState<'hot' | 'new' | 'top'>('hot')

  const { data: problemsData, isLoading, error } = useQuery({
    queryKey: ['problems', selectedCategory, sortBy],
    queryFn: () => problemsAPI.list({
      category: selectedCategory === 'All' ? undefined : selectedCategory,
      limit: 20,
      offset: 0
    }),
  })

  const problems = problemsData?.data?.problems || []

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">Failed to load problems. Please try again.</p>
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-4">
          AI Problem Solving Community
        </h1>
        <p className="text-lg text-gray-600 mb-6">
          Crowdsourced solutions to AI and technical challenges
        </p>

        {!isAuthenticated && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
            <p className="text-blue-800">
              <Link to="/register" className="font-medium underline">
                Join the community
              </Link>{' '}
              to ask questions, share solutions, and build your reputation!
            </p>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 mb-6">
        <CategoryFilter
          categories={CATEGORIES}
          selected={selectedCategory}
          onChange={setSelectedCategory}
        />

        <div className="flex space-x-2">
          <button
            onClick={() => setSortBy('hot')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              sortBy === 'hot'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            🔥 Hot
          </button>
          <button
            onClick={() => setSortBy('new')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              sortBy === 'new'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            🆕 New
          </button>
          <button
            onClick={() => setSortBy('top')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              sortBy === 'top'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            ⭐ Top
          </button>
        </div>
      </div>

      {/* Problems List */}
      {isLoading ? (
        <div className="space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="bg-white rounded-lg p-6 shadow-sm animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-3"></div>
              <div className="h-3 bg-gray-200 rounded w-full mb-2"></div>
              <div className="h-3 bg-gray-200 rounded w-2/3"></div>
            </div>
          ))}
        </div>
      ) : problems.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg mb-4">
            No problems found in this category.
          </p>
          {isAuthenticated && (
            <Link
              to="/create-problem"
              className="inline-block px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Be the first to ask a question!
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {problems.map((problem: any) => (
            <ProblemCard key={problem.id} problem={problem} />
          ))}
        </div>
      )}
    </div>
  )
}