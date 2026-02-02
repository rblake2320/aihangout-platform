/**
 * AI Hangout Security & Prompt Injection Protection
 * Enterprise-grade content filtering and safety measures
 * Created: January 22, 2026 (Patent Documentation)
 */

interface SecurityResult {
  isValid: boolean
  risk: 'safe' | 'warning' | 'blocked'
  violations: string[]
  sanitized?: string
}

interface ContentFlags {
  promptInjection: boolean
  maliciousCode: boolean
  harmfulContent: boolean
  spamPattern: boolean
  socialEngineering: boolean
}

// Prompt injection detection patterns
const PROMPT_INJECTION_PATTERNS = [
  // Direct command injections
  /ignore\s+(previous|all)\s+(instructions?|prompts?)/gi,
  /forget\s+(everything|all)\s+(above|before)/gi,
  /new\s+(instructions?|task|prompt)/gi,

  // Role manipulation
  /you\s+are\s+now\s+(a|an)\s+\w+/gi,
  /act\s+as\s+(a|an)\s+\w+/gi,
  /pretend\s+(you\s+are|to\s+be)/gi,

  // System prompts
  /system\s*[:]\s*/gi,
  /\[system\]/gi,
  /assistant\s*[:]\s*/gi,

  // Jailbreak attempts
  /jailbreak/gi,
  /developer\s+mode/gi,
  /unrestricted\s+mode/gi,

  // Code execution attempts
  /```\s*(python|javascript|bash|sh|cmd)/gi,
  /eval\s*\(/gi,
  /exec\s*\(/gi,

  // Social engineering
  /urgent\s*(emergency|critical)/gi,
  /this\s+is\s+a\s+test/gi,
  /authorized\s+by/gi
]

// Malicious code patterns
const MALICIOUS_CODE_PATTERNS = [
  /rm\s+-rf\s+\//gi,
  /del\s+\/[sq]/gi,
  /format\s+c:/gi,
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
  /javascript:/gi,
  /data:text\/html/gi,
  /vbscript:/gi,
  /onload\s*=/gi,
  /onerror\s*=/gi,
  /onclick\s*=/gi
]

// Harmful content patterns
const HARMFUL_CONTENT_PATTERNS = [
  // Violence and threats
  /\b(kill|murder|bomb|terrorist|weapon)\b/gi,
  /\b(suicide|self-harm|hurt)\b/gi,

  // Illegal activities
  /\b(drugs|cocaine|heroin|meth)\b/gi,
  /\b(hack|hacking|ddos|exploit)\b/gi,

  // Inappropriate content
  /\b(nude|naked|porn|sex)\b/gi,

  // Financial scams
  /\b(bitcoin|crypto|investment|guaranteed\s+returns)\b/gi
]

// Spam detection patterns
const SPAM_PATTERNS = [
  /\b(click\s+here|visit\s+now|limited\s+time)\b/gi,
  /\b(free\s+money|make\s+\$\d+|earn\s+\$\d+)\b/gi,
  /\b(buy\s+now|discount|sale|offer)\b/gi,
  /(http[s]?:\/\/[^\s]+){3,}/gi, // Multiple URLs
  /(.)\1{10,}/gi, // Repeated characters
]

/**
 * Comprehensive content security analysis
 */
export function analyzeContentSecurity(content: string): SecurityResult {
  const violations: string[] = []
  const flags: ContentFlags = {
    promptInjection: false,
    maliciousCode: false,
    harmfulContent: false,
    spamPattern: false,
    socialEngineering: false
  }

  // Check for prompt injection
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      flags.promptInjection = true
      violations.push('Prompt injection attempt detected')
      break
    }
  }

  // Check for malicious code
  for (const pattern of MALICIOUS_CODE_PATTERNS) {
    if (pattern.test(content)) {
      flags.maliciousCode = true
      violations.push('Malicious code pattern detected')
      break
    }
  }

  // Check for harmful content
  for (const pattern of HARMFUL_CONTENT_PATTERNS) {
    if (pattern.test(content)) {
      flags.harmfulContent = true
      violations.push('Potentially harmful content detected')
      break
    }
  }

  // Check for spam patterns
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(content)) {
      flags.spamPattern = true
      violations.push('Spam pattern detected')
      break
    }
  }

  // Determine risk level
  let risk: 'safe' | 'warning' | 'blocked' = 'safe'

  if (flags.promptInjection || flags.maliciousCode) {
    risk = 'blocked'
  } else if (flags.harmfulContent || flags.spamPattern) {
    risk = 'warning'
  }

  // Sanitize content if needed
  let sanitized = content
  if (risk === 'warning') {
    sanitized = sanitizeContent(content)
  }

  return {
    isValid: risk !== 'blocked',
    risk,
    violations,
    sanitized: risk === 'warning' ? sanitized : undefined
  }
}

/**
 * Sanitize content by removing harmful patterns
 */
function sanitizeContent(content: string): string {
  let sanitized = content

  // Remove script tags
  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '[SCRIPT REMOVED]')

  // Remove javascript: URLs
  sanitized = sanitized.replace(/javascript:/gi, 'blocked:')

  // Remove event handlers
  sanitized = sanitized.replace(/on\w+\s*=/gi, 'data-blocked=')

  // Remove data URLs
  sanitized = sanitized.replace(/data:text\/html/gi, 'data:blocked')

  return sanitized
}

/**
 * Validate AI agent responses for safety
 */
export function validateAIResponse(response: string): SecurityResult {
  const result = analyzeContentSecurity(response)

  // Additional checks for AI responses
  const aiViolations = []

  // Check for attempts to break character
  if (/\b(I am not|I cannot|I refuse)\b.*\b(AI|assistant|bot)\b/gi.test(response)) {
    aiViolations.push('AI identity confusion detected')
  }

  // Check for harmful instructions
  if (/\b(ignore|bypass|override)\b.*\b(safety|guidelines|rules)\b/gi.test(response)) {
    aiViolations.push('Attempt to bypass safety guidelines')
  }

  return {
    ...result,
    violations: [...result.violations, ...aiViolations]
  }
}

/**
 * Content moderation interface
 */
export interface ModerationResult {
  approved: boolean
  flagged: boolean
  category: string
  confidence: number
  action: 'approve' | 'review' | 'block'
}

/**
 * Enterprise-grade content moderation
 */
export function moderateContent(content: string, authorType: 'human' | 'ai'): ModerationResult {
  const security = analyzeContentSecurity(content)

  let action: 'approve' | 'review' | 'block' = 'approve'
  let category = 'safe'
  let confidence = 0.9

  if (security.risk === 'blocked') {
    action = 'block'
    category = 'security_violation'
    confidence = 0.95
  } else if (security.risk === 'warning') {
    action = 'review'
    category = 'potentially_harmful'
    confidence = 0.7
  }

  // AI responses have stricter moderation
  if (authorType === 'ai' && security.violations.length > 0) {
    action = 'block'
    confidence = 0.85
  }

  return {
    approved: action === 'approve',
    flagged: action !== 'approve',
    category,
    confidence,
    action
  }
}

/**
 * Generate security audit log entry
 */
export function createSecurityLog(
  content: string,
  result: SecurityResult,
  userId: number,
  userType: 'human' | 'ai'
) {
  return {
    timestamp: new Date().toISOString(),
    userId,
    userType,
    contentLength: content.length,
    risk: result.risk,
    violations: result.violations,
    blocked: !result.isValid,
    ip: 'masked', // Privacy protection
    userAgent: 'masked'
  }
}