import assert from 'node:assert/strict';
import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Entity, PrimaryKey, Property, Type } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { SqsProbe } from './sqs.probe';

// Diagnostic mapping only: no Money domain object or financial rules.
export class DiagnosticAmountType extends Type<string, string> {
  override convertToDatabaseValue(value: string): string {
    assert.equal(typeof value, 'string', 'Monetary database input must be a string');
    return value;
  }

  override convertToJSValue(value: string): string {
    assert.equal(typeof value, 'string', 'The driver must return NUMERIC as a string');
    return value;
  }

  override getColumnType(): string {
    return 'numeric';
  }

  override compareAsType(): string {
    return 'string';
  }
}

@Entity({ tableName: 'compatibility_probe' })
export class DiagnosticRecord {
  @PrimaryKey({ type: 'string', columnType: 'text' })
  id!: string;

  @Property({ type: DiagnosticAmountType })
  amount!: string;
}

@Injectable()
export class DependencyProbe {
  readonly marker = 'dependency-injected';
}

@Injectable()
export class BootstrapProbe {
  // No @Inject: resolution must use emitted design:paramtypes.
  constructor(private readonly dependency: DependencyProbe) {}

  verify(): void {
    const parameters: unknown = Reflect.getMetadata('design:paramtypes', BootstrapProbe);
    assert.deepEqual(parameters, [DependencyProbe], 'Constructor metadata is missing');
    assert.equal(this.dependency.marker, 'dependency-injected', 'Nest DI did not resolve the dependency');
    assert.equal(Reflect.getMetadata('design:type', DiagnosticRecord.prototype, 'amount'), String);
  }
}

@Module({ providers: [DependencyProbe, BootstrapProbe], exports: [BootstrapProbe] })
export class BootstrapModule {}

export async function verifyOrmMetadata(): Promise<void> {
  const orm = await MikroORM.init({
    entities: [DiagnosticRecord],
    dbName: 'compatibility_diagnostic',
    connect: false,
    ensureDatabase: false,
    logger: () => {},
  });
  try {
    const amount = orm.getMetadata().get(DiagnosticRecord).properties['amount'];
    assert.deepEqual(amount?.columnTypes, ['numeric']);
    assert.equal(amount?.runtimeType, 'string');
    assert.ok(amount?.customType instanceof DiagnosticAmountType);
    console.log(JSON.stringify({ check: 'orm_metadata_without_database', status: 'passed' }));
  } finally {
    await orm.close(true);
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  assert.ok(value, `Missing diagnostic environment variable: ${name}`);
  return value;
}

async function createDiagnosticOrm(): Promise<MikroORM> {
  // Prevent accidentally targeting an existing database from a developer shell.
  assert.equal(process.env['GITHUB_ACTIONS'], 'true', 'Database diagnostics require GitHub Actions');
  assert.equal(process.env['DIAGNOSTIC_CONTAINER'], '1', 'Database diagnostics require the Compose client');
  assert.equal(requiredEnvironment('PGHOST'), 'postgres');
  assert.equal(requiredEnvironment('PGDATABASE'), 'compatibility_diagnostic');
  assert.equal(requiredEnvironment('PGUSER'), 'diagnostic');

  console.log(JSON.stringify({ check: 'orm_initialization', status: 'started' }));
  return MikroORM.init({
    entities: [DiagnosticRecord],
    host: 'postgres',
    port: 5432,
    dbName: 'compatibility_diagnostic',
    user: 'diagnostic',
    password: requiredEnvironment('PGPASSWORD'),
    ensureDatabase: false,
    debug: false,
    logger: () => {},
    pool: { min: 0, max: 2, acquireTimeoutMillis: 5_000 },
    driverOptions: {
      connection: {
        connectionTimeoutMillis: 5_000,
        statement_timeout: 5_000,
        query_timeout: 5_000,
      },
    },
  });
}

@Injectable()
export class DatabaseProbe implements OnApplicationShutdown {
  constructor(private readonly orm: MikroORM) {}

  async verify(): Promise<void> {
    console.log(JSON.stringify({ check: 'orm_connection', status: 'started' }));
    const connection = this.orm.em.getConnection();
    const ping = await connection.execute<{ result: number }[]>('select 1 as result');
    assert.equal(ping[0]?.result, 1);

    // Disposable fixture DDL, exclusively in the dedicated Compose database.
    await this.orm.getSchemaGenerator().createSchema();
    const columns = await connection.execute<{ data_type: string; numeric_scale: number | null }[]>(
      `select data_type, numeric_scale from information_schema.columns
       where table_schema = 'public' and table_name = 'compatibility_probe' and column_name = 'amount'`,
    );
    assert.equal(columns.length, 1);
    assert.equal(columns[0]?.data_type, 'numeric');
    assert.equal(columns[0]?.numeric_scale, null, 'NUMERIC must not have a scale modifier');
    console.log(JSON.stringify({ check: 'orm_connection_and_numeric_schema', status: 'passed' }));

    // Strings throughout, including values beyond Number.MAX_SAFE_INTEGER in whole units.
    const amounts = ['0.00', '0.01', '9007199254740993.01', '92233720368547758.07'];
    await this.orm.em.fork().transactional(async (transaction) => {
      for (const [index, amount] of amounts.entries()) {
        transaction.persist(transaction.create(DiagnosticRecord, { id: `commit-${index}`, amount }));
      }
      await transaction.flush();
    });

    // Fresh identity map: committed rows must be read back from PostgreSQL.
    const reader = this.orm.em.fork();
    for (const [index, expectedAmount] of amounts.entries()) {
      const record = await reader.findOneOrFail(DiagnosticRecord, { id: `commit-${index}` });
      assert.equal(typeof record.amount, 'string');
      assert.equal(record.amount, expectedAmount, 'ORM round-trip changed a monetary value');
      const raw = await connection.execute<{ amount: string }[]>(
        'select amount from compatibility_probe where id = ?', [record.id],
      );
      assert.equal(typeof raw[0]?.amount, 'string', 'Raw driver result is not a string');
      assert.equal(raw[0]?.amount, expectedAmount);
    }
    assert.equal(await reader.count(DiagnosticRecord), amounts.length);
    console.log(JSON.stringify({ check: 'commit_and_exact_round_trip', status: 'passed' }));

    const rollbackSignal = new Error('intentional diagnostic rollback');
    await assert.rejects(
      this.orm.em.fork().transactional(async (transaction) => {
        transaction.persist(transaction.create(DiagnosticRecord, { id: 'rollback', amount: '12.34' }));
        await transaction.flush();
        assert.equal(await transaction.count(DiagnosticRecord, { id: 'rollback' }), 1);
        throw rollbackSignal;
      }),
      (error: unknown) => error === rollbackSignal,
      'The intentional rollback must propagate its original failure',
    );
    const afterRollback = this.orm.em.fork();
    assert.equal(await afterRollback.count(DiagnosticRecord, { id: 'rollback' }), 0);
    assert.equal(await afterRollback.count(DiagnosticRecord), amounts.length);
    console.log(JSON.stringify({ check: 'rollback_without_partial_write', status: 'passed' }));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

@Module({
  imports: [BootstrapModule],
  providers: [{ provide: MikroORM, useFactory: createDiagnosticOrm }, DatabaseProbe, SqsProbe],
})
export class DiagnosticModule {}
