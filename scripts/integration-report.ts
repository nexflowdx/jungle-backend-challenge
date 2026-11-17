// Skipped hooks appear as extra unnamed cases locally; they are not real tests.
// Counts exclude hooks and expand test.each for each required integration file.
export const minimumPersistenceTests = 55;
export const minimumWalletOpeningTests = 32;
export const minimumWagerInfrastructureTests = 9;
export const minimumWagerIdentityTests = 32;
export const minimumBetProcessingTests = 31;
export const minimumPostgresTests = minimumPersistenceTests + minimumWalletOpeningTests + minimumWagerInfrastructureTests + minimumWagerIdentityTests + minimumBetProcessingTests;

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
  const cases = [...xml.matchAll(/<testcase\b([^>]*)>/g)].map(match => match[1]!);
  for (const [file, minimum] of [
    ['postgres', minimumPersistenceTests], ['wallet-opening', minimumWalletOpeningTests],
    ['wager-processing', minimumWagerInfrastructureTests],
    ['wager-identity', minimumWagerIdentityTests],
    ['bet-processing', minimumBetProcessingTests],
  ] as const) {
    const path = new RegExp(`\\bfile="[^"]*\\/${file}\\.test\\.(?:js|ts)"`);
    const executed = cases.filter(attributes => path.test(attributes)
      && !/\bname="\(unnamed\)"/.test(attributes)
      && Number(attributes.match(/\bassertions="([0-9]+)"/)?.[1] ?? '0') > 0);
    if (executed.length < minimum) throw new Error(`Missing executed PostgreSQL cases with assertions: ${file}`);
  }
}
