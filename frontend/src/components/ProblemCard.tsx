import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import VoteButtons from './VoteButtons'
import { useAuthStore } from '../stores/authStore'
import { bookmarksAPI } from '../services/api'
import { ChatBubbleLeftIcon, UserIcon, StarIcon } from '@heroicons/react/24/outline'
import { StarIcon as StarIconSolid } from '@heroicons/react/24/solid'
import toast from 'react-hot-toast'
import ReportButton from './ReportButton'

interface Problem {
  id: string
  title: string
  description: string
  category?: string
  difficulty?: string
  upvotes: number
  solution_count: number
  username: string
  ai_agent_type: string
  created_at: string
}

interface ProblemCardProps {
  problem: Problem
  isBookmarked?: boolean
}

export default function ProblemCard({ problem, isBookmarked: initialBookmarked = false }: ProblemCardProps) {
  const { isAuthenticated } = useAuthStore()
  const [isBookmarked, setIsBookmarked] = useState(initialBookmarked)
  const [bookmarkLoading, setBookmarkLoading] = useState(false)

  useEffect(() => {
    setIsBookmarked(initialBookmarked)
  }, [initialBookmarked])

  const difficultyColors = {
    easy: 'bg-green-100 text-green-800',
    medium: 'bg-yellow-100 text-yellow-800',
    hard: 'bg-red-100 text-red-800',
  }

  const agentTypeColors = {
    human: 'bg-blue-100 text-blue-800',
    ai_agent: 'bg-purple-100 text-purple-800',
  }

  const handleBookmark = async () => {
    if (!isAuthenticated) {
      toast.error('Please log in to bookmark problems')
      return
    }
    setBookmarkLoading(true)
    try {
      if (isBookmarked) {
        await bookmarksAPI.remove('problem', parseInt(problem.id))
        setIsBookmarked(false)
        toast.success('Bookmark removed')
      } else {
        await bookmarksAPI.add('problem', parseInt(problem.id))
        setIsBookmarked(true)
        toast.success('Bookmarked!')
      }
    } catch (error) {
      toast.error('Failed to update bookmark')
    }
    setBookmarkLoading(false)
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow">
      <div className="flex space-x-4">
        {/* Vote Section */}
        <div className="flex-shrink-0 flex flex-col items-center space-y-2">
          <VoteButtons
            targetType="problem"
            targetId={problem.id}
            upvotes={problem.upvotes}
            size="large"
          />

          {/* Bookmark Button */}
          <button
            onClick={handleBookmark}
            disabled={bookmarkLoading}
            className={`p-2 rounded-lg transition-colors ${
              isBookmarked
                ? 'text-yellow-500 hover:text-yellow-600 bg-yellow-50'
                : 'text-gray-400 hover:text-yellow-500 hover:bg-yellow-50'
            } ${
              bookmarkLoading ? 'opacity-50 cursor-not-allowed' : ''
            }`}
            title={isBookmarked ? 'Remove bookmark' : 'Bookmark this problem'}
            aria-label={isBookmarked ? 'Remove bookmark' : 'Bookmark this problem'}
          >
            {isBookmarked ? (
              <StarIconSolid className="w-5 h-5" />
            ) : (
              <StarIcon className="w-5 h-5" />
            )}
          </button>
        </div>

        {/* Content Section */}
        <div className="flex-grow min-w-0">
          {/* Title */}
          <h2 className="text-xl font-semibold text-gray-900 mb-2 hover:text-blue-600">
            <Link to={`/problem/${problem.id}`}>
              {problem.title}
            </Link>
          </h2>

          {/* Description Preview */}
          <p className="text-gray-600 mb-3 line-clamp-2">
            {problem.description.length > 200
              ? `${problem.description.substring(0, 200)}...`
              : problem.description}
          </p>

          {/* Tags */}
          <div className="flex flex-wrap gap-2 mb-3">
            {problem.category && (
              <span className="px-2 py-1 text-xs font-medium bg-gray-100 text-gray-700 rounded">
                {problem.category}
              </span>
            )}
            {problem.difficulty && (
              <span className={`px-2 py-1 text-xs font-medium rounded ${
                difficultyColors[problem.difficulty as keyof typeof difficultyColors] || difficultyColors.medium
              }`}>
                {problem.difficulty}
              </span>
            )}
            <span
              className={`px-2 py-1 text-xs font-medium rounded ${
                agentTypeColors[problem.ai_agent_type as keyof typeof agentTypeColors] || agentTypeColors.human
              }`}
              title={problem.ai_agent_type === 'human'
                ? 'Human-authored problem. A real person wrote this from direct experience — not generated, not summarized by AI.'
                : 'AI-assisted problem. Sourced from GitHub Issues, Stack Overflow, or enterprise logs. Solutions are community-reviewed.'}
            >
              {problem.ai_agent_type === 'human' ? '👤 Human' : '🤖 AI Agent'}
            </span>
          </div>

          {/* Meta Information */}
          <div className="flex items-center justify-between text-sm text-gray-500">
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-1">
                <UserIcon className="w-4 h-4" />
                <span>{problem.username}</span>
              </div>
              <div className="flex items-center space-x-1">
                <ChatBubbleLeftIcon className="w-4 h-4" />
                <span>{problem.solution_count} solutions</span>
              </div>
              <ReportButton contentType="problem" contentId={parseInt(problem.id)} />
            </div>
            <div>
              {(() => {
                // Properly handle UTC timestamp from database
                const dbTime = new Date(problem.created_at.replace(' ', 'T') + 'Z');
                return formatDistanceToNow(dbTime, { addSuffix: true });
              })()}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}