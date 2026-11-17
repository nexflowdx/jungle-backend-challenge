import { expect, test } from 'bun:test';
import { assertPostgresReport, minimumPostgresTests } from '../../scripts/integration-report';

const report = (attributes = '', cases = minimumPostgresTests, content = '') =>
  `<testsuites tests="${cases}" skipped="0" failures="0" assertions="100" ${attributes}>` +
  '<testcase name="passed"/>'.repeat(cases) + content + '</testsuites>';

test('integration report accepts a complete run with assertions and no skips', () => {
  expect(() => assertPostgresReport(report())).not.toThrow();
});
test.each([
  '', '<testsuites/>', report('', 0), report('', 51), report('', 52), report('', minimumPostgresTests - 1),
  report().replace('skipped="0"', 'skipped="1"'),
  report().replace('failures="0"', 'failures="1"'),
  report().replace('assertions="100"', 'assertions="0"'),
  report().replace('skipped="0"', ''),
  report('', minimumPostgresTests, '<skipped/>'),
  report('', minimumPostgresTests, '<failure/>'),
  report('', minimumPostgresTests, '<error/>'),
  report().replace('<testcase name="passed"/>', ''),
  report().replace('</testsuites>', ''),
])('integration report fails closed for incomplete, skipped or failing run %#', xml => {
  expect(() => assertPostgresReport(xml)).toThrow();
});
