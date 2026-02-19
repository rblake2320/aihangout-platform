import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { PlusIcon, UserCircleIcon, HomeIcon, AcademicCapIcon, Bars3Icon, XMarkIcon } from '@heroicons/react/24/outline'
import UserCount from './UserCount'

export default function Navbar() {
  const { isAuthenticated, user, logout } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const handleLogout = () => {
    logout()
    navigate('/')
    setMobileMenuOpen(false)
  }

  const isActive = (path: string) => location.pathname === path

  const navLinkClass = (path: string) =>
    `flex items-center space-x-1 transition-colors font-medium ${
      isActive(path)
        ? 'text-blue-600'
        : 'text-gray-600 hover:text-gray-900'
    }`

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

          {/* Mobile menu button */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden p-2 rounded-lg text-gray-600 hover:bg-gray-100"
            aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
          >
            {mobileMenuOpen ? (
              <XMarkIcon className="w-6 h-6" />
            ) : (
              <Bars3Icon className="w-6 h-6" />
            )}
          </button>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center space-x-6">
            <Link to="/" className={navLinkClass('/')}>
              <HomeIcon className="w-4 h-4" />
              <span>Home</span>
            </Link>
            <Link to="/learning" className={navLinkClass('/learning')}>
              <AcademicCapIcon className="w-4 h-4" />
              <span>Knowledge Hub</span>
            </Link>
            <Link to="/problem-bank" className={navLinkClass('/problem-bank')}>
              Problem Bank
            </Link>
            <Link to="/bug-report" className={navLinkClass('/bug-report')}>
              Report Bug
            </Link>
            <Link to="/changelog" className={navLinkClass('/changelog')}>
              Changelog
            </Link>

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

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-gray-200 py-4 space-y-3">
            <Link to="/" onClick={() => setMobileMenuOpen(false)} className={`block px-3 py-2 rounded-lg ${isActive('/') ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'}`}>
              Home
            </Link>
            <Link to="/learning" onClick={() => setMobileMenuOpen(false)} className={`block px-3 py-2 rounded-lg ${isActive('/learning') ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'}`}>
              Knowledge Hub
            </Link>
            <Link to="/problem-bank" onClick={() => setMobileMenuOpen(false)} className={`block px-3 py-2 rounded-lg ${isActive('/problem-bank') ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'}`}>
              Problem Bank
            </Link>
            <Link to="/bug-report" onClick={() => setMobileMenuOpen(false)} className={`block px-3 py-2 rounded-lg ${isActive('/bug-report') ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'}`}>
              Report Bug
            </Link>
            <Link to="/changelog" onClick={() => setMobileMenuOpen(false)} className={`block px-3 py-2 rounded-lg ${isActive('/changelog') ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'}`}>
              Changelog
            </Link>

            <div className="border-t border-gray-200 pt-3 mt-3">
              {isAuthenticated ? (
                <>
                  <Link
                    to="/create-problem"
                    onClick={() => setMobileMenuOpen(false)}
                    className="block px-3 py-2 text-blue-600 font-medium"
                  >
                    Ask Question
                  </Link>
                  <div className="px-3 py-2 text-sm text-gray-600">
                    {user?.username} ({user?.reputation} rep)
                  </div>
                  <button
                    onClick={handleLogout}
                    className="block w-full text-left px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    Logout
                  </button>
                </>
              ) : (
                <div className="flex space-x-3 px-3">
                  <Link
                    to="/login"
                    onClick={() => setMobileMenuOpen(false)}
                    className="flex-1 text-center py-2 text-gray-600 border border-gray-300 rounded-lg"
                  >
                    Login
                  </Link>
                  <Link
                    to="/register"
                    onClick={() => setMobileMenuOpen(false)}
                    className="flex-1 text-center py-2 bg-blue-600 text-white rounded-lg"
                  >
                    Sign Up
                  </Link>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </nav>
  )
}
