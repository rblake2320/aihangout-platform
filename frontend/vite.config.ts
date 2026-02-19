import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: false,  // Keep console.log statements for debugging
        drop_debugger: false  // Keep debugger statements
      },
      format: {
        comments: false  // Remove comments but keep console/debugger
      }
    },
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          ui: ['@headlessui/react', '@heroicons/react'],
          state: ['zustand', '@tanstack/react-query'],
          utils: ['axios', 'date-fns', 'classnames']
        }
      }
    }
  }
})