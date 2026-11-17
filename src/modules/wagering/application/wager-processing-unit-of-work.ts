export abstract class WagerProcessingUnitOfWork {
  /** Resolves after commit; callback and commit failures roll back and propagate. */
  abstract transaction<T>(work: () => Promise<T>): Promise<T>;
}
