import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronUpIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import { votingAPI } from '../services/api'
import { useAuthStore } from '../stores/authStore'
import toast from 'react-hot-toast'

interface VoteButtonsProps {
  targetType: 'problem' | 'solution'
  targetId: string
  upvotes: number
  size?: 'small' | 'large'
  userVote?: 'up' | 'down' | null
}

export default function VoteButtons({
  targetType,
  targetId,
  upvotes,
  size = 'small',
  userVote = null
}: VoteButtonsProps) {
  const { isAuthenticated } = useAuthStore()
  const queryClient = useQueryClient()
  const [currentVote, setCurrentVote] = useState<'up' | 'down' | null>(userVote)
  const [voteCount, setVoteCount] = useState(upvotes)

  const voteMutation = useMutation({
    mutationFn: ({ voteType }: { voteType: 'up' | 'down' }) =>
      votingAPI.vote(targetType, targetId, voteType),
    onSuccess: (response) => {
      setVoteCount(response.data.upvotes)
      // Invalidate and refetch relevant queries
      queryClient.invalidateQueries({ queryKey: ['problems'] })
      queryClient.invalidateQueries({ queryKey: ['problem', targetId] })
    },
    onError: (error: any) => {
      const message = error.response?.data?.error || 'Failed to vote'
      toast.error(message)
      // Revert optimistic update
      setCurrentVote(userVote)
      setVoteCount(upvotes)
    },
  })

  const handleVote = (voteType: 'up' | 'down') => {
    if (!isAuthenticated) {
      toast.error('Please login to vote')
      return
    }

    // Optimistic update
    const newVote = currentVote === voteType ? null : voteType
    setCurrentVote(newVote)

    // Optimistic vote count update
    if (currentVote === 'up' && voteType === 'down') {
      setVoteCount(voteCount - 2) // Remove upvote and add downvote
    } else if (currentVote === 'down' && voteType === 'up') {
      setVoteCount(voteCount + 2) // Remove downvote and add upvote
    } else if (currentVote === null && voteType === 'up') {
      setVoteCount(voteCount + 1) // Add upvote
    } else if (currentVote === null && voteType === 'down') {
      setVoteCount(voteCount - 1) // Add downvote
    } else if (currentVote === 'up' && voteType === 'up') {
      setVoteCount(voteCount - 1) // Remove upvote
    } else if (currentVote === 'down' && voteType === 'down') {
      setVoteCount(voteCount + 1) // Remove downvote
    }

    voteMutation.mutate({ voteType })
  }

  const buttonSize = size === 'large' ? 'w-10 h-10' : 'w-8 h-8'
  const iconSize = size === 'large' ? 'w-6 h-6' : 'w-5 h-5'
  const textSize = size === 'large' ? 'text-lg font-semibold' : 'text-sm font-medium'

  return (
    <div className="flex flex-col items-center space-y-1">
      {/* Upvote Button */}
      <button
        onClick={() => handleVote('up')}
        disabled={voteMutation.isPending}
        className={`${buttonSize} rounded-md border-2 flex items-center justify-center transition-all ${
          currentVote === 'up'
            ? 'bg-orange-500 border-orange-500 text-white shadow-md'
            : 'bg-white border-gray-200 text-gray-400 hover:border-orange-300 hover:text-orange-500'
        } ${voteMutation.isPending ? 'opacity-50 cursor-not-allowed' : 'hover:scale-110'}`}
      >
        <ChevronUpIcon className={iconSize} />
      </button>

      {/* Vote Count */}
      <div className={`${textSize} text-gray-900 min-w-8 text-center`}>
        {voteCount}
      </div>

      {/* Downvote Button */}
      <button
        onClick={() => handleVote('down')}
        disabled={voteMutation.isPending}
        className={`${buttonSize} rounded-md border-2 flex items-center justify-center transition-all ${
          currentVote === 'down'
            ? 'bg-blue-500 border-blue-500 text-white shadow-md'
            : 'bg-white border-gray-200 text-gray-400 hover:border-blue-300 hover:text-blue-500'
        } ${voteMutation.isPending ? 'opacity-50 cursor-not-allowed' : 'hover:scale-110'}`}
      >
        <ChevronDownIcon className={iconSize} />
      </button>
    </div>
  )
}