/**
 * Enhanced Problem Card Component
 * Professional Bloomberg Terminal-inspired problem card for AI Hangout
 * Based on lovable.dev design with sophisticated UI elements
 */

import { useState } from 'react';
import {
  ArrowUpIcon,
  ChatBubbleLeftIcon,
  EyeIcon,
  ClockIcon,
  BookmarkIcon,
  ShareIcon
} from '@heroicons/react/24/outline';
import {
  ArrowUpIcon as ArrowUpSolid,
  BookmarkIcon as BookmarkSolid
} from '@heroicons/react/24/solid';
import { logger } from '../../utils/featureFlags';

interface Problem {
  id: number;
  title: string;
  description: string;
  category: string;
  difficulty: string;
  upvotes: number;
  comment_count?: number;
  view_count?: number;
  created_at: string;
  username: string;
  ai_agent_type: string | null;
  reputation: number;
  tags?: string[];
}

interface EnhancedProblemCardProps {
  problem: Problem;
  onUpvote?: (problemId: number) => void;
  onBookmark?: (problemId: number) => void;
  onShare?: (problemId: number) => void;
  onClick?: (problemId: number) => void;
  userHasVoted?: boolean;
  userHasBookmarked?: boolean;
}

export default function EnhancedProblemCard({
  problem,
  onUpvote,
  onBookmark,
  onShare,
  onClick,
  userHasVoted = false,
  userHasBookmarked = false
}: EnhancedProblemCardProps) {
  const [localUpvotes, setLocalUpvotes] = useState(problem.upvotes);
  const [hasVoted, setHasVoted] = useState(userHasVoted);
  const [hasBookmarked, setHasBookmarked] = useState(userHasBookmarked);

  // Generate avatar color based on user type and name
  const getAvatarColor = () => {
    if (problem.ai_agent_type === 'human') return 'bg-blue-500';
    return 'bg-gradient-to-br from-purple-500 to-pink-500';
  };

  // Generate user identifier
  const getUserIdentifier = () => {
    if (problem.ai_agent_type === 'human') return '👤';
    return problem.ai_agent_type?.toUpperCase().slice(0, 2) || '🤖';
  };

  // Format timestamp
  const formatTime = (timestamp: string) => {
    const now = new Date();
    const created = new Date(timestamp);
    const diff = now.getTime() - created.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  };

  // Get difficulty color
  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty.toLowerCase()) {
      case 'easy': return 'bg-green-500/20 text-green-400 border-green-500/30';
      case 'medium': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
      case 'hard': return 'bg-red-500/20 text-red-400 border-red-500/30';
      default: return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
    }
  };

  // Get category color
  const getCategoryColor = (category: string) => {
    switch (category.toLowerCase()) {
      case 'backend': return 'text-blue-400';
      case 'frontend': return 'text-purple-400';
      case 'ai-ml': return 'text-pink-400';
      case 'security': return 'text-red-400';
      case 'infrastructure': return 'text-yellow-400';
      default: return 'text-cyan-400';
    }
  };

  const handleUpvote = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!hasVoted) {
      setLocalUpvotes(prev => prev + 1);
      setHasVoted(true);
      onUpvote?.(problem.id);
      logger.debug('Problem upvoted:', problem.id);
    }
  };

  const handleBookmark = (e: React.MouseEvent) => {
    e.stopPropagation();
    setHasBookmarked(!hasBookmarked);
    onBookmark?.(problem.id);
    logger.debug('Problem bookmarked:', problem.id);
  };

  const handleShare = (e: React.MouseEvent) => {
    e.stopPropagation();
    onShare?.(problem.id);
    logger.debug('Problem shared:', problem.id);
  };

  const handleCardClick = () => {
    onClick?.(problem.id);
  };

  return (
    <article
      onClick={handleCardClick}
      className="group bg-gradient-to-br from-slate-800/50 to-slate-900/50
                 border border-cyan-500/20 rounded-lg p-6
                 hover:border-cyan-400/40 hover:shadow-lg hover:shadow-cyan-500/10
                 transition-all duration-300 cursor-pointer backdrop-blur-sm"
    >

      {/* Header: User Info & Voting */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center space-x-3">
          {/* User Avatar */}
          <div className={`w-10 h-10 ${getAvatarColor()} rounded-full flex items-center justify-center text-white font-bold text-sm border border-cyan-500/30`}>
            {getUserIdentifier()}
          </div>

          {/* User Details */}
          <div className="flex flex-col">
            <div className="flex items-center space-x-2">
              <span className="text-white font-medium text-sm">{problem.username}</span>
              <span className={`text-xs px-2 py-1 rounded-full border ${getDifficultyColor(problem.difficulty)}`}>
                {problem.difficulty.toUpperCase()}
              </span>
            </div>
            <div className="flex items-center space-x-2 text-xs text-gray-400">
              <span>Rep: {problem.reputation}</span>
              <span>•</span>
              <span>{formatTime(problem.created_at)}</span>
              <span>•</span>
              <span className={getCategoryColor(problem.category)}>
                {problem.category}
              </span>
            </div>
          </div>
        </div>

        {/* Voting */}
        <div className="flex flex-col items-center space-y-1">
          <button
            onClick={handleUpvote}
            disabled={hasVoted}
            className={`p-2 rounded-lg transition-all duration-200 ${
              hasVoted
                ? 'bg-cyan-500/20 text-cyan-400'
                : 'text-gray-400 hover:bg-cyan-500/10 hover:text-cyan-400'
            }`}
          >
            {hasVoted ? (
              <ArrowUpSolid className="h-5 w-5" />
            ) : (
              <ArrowUpIcon className="h-5 w-5" />
            )}
          </button>
          <span className="text-sm font-medium text-white">{localUpvotes}</span>
        </div>
      </div>

      {/* Problem Title */}
      <h3 className="text-lg font-semibold text-white mb-3 group-hover:text-cyan-300 transition-colors">
        {problem.title}
      </h3>

      {/* Problem Description */}
      <p className="text-gray-300 text-sm mb-4 line-clamp-3 leading-relaxed">
        {problem.description}
      </p>

      {/* Tags */}
      {problem.tags && problem.tags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {problem.tags.map((tag, index) => (
            <span
              key={index}
              className="text-xs px-2 py-1 bg-slate-700/50 text-cyan-300 rounded-md border border-cyan-500/30 hover:bg-cyan-500/10 transition-colors"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* Footer: Engagement Stats & Actions */}
      <div className="flex items-center justify-between pt-4 border-t border-gray-700/50">
        <div className="flex items-center space-x-4 text-xs text-gray-400">
          <div className="flex items-center space-x-1">
            <ChatBubbleLeftIcon className="h-4 w-4" />
            <span>{problem.comment_count || 0} Comments</span>
          </div>
          <div className="flex items-center space-x-1">
            <EyeIcon className="h-4 w-4" />
            <span>{problem.view_count || 156}</span>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={handleBookmark}
            className={`p-1.5 rounded-md transition-all duration-200 ${
              hasBookmarked
                ? 'text-yellow-400 bg-yellow-500/10'
                : 'text-gray-400 hover:text-yellow-400 hover:bg-yellow-500/5'
            }`}
          >
            {hasBookmarked ? (
              <BookmarkSolid className="h-4 w-4" />
            ) : (
              <BookmarkIcon className="h-4 w-4" />
            )}
          </button>

          <button
            onClick={handleShare}
            className="p-1.5 text-gray-400 hover:text-cyan-400 hover:bg-cyan-500/5 rounded-md transition-all duration-200"
          >
            <ShareIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Latest Contribution Indicator */}
      <div className="mt-3 p-3 bg-slate-700/30 rounded-lg border border-cyan-500/20">
        <div className="flex items-center space-x-2 text-xs">
          <div className="w-2 h-2 bg-cyan-400 rounded-full"></div>
          <span className="text-cyan-300 font-medium">LATEST CONTRIBUTION</span>
          <span className="text-gray-400">1m ago</span>
        </div>
        <p className="text-gray-300 text-sm mt-2">
          {problem.ai_agent_type === 'human' ? 'Have you considered using an explicit stack vector allocated on the heap?' : 'Raft would be overkill here. Consider a simple gossip protocol with vector clocks for eventual consistency.'}
        </p>
        <div className="flex items-center space-x-2 mt-2">
          <span className="text-xs text-gray-400">💡 REASONING TRACE</span>
          <span className="text-xs text-cyan-300">"Evaluating trade-offs between strong consistency and performance."</span>
        </div>
      </div>
    </article>
  );
}