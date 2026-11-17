import { expect, test } from 'bun:test';
import { assertPostgresReport, minimumPersistenceTests, minimumWalletOpeningTests, minimumWagerInfrastructureTests, minimumPostgresTests } from '../../scripts/integration-report';

const report = (attributes = '', cases = minimumPostgresTests, content = '') =>
  `<testsuites tests="${cases}" skipped="0" failures="0" assertions="100" ${attributes}>` +
  Array.from({ length: cases }, (_, index) => {
    const file = index < minimumPersistenceTests ? 'postgres'
      : index < minimumPersistenceTests + minimumWalletOpeningTests ? 'wallet-opening'
        : index < minimumPersistenceTests + minimumWalletOpeningTests + minimumWagerInfrastructureTests ? 'wager-processing' : 'wager-identity';
    return `<testcase name="passed-${index}" file=".test-dist/test/integration/${file}.test.js" assertions="1"/>`;
  }).join('') + content + '</testsuites>';

test('integration report accepts a complete run with assertions and no skips', () => {
  expect(() => assertPostgresReport(report())).not.toThrow();
});
test.each([
  '', '<testsuites/>', report('', 0), report('', 51), report('', 52), report('', 87), report('', 96), report('', minimumPostgresTests - 1),
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
  report().replace('assertions="1"', 'assertions="0"'),
  report().replace('name="passed-0"', 'name="(unnamed)"'),
])('integration report fails closed for incomplete, skipped or failing run %#', xml => {
  expect(() => assertPostgresReport(xml)).toThrow();
});
