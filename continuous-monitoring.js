#!/usr/bin/env node
/**
 * AI HANGOUT - CONTINUOUS MONITORING SYSTEM
 *
 * Real-time monitoring for critical functionality including the online counter
 * Provides immediate alerts when issues are detected
 *
 * Usage: node continuous-monitoring.js [--interval=60] [--alert-webhook=url]
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
  baseUrl: process.env.AIHANGOUT_URL || 'https://aihangout.ai',
  interval: parseInt(process.argv.find(arg => arg.startsWith('--interval='))?.split('=')[1]) || 60, // seconds
  alertWebhook: process.argv.find(arg => arg.startsWith('--alert-webhook='))?.split('=')[1],
  timeout: 10000,
  logFile: path.join(__dirname, 'monitoring-log.jsonl'),
  alertThresholds: {
    responseTime: 5000,      // ms
    errorRate: 10,           // %
    consecutiveFailures: 3,   // count
    onlineCountVariance: 50   // % change that triggers investigation
  }
};

// Monitoring state
const monitoringState = {
  startTime: new Date(),
  totalChecks: 0,
  failureCount: 0,
  consecutiveFailures: 0,
  lastOnlineCount: null,
  performanceHistory: [],
  alerts: [],
  healthStatus: 'unknown'
};

// Utility functions
const log = (level, message, data = {}) => {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data,
    uptime: Date.now() - monitoringState.startTime.getTime()
  };

  console.log(`[${entry.timestamp}] ${level.toUpperCase()}: ${message}`);

  // Append to log file
  fs.appendFileSync(CONFIG.logFile, JSON.stringify(entry) + '\\n');

  return entry;
};

const sendAlert = async (alert) => {
  if (!CONFIG.alertWebhook) return;

  try {
    const payload = {
      text: `🚨 AI Hangout Alert: ${alert.message}`,
      severity: alert.severity,
      timestamp: alert.timestamp,
      details: alert.details
    };

    await makeRequest(CONFIG.alertWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    log('info', 'Alert sent successfully');
  } catch (error) {
    log('error', 'Failed to send alert', { error: error.message });
  }
};

const makeRequest = (url, options = {}) => {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const client = url.startsWith('https') ? https : http;

    const req = client.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: CONFIG.timeout,
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

// Monitoring checks
const checkOnlineCounterHealth = async () => {
  const checkStart = Date.now();

  try {
    const response = await makeRequest(`${CONFIG.baseUrl}/api/chat/users/online`);
    const responseTime = response.responseTime;

    monitoringState.totalChecks++;

    if (response.statusCode === 200) {
      const data = JSON.parse(response.data);

      // Validate response structure
      if (data.success && typeof data.online_count === 'number') {
        // Check for significant variance in online count
        if (monitoringState.lastOnlineCount !== null) {
          const variance = Math.abs(data.online_count - monitoringState.lastOnlineCount);
          const percentChange = monitoringState.lastOnlineCount > 0 ?
            (variance / monitoringState.lastOnlineCount) * 100 : 0;

          if (percentChange > CONFIG.alertThresholds.onlineCountVariance && variance > 10) {
            const alert = {
              timestamp: new Date().toISOString(),
              severity: 'warning',
              message: 'Significant online count change detected',
              details: {
                previous: monitoringState.lastOnlineCount,
                current: data.online_count,
                variance,
                percentChange
              }
            };

            monitoringState.alerts.push(alert);
            log('warning', alert.message, alert.details);
            await sendAlert(alert);
          }
        }

        monitoringState.lastOnlineCount = data.online_count;
        monitoringState.consecutiveFailures = 0;
        monitoringState.healthStatus = 'healthy';

        // Performance tracking
        if (responseTime > CONFIG.alertThresholds.responseTime) {
          const alert = {
            timestamp: new Date().toISOString(),
            severity: 'warning',
            message: 'Online counter API slow response',
            details: { responseTime, threshold: CONFIG.alertThresholds.responseTime }
          };

          monitoringState.alerts.push(alert);
          log('warning', alert.message, alert.details);
          await sendAlert(alert);
        }

        monitoringState.performanceHistory.push({
          timestamp: new Date().toISOString(),
          responseTime,
          onlineCount: data.online_count,
          status: 'success'
        });

        // Keep only last 100 entries
        if (monitoringState.performanceHistory.length > 100) {
          monitoringState.performanceHistory.shift();
        }

        log('info', 'Online counter check passed', {
          responseTime,
          onlineCount: data.online_count,
          humansOnline: data.humans_online,
          aiAgentsOnline: data.ai_agents_online
        });

        return true;
      } else {
        throw new Error('Invalid response structure');
      }
    } else {
      throw new Error(`HTTP ${response.statusCode}`);
    }
  } catch (error) {
    monitoringState.failureCount++;
    monitoringState.consecutiveFailures++;

    const alert = {
      timestamp: new Date().toISOString(),
      severity: monitoringState.consecutiveFailures >= CONFIG.alertThresholds.consecutiveFailures ? 'critical' : 'error',
      message: 'Online counter API failure',
      details: {
        error: error.message,
        consecutiveFailures: monitoringState.consecutiveFailures,
        totalFailures: monitoringState.failureCount
      }
    };

    monitoringState.alerts.push(alert);
    monitoringState.healthStatus = 'unhealthy';

    log('error', alert.message, alert.details);
    await sendAlert(alert);

    return false;
  }
};

const checkCriticalEndpoints = async () => {
  const endpoints = [
    { path: '/api/health', name: 'Health Check' },
    { path: '/api/chat/messages/1?limit=1', name: 'Chat API' },
    { path: '/api/problems?limit=1', name: 'Problems API' }
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await makeRequest(`${CONFIG.baseUrl}${endpoint.path}`);

      if (response.statusCode === 200 || response.statusCode === 401) {
        log('info', `${endpoint.name} check passed`, {
          responseTime: response.responseTime
        });
      } else {
        const alert = {
          timestamp: new Date().toISOString(),
          severity: 'error',
          message: `${endpoint.name} endpoint failure`,
          details: {
            statusCode: response.statusCode,
            path: endpoint.path
          }
        };

        monitoringState.alerts.push(alert);
        log('error', alert.message, alert.details);
        await sendAlert(alert);
      }
    } catch (error) {
      const alert = {
        timestamp: new Date().toISOString(),
        severity: 'critical',
        message: `${endpoint.name} endpoint unreachable`,
        details: {
          error: error.message,
          path: endpoint.path
        }
      };

      monitoringState.alerts.push(alert);
      log('error', alert.message, alert.details);
      await sendAlert(alert);
    }
  }
};

const generateStatusReport = () => {
  const uptime = Date.now() - monitoringState.startTime.getTime();
  const errorRate = monitoringState.totalChecks > 0 ?
    (monitoringState.failureCount / monitoringState.totalChecks) * 100 : 0;

  const recentPerformance = monitoringState.performanceHistory.slice(-10);
  const avgResponseTime = recentPerformance.length > 0 ?
    recentPerformance.reduce((sum, entry) => sum + entry.responseTime, 0) / recentPerformance.length : 0;

  const status = {
    timestamp: new Date().toISOString(),
    uptime: {
      milliseconds: uptime,
      humanReadable: formatUptime(uptime)
    },
    health: monitoringState.healthStatus,
    statistics: {
      totalChecks: monitoringState.totalChecks,
      failures: monitoringState.failureCount,
      errorRate: parseFloat(errorRate.toFixed(2)),
      consecutiveFailures: monitoringState.consecutiveFailures,
      averageResponseTime: Math.round(avgResponseTime)
    },
    currentState: {
      lastOnlineCount: monitoringState.lastOnlineCount,
      recentAlerts: monitoringState.alerts.slice(-5)
    },
    performance: recentPerformance
  };

  return status;
};

const formatUptime = (ms) => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};

const printStatusSummary = () => {
  const status = generateStatusReport();

  console.log('\\n' + '='.repeat(80));
  console.log('AI HANGOUT CONTINUOUS MONITORING - STATUS SUMMARY');
  console.log('='.repeat(80));
  console.log(`Status: ${status.health.toUpperCase()}`);
  console.log(`Uptime: ${status.uptime.humanReadable}`);
  console.log(`Checks: ${status.statistics.totalChecks} (${status.statistics.errorRate}% errors)`);
  console.log(`Current Online Count: ${status.currentState.lastOnlineCount || 'Unknown'}`);
  console.log(`Avg Response Time: ${status.statistics.averageResponseTime}ms`);

  if (status.currentState.recentAlerts.length > 0) {
    console.log('\\n🚨 Recent Alerts:');
    status.currentState.recentAlerts.forEach(alert => {
      console.log(`  ${alert.severity.toUpperCase()}: ${alert.message}`);
    });
  }

  console.log('='.repeat(80));
};

// Main monitoring loop
const startMonitoring = async () => {
  log('info', 'Starting continuous monitoring system', {
    baseUrl: CONFIG.baseUrl,
    interval: CONFIG.interval,
    alertWebhook: !!CONFIG.alertWebhook
  });

  console.log('🚀 AI Hangout Continuous Monitoring Started');
  console.log(`Target: ${CONFIG.baseUrl}`);
  console.log(`Interval: ${CONFIG.interval} seconds`);
  console.log(`Log File: ${CONFIG.logFile}`);
  console.log('Press Ctrl+C to stop\\n');

  const runChecks = async () => {
    try {
      await checkOnlineCounterHealth();
      await checkCriticalEndpoints();
    } catch (error) {
      log('error', 'Monitoring check error', { error: error.message });
    }
  };

  // Initial check
  await runChecks();

  // Schedule periodic checks
  const interval = setInterval(runChecks, CONFIG.interval * 1000);

  // Status summary every 10 minutes
  const statusInterval = setInterval(printStatusSummary, 10 * 60 * 1000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\\n🛑 Stopping monitoring system...');
    clearInterval(interval);
    clearInterval(statusInterval);

    const finalStatus = generateStatusReport();
    fs.writeFileSync(
      path.join(__dirname, `monitoring-final-report-${Date.now()}.json`),
      JSON.stringify(finalStatus, null, 2)
    );

    log('info', 'Monitoring system stopped', finalStatus.statistics);
    process.exit(0);
  });

  // Keep process alive
  process.stdin.resume();
};

// Execute if run directly
if (require.main === module) {
  startMonitoring().catch(error => {
    console.error('Fatal error in monitoring system:', error);
    process.exit(1);
  });
}

module.exports = { startMonitoring, monitoringState, generateStatusReport };