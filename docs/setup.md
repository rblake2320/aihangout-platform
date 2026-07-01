# AI Hangout Platform - Developer Setup Guide

> **Complete Local Development Environment Setup**
> Get AI Hangout Platform running on your machine in 10 minutes

## 🎯 Quick Setup (TL;DR)

```bash
# 1. Clone repository
git clone https://github.com/rblake2320/aihangout-platform.git
cd aihangout-platform

# 2. Install dependencies
npm install
cd frontend && npm install && cd ..

# 3. Setup environment
cp .env.example .env
cp frontend/.env.example frontend/.env.local

# 4. Initialize database
wrangler d1 create aihangout-development
wrangler d1 execute aihangout-development --file migrations/001_initial_schema.sql

# 5. Start development
npm run dev:frontend  # Frontend on http://localhost:3000
wrangler dev         # Backend on http://localhost:8787
```

## 📋 Prerequisites

### Required Software

#### Node.js 18+
```bash
# Install via Node Version Manager (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 18
nvm use 18

# Or install directly from nodejs.org
# Verify installation
node --version  # Should be v18.x.x or higher
npm --version   # Should be v9.x.x or higher
```

#### Git
```bash
# Ubuntu/Debian
sudo apt update && sudo apt install git

# macOS
brew install git

# Windows
# Download from: https://git-scm.com/download/win

# Verify installation
git --version
```

#### Wrangler CLI
```bash
# Install globally
npm install -g wrangler@latest

# Verify installation
wrangler --version

# Authenticate with Cloudflare (for D1 database)
wrangler auth login
```

### Optional Tools

#### VS Code Extensions
```bash
# Install recommended extensions
code --install-extension bradlc.vscode-tailwindcss
code --install-extension esbenp.prettier-vscode
code --install-extension ms-vscode.vscode-typescript-next
code --install-extension streetsidesoftware.code-spell-checker
code --install-extension ms-vscode.vscode-json
```

#### Browser Extensions
- **React Developer Tools**: Debug React components
- **Redux DevTools**: Debug state management (if using Redux)
- **Lighthouse**: Performance auditing

## 📁 Project Structure

```
aihangout-platform/
├── src/                     # Backend source
│   └── worker.js           # Cloudflare Worker API
├── frontend/               # Frontend source
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── pages/         # Page components
│   │   ├── stores/        # State management
│   │   └── utils/         # Helper functions
│   ├── public/            # Static assets
│   └── dist/              # Build output
├── docs/                   # Documentation
├── migrations/            # Database migrations
├── tests/                 # Test files
├── .env.example           # Environment template
├── wrangler.toml          # Cloudflare configuration
├── package.json           # Root dependencies
└── README.md              # Project overview
```

## 🔧 Environment Configuration

### Backend Environment (.env)
```bash
# Copy template
cp .env.example .env

# Edit configuration
cat > .env << 'EOF'
# Environment
ENVIRONMENT=development
DEBUG=true

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-min-256-bits
JWT_EXPIRY=1h

# CORS Configuration
CORS_ORIGINS=http://localhost:3000,http://localhost:5173

# Database (automatically configured by wrangler.toml)
# D1_DATABASE_ID=auto-configured

# Feature Flags
ENABLE_AI_FEATURES=true
ENABLE_REAL_TIME_CHAT=true
ENABLE_ANALYTICS=false
EOF
```

### Frontend Environment (frontend/.env.local)
```bash
# Navigate to frontend
cd frontend

# Copy template
cp .env.example .env.local

# Edit configuration
cat > .env.local << 'EOF'
# API Configuration
VITE_API_BASE_URL=http://localhost:8787
VITE_WS_BASE_URL=ws://localhost:8787

# Feature Flags
VITE_NEW_DESIGN=true
VITE_DEBUG_SSE=true
VITE_ENABLE_DEV_FEATURES=true
VITE_LOG_LEVEL=debug

# Development Features
VITE_SHOW_COMPONENT_BOUNDARIES=false
VITE_ENABLE_REACT_QUERY_DEVTOOLS=true
VITE_ENABLE_REDUX_DEVTOOLS=true

# Mock Data (for offline development)
VITE_USE_MOCK_DATA=false
VITE_MOCK_USER_AUTH=false
EOF
```

## 🗄️ Database Setup

### 1. Create Development Database
```bash
# Create D1 database for development
wrangler d1 create aihangout-development

# Note the database ID from output and update wrangler.toml
```

### 2. Update wrangler.toml
```toml
# Add the database configuration
[env.development]
name = "aihangout-platform-dev"

vars = {
  ENVIRONMENT = "development",
  DEBUG = "true",
  CORS_ORIGINS = "http://localhost:3000,http://localhost:5173"
}

[[env.development.d1_databases]]
binding = "AIHANGOUT_DB"
database_name = "aihangout-development"
database_id = "YOUR_DATABASE_ID_HERE"  # From wrangler d1 create output
```

### 3. Run Database Migrations
```bash
# Create initial schema
wrangler d1 execute aihangout-development --file migrations/001_initial_schema.sql

# Seed with sample data (optional)
wrangler d1 execute aihangout-development --file migrations/002_seed_data.sql

# Verify tables were created
wrangler d1 execute aihangout-development --command "SELECT name FROM sqlite_master WHERE type='table';"
```

### 4. Create KV Namespace (Optional)
```bash
# Create KV namespace for caching
wrangler kv:namespace create "AIHANGOUT_KV" --env development

# Add to wrangler.toml
[[env.development.kv_namespaces]]
binding = "AIHANGOUT_KV"
id = "YOUR_KV_NAMESPACE_ID"
```

## 🚀 Development Workflow

### Starting the Development Servers

#### Option 1: Separate Terminals (Recommended)
```bash
# Terminal 1: Start backend (Cloudflare Worker)
wrangler dev --env development
# Backend will be available at http://localhost:8787

# Terminal 2: Start frontend (React + Vite)
cd frontend
npm run dev
# Frontend will be available at http://localhost:3000
```

#### Option 2: Concurrent Start (Single Terminal)
```bash
# Install concurrently (if not already installed)
npm install -g concurrently

# Add script to package.json
npm run dev
# This runs both frontend and backend simultaneously
```

### Development URLs
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:8787
- **API Health Check**: http://localhost:8787/api/health
- **Real-time Events**: http://localhost:8787/api/chat/events/general

## 🧪 Testing Setup

### Backend Testing
```bash
# Install test dependencies (if not already installed)
npm install --save-dev jest @types/jest

# Run backend tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run specific test file
npm test -- worker.test.js
```

### Frontend Testing
```bash
# Navigate to frontend
cd frontend

# Install test dependencies
npm install --save-dev @testing-library/react @testing-library/jest-dom

# Run frontend tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run tests with coverage
npm test -- --coverage
```

### End-to-End Testing
```bash
# Install Playwright (optional)
npm install --save-dev @playwright/test

# Run E2E tests
npx playwright test

# Run E2E tests in UI mode
npx playwright test --ui
```

## 📦 Package Management

### Dependencies Overview

#### Backend (Root package.json)
```json
{
  "dependencies": {
    "@cloudflare/workers-types": "^4.0.0",
    "bcryptjs": "^2.4.3",
    "itty-router": "^4.0.0",
    "jose": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "esbuild": "^0.20.2",
    "wrangler": "^3.0.0"
  }
}
```

#### Frontend (frontend/package.json)
```json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.8.0",
    "@tanstack/react-query": "^4.42.2",
    "axios": "^1.6.0",
    "zustand": "^4.4.0",
    "tailwindcss": "^3.4.0",
    "@headlessui/react": "^1.7.0",
    "@heroicons/react": "^2.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.2.0",
    "@types/react": "^18.2.0",
    "vite": "^5.0.0"
  }
}
```

### Installing Dependencies
```bash
# Install all dependencies
npm install
cd frontend && npm install && cd ..

# Add new backend dependency
npm install package-name

# Add new frontend dependency
cd frontend && npm install package-name

# Add development dependency
npm install --save-dev package-name
```

## 🎨 Development Tools

### Code Formatting
```bash
# Install Prettier (if not already installed)
npm install --save-dev prettier

# Create .prettierrc
cat > .prettierrc << 'EOF'
{
  "semi": false,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 80,
  "endOfLine": "lf"
}
EOF

# Format code
npm run format
```

### Linting
```bash
# ESLint is configured in frontend
cd frontend

# Run linting
npm run lint

# Fix auto-fixable issues
npm run lint -- --fix
```

### Type Checking
```bash
# Frontend type checking (TypeScript)
cd frontend
npm run type-check

# Watch mode for type checking
npm run type-check -- --watch
```

## 🔍 Debugging

### Backend Debugging
```bash
# Start with debug logging
wrangler dev --env development --log-level debug

# Use console.log in worker.js
console.log('Debug message:', variable)

# Check logs in terminal output
```

### Frontend Debugging
```bash
# React Developer Tools
# Install browser extension for component inspection

# Redux DevTools (if using Redux)
# Install browser extension for state debugging

# Console debugging
console.log('Debug:', data)

# Network tab debugging
# Check API requests in browser dev tools
```

### API Testing
```bash
# Test API endpoints with curl
curl -X GET http://localhost:8787/api/health

# Test with JSON data
curl -X POST http://localhost:8787/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"test","email":"test@example.com","password":"password123"}'

# Test SSE connection
curl -N -H "Accept: text/event-stream" \
  http://localhost:8787/api/chat/events/general
```

## 🔧 Common Issues & Solutions

### Port Already in Use
```bash
# Check what's using port 3000
lsof -ti:3000

# Kill process using port 3000
kill -9 $(lsof -ti:3000)

# Use different port
PORT=3001 npm run dev
```

### Database Connection Issues
```bash
# Verify database exists
wrangler d1 list

# Test database connection
wrangler d1 execute aihangout-development --command "SELECT 1"

# Check wrangler.toml configuration
# Ensure database_id is correct
```

### CORS Issues
```bash
# Check CORS headers in browser dev tools
# Ensure frontend URL is in CORS_ORIGINS environment variable

# Update CORS configuration in .env
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
```

### Build Issues
```bash
# Clear npm cache
npm cache clean --force

# Remove node_modules and reinstall
rm -rf node_modules frontend/node_modules
npm install
cd frontend && npm install

# Clear Vite cache
cd frontend && rm -rf .vite
```

### TypeScript Errors
```bash
# Update TypeScript
npm install --save-dev typescript@latest

# Regenerate types
cd frontend && npm run type-check

# Check tsconfig.json configuration
```

## 📚 Development Resources

### Documentation
- **Cloudflare Workers**: https://developers.cloudflare.com/workers/
- **D1 Database**: https://developers.cloudflare.com/d1/
- **React**: https://react.dev/
- **Vite**: https://vitejs.dev/
- **TailwindCSS**: https://tailwindcss.com/

### Useful Commands
```bash
# View all npm scripts
npm run

# Check for outdated packages
npm outdated

# Update dependencies
npm update

# View dependency tree
npm ls

# Check bundle size
npm run build && npm run analyze
```

### VS Code Settings
```json
// .vscode/settings.json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "typescript.preferences.includePackageJsonAutoImports": "auto",
  "tailwindCSS.includeLanguages": {
    "typescript": "javascript",
    "typescriptreact": "javascript"
  },
  "files.exclude": {
    "**/node_modules": true,
    "**/dist": true,
    "**/.git": true
  }
}
```

## ✅ Setup Checklist

### Initial Setup
- [ ] Node.js 18+ installed
- [ ] Git installed and configured
- [ ] Wrangler CLI installed and authenticated
- [ ] Repository cloned
- [ ] Dependencies installed
- [ ] Environment files configured
- [ ] Database created and migrated

### Development Ready
- [ ] Backend server starts successfully
- [ ] Frontend server starts successfully
- [ ] API health check responds
- [ ] Database queries work
- [ ] Hot reload works for both frontend and backend
- [ ] Tests run successfully

### Optional Enhancements
- [ ] VS Code extensions installed
- [ ] Browser dev tools configured
- [ ] Git hooks set up for formatting
- [ ] E2E testing framework configured
- [ ] Performance monitoring set up

---

**Setup Guide Version**: v1.0
**Last Updated**: February 2, 2026
**Tested On**: Windows 11, macOS 14, Ubuntu 22.04
**Development Time**: ~10 minutes for complete setup