import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';

/** Infrastructure boundary: the manager stays inside persistence adapters/tests. */
export function runPostgresTransaction<T>(
  orm: MikroORM, work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return orm.em.fork().transactional(work);
}
