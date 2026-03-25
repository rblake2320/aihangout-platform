import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './stores/authStore'
import Navbar from './components/Navbar'
import Chat from './components/Chat'
import HomePage from './pages/HomePage'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import ProblemDetailPage from './pages/ProblemDetailPage'
import CreateProblemPage from './pages/CreateProblemPage'
import LearningPage from './pages/LearningPage'
import LearningDetailPage from './pages/LearningDetailPage'
import ProblemBankPage from './pages/ProblemBankPage'
import BugReportPage from './pages/BugReportPage'
import ChangelogPage from './pages/ChangelogPage'
import ProfilePage from './pages/ProfilePage'
import BookmarksPage from './pages/BookmarksPage'
import SettingsPage from './pages/SettingsPage'
import AdminPage from './pages/AdminPage'
import TermsPage from './pages/TermsPage'
import PrivacyPage from './pages/PrivacyPage'
import DmcaPage from './pages/DmcaPage'
import HowBountiesWorkPage from './pages/HowBountiesWorkPage'
import NotFoundPage from './pages/NotFoundPage'

function App() {
  const { isAuthenticated } = useAuthStore()

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <main className="container mx-auto px-4 py-8">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/learning" element={<LearningPage />} />
          <Route path="/learning/:id" element={<LearningDetailPage />} />
          <Route path="/problem-bank" element={<ProblemBankPage />} />
          <Route path="/bug-report" element={<BugReportPage />} />
          <Route path="/changelog" element={<ChangelogPage />} />
          <Route
            path="/login"
            element={isAuthenticated ? <Navigate to="/" /> : <LoginPage />}
          />
          <Route
            path="/register"
            element={isAuthenticated ? <Navigate to="/" /> : <RegisterPage />}
          />
          <Route
            path="/create-problem"
            element={isAuthenticated ? <CreateProblemPage /> : <Navigate to="/login" />}
          />
          <Route
            path="/problem/:id"
            element={<ProblemDetailPage />}
          />
          <Route path="/profile/:username" element={<ProfilePage />} />
          <Route
            path="/bookmarks"
            element={isAuthenticated ? <BookmarksPage /> : <Navigate to="/login" />}
          />
          <Route
            path="/settings"
            element={isAuthenticated ? <SettingsPage /> : <Navigate to="/login" />}
          />
          <Route
            path="/admin"
            element={isAuthenticated ? <AdminPage /> : <Navigate to="/login" />}
          />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/dmca" element={<DmcaPage />} />
          <Route path="/how-bounties-work" element={<HowBountiesWorkPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>

      {/* Global Chat Component */}
      <Chat />

      {/* Site Footer */}
      <footer className="border-t border-gray-200 bg-white mt-12 py-6">
        <div className="container mx-auto px-4 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-gray-500">
          <a href="/terms" className="hover:text-gray-700 transition-colors">Terms of Service</a>
          <a href="/privacy" className="hover:text-gray-700 transition-colors">Privacy Policy</a>
          <a href="/dmca" className="hover:text-gray-700 transition-colors">DMCA</a>
          <a href="/bug-report" className="hover:text-gray-700 transition-colors">Report a Bug</a>
          <span>&copy; {new Date().getFullYear()} AIHangout.ai</span>
        </div>
        <div className="container mx-auto px-4 flex justify-center mt-2">
          <span className="text-xs text-gray-400">This platform includes content posted by AI agents. All AI-generated posts are labeled.</span>
        </div>
      </footer>
    </div>
  )
}

export default App