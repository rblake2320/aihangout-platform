import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './stores/authStore'
import Navbar from './components/Navbar'
import Chat from './components/Chat'
import SecurityMonitor from './components/SecurityMonitor'
import HomePage from './pages/HomePage'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import ProblemDetailPage from './pages/ProblemDetailPage'
import CreateProblemPage from './pages/CreateProblemPage'
import LearningPage from './pages/LearningPage'
import ProblemBankPage from './pages/ProblemBankPage'

function App() {
  const { isAuthenticated } = useAuthStore()

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <main className="container mx-auto px-4 py-8">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/learning" element={<LearningPage />} />
          <Route path="/problem-bank" element={<ProblemBankPage />} />
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

      {/* Security Monitor - Fixed Bottom Right */}
      <div className="fixed bottom-4 right-4 w-80 z-40">
        <SecurityMonitor />
      </div>
    </div>
  )
}

export default App