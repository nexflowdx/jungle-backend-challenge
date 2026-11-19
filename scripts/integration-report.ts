// Skipped hooks appear as extra unnamed cases locally; they are not real tests.
// Counts exclude hooks and expand test.each for each required integration file.
export const minimumPersistenceTests = 55;
export const minimumWalletOpeningTests = 32;
export const minimumWagerInfrastructureTests = 9;
export const minimumWagerIdentityTests = 32;
export const minimumBetProcessingTests = 31;
export const minimumWinLossProcessingTests = 41;
export const minimumReferenceProcessingTests = 43;
export const minimumReversalProcessingTests = 90;
export const minimumHttpApiTests = 6;
export const minimumWagerAtomicityTests = 6;
export const minimumWagerMultiprocessTests = 10;
export const minimumSqsInboxTests = 17;
export const minimumSqsRetryDlqTests = 13;
export const minimumSqsFinancialProtectionTests = 6;
export const minimumOutboxReservationTests = 14;
export const minimumOutboxConfirmationTests = 5;
export const minimumOutboxRetryTests = 5;
export const minimumSqsOutboxPublicationTests = 1;
// Explicit manifest shared by execution and report validation; no filesystem/glob discovery.
export const requiredIntegrationSuites = [
  ['postgres', minimumPersistenceTests], ['wallet-opening', minimumWalletOpeningTests],
  ['wager-processing', minimumWagerInfrastructureTests], ['wager-identity', minimumWagerIdentityTests],
  ['bet-processing', minimumBetProcessingTests], ['win-loss-processing', minimumWinLossProcessingTests],
  ['reference-processing', minimumReferenceProcessingTests], ['reversal-processing', minimumReversalProcessingTests],
  ['http-api', minimumHttpApiTests], ['wager-atomicity', minimumWagerAtomicityTests],
  ['wager-multiprocess', minimumWagerMultiprocessTests], ['sqs-inbox', minimumSqsInboxTests],
  ['sqs-retry-dlq', minimumSqsRetryDlqTests], ['sqs-financial-protection', minimumSqsFinancialProtectionTests],
  ['outbox-reservation', minimumOutboxReservationTests],
  ['outbox-confirmation', minimumOutboxConfirmationTests],
  ['outbox-retry', minimumOutboxRetryTests],
  ['sqs-outbox-publication', minimumSqsOutboxPublicationTests],
  ['outbox-recovery', 1],
  ['wallet-ledger', 11],
  ['wallet-reconciliation', 17],
  ['operational-metrics', 2],
  ['health', 2],
] as const;
export const minimumPostgresTests = requiredIntegrationSuites.reduce((total, [, minimum]) => total + minimum, 0);

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
  if (cases.some(attributes => !/\bname="\(unnamed\)"/.test(attributes)
    && !(Number(attributes.match(/\bassertions="([0-9]+)"/)?.[1] ?? '0') > 0))) {
    throw new Error('Every named integration testcase must include at least one assertion');
  }
  for (const [file, minimum] of requiredIntegrationSuites) {
    const path = new RegExp(`\\bfile="[^"]*\\/${file}\\.test\\.(?:js|ts)"`);
    const executed = cases.filter(attributes => path.test(attributes)
      && !/\bname="\(unnamed\)"/.test(attributes)
      && Number(attributes.match(/\bassertions="([0-9]+)"/)?.[1] ?? '0') > 0);
    if (executed.length < minimum) throw new Error(`Missing executed PostgreSQL cases with assertions: ${file}`);
  }
}
