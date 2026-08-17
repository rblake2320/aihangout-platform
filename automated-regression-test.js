#!/usr/bin/env node
/**
 * AI HANGOUT - AUTOMATED REGRESSION TEST SUITE
 *
 * This script performs comprehensive regression testing for the AI Hangout platform
 * Designed to run automatically and detect any issues with core functionality
 *
 * Usage: node automated-regression-test.js [--env=production|staging]
 *
 * @author Regression Testing Agent
 * @date 2026-02-02
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  production: {
    baseUrl: 'https://aihangout.ai',
    timeout: 10000
  },
  staging: {
    baseUrl: 'https://staging.aihangout.ai',
    timeout: 5000
  },
  development: {
    baseUrl: 'http://localhost:3000',
    timeout: 3000
  }
};

// Test results storage
const testResults = {
  timestamp: new Date().toISOString(),
  environment: process.argv.includes('--env=production') ? 'production' :
               process.argv.includes('--env=staging') ? 'staging' : 'development',
  totalTests: 0,
  passedTests: 0,
  failedTests: 0,
  criticalFailures: [],
  warnings: [],
  performance: {},
  details: []
};

// Utility functions
const log = (level, message, data = null) => {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message, data };

  console.log(`[${timestamp}] ${level.toUpperCase()}: ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));

  testResults.details.push(logEntry);
};

const makeRequest = (url, options = {}) => {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const client = url.startsWith('https') ? https : http;

    const req = client.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: CONFIG[testResults.environment].timeout,
      ...options
    }, (res) => {
      const responseTime = Date.now() - startTime;
      let data = '';

      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data,
          responseTime
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Request timeout')));

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
};

// Test functions
const testApiHealthCheck = async () => {
  log('info', 'Testing API health check...');
  testResults.totalTests++;

  try {
    const baseUrl = CONFIG[testResults.environment].baseUrl;
    const response = await makeRequest(`${baseUrl}/api/health`);

    testResults.performance.healthCheck = response.responseTime;

    if (response.statusCode === 200) {
      testResults.passedTests++;
      log('success', `Health check passed (${response.responseTime}ms)`);
      return true;
    } else {
      testResults.failedTests++;
      testResults.criticalFailures.push('API health check failed');
      log('error', 'Health check failed', { statusCode: response.statusCode });
      return false;
    }
  } catch (error) {
    testResults.failedTests++;
    testResults.criticalFailures.push(`Health check error: ${error.message}`);
    log('error', 'Health check error', error.message);
    return false;
  }
};

const testOnlineCounterAPI = async () => {
  log('info', 'Testing online counter API...');
  testResults.totalTests++;

  try {
    const baseUrl = CONFIG[testResults.environment].baseUrl;
    const response = await makeRequest(`${baseUrl}/api/chat/users/online`);

    testResults.performance.onlineCounterAPI = response.responseTime;

    if (response.statusCode === 200) {
      const data = JSON.parse(response.data);

      // Validate response structure
      const requiredFields = ['success', 'online_count', 'humans_online', 'ai_agents_online', 'recent_users'];
      const hasAllFields = requiredFields.every(field => data.hasOwnProperty(field));

      if (hasAllFields && data.success === true) {
        testResults.passedTests++;
        log('success', `Online counter API passed (${response.responseTime}ms)`, {
          onlineCount: data.online_count,
          humansOnline: data.humans_online,
          aiAgentsOnline: data.ai_agents_online
        });
        return true;
      } else {
        testResults.failedTests++;
        testResults.criticalFailures.push('Online counter API invalid response structure');
        log('error', 'Online counter API invalid response', data);
        return false;
      }
    } else {
      testResults.failedTests++;
      testResults.criticalFailures.push('Online counter API HTTP error');
      log('error', 'Online counter API failed', { statusCode: response.statusCode });
      return false;
    }
  } catch (error) {
    testResults.failedTests++;
    testResults.criticalFailures.push(`Online counter API error: ${error.message}`);
    log('error', 'Online counter API error', error.message);
    return false;
  }
};

const testChatEndpoints = async () => {
  log('info', 'Testing chat endpoints...');
  testResults.totalTests++;

  try {
    const baseUrl = CONFIG[testResults.environment].baseUrl;
    const response = await makeRequest(`${baseUrl}/api/chat/messages/1?limit=10`);

    testResults.performance.chatAPI = response.responseTime;

    if (response.statusCode === 200 || response.statusCode === 401) {
      // 401 is acceptable for unauthenticated requests
      const data = JSON.parse(response.data);

      if ((response.statusCode === 200 && data.success) ||
          (response.statusCode === 401 && data.error)) {
        testResults.passedTests++;
        log('success', `Chat API passed (${response.responseTime}ms)`, {
          statusCode: response.statusCode,
          authenticated: response.statusCode === 200
        });
        return true;
      } else {
        testResults.failedTests++;
        log('error', 'Chat API unexpected response', data);
        return false;
      }
    } else {
      testResults.failedTests++;
      testResults.criticalFailures.push('Chat API unexpected status code');
      log('error', 'Chat API failed', { statusCode: response.statusCode });
      return false;
    }
  } catch (error) {
    testResults.failedTests++;
    testResults.criticalFailures.push(`Chat API error: ${error.message}`);
    log('error', 'Chat API error', error.message);
    return false;
  }
};

const testFrontendLoading = async () => {
  log('info', 'Testing frontend loading...');
  testResults.totalTests++;

  try {
    const baseUrl = CONFIG[testResults.environment].baseUrl;
    const response = await makeRequest(baseUrl);

    testResults.performance.frontendLoading = response.responseTime;

    if (response.statusCode === 200) {
      const html = response.data;

      // Check for critical elements
      const hasTitle = html.includes('AI Hangout');
      const hasReactRoot = html.includes('id="root"') || html.includes('id="app"');
      const hasJavaScript = html.includes('.js');

      if (hasTitle && hasReactRoot && hasJavaScript) {
        testResults.passedTests++;
        log('success', `Frontend loading passed (${response.responseTime}ms)`);
        return true;
      } else {
        testResults.failedTests++;
        testResults.warnings.push('Frontend missing critical elements');
        log('warning', 'Frontend loading issues', {
          hasTitle, hasReactRoot, hasJavaScript
        });
        return false;
      }
    } else {
      testResults.failedTests++;
      testResults.criticalFailures.push('Frontend not accessible');
      log('error', 'Frontend loading failed', { statusCode: response.statusCode });
      return false;
    }
  } catch (error) {
    testResults.failedTests++;
    testResults.criticalFailures.push(`Frontend loading error: ${error.message}`);
    log('error', 'Frontend loading error', error.message);
    return false;
  }
};

const testDatabaseConnectivity = async () => {
  log('info', 'Testing database connectivity (via API)...');
  testResults.totalTests++;

  try {
    // Test database connectivity by hitting an endpoint that requires DB access
    const baseUrl = CONFIG[testResults.environment].baseUrl;
    const response = await makeRequest(`${baseUrl}/api/problems?limit=1`);

    testResults.performance.databaseAPI = response.responseTime;

    if (response.statusCode === 200) {
      const data = JSON.parse(response.data);

      if (data.success !== undefined) {
        testResults.passedTests++;
        log('success', `Database connectivity passed (${response.responseTime}ms)`);
        return true;
      } else {
        testResults.failedTests++;
        testResults.criticalFailures.push('Database API invalid response');
        log('error', 'Database connectivity issues', data);
        return false;
      }
    } else {
      testResults.failedTests++;
      testResults.criticalFailures.push('Database API not accessible');
      log('error', 'Database connectivity failed', { statusCode: response.statusCode });
      return false;
    }
  } catch (error) {
    testResults.failedTests++;
    testResults.criticalFailures.push(`Database connectivity error: ${error.message}`);
    log('error', 'Database connectivity error', error.message);
    return false;
  }
};

const testSecurityHeaders = async () => {
  log('info', 'Testing security headers...');
  testResults.totalTests++;

  try {
    const baseUrl = CONFIG[testResults.environment].baseUrl;
    const response = await makeRequest(baseUrl);

    const headers = response.headers;
    const securityChecks = {
      hasContentSecurityPolicy: !!headers['content-security-policy'],
      hasXFrameOptions: !!headers['x-frame-options'],
      hasXContentTypeOptions: !!headers['x-content-type-options'],
      hasReferrerPolicy: !!headers['referrer-policy'],
      hasStrictTransportSecurity: !!headers['strict-transport-security']
    };

    const securityScore = Object.values(securityChecks).filter(Boolean).length;

    if (securityScore >= 3) {
      testResults.passedTests++;
      log('success', `Security headers passed (${securityScore}/5 headers present)`);
      return true;
    } else {
      testResults.failedTests++;
      testResults.warnings.push(`Only ${securityScore}/5 security headers present`);
      log('warning', 'Security headers incomplete', securityChecks);
      return false;
    }
  } catch (error) {
    testResults.failedTests++;
    log('error', 'Security headers test error', error.message);
    return false;
  }
};

const generateReport = () => {
  log('info', 'Generating test report...');

  const summary = {
    environment: testResults.environment,
    timestamp: testResults.timestamp,
    duration: Date.now() - new Date(testResults.timestamp).getTime(),
    results: {
      total: testResults.totalTests,
      passed: testResults.passedTests,
      failed: testResults.failedTests,
      successRate: ((testResults.passedTests / testResults.totalTests) * 100).toFixed(1)
    },
    performance: testResults.performance,
    issues: {
      critical: testResults.criticalFailures,
      warnings: testResults.warnings
    }
  };

  // Save detailed results
  const reportPath = path.join(__dirname, `regression-test-${testResults.environment}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    summary,
    details: testResults.details
  }, null, 2));

  // Console summary
  console.log('\n' + '='.repeat(60));
  console.log('REGRESSION TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Environment: ${summary.environment}`);
  console.log(`Duration: ${summary.duration}ms`);
  console.log(`Tests: ${summary.results.passed}/${summary.results.total} passed (${summary.results.successRate}%)`);

  if (summary.issues.critical.length > 0) {
    console.log('\n🚨 CRITICAL FAILURES:');
    summary.issues.critical.forEach(failure => console.log(`  - ${failure}`));
  }

  if (summary.issues.warnings.length > 0) {
    console.log('\n⚠️  WARNINGS:');
    summary.issues.warnings.forEach(warning => console.log(`  - ${warning}`));
  }

  console.log('\n📊 PERFORMANCE:');
  Object.entries(summary.performance).forEach(([test, time]) => {
    console.log(`  ${test}: ${time}ms`);
  });

  console.log(`\n📄 Full report saved: ${reportPath}`);
  console.log('='.repeat(60));

  // Exit with appropriate code
  process.exit(testResults.criticalFailures.length > 0 ? 1 : 0);
};

// Main test execution
const runRegressionTests = async () => {
  console.log('🚀 Starting AI Hangout Regression Test Suite...');
  console.log(`Environment: ${testResults.environment}`);
  console.log(`Base URL: ${CONFIG[testResults.environment].baseUrl}`);
  console.log('='.repeat(60));

  try {
    // Core functionality tests
    await testApiHealthCheck();
    await testOnlineCounterAPI();
    await testChatEndpoints();
    await testFrontendLoading();
    await testDatabaseConnectivity();
    await testSecurityHeaders();

    // Performance validation
    const performanceIssues = Object.entries(testResults.performance).filter(([test, time]) => {
      const thresholds = {
        healthCheck: 2000,
        onlineCounterAPI: 1000,
        chatAPI: 1000,
        frontendLoading: 3000,
        databaseAPI: 2000
      };
      return time > (thresholds[test] || 5000);
    });

    if (performanceIssues.length > 0) {
      performanceIssues.forEach(([test, time]) => {
        testResults.warnings.push(`Performance issue: ${test} took ${time}ms`);
      });
    }

  } catch (error) {
    log('error', 'Test suite execution error', error.message);
    testResults.criticalFailures.push(`Test execution error: ${error.message}`);
  } finally {
    generateReport();
  }
};

// Execute if run directly
if (require.main === module) {
  runRegressionTests().catch(error => {
    console.error('Fatal error in test suite:', error);
    process.exit(1);
  });
}

module.exports = { runRegressionTests, testResults };