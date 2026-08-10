import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Discover all test files matching tests/*.test.mjs
const testFiles = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join(__dirname, f));

console.log('======================================================================');
console.log('              VOID 2.0 MASTER E2E TEST RUNNER                         ');
console.log('======================================================================');
console.log(`Discovered ${testFiles.length} test files:`);
testFiles.forEach((file) => console.log(`  - ${path.basename(file)}`));
console.log('----------------------------------------------------------------------\n');

const startTime = Date.now();
const testStream = run({ files: testFiles });

// Track summary statistics
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let skippedTests = 0;
let suiteCount = 0;

const tierStats = {};

testStream.on('test:pass', (data) => {
  if (data.nesting === 1) {
    // Leaf test case
    totalTests++;
    passedTests++;
    const fileKey = path.basename(data.file || 'unknown');
    if (!tierStats[fileKey]) tierStats[fileKey] = { pass: 0, fail: 0, total: 0 };
    tierStats[fileKey].pass++;
    tierStats[fileKey].total++;
  } else if (data.nesting === 0) {
    suiteCount++;
  }
});

testStream.on('test:fail', (data) => {
  if (data.nesting === 1) {
    totalTests++;
    failedTests++;
    const fileKey = path.basename(data.file || 'unknown');
    if (!tierStats[fileKey]) tierStats[fileKey] = { pass: 0, fail: 0, total: 0 };
    tierStats[fileKey].fail++;
    tierStats[fileKey].total++;
  }
});

testStream.on('test:dequeue', (data) => {
  // Can be used for detailed event logging if needed
});

// Pipe standard spec reporter output to stdout
testStream.compose(spec).pipe(process.stdout);

testStream.on('end', () => {
  const durationMs = Date.now() - startTime;
  console.log('\n======================================================================');
  console.log('                    E2E TEST RUNNER SUMMARY STATISTICS                ');
  console.log('======================================================================');
  console.log(`Execution Duration : ${(durationMs / 1000).toFixed(2)}s (${durationMs} ms)`);
  console.log(`Test Files / Suites: ${testFiles.length}`);
  console.log(`Total Tests Run    : ${totalTests}`);
  console.log(`Passed             : ${passedTests}`);
  console.log(`Failed             : ${failedTests}`);
  console.log(`Skipped            : ${skippedTests}`);
  console.log('----------------------------------------------------------------------');
  console.log('BREAKDOWN BY SUITE:');
  Object.keys(tierStats).sort().forEach((file) => {
    const stat = tierStats[file];
    const statusStr = stat.fail === 0 ? 'PASS' : 'FAIL';
    console.log(`  [${statusStr}] ${file.padEnd(30)}: ${stat.pass}/${stat.total} tests passed`);
  });
  console.log('======================================================================');

  if (failedTests > 0 || totalTests === 0) {
    console.error(`\n❌ E2E Test Runner Completed WITH ERRORS (Failures: ${failedTests}, Total: ${totalTests})`);
    process.exit(1);
  } else {
    console.log(`\n✅ ALL ${totalTests} E2E TESTS PASSED SUCCESSFULLY! (Exit Code: 0)`);
    process.exit(0);
  }
});
