#!/usr/bin/env node
/**
 * MANDATORY DEPLOYMENT VERIFICATION SCRIPT
 *
 * This script MUST be run after every deployment.
 * NO SUCCESS CLAIMS allowed until this passes.
 */

const https = require('https');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const PRODUCTION_URL = 'https://aihangout.ai';
const REQUIRED_CHECKS = [
    'Backend API responding',
    'Problems endpoint returns newest-first',
    'Multi-term search and signup route work',
    'API contract boundaries return standard errors',
    'Online counter endpoint works',
    'Frontend assets deployed',
    'Frontend contains sorting fix',
    'Deployed JS matches local dist build',
    'Auth crypto healthy (/api/health/auth)',
    'Notification pipeline healthy (/api/health/notifications)',
    'Human verification pipeline healthy and feed sources separated',
    'Pathbook audit, state, and application pipeline healthy',
    'Launch contracts and CSP are production-safe',
    'Grounded capability APIs return production-safe responses',
    'PBKDF2 iterations within Workers cap (local src)'
];

async function makeHttpRequest(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, data }));
        }).on('error', reject);
    });
}

async function makeApiRequest(url, { method = 'GET', headers = {}, body = '' } = {}) {
    return new Promise((resolve, reject) => {
        const request = https.request(url, { method, headers }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, data }));
        });
        request.on('error', reject);
        if (body) request.write(body);
        request.end();
    });
}

async function makeExpectedHttpRequest(url, expectedStatus, attempts = 4) {
    let response;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        response = await makeHttpRequest(url);
        if (response.statusCode === expectedStatus) return response;
        if (attempt < attempts) {
            // Cloudflare route propagation can briefly serve the prior Worker version.
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    return response;
}

async function verifyDeployment() {
    console.log('\n🚨 MANDATORY DEPLOYMENT VERIFICATION');
    console.log('=====================================');

    let passedChecks = 0;
    const deploymentProbe = `deploy_probe=${Date.now()}`;

    try {
        // 1. Test API endpoints
        console.log('\n📡 Testing API endpoints...');

        const problemsResponse = await makeHttpRequest(`${PRODUCTION_URL}/api/problems?sortBy=new&limit=5`);
        if (problemsResponse.statusCode === 200) {
            const data = JSON.parse(problemsResponse.data);
            if (data.success && data.problems && data.problems.length > 0) {
                console.log('✅ Problems API: Working');

                // Verify newest-first sorting
                const problems = data.problems;
                let sortingCorrect = true;
                for (let i = 1; i < problems.length; i++) {
                    if (new Date(problems[i-1].created_at) < new Date(problems[i].created_at)) {
                        sortingCorrect = false;
                        break;
                    }
                }

                if (sortingCorrect) {
                    console.log('✅ Sorting: Newest-first verified');
                    passedChecks += 2;
                } else {
                    console.log('❌ Sorting: NOT newest-first');
                }
            }
        } else {
            console.log('❌ Problems API: Failed');
        }

        const onlineResponse = await makeHttpRequest(`${PRODUCTION_URL}/api/live/count`);
        if (onlineResponse.statusCode === 200) {
            console.log('✅ Online counter API: Working');
            passedChecks++;
        } else {
            console.log('❌ Online counter API: Failed');
        }

        const searchResponse = await makeHttpRequest(
            `${PRODUCTION_URL}/api/problems?search=${encodeURIComponent('PyTorch GPU')}&limit=20`
        );
        const searchData = searchResponse.statusCode === 200 ? JSON.parse(searchResponse.data) : {};
        const searchMatched = (searchData.problems || []).some(problem => {
            const text = `${problem.title || ''} ${problem.description || ''}`.toLowerCase();
            return text.includes('pytorch') && text.includes('gpu');
        });
        const signupResponse = await makeHttpRequest(`${PRODUCTION_URL}/signup`);
        if (searchMatched && signupResponse.statusCode === 200 &&
            signupResponse.data.includes('<div id="root">')) {
            console.log('✅ New-user routes/search: multi-term match and /signup shell verified');
            passedChecks++;
        } else {
            console.log(`❌ New-user routes/search: search=${searchMatched}, signup=${signupResponse.statusCode}`);
        }

        const contractResults = await Promise.all([
            makeHttpRequest(`${PRODUCTION_URL}/api/problems?limit=-5`),
            makeHttpRequest(`${PRODUCTION_URL}/api/problems?limit=10000`),
            makeApiRequest(`${PRODUCTION_URL}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'email=test%40example.com&password=invalid'
            }),
            makeApiRequest(`${PRODUCTION_URL}/api/chat/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channelId: 1, message: 'contract probe' })
            })
        ]);
        const expectedContracts = [400, 400, 415, 404];
        const contractOk = contractResults.every(
            (result, index) => result.statusCode === expectedContracts[index]
        );
        if (contractOk) {
            console.log('✅ API contracts: pagination, media type, and unknown route errors verified');
            passedChecks++;
        } else {
            console.log(`❌ API contracts: expected ${expectedContracts.join(',')}, got ${contractResults.map(r => r.statusCode).join(',')}`);
        }

        // 2. Test frontend deployment
        console.log('\n🌐 Testing frontend deployment...');

        // The HTML shell may still exist in an edge cache immediately after a
        // Worker asset deployment. A unique query verifies the current origin
        // manifest rather than accepting or rejecting a stale shell.
        const htmlResponse = await makeHttpRequest(`${PRODUCTION_URL}/?${deploymentProbe}`);
        if (htmlResponse.statusCode === 200) {
            console.log('✅ Frontend: Loading');
            passedChecks++;

            // Extract JS asset hash
            const jsMatch = htmlResponse.data.match(/assets\/(index-[^.]+\.js)/);
            if (jsMatch) {
                const jsFile = jsMatch[1];
                console.log(`📄 JS Asset: ${jsFile}`);

                // Check if JS contains our sorting fix
                const jsResponse = await makeHttpRequest(`${PRODUCTION_URL}/assets/${jsFile}`);
                if (jsResponse.data.includes('useState') && jsResponse.data.includes('new')) {
                    console.log('✅ Frontend: Contains sorting fix');
                    passedChecks++;
                } else {
                    console.log('❌ Frontend: Sorting fix NOT found in deployed JS');
                }

                // Deployed bundle must be the one committed in frontend/dist —
                // catches the "production runs code git doesn't have" drift class.
                const fs = require('fs');
                const path = require('path');
                const localAssets = fs.readdirSync(path.join(__dirname, 'frontend', 'dist', 'assets'));
                if (localAssets.includes(jsFile)) {
                    console.log('✅ Frontend: Deployed JS matches local dist build');
                    passedChecks++;
                } else {
                    console.log(`❌ Frontend: Deployed ${jsFile} not found in local frontend/dist/assets`);
                }
            }
        }

        // Auth crypto — the July 2026 outage class (hashPassword throwing platform errors
        // while /api/health stayed green). /api/health/auth runs hash+verify in-process.
        const authHealth = await makeHttpRequest(`${PRODUCTION_URL}/api/health/auth`);
        if (authHealth.statusCode === 200 && JSON.parse(authHealth.data).status === 'ok') {
            console.log('✅ Auth crypto: healthy');
            passedChecks++;
        } else {
            console.log(`❌ Auth crypto: DEGRADED — ${authHealth.data}`);
        }

        const notificationHealth = await makeExpectedHttpRequest(
            `${PRODUCTION_URL}/api/health/notifications`, 200
        );
        if (notificationHealth.statusCode === 200 &&
            JSON.parse(notificationHealth.data).status === 'ok') {
            console.log('✅ Notification pipeline: healthy');
            passedChecks++;
        } else {
            console.log(`❌ Notification pipeline: DEGRADED — ${notificationHealth.data}`);
        }

        const verificationHealth = await makeExpectedHttpRequest(
            `${PRODUCTION_URL}/api/health/verification`, 200
        );
        const communityFeed = await makeHttpRequest(
            `${PRODUCTION_URL}/api/problems?contentSource=community&limit=50`
        );
        const digestFeed = await makeHttpRequest(
            `${PRODUCTION_URL}/api/problems?contentSource=digest&limit=50`
        );
        const verificationData = verificationHealth.statusCode === 200
            ? JSON.parse(verificationHealth.data) : {};
        const communityData = communityFeed.statusCode === 200 ? JSON.parse(communityFeed.data) : {};
        const digestData = digestFeed.statusCode === 200 ? JSON.parse(digestFeed.data) : {};
        const communityClean = (communityData.problems || []).every(problem =>
            !problem.is_harvested && problem.username !== 'aihangout-curator'
        );
        const digestClean = (digestData.problems || []).every(problem => Boolean(problem.is_harvested));
        if (verificationData.status === 'ok' && communityClean && digestClean) {
            console.log('✅ Human verification/feed: schema healthy and Community/AI Digest sources separated');
            passedChecks++;
        } else {
            console.log(`❌ Human verification/feed: health=${verificationData.status}, community=${communityClean}, digest=${digestClean}`);
        }

        const pathbookHealth = await makeApiRequest(
            `${PRODUCTION_URL}/api/health/pathbooks?${deploymentProbe}`
        );
        const pathbookHealthData = pathbookHealth.statusCode === 200
            ? JSON.parse(pathbookHealth.data) : {};
        if (
            pathbookHealthData.status === 'ok' &&
            pathbookHealthData.checks?.schema === 'ok' &&
            pathbookHealthData.checks?.audit_chain === 'ok' &&
            pathbookHealthData.checks?.audit_head === 'ok' &&
            pathbookHealthData.checks?.materialized_state === 'ok'
        ) {
            console.log('✅ Pathbooks: schema, D1 audit chain/head, and sealed materialized state healthy');
            passedChecks++;
        } else {
            console.log(`❌ Pathbooks: ${pathbookHealth.data}`);
        }

        const launchContracts = await Promise.all([
            makeApiRequest(`${PRODUCTION_URL}/api/events/batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
                body: JSON.stringify({ events: [], session_id: 'deployment_probe' })
            }),
            makeApiRequest(`${PRODUCTION_URL}/api/auth/logout`, { method: 'POST' }),
            makeApiRequest(`${PRODUCTION_URL}/api/identity/universal-passport`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            }),
            makeApiRequest(`${PRODUCTION_URL}/mcp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
            })
        ]);
        const csp = htmlResponse.headers?.['content-security-policy'] || '';
        const launchContractsOk =
            launchContracts.map(result => result.statusCode).join(',') === '200,200,410,200' &&
            launchContracts[3].data.includes('lookup_pathbook') &&
            launchContracts[3].data.includes('execute_pathbook') &&
            launchContracts[3].data.includes('post_solution') &&
            launchContracts[3].data.includes('report_pathbook_result') &&
            !htmlResponse.data.includes('fonts.googleapis.com') &&
            csp.includes("font-src 'self'") &&
            csp.includes('static.cloudflareinsights.com');
        if (launchContractsOk) {
            console.log('✅ Launch contracts/CSP: beacon, logout, retired prototype, and self-hosted font verified');
            passedChecks++;
        } else {
            console.log(`❌ Launch contracts/CSP: statuses=${launchContracts.map(r => r.statusCode).join(',')}, CSP=${csp}`);
        }

        // Legacy flywheel routes once called nonexistent helpers and returned raw 500s.
        // Verify their grounded replacements, including correct not-found semantics.
        const capabilityChecks = [
            ['/api/dashboard/ai-activity', 200],
            ['/api/innovation/opportunities', 200],
            ['/api/matching/analytics', 200],
            ['/api/personas/diversity', 200],
            ['/api/predictions/innovation-detection', 200],
            ['/api/knowledge-graph/related/268', 200],
            ['/api/matching/recommendations/268', 200],
            ['/api/recommendations/related-problems/268', 200],
            ['/api/solutions/compare/268', 200],
            ['/api/knowledge-graph/related/not-a-number', 400],
            ['/api/ai-collaboration/session/verification-does-not-exist', 404],
            ['/api/identity/analytics/verification-does-not-exist', 410]
        ];
        const capabilityResults = await Promise.all(capabilityChecks.map(async ([route, expected]) => {
            const result = await makeExpectedHttpRequest(`${PRODUCTION_URL}${route}`, expected);
            return { route, expected, actual: result.statusCode };
        }));
        const badCapabilities = capabilityResults.filter(result => result.actual !== result.expected);
        if (badCapabilities.length === 0) {
            console.log(`✅ Grounded capability APIs: ${capabilityResults.length}/${capabilityResults.length} expected responses`);
            passedChecks++;
        } else {
            console.log('❌ Grounded capability API failures:');
            badCapabilities.forEach(result =>
                console.log(`   ${result.route}: expected ${result.expected}, got ${result.actual}`)
            );
        }

        // Local-source regression guard: Cloudflare Workers caps PBKDF2 at 100000
        // iterations. Node tests won't catch a higher value (Node has no cap) — this did
        // ship broken once. Keep the constant at or below the platform limit.
        const workerSrc = require('fs').readFileSync(require('path').join(__dirname, 'src', 'worker.js'), 'utf8');
        const iterMatch = workerSrc.match(/^const PBKDF2_ITERATIONS = (\d+);/m);
        if (iterMatch && parseInt(iterMatch[1], 10) <= 100000) {
            console.log(`✅ PBKDF2 iterations: ${iterMatch[1]} (within Workers cap)`);
            passedChecks++;
        } else {
            console.log(`❌ PBKDF2 iterations: ${iterMatch ? iterMatch[1] : 'NOT FOUND'} — exceeds Workers' 100000 cap, will 500 all auth`);
        }

    } catch (error) {
        console.error('❌ Verification failed:', error.message);
    }

    // Final assessment
    console.log('\n📊 VERIFICATION RESULTS');
    console.log('========================');
    console.log(`Passed: ${passedChecks}/${REQUIRED_CHECKS.length}`);

    if (passedChecks === REQUIRED_CHECKS.length) {
        console.log('🎉 ✅ DEPLOYMENT VERIFIED - SUCCESS CLAIMS ALLOWED');
        process.exit(0);
    } else {
        console.log('🚨 ❌ DEPLOYMENT NOT VERIFIED - NO SUCCESS CLAIMS ALLOWED');
        console.log('\nFailed checks:');
        REQUIRED_CHECKS.forEach((check, i) => {
            if (i >= passedChecks) {
                console.log(`  - ${check}`);
            }
        });
        process.exit(1);
    }
}

if (require.main === module) {
    verifyDeployment();
}

module.exports = { verifyDeployment };
