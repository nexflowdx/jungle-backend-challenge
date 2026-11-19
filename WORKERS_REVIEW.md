# Validação dos workers contínuos

Execução em 19/11/2026, com Bun 1.4.4. As alterações da implementação interrompida
foram preservadas. Esta revisão não alterou código dos workers, regras financeiras,
idempotência, leases, contratos SQS, migrations ou infraestrutura.

## Resultados desta execução

- `bun run typecheck`: aprovado (código 0, etapa anterior ao build).
- `bun x tsc -p tsconfig.test.json`: aprovado; testes recompilados a partir dos fontes atuais.
- Testes unitários relacionados: **315 aprovados, 0 falhas, 765 assertions em nove
  arquivos**, em 24,58 s. Incluem consumidor/publisher contínuos, evidência
  financeira, configuração/sinais, coordenador de publicação, entrada SQS,
  retry, DLQ e manifesto de integração. Falhas simuladas emitem logs de erro
  esperados, sem representar falhas da suíte.
- `bun run build`: aprovado (código 0).
- Uma repetição via `bun run --bun typecheck && bun run --bun build` e outra
  via `bun node_modules/typescript/bin/tsc -p tsconfig.test.json && bun test ...`
  foram interrompidas com SIGINT (código 130) após a execução original completa
  passar. Os resultados acima são da execução original; as repetições parciais
  não foram contabilizadas.
- `git diff --check`: aprovado.
- `docker compose version`: disponível, v5.3.1.
- `docker info --format '{{.ServerVersion}}'`: código 1, acesso negado à API
  Docker em `unix:///var/run/docker.sock`. Não foi possível confirmar disponibilidade
  de PostgreSQL/MiniStack nem iniciar os containers isolados. Não houve tentativa
  com sudo, alteração de permissões ou contorno do sandbox.
- Os scripts reais `scripts/run-sqs-consumer.ts` e
  `scripts/run-outbox-publisher.ts` foram executados com ambiente vazio, via
  `env -i PATH=/home/codex/.bun/bin:/usr/bin:/bin bun <script>`.
  Ambos emitiram JSON `worker.failed` e encerraram com código 1, como esperado
  sem configuração obrigatória. Isso valida carregamento e rejeição de configuração;
  não comprova conexão, polling ou shutdown dos entrypoints em funcionamento.

Comandos da validação local (Bash):

```bash
bun run typecheck
bun run build
bun x tsc -p tsconfig.test.json
bun test ./.test-dist/test/unit/{continuous-sqs-consumer,continuous-outbox-publisher,consumer-financial-evidence,worker-configuration,outbox-publication-coordinator,sqs-entry,sqs-wager-retry,sqs-wager-dlq,integration-report}.test.js
git diff --check
```

## Integrações bloqueadas

Não foram executados os cinco testes de `continuous-consumer.test.ts`, os três de
`continuous-publisher.test.ts`, nem os testes existentes de concorrência da outbox.
O motivo é a falta de acesso ao daemon Docker. Testes ignorados por ausência de
`PERSISTENCE_INTEGRATION=1` não são contabilizados como validação.

As suítes contínuas já estão incluídas em `requiredIntegrationSuites`, usado pelo
runner `scripts/run-persistence-integration.ts`. O runner exige execução sem skips.
O Compose existente usa banco descartável em tmpfs, rede interna e nenhuma porta
publicada. As proteções dos testes exigem o ambiente isolado do GitHub Actions;
não foram alteradas nem foram usadas credenciais de produção.

Para executar no ambiente de CI existente, sem alterar essas proteções:

```bash
# No job isolado já definido em .github/workflows/persistence-integration.yml,
# com COMPOSE_FILE, COMPOSE_PROJECT_NAME e senha descartável configurados pelo job:
docker compose build persistence-tests
docker compose up --detach --wait --wait-timeout 60 postgres ministack
docker compose run --rm --no-deps -T persistence-tests
```

O último comando executa o manifesto completo, incluindo os oito testes novos,
`outbox-reservation`, `outbox-confirmation`, `outbox-retry`, `outbox-recovery` e
`sqs-outbox-publication`. O workflow não foi disparado nesta revisão; nenhuma
operação externa com custo foi executada.

## Execução operacional

Em ambiente autorizado, com PostgreSQL e filas já provisionados, execute cada
processo separadamente:

```bash
bun scripts/run-sqs-consumer.ts
bun scripts/run-outbox-publisher.ts
```

Ambos exigem `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`,
`SQS_ENDPOINT`, `AWS_ACCESS_KEY_ID` e `AWS_SECRET_ACCESS_KEY`.
`AWS_REGION` assume `us-east-1`; `AWS_SESSION_TOKEN` é opcional.
O consumidor exige `SQS_QUEUE_URL` e `SQS_DLQ_URL`; o publisher exige
`SQS_EVENTS_QUEUE_URL` terminando em `/wager-events.fifo`.

Limites existentes: `WORKER_POLL_INTERVAL_MS=250`,
`WORKER_SHUTDOWN_GRACE_MS=30000`, `SQS_WAIT_TIME_SECONDS=10` e
`SQS_VISIBILITY_TIMEOUT_SECONDS=120`. Faixas permitidas estão no RUNBOOK.
SIGTERM/SIGINT solicitam parada e drenagem; timeout deve resultar em código 1.

## Pendências e riscos

- Validar SIGTERM/SIGINT reais, ACK após commit, redelivery sem novo débito,
  evidência de rollback, commit incerto, retry e recuperação de lease com
  PostgreSQL/MiniStack reais. A cobertura unitária não substitui essa validação.
- As integrações novas iniciam probes que reutilizam os componentes dos workers;
  ainda é necessário verificar os dois scripts operacionais completos com
  configuração válida, inclusive startup e encerramento dos recursos.
- Falta executar concorrência da outbox em banco real nesta revisão.
- Visibilidade não tem heartbeat. Trabalho que ultrapasse a visibilidade pode
  sofrer redelivery; a segurança depende das garantias persistentes existentes.
- Nenhuma falha funcional foi demonstrada nos testes executados nesta revisão;
  não há justificativa para reimplementar os processos.

Arquivos editados nesta revisão: `WORKERS_REVIEW.md` (novo) e `FINAL_REVIEW.md`
(texto da referência). A criação deste relatório resolve também o link existente
no `RUNBOOK.md`. `AGENTS.md` e `PLANO_REVISADO1.md` foram preservados.
