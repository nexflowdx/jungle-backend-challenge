import 'reflect-metadata';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM, type Options } from '@mikro-orm/postgresql';
import { persistenceEntities } from './entities';
import { Migration202611170001 } from './migrations/Migration202611170001';
import { Migration202611170002 } from './migrations/Migration202611170002';
import { Migration202611170003 } from './migrations/Migration202611170003';
import { Migration202611170004 } from './migrations/Migration202611170004';

export const persistenceMigrations = [
  Migration202611170001, Migration202611170002, Migration202611170003, Migration202611170004,
];

export interface DatabaseConnection {
  readonly host: string;
  readonly port: number;
  readonly dbName: string;
  readonly user: string;
  readonly password: string;
}

export function databaseOptions(connection: DatabaseConnection): Options {
  return {
    ...connection, entities: persistenceEntities, extensions: [Migrator],
    allowGlobalContext: false, ensureDatabase: false, debug: false,
    migrations: {
      migrationsList: persistenceMigrations, transactional: true, allOrNothing: true,
      disableForeignKeys: false, snapshot: false,
    },
    pool: { min: 0, max: 5 },
    driverOptions: { connection: { connectionTimeoutMillis: 5000, statement_timeout: 10000 } },
  };
}

// Each request/job must fork its own EntityManager; initialization never synchronizes schema.
export async function createPersistence(connection: DatabaseConnection): Promise<MikroORM> {
  return MikroORM.init(databaseOptions(connection));
}
