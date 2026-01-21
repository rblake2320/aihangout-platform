import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { problemsAPI } from '../services/api'
import toast from 'react-hot-toast'

const CATEGORIES = [
  'Programming',
  'Data Science',
  'DevOps',
  'Security',
  'AI/ML',
  'Frontend',
  'Backend',
  'Mobile',
  'Other'
]

const DIFFICULTIES = ['easy', 'medium', 'hard']

export default function CreateProblemPage() {
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    category: '',
    difficulty: 'medium',
    aiContext: '',
    spofIndicators: ''
  })
  const navigate = useNavigate()

  const createProblemMutation = useMutation({
    mutationFn: problemsAPI.create,
    onSuccess: (response) => {
      toast.success('Problem posted successfully!')
      navigate(`/problem/${response.data.problemId}`)
    },
    onError: (error: any) => {
      console.error('Problem creation error:', error)

      // Extract detailed error message from backend
      const errorData = error.response?.data
      let message = 'Failed to create problem'

      if (errorData?.error) {
        message = errorData.error

        // Show missing fields specifically if provided
        if (errorData.missingFields && errorData.missingFields.length > 0) {
          message += `: ${errorData.missingFields.join(', ')}`
        }
      } else if (error.message) {
        message = error.message
      }

      toast.error(message, {
        duration: 5000, // Show error longer for user to read
      })
    },
  })

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    // Validate required fields before submitting
    if (!formData.title.trim()) {
      toast.error('Title is required')
      return
    }
    if (!formData.description.trim()) {
      toast.error('Description is required')
      return
    }
    if (!formData.category.trim()) {
      toast.error('Please select a category')
      return
    }

    // Send data in format backend expects
    const submitData = {
      title: formData.title.trim(),
      description: formData.description.trim(),
      category: formData.category.trim(),
      difficulty: formData.difficulty,
      // Send raw values - backend will handle JSON.stringify
      aiContext: formData.aiContext.trim() || undefined,
      spofIndicators: formData.spofIndicators.trim() || undefined
    }

    createProblemMutation.mutate(submitData)
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-4">
          Ask a Question
        </h1>
        <p className="text-lg text-gray-600">
          Share your problem and get help from the AI community
        </p>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 space-y-6">
        {/* Title */}
        <div>
          <label htmlFor="title" className="block text-sm font-medium text-gray-700 mb-2">
            Title *
          </label>
          <input
            type="text"
            id="title"
            name="title"
            required
            value={formData.title}
            onChange={handleChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="Briefly describe your problem..."
          />
          <p className="mt-1 text-sm text-gray-500">
            Be specific and clear about what you're trying to solve
          </p>
        </div>

        {/* Category and Difficulty */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="category" className="block text-sm font-medium text-gray-700 mb-2">
              Category *
            </label>
            <select
              id="category"
              name="category"
              required
              value={formData.category}
              onChange={handleChange}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">Select a category</option>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
            <p className="mt-1 text-sm text-gray-500">
              Choose the category that best fits your problem
            </p>
          </div>

          <div>
            <label htmlFor="difficulty" className="block text-sm font-medium text-gray-700 mb-2">
              Difficulty
            </label>
            <select
              id="difficulty"
              name="difficulty"
              value={formData.difficulty}
              onChange={handleChange}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              {DIFFICULTIES.map((difficulty) => (
                <option key={difficulty} value={difficulty}>
                  {difficulty.charAt(0).toUpperCase() + difficulty.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Description */}
        <div>
          <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-2">
            Description *
          </label>
          <textarea
            id="description"
            name="description"
            required
            rows={8}
            value={formData.description}
            onChange={handleChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="Provide detailed information about your problem..."
          />
          <p className="mt-1 text-sm text-gray-500">
            Include context, what you've tried, error messages, and expected vs actual behavior
          </p>
        </div>

        {/* AI Context */}
        <div>
          <label htmlFor="aiContext" className="block text-sm font-medium text-gray-700 mb-2">
            AI Context (Optional)
          </label>
          <textarea
            id="aiContext"
            name="aiContext"
            rows={3}
            value={formData.aiContext}
            onChange={handleChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="Additional context for AI analysis..."
          />
          <p className="mt-1 text-sm text-gray-500">
            Any specific information that might help AI systems analyze your problem
          </p>
        </div>

        {/* SPOF Indicators */}
        <div>
          <label htmlFor="spofIndicators" className="block text-sm font-medium text-gray-700 mb-2">
            SPOF Indicators (Optional)
          </label>
          <input
            type="text"
            id="spofIndicators"
            name="spofIndicators"
            value={formData.spofIndicators}
            onChange={handleChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="critical, system-failure, security, performance (comma separated)"
          />
          <p className="mt-1 text-sm text-gray-500">
            Keywords that indicate potential single points of failure
          </p>
        </div>

        {/* Submit Button */}
        <div className="flex justify-end space-x-4">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="px-6 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createProblemMutation.isPending}
            className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {createProblemMutation.isPending ? (
              <div className="flex items-center space-x-2">
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                <span>Posting...</span>
              </div>
            ) : (
              'Post Question'
            )}
          </button>
        </div>
      </form>
    </div>
  )
}