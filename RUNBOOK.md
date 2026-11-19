# Execução e validação — Jungle Gaming

O README.md original permanece a fonte dos requisitos. Estado e pendências reais:
[FINAL_REVIEW.md](FINAL_REVIEW.md). Não há deploy ou stack operacional completa
automatizados. Estes comandos não substituem provisionamento/autorização do ambiente.

## Pré-requisitos e build

Bun 1.4.4, dependências do lockfile, PostgreSQL com as migrations existentes já
aplicadas e MiniStack/LocalStack acessível. Não se assume Docker local disponível.

```bash
bun --version
bun install --frozen-lockfile --ignore-scripts
bun run --bun typecheck
bun run --bun build
bun run bootstrap
```

Instalação é tarefa manual quando as dependências não estiverem presentes; não foi
executada nesta finalização. Não utilizar sincronização automática de schema.
O runner de integração aplica migrations versionadas em banco descartável.
Não existe neste projeto CLI de provisionamento/migration de produção.

## HTTP

Forneça PGHOST, PGPORT, PGDATABASE, PGUSER e PGPASSWORD por meio seguro. Não inclua
credenciais no Git. Para readiness SQS, também configure SQS_ENDPOINT,
AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY e, se necessário, AWS_SESSION_TOKEN;
AWS_REGION tem default us-east-1. Para emulador local use somente credenciais de
teste do próprio emulador. Não há endpoint AWS implícito nem acesso IMDS.

```bash
bun run start
```

O processo escuta 127.0.0.1:3000. Sem PostgreSQL na inicialização, o bootstrap falha;
health só existe após HTTP inicializar. Perda posterior de conexão resulta em 503.

```bash
curl -i http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
```

Readiness exige PG e SQS confirmados; ausência de configuração SQS dá 503.
Probes são SELECT 1 e ListQueues; credenciais precisam permitir esta leitura SQS.
Os endpoints de health não exigem autenticação e não executam movimentações.

Endpoints financeiros implementados: POST /wallets, POST /wagering/transactions,
GET /wallets/:walletId/ledger e POST /wallets/:walletId/reconciliation. Ledger e
reconciliação mantêm bloqueio padrão 403 até integração confiável de autorização
por carteira. Não alterar o guard para true como forma de demonstração. O guard de
provedor é apenas extensão, não autenticação implementada. Consultas GET wallet,
transação por ID e por provedor ainda estão pendentes.

## Workers e métricas internas

```bash
bun scripts/run-pending-references.ts
bun scripts/run-pending-references-loop.ts
bun scripts/read-operational-metrics.ts
```

Os dois primeiros usam as variáveis PG e resolvem referências pendentes; o periódico
trata SIGTERM concluindo o lote. Não são consumidores SQS. Não existe comando
operacional de consumer SQS ou publisher contínuo: há adapters e coordinator/factory
testados, cuja composição contínua e shutdown SQS permanecem pendentes.

O CLI de métricas faz somente leitura do banco; não consulta a memória do HTTP ou
dos workers. Contadores efêmeros são acessíveis dentro da instância por
`operationalMetrics.snapshot()`, com instanceId/startedAt. Reinícios perdem esses
contadores. O snapshot também contém contagem/soma/máximo da latência de execução
HTTP/SQS, incluindo falhas/replays e locks/retries internos, excluindo ACK/transporte.
Logs são JSON sanitizado best effort, sem garantia de entrega.

## Testes reproduzíveis

```bash
bun run --bun typecheck
bun run --bun build
bun run --bun test:unit
git diff --check
```

As integrações usam PostgreSQL e MiniStack reais no workflow
`.github/workflows/persistence-integration.yml`, com validação de relatório que
rejeita skips/falhas/casos obrigatórios ausentes. O ambiente Compose é
`infra/persistence/compose.yaml`, isolado para Actions. Não simular variáveis de
Actions para contornar seus guards nem apontar testes para produção.

Após revisão, commit/push manuais e confirmação de orçamento US$ 0 com Stop usage,
o operador pode iniciar a validação existente (não executada pelo agente):

```bash
gh workflow run persistence-integration.yml --ref develop -f zero_spend_confirmed=true
gh run list --workflow persistence-integration.yml --branch develop --limit 5
```

Somente confirmar CI verde após observar a conclusão desse run. No sandbox atual,
o socket Docker nega acesso e o harness IPC pode falhar com EPERM ao escrever no
pipe dos subprocessos; essas falhas devem ser relatadas, não ocultadas por skips.
