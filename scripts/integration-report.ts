// Skipped hooks appear as extra unnamed cases locally; they are not real tests.
// Expanding test.each yields 55 PostgreSQL cases, including the ORM regressions.
export const minimumPostgresTests = 55;

export function assertPostgresReport(xml: string): void {
  const root = xml.match(/<testsuites\b([^>]*)>/)?.[1];
  const attribute = (name: string): number => {
    const value = root?.match(new RegExp(`\\b${name}="([0-9]+)"`))?.[1];
    if (value === undefined) throw new Error(`Missing integration report attribute: ${name}`);
    return Number(value); // Test counters only; monetary values never enter this parser.
  };
  const tests = attribute('tests');
  if (!xml.includes('</testsuites>') || tests < minimumPostgresTests ||
    attribute('skipped') !== 0 || attribute('failures') !== 0 || attribute('assertions') === 0 ||
    /<(?:skipped|failure|error)\b/.test(xml) || (xml.match(/<testcase\b/g)?.length ?? 0) !== tests) {
    throw new Error('PostgreSQL integration must execute all tests with assertions, zero skips and zero failures');
  }
}
