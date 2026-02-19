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
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>

      {/* Global Chat Component */}
      <Chat />
    </div>
  )
}

export default App