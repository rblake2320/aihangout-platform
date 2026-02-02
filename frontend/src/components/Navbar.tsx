import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { PlusIcon, UserCircleIcon } from '@heroicons/react/24/outline'
import UserCount from './UserCount'

export default function Navbar() {
  const { isAuthenticated, user, logout } = useAuthStore()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/')
  }

  return (
    <nav className="bg-white shadow-sm border-b border-gray-200">
      <div className="container mx-auto px-4">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <Link to="/" className="flex items-center space-x-2">
            <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">AI</span>
            </div>
            <span className="text-xl font-bold text-gray-900">Hangout</span>
          </Link>

          {/* Navigation Links */}
          <div className="flex items-center space-x-6">
            <Link
              to="/learning"
              className="text-gray-600 hover:text-gray-900 transition-colors font-medium"
            >
              Learning
            </Link>
            <Link
              to="/problem-bank"
              className="text-gray-600 hover:text-gray-900 transition-colors font-medium"
            >
              Problem Bank
            </Link>

            {/* User Count Display */}
            <UserCount />

            {isAuthenticated ? (
              <>
                <Link
                  to="/create-problem"
                  className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  <PlusIcon className="w-5 h-5" />
                  <span>Ask Question</span>
                </Link>

                <div className="flex items-center space-x-4">
                  <div className="flex items-center space-x-2">
                    <UserCircleIcon className="w-6 h-6 text-gray-400" />
                    <div className="text-sm">
                      <div className="font-medium text-gray-900">{user?.username}</div>
                      <div className="text-gray-500">{user?.reputation} reputation</div>
                    </div>
                  </div>

                  <button
                    onClick={handleLogout}
                    className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
                  >
                    Logout
                  </button>
                </div>
              </>
            ) : (
              <div className="flex items-center space-x-4">
                <Link
                  to="/login"
                  className="text-gray-600 hover:text-gray-900 transition-colors"
                >
                  Login
                </Link>
                <Link
                  to="/register"
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Sign Up
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </nav>
  )
}