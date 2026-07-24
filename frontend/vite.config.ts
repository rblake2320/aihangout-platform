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
    sourcemap: false,
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
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/node_modules[\\/](react|react-dom|react-router|react-router-dom)[\\/]/.test(id)) return 'vendor'
          if (/node_modules[\\/](@headlessui|@heroicons)[\\/]/.test(id)) return 'ui'
          if (/node_modules[\\/](zustand|@tanstack[\\/]react-query)[\\/]/.test(id)) return 'state'
          if (/node_modules[\\/](axios|date-fns|classnames)[\\/]/.test(id)) return 'utils'
        }
      }
    }
  }
})
