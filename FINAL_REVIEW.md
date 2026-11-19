# Revisão final — Jungle Gaming

Base da execução autônoma: `develop`, commit `41e1a17`. Nenhum commit, push, deploy,
provisionamento ou operação com custo externo foi executado.

## Etapa 1 — 9.3.2

Implementados contadores locais para respostas/replays HTTP e SQS, confirmação de
reagendamento SQS, reagendamento persistido de outbox/referências, publicação DLQ
confirmada, falhas SQL identificadas e resultados de reconciliação. As observações
ocorrem após o retorno correspondente, sem modificar políticas ou transações.
DLQ confirmada não significa ACK confirmado; respostas de wagering incluem replay,
não representam transações únicas. Serialização não é classificada como deadlock.

Validação: typecheck, build e `git diff --check` aprovados; **233 testes aprovados,
zero falhas** em 8 arquivos. Um erro inicial de tipagem na fixture de teste foi
corrigido antes da validação. Registro local: `.test-dist/final-stage-1.log`.

## Etapa 2 — 9.3.3

Snapshot interno: `operationalMetrics.snapshot()` identifica instância, início,
processo e natureza efêmera; não é consultável a partir de outro processo.
O CLI `bun scripts/read-operational-metrics.ts` consulta somente o PostgreSQL,
sem apresentar contadores locais recém-iniciados como se fossem do servidor.
Há estados atuais (gauge), transações com transições na outbox retida, backlog/idade
da outbox e duração de ciclo de vida, incluindo espera por referência e OPENING.
Não há histórico completo de duplicatas/retries/DLQ/reconciliações. A medição de
execução local nas bordas HTTP/SQS foi incluída na revisão final. Não foi criada
migration ou endpoint de métricas.

Validação: typecheck, build e `git diff --check` aprovados; **77 testes aprovados,
zero falhas** em 3 arquivos. Registro: `.test-dist/final-stage-2.log`.
Dois testes PostgreSQL foram adicionados ao manifesto obrigatório da CI e não
executados localmente.

## Etapa 3 — 9.4

Implementados endpoints públicos GET /health/live e GET /health/ready. Liveness não
consulta dependências. Readiness faz SELECT 1 e ListQueues, com prazo de 1500 ms,
cancelamento SDK e coalescência de I/O pendente; respostas contêm somente up/down.
Ausência de configuração não inventa disponibilidade. Não há escrita financeira.

Validação: typecheck, build e `git diff --check` aprovados; **139 testes aprovados,
zero falhas** em 6 arquivos. Registro: `.test-dist/final-stage-3.log`.
Dois testes reais de health foram preparados para PostgreSQL/MiniStack na CI.

## Etapa 4 — 9.5: revisão e pendências reais

Correções pontuais: eventos JSON específicos para reconciliação divergente ou
inconclusiva, após o snapshot concluir, sem payload financeiro; latência nas bordas
HTTP/SQS com relógio monotônico. Falha do relógio preserva resultado/erro original
e não inventa duração. Nenhuma medição é usada em decisões de negócio. Sem mudanças nas
regras de domínio, migrations, locks, idempotência, leases, políticas ou ACKs.

| Requisito | Evidência no código / limite |
|---|---|
| Precisão e invariantes financeiras | Money imutável, NUMERIC, constraints e ledger imutável existentes; não modificados |
| Idempotência/concorrência | Constraints persistentes, lock por carteira, inbox/outbox atômicos existentes; CI real ainda necessária para esta revisão |
| Ledger/reconciliação HTTP | Implementados, bloqueados 403 até autorização por carteira confiável |
| Consultas GET wallet e transações por ID/provedor | **Ausentes** dos controllers atuais; não foram inventadas nem adicionadas nesta revisão |
| SQS/DLQ | Adapters explícitos de receive/process/ACK, retry e DLQ existentes; sem consumer loop operacional |
| SIGTERM do consumidor SQS | **Não implementado nem testado em consumidor real**. MessagingModule declara não iniciar consumer; SqsWagerDelivery não possui política de shutdown |
| Shutdown existente | HTTP fecha recursos; worker de referências trata SIGTERM após o lote. O worker de teste multiprocesso não é consumidor SQS |
| Publisher de outbox | Coordinator.processOnce/factory existentes, sem entrypoint contínuo de publicação |
| Replay após reinício | Testes existentes reconstroem conexão/handler; isso não demonstra SIGTERM do consumidor nem kill real após commit antes de ACK |
| Métricas | Snapshot local, latência HTTP/SQS e agregados persistidos disponíveis; históricos não persistidos declarados indisponíveis |
| Autenticação | Guard de provedor ainda no-op, permitido pelo README; aplicação não deve ser exposta como serviço autenticado |
| Health | Conectividade PG/SQS, não comprova consumidores, filas individuais ou todo o pipeline |
| Compose | Existe ambiente isolado de integração e referência de worker; não há stack operacional completa de três instâncias/consumer/publisher |

O desafio **não está integralmente concluído**. Consumer contínuo com shutdown e
recuperação, publisher contínuo e consultas faltantes exigem incrementos próprios;
implementá-los agora ultrapassaria uma correção pontual de baixo risco. Não houve
alteração de infraestrutura/produção, instalação, commit, push, merge ou CI remota.

PostgreSQL/MiniStack reais não estão disponíveis
localmente: acesso ao socket Docker negado. Não houve tentativa de contorno.

## Validação final executada

- Typecheck, build, bootstrap Nest e `git diff --check`: aprovados.
- Suíte unitária completa: **1.169 aprovados e 4 falhos**, 1.173 casos em 45 arquivos.
- Os quatro falhos são do harness IPC preexistente: 50 requisições em três processos,
  liberação de checkpoint, morte prematura e timeout/teardown.
- Reprodução isolada do worker confirmou `EPERM: operation not permitted, write`
  ao escrever no pipe do subprocesso. Não foi alterado o sandbox nem ocultada a falha.
- Bateria final relacionada: **49 aprovados, zero falhas** em 5 arquivos. Os casos
  se sobrepõem à suíte completa; as contagens não devem ser somadas.
- Logs locais: `.test-dist/final-stage-4-unit.log` e
  `.test-dist/final-stage-4-related.log` (artefatos ignorados pelo Git).
- PostgreSQL/MiniStack, concorrência real e casos novos de métricas/health dependem
  da CI. Não foram executados localmente porque Docker nega acesso. O manifesto
  exige no mínimo **449 casos de integração**, sem skips/falhas. Nenhuma CI nova foi
  iniciada ou declarada verde.

## Arquivos modificados nesta execução

- `ARCHITECTURE.md`
- `FINAL_REVIEW.md`
- `RUNBOOK.md`
- `scripts/integration-report.ts`
- `scripts/read-operational-metrics.ts`
- `src/http/health.controller.ts`
- `src/http/http-api.module.ts`
- `src/http/runtime-persistence.ts`
- `src/http/wagering-transactions.controller.ts`
- `src/modules/messaging/application/outbox-publication-coordinator.ts`
- `src/modules/messaging/application/sqs-wager-command-handler.ts`
- `src/modules/messaging/infrastructure/sqs-wager-dlq.ts`
- `src/modules/messaging/infrastructure/sqs-wager-retry.ts`
- `src/modules/operations/json-logger.ts`
- `src/modules/operations/operational-metrics.ts`
- `src/modules/operations/postgres-operational-metrics.ts`
- `src/modules/operations/readiness.ts`
- `src/modules/operations/sqs-readiness.ts`
- `src/modules/wagering/application/process-pending-reference.ts`
- `src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work.ts`
- `src/modules/wallets/application/reconcile-wallet.ts`
- `test/integration/health.test.ts`
- `test/integration/operational-metrics.test.ts`
- `test/unit/health.test.ts`
- `test/unit/integration-report.test.ts`
- `test/unit/operational-metrics.test.ts`
- `test/unit/postgres-operational-metrics.test.ts`
- `test/unit/reconcile-wallet.test.ts`
- `test/unit/sqs-wager-dlq.test.ts`

AGENTS.md e PLANO_REVISADO1.md permanecem inalterados e não estão incluídos nos
comandos de staging. README.md, dependências, lockfile e migrations não mudaram.

## Comandos para revisão e validação manual

```bash
git status --short
git diff --check
git diff --stat
git diff
bun run --bun typecheck
bun run --bun build
bun run bootstrap
bun run --bun test:unit
```

A suíte completa falha no sandbox pelo problema IPC relatado acima. Não interpretar
isso como uma execução verde nem remover esses testes. Revise os novos arquivos
listados acima; após decidir pelo commit manual, o staging explícito é:

```bash
git add -- ARCHITECTURE.md FINAL_REVIEW.md RUNBOOK.md scripts/integration-report.ts scripts/read-operational-metrics.ts src/http/health.controller.ts src/http/http-api.module.ts src/http/runtime-persistence.ts src/http/wagering-transactions.controller.ts src/modules/messaging/application/outbox-publication-coordinator.ts src/modules/messaging/application/sqs-wager-command-handler.ts src/modules/messaging/infrastructure/sqs-wager-dlq.ts src/modules/messaging/infrastructure/sqs-wager-retry.ts src/modules/operations/json-logger.ts src/modules/operations/operational-metrics.ts src/modules/operations/postgres-operational-metrics.ts src/modules/operations/readiness.ts src/modules/operations/sqs-readiness.ts src/modules/wagering/application/process-pending-reference.ts src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work.ts src/modules/wallets/application/reconcile-wallet.ts test/integration/health.test.ts test/integration/operational-metrics.test.ts test/unit/health.test.ts test/unit/integration-report.test.ts test/unit/operational-metrics.test.ts test/unit/postgres-operational-metrics.test.ts test/unit/reconcile-wallet.test.ts test/unit/sqs-wager-dlq.test.ts
git diff --cached --check
git diff --cached --stat
git diff --cached
```

Somente após a revisão do staged diff, por decisão do desenvolvedor:

```bash
git commit -m "feat(operations): add operational metrics and health checks"
git push origin develop
```

Para integração real, somente no workflow isolado já existente e após confirmar
orçamento US$ 0 com Stop usage. Estes comandos não foram executados pelo agente:

```bash
gh workflow run persistence-integration.yml --ref develop -f zero_spend_confirmed=true
gh run list --workflow persistence-integration.yml --branch develop --limit 5
gh run watch --exit-status
```

O último comando permite selecionar o run. Validar o resultado efetivo e seus
logs; não deduzir sucesso apenas por ter iniciado o workflow.
