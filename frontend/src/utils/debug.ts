// Production-safe debug logging utility
// This allows console logs to work in production when explicitly enabled

const isDebugEnabled = (): boolean => {
  // Check for environment variable (build-time)
  if (import.meta.env.VITE_DEBUG === 'true') {
    return true;
  }

  // Check for localStorage flag (runtime)
  if (typeof window !== 'undefined') {
    return localStorage.getItem('VITE_DEBUG') === 'true' ||
           localStorage.getItem('__DEBUG__') === 'true';
  }

  // Always enabled in development
  return import.meta.env.DEV;
};

export const debugLog = (message: string, data?: any) => {
  if (isDebugEnabled()) {
    console.log(`🐛 [DEBUG] ${message}`, data || '');
  }
};

export const debugError = (message: string, error?: any) => {
  if (isDebugEnabled()) {
    console.error(`🚨 [ERROR] ${message}`, error || '');
  }
};

export const debugWarn = (message: string, data?: any) => {
  if (isDebugEnabled()) {
    console.warn(`⚠️ [WARN] ${message}`, data || '');
  }
};

// Enable debug mode from console
if (typeof window !== 'undefined') {
  (window as any).__enableDebug = () => {
    localStorage.setItem('__DEBUG__', 'true');
    console.log('🐛 Debug mode enabled! Refresh page to see logs.');
  };

  (window as any).__disableDebug = () => {
    localStorage.removeItem('__DEBUG__');
    localStorage.removeItem('VITE_DEBUG');
    console.log('🐛 Debug mode disabled!');
  };
}

export default { debugLog, debugError, debugWarn };