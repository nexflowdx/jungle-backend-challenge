import { expect, test } from 'bun:test';
import { assertPostgresReport, minimumPostgresTests, requiredIntegrationSuites } from '../../scripts/integration-report';

const expectedFiles = requiredIntegrationSuites.flatMap(([file, minimum]) => Array.from({ length: minimum }, () => file));

const report = (attributes = '', cases = minimumPostgresTests, content = '') =>
  `<testsuites tests="${cases}" skipped="0" failures="0" assertions="100" ${attributes}>` +
  Array.from({ length: cases }, (_, index) => {
    const file = expectedFiles[index] ?? 'extra';
    return `<testcase name="passed-${index}" file=".test-dist/test/integration/${file}.test.js" assertions="1"/>`;
  }).join('') + content + '</testsuites>';

test('integration report accepts a complete run with assertions and no skips', () => {
  expect(() => assertPostgresReport(report())).not.toThrow();
});
test('integration report rejects an extra named testcase with zero assertions beyond all required cases', () => {
  const xml = report('', minimumPostgresTests + 1).replace('extra.test.js" assertions="1"', 'extra.test.js" assertions="0"');
  expect(() => assertPostgresReport(xml)).toThrow('Every named integration testcase');
});
test('integration report rejects an extra named testcase without the assertions attribute', () => {
  const xml = report('', minimumPostgresTests + 1).replace('extra.test.js" assertions="1"', 'extra.test.js"');
  expect(() => assertPostgresReport(xml)).toThrow('Every named integration testcase');
});
test('integration report accepts additional named cases with assertions and ignores unnamed hooks', () => {
  expect(() => assertPostgresReport(report('', minimumPostgresTests + 1))).not.toThrow();
  const xml = report('', minimumPostgresTests + 1).replace(`name="passed-${minimumPostgresTests}"`, 'name="(unnamed)"')
    .replace('extra.test.js" assertions="1"', 'extra.test.js" assertions="0"');
  expect(() => assertPostgresReport(xml)).not.toThrow();
});
test.each([
  '', '<testsuites/>', report('', 0), report('', 51), report('', 52), report('', 87), report('', 96), report('', 128), report('', 159), report('', 200), report('', 236), report('', 326), report('', 331), report('', 347), report('', minimumPostgresTests - 1),
  report().replace('skipped="0"', 'skipped="1"'),
  report().replace('failures="0"', 'failures="1"'),
  report().replace('assertions="100"', 'assertions="0"'),
  report().replace('skipped="0"', ''),
  report('', minimumPostgresTests, '<skipped/>'),
  report('', minimumPostgresTests, '<failure/>'),
  report('', minimumPostgresTests, '<error/>'),
  report().replace(/<testcase[^>]*\/>/, ''),
  report().replace('</testsuites>', ''),
  report().replaceAll('wallet-opening.test.js', 'other.test.js'),
  report().replaceAll('postgres.test.js', 'wallet-opening.test.js'),
  report().replaceAll('wager-processing.test.js', 'other.test.js'),
  report().replace(/name="passed-\d+" file="([^"]*wager-processing.test.js)" assertions="1"/, 'name="(unnamed)" file="$1" assertions="1"'),
  report().replace(/wager-processing\.test\.js" assertions="1"/, 'wager-processing.test.js" assertions="0"'),
  report().replaceAll('wager-identity.test.js', 'other.test.js'),
  report().replace(/name="passed-\d+" file="([^"]*wager-identity.test.js)" assertions="1"/, 'name="(unnamed)" file="$1" assertions="1"'),
  report().replace(/wager-identity\.test\.js" assertions="1"/, 'wager-identity.test.js" assertions="0"'),
  report().replaceAll('bet-processing.test.js', 'other.test.js'),
  report().replace(/name="passed-\d+" file="([^"]*bet-processing.test.js)" assertions="1"/, 'name="(unnamed)" file="$1" assertions="1"'),
  report().replace(/bet-processing\.test\.js" assertions="1"/, 'bet-processing.test.js" assertions="0"'),
  report().replaceAll('win-loss-processing.test.js', 'other.test.js'),
  report().replace(/name="passed-\d+" file="([^"]*win-loss-processing.test.js)" assertions="1"/, 'name="(unnamed)" file="$1" assertions="1"'),
  report().replace(/win-loss-processing\.test\.js" assertions="1"/, 'win-loss-processing.test.js" assertions="0"'),
  report().replaceAll('reference-processing.test.js', 'other.test.js'),
  report().replace(/name="passed-\d+" file="([^"]*reference-processing.test.js)" assertions="1"/, 'name="(unnamed)" file="$1" assertions="1"'),
  report().replace(/reference-processing\.test\.js" assertions="1"/, 'reference-processing.test.js" assertions="0"'),
  report().replaceAll('reversal-processing.test.js', 'other.test.js'),
  report().replace(/name="passed-\d+" file="([^"]*reversal-processing.test.js)" assertions="1"/, 'name="(unnamed)" file="$1" assertions="1"'),
  report().replace(/reversal-processing\.test\.js" assertions="1"/, 'reversal-processing.test.js" assertions="0"'),
  report().replaceAll('http-api.test.js', 'other.test.js'),
  report().replace(/name="passed-\d+" file="([^"]*http-api.test.js)" assertions="1"/, 'name="(unnamed)" file="$1" assertions="1"'),
  report().replace(/http-api\.test\.js" assertions="1"/, 'http-api.test.js" assertions="0"'),
  report().replaceAll('wager-atomicity.test.js', 'other.test.js'),
  report().replace(/name="passed-\d+" file="([^"]*wager-atomicity.test.js)" assertions="1"/, 'name="(unnamed)" file="$1" assertions="1"'),
  report().replace(/wager-atomicity\.test\.js" assertions="1"/, 'wager-atomicity.test.js" assertions="0"'),
  report().replaceAll('wager-multiprocess.test.js', 'other.test.js'),
  report().replace(/name="passed-\d+" file="([^"]*wager-multiprocess.test.js)" assertions="1"/, 'name="(unnamed)" file="$1" assertions="1"'),
  report().replace(/wager-multiprocess\.test\.js" assertions="1"/, 'wager-multiprocess.test.js" assertions="0"'),
  report().replaceAll('sqs-inbox.test.js', 'other.test.js'),
  report().replace(/name="passed-\d+" file="([^"]*sqs-inbox.test.js)" assertions="1"/, 'name="(unnamed)" file="$1" assertions="1"'),
  report().replace(/sqs-inbox\.test\.js" assertions="1"/, 'sqs-inbox.test.js" assertions="0"'),
  report().replace('assertions="1"', 'assertions="0"'),
  report().replace('name="passed-0"', 'name="(unnamed)"'),
])('integration report fails closed for incomplete, skipped or failing run %#', xml => {
  expect(() => assertPostgresReport(xml)).toThrow();
});

test('manifest retains every historical per-file minimum and requires the outbox reservation suite', () => {
  expect(requiredIntegrationSuites).toEqual([
    ['postgres', 55], ['wallet-opening', 32], ['wager-processing', 9], ['wager-identity', 32],
    ['bet-processing', 31], ['win-loss-processing', 41], ['reference-processing', 43], ['reversal-processing', 90],
    ['http-api', 6], ['wager-atomicity', 6], ['wager-multiprocess', 10], ['sqs-inbox', 17],
    ['sqs-retry-dlq', 13], ['sqs-financial-protection', 6],
    ['outbox-reservation', 14], ['outbox-confirmation', 5], ['outbox-retry', 5],
    ['sqs-outbox-publication', 1],
    ['outbox-recovery', 1],
    ['wallet-ledger', 11],
    ['wallet-reconciliation', 17],
  ]);
  expect(minimumPostgresTests).toBe(445);
  expect(() => assertPostgresReport(report('', 364))).toThrow();
  expect(() => assertPostgresReport(report('', 383))).toThrow();
});

test.each(['sqs-retry-dlq', 'sqs-financial-protection', 'outbox-reservation', 'wallet-ledger', 'wallet-reconciliation'])('%s cannot be replaced by other cases, unnamed hooks, or cases without assertions', file => {
  const xml = report(); const name = `${file}.test.js`;
  const path = new RegExp(`name="passed-\\d+" file="([^"]*${file}\\.test\\.js)" assertions="1"`);
  expect(() => assertPostgresReport(xml.replaceAll(name, 'extra.test.js'))).toThrow();
  expect(() => assertPostgresReport(xml.replace(path, 'name="(unnamed)" file="$1" assertions="1"'))).toThrow();
  expect(() => assertPostgresReport(xml.replace(path, 'name="passed-without-assertions" file="$1" assertions="0"'))).toThrow();
});
