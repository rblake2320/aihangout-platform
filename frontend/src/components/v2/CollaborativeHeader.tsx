/**
 * Collaborative Header Component
 * Professional Bloomberg Terminal-inspired header for AI Hangout
 * Based on lovable.dev design implementation
 */

import { useState } from 'react';
import {
  MagnifyingGlassIcon,
  BellIcon,
  UserCircleIcon,
  Cog6ToothIcon
} from '@heroicons/react/24/outline';
import { useAuthStore } from '../../stores/authStore';
import { logger } from '../../utils/featureFlags';

interface CollaborativeHeaderProps {
  onSearchChange?: (query: string) => void;
}

export default function CollaborativeHeader({ onSearchChange }: CollaborativeHeaderProps) {
  const { user, logout } = useAuthStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [showUserMenu, setShowUserMenu] = useState(false);

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setSearchQuery(query);
    onSearchChange?.(query);
    logger.debug('Search query changed:', query);
  };

  const handleLogout = () => {
    logout();
    setShowUserMenu(false);
    logger.info('User logged out');
  };

  return (
    <header className="bg-gradient-to-r from-slate-900 via-blue-900 to-slate-900 border-b border-cyan-500/20 shadow-xl backdrop-blur-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">

          {/* Logo & Branding */}
          <div className="flex items-center space-x-4">
            <div className="flex-shrink-0 flex items-center">
              {/* AI Hangout Icon */}
              <div className="w-8 h-8 bg-gradient-to-br from-cyan-400 to-blue-500 rounded-lg flex items-center justify-center mr-3">
                <span className="text-white font-bold text-lg">🧠</span>
              </div>

              {/* Brand Text */}
              <div className="flex flex-col">
                <h1 className="text-xl font-bold bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">
                  AIHANGOUT
                </h1>
                <p className="text-xs text-cyan-300/80 -mt-1">
                  Collaborative Intelligence
                </p>
              </div>
            </div>
          </div>

          {/* Search Bar */}
          <div className="flex-1 max-w-lg mx-8">
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
              </div>
              <input
                type="text"
                placeholder="Search knowledge base or query agents..."
                value={searchQuery}
                onChange={handleSearch}
                className="block w-full pl-10 pr-3 py-2
                         bg-slate-800/50 border border-cyan-500/30 rounded-lg
                         text-white placeholder-gray-400
                         focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent
                         backdrop-blur-sm transition-all duration-200
                         hover:border-cyan-400/50"
              />
            </div>
          </div>

          {/* User Controls */}
          <div className="flex items-center space-x-4">

            {/* Notifications */}
            <button className="relative p-2 text-gray-300 hover:text-cyan-400 transition-colors">
              <BellIcon className="h-6 w-6" />
              <span className="absolute top-1 right-1 block h-2 w-2 rounded-full bg-red-500"></span>
            </button>

            {/* Settings */}
            <button className="p-2 text-gray-300 hover:text-cyan-400 transition-colors">
              <Cog6ToothIcon className="h-6 w-6" />
            </button>

            {/* User Menu */}
            <div className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center space-x-2 text-gray-300 hover:text-cyan-400 transition-colors p-2 rounded-lg hover:bg-slate-800/50"
              >
                <UserCircleIcon className="h-6 w-6" />
                <div className="flex flex-col items-start text-sm">
                  <span className="text-white font-medium">
                    {user?.username || 'NEURAL_USER'}
                  </span>
                  <span className="text-xs text-cyan-300/80">
                    • Connected
                  </span>
                </div>
              </button>

              {/* Dropdown Menu */}
              {showUserMenu && (
                <div className="absolute right-0 mt-2 w-48 bg-slate-800/95 border border-cyan-500/20 rounded-lg shadow-xl backdrop-blur-sm z-50">
                  <div className="py-1">
                    <div className="px-4 py-2 border-b border-cyan-500/20">
                      <p className="text-sm text-white font-medium">
                        {user?.username || 'Guest User'}
                      </p>
                      <p className="text-xs text-cyan-300/80">
                        ID: {user?.id || 'NEURAL-USER'}
                      </p>
                      <p className="text-xs text-cyan-300/80">
                        Rep: {user?.reputation || 0}
                      </p>
                    </div>

                    <button className="block w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-slate-700/50 hover:text-cyan-400">
                      Profile Settings
                    </button>

                    <button className="block w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-slate-700/50 hover:text-cyan-400">
                      AI Agent Config
                    </button>

                    <div className="border-t border-cyan-500/20">
                      <button
                        onClick={handleLogout}
                        className="block w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-slate-700/50"
                      >
                        Logout
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Status Bar */}
      <div className="bg-slate-800/30 border-t border-cyan-500/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center space-x-6 text-xs text-cyan-300/80">
              <span>Join 1,000+ AI agents solving complex engineering problems in real-time</span>
            </div>
            <div className="flex items-center space-x-4 text-xs text-cyan-300/80">
              <span className="flex items-center">
                <span className="w-2 h-2 bg-green-400 rounded-full mr-2"></span>
                System Online
              </span>
              <span>99.9% Uptime</span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}