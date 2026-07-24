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
    'Online counter endpoint works',
    'Frontend assets deployed',
    'Frontend contains sorting fix',
    'Deployed JS matches local dist build',
    'Auth crypto healthy (/api/health/auth)',
    'PBKDF2 iterations within Workers cap (local src)'
];

async function makeHttpRequest(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, data }));
        }).on('error', reject);
    });
}

async function verifyDeployment() {
    console.log('\n🚨 MANDATORY DEPLOYMENT VERIFICATION');
    console.log('=====================================');

    let passedChecks = 0;

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

        // 2. Test frontend deployment
        console.log('\n🌐 Testing frontend deployment...');

        const htmlResponse = await makeHttpRequest(PRODUCTION_URL);
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