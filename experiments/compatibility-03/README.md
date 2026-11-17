# Experimento diagnóstico — incremento 0.3

Prova de compatibilidade isolada do projeto financeiro. Não contém endpoints,
wallets, ledger, migrations definitivas ou integração SQS (incremento 0.4).

## Versões fixadas

| Componente | Versão |
| --- | --- |
| Bun | 1.4.4 |
| TypeScript | 5.9.3 |
| NestJS common/core | 11.2.10 |
| MikroORM core/postgresql | 6.6.18 |
| Driver pg | 8.20.0, também exigido pelo adapter MikroORM |
| PostgreSQL | 17.12-bookworm |

O `bun.lock` fixa as dependências transitivas e suas integridades.
As imagens têm tags fixadas; seus digests não estão fixados.
Scripts de instalação de dependências ficam desabilitados.

## Validação local sem Docker

Requer Bun 1.4.4. Dentro desta pasta, com instalação previamente autorizada:

```bash
mkdir -p .tmp
TMPDIR="$PWD/.tmp" BUN_INSTALL_CACHE_DIR="$PWD/.bun-cache" bun install --frozen-lockfile --ignore-scripts
bun run --bun typecheck
bun run --bun build
bun run bootstrap
```

O typecheck executa `tsc --noEmit` com strict e sem ignorar tipos de bibliotecas.
O build usa `tsc` para emitir JavaScript e `design:paramtypes`/`design:type`.
Esse JavaScript executa com Bun: não se está validando a emissão de metadados
pelo transpiler nativo do Bun. O contexto Nest real não abre servidor HTTP.
O bootstrap verifica injeção por tipo, sem `@Inject`, e metadados da entidade.
Também inicializa o MikroORM com `connect: false` para verificar a descoberta
da entidade e o mapeamento string/NUMERIC, sem acessar banco ou serviço externo.
O nome `compatibility-03` evita que a resolução de módulos do MikroORM 6
interprete o diretório de trabalho como arquivo por conter uma extensão.

## Integração exclusivamente no GitHub Actions

O workflow manual **Compatibility 0.3** constrói o cliente e executa PostgreSQL
e diagnóstico em containers separados, na rede interna do projeto Compose.
Não executar Docker na VPS. O código exige `GITHUB_ACTIONS=true` e a marca do
container antes de inicializar o ORM. Esses checks evitam enganos operacionais;
não são uma fronteira de segurança contra execução deliberada.

O job requer a confirmação de orçamento do Actions em US$ 0,00 com **Stop usage**
ativado, como no smoke do MiniStack. O checkbox é declaração do operador,
não consulta de cobrança. Não há AWS real, uploads de artefatos ou caches de CI.
Downloads públicos de imagens/pacotes ocorrem na preparação; os containers
em execução usam somente a rede interna, sem portas publicadas.

Cada execução usa nome de projeto único, senha aleatória mascarada e banco
descartável em tmpfs. Os processos usam usuários sem root, removem capabilities
e não montam o socket Docker. Limites: job 10 minutos, build 240s, inicialização
90s, diagnóstico 70s (deadline interno de 45s), limpeza 30s.
A limpeza roda com `always()`; cancelamento abrupto do runner pode impedi-la,
e o runner hospedado continua descartável.

Critérios executados pelo diagnóstico:

1. Conexão ORM autenticada a `postgres:5432` e `SELECT 1`.
2. Criação somente da fixture `compatibility_probe`, com `NUMERIC` sem escala
   declarada, verificada por `information_schema`.
3. Commit de `0.00`, `0.01`, `9007199254740993.01` e `92233720368547758.07`.
4. Leitura por novo EntityManager e pelo driver: tipo string e igualdade exata,
   sem conversão monetária para `number`.
5. INSERT e flush dentro de transação, erro proposital, rollback e confirmação
   por novo EntityManager de que a linha não existe e os commits permanecem.

O mapeamento decimal é diagnóstico; não substitui Money ou suas validações.
DDL de fixture não substitui as migrations versionadas dos próximos marcos.
O sucesso local do bootstrap não comprova integração PostgreSQL, Compose,
commit, rollback ou round-trip. Esses critérios dependem da execução real
do workflow, que deve ser autorizada separadamente. Os três workflows
anteriores permanecem independentes e inalterados.
