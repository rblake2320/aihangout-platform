import { useState } from 'react'

interface SolutionFormProps {
  onSubmit: (data: {
    solutionText: string
    codeSnippet?: string
    whyExplanation: string
  }) => void
  isLoading: boolean
  onCancel: () => void
}

export default function SolutionForm({ onSubmit, isLoading, onCancel }: SolutionFormProps) {
  const [formData, setFormData] = useState({
    solutionText: '',
    codeSnippet: '',
    whyExplanation: ''
  })

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit({
      solutionText: formData.solutionText,
      codeSnippet: formData.codeSnippet || undefined,
      whyExplanation: formData.whyExplanation
    })
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 space-y-4">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Add Your Solution</h3>

      {/* Solution Text */}
      <div>
        <label htmlFor="solutionText" className="block text-sm font-medium text-gray-700 mb-2">
          Solution *
        </label>
        <textarea
          id="solutionText"
          name="solutionText"
          required
          rows={6}
          value={formData.solutionText}
          onChange={handleChange}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          placeholder="Describe your solution step by step..."
        />
      </div>

      {/* Code Snippet */}
      <div>
        <label htmlFor="codeSnippet" className="block text-sm font-medium text-gray-700 mb-2">
          Code Snippet (Optional)
        </label>
        <textarea
          id="codeSnippet"
          name="codeSnippet"
          rows={8}
          value={formData.codeSnippet}
          onChange={handleChange}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
          placeholder="// Your code here..."
        />
      </div>

      {/* Why Explanation */}
      <div>
        <label htmlFor="whyExplanation" className="block text-sm font-medium text-gray-700 mb-2">
          Why This Works *
        </label>
        <textarea
          id="whyExplanation"
          name="whyExplanation"
          required
          rows={4}
          value={formData.whyExplanation}
          onChange={handleChange}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          placeholder="Explain why your solution works and the reasoning behind it..."
        />
        <p className="mt-1 text-sm text-gray-500">
          Help others understand the logic and learn from your approach
        </p>
      </div>

      {/* Submit Buttons */}
      <div className="flex justify-end space-x-3 pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isLoading ? (
            <div className="flex items-center space-x-2">
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              <span>Submitting...</span>
            </div>
          ) : (
            'Submit Solution'
          )}
        </button>
      </div>
    </form>
  )
}