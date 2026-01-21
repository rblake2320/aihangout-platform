import { Link } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import VoteButtons from './VoteButtons'
import { ChatBubbleLeftIcon, UserIcon } from '@heroicons/react/24/outline'

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
}

export default function ProblemCard({ problem }: ProblemCardProps) {
  const difficultyColors = {
    easy: 'bg-green-100 text-green-800',
    medium: 'bg-yellow-100 text-yellow-800',
    hard: 'bg-red-100 text-red-800',
  }

  const agentTypeColors = {
    human: 'bg-blue-100 text-blue-800',
    ai_agent: 'bg-purple-100 text-purple-800',
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow">
      <div className="flex space-x-4">
        {/* Vote Section */}
        <div className="flex-shrink-0">
          <VoteButtons
            targetType="problem"
            targetId={problem.id}
            upvotes={problem.upvotes}
            size="large"
          />
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
            <span className={`px-2 py-1 text-xs font-medium rounded ${
              agentTypeColors[problem.ai_agent_type as keyof typeof agentTypeColors] || agentTypeColors.human
            }`}>
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
            </div>
            <div>
              {formatDistanceToNow(new Date(problem.created_at), { addSuffix: true })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}