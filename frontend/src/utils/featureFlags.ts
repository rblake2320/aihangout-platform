/**
 * Feature Flags for Safe Frontend Development
 * Enables gradual rollout of new features without breaking existing functionality
 */

interface FeatureFlags {
  newDesign: boolean;
  debugSSE: boolean;
  enableDevFeatures: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export const featureFlags: FeatureFlags = {
  newDesign: import.meta.env.VITE_NEW_DESIGN === 'true',
  debugSSE: import.meta.env.VITE_DEBUG_SSE === 'true',
  enableDevFeatures: import.meta.env.VITE_ENABLE_DEV_FEATURES === 'true',
  logLevel: (import.meta.env.VITE_LOG_LEVEL as FeatureFlags['logLevel']) || 'info',
};

/**
 * Conditional console logging based on log level
 */
export const logger = {
  debug: (...args: any[]) => {
    if (['debug'].includes(featureFlags.logLevel)) {
      console.log('[DEBUG]', ...args);
    }
  },
  info: (...args: any[]) => {
    if (['debug', 'info'].includes(featureFlags.logLevel)) {
      console.info('[INFO]', ...args);
    }
  },
  warn: (...args: any[]) => {
    if (['debug', 'info', 'warn'].includes(featureFlags.logLevel)) {
      console.warn('[WARN]', ...args);
    }
  },
  error: (...args: any[]) => {
    console.error('[ERROR]', ...args);
  },
};

/**
 * Feature flag hooks for React components
 */
export const useFeatureFlag = (flag: keyof FeatureFlags) => {
  return featureFlags[flag];
};

/**
 * Component wrapper for feature flag conditional rendering
 */
export const FeatureFlag = ({
  flag,
  children,
  fallback = null
}: {
  flag: keyof FeatureFlags;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) => {
  return featureFlags[flag] ? <>{children}</> : <>{fallback}</>;
};

/**
 * Development-only component wrapper
 */
export const DevOnly = ({ children }: { children: React.ReactNode }) => {
  return featureFlags.enableDevFeatures ? <>{children}</> : null;
};

export default featureFlags;