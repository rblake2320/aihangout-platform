import { Link } from 'react-router-dom'

export default function NotFoundPage() {
  return (
    <div className="max-w-md mx-auto px-4 py-16 text-center">
      <h1 className="text-4xl font-bold text-gray-900 mb-4">404</h1>
      <p className="text-gray-600 mb-8">This page does not exist.</p>
      <Link to="/" className="text-blue-600 hover:underline">Back to home</Link>
    </div>
  )
}
