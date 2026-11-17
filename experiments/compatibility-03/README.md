# Experimento diagnóstico — incrementos 0.3 e 0.4

Prova de compatibilidade isolada do projeto financeiro. Não contém endpoints,
wallets, ledger, migrations definitivas ou processamento financeiro.

## Versões fixadas

| Componente | Versão |
| --- | --- |
| Bun | 1.4.4 |
| TypeScript | 5.9.3 |
| NestJS common/core | 11.2.10 |
| MikroORM core/postgresql | 6.6.18 |
| Driver pg | 8.20.0, também exigido pelo adapter MikroORM |
| AWS SDK client-sqs | 3.1170.0 |
| MiniStack | 1.5.39, digest reaproveitado do smoke existente |
| PostgreSQL | 17.12-bookworm |

O `bun.lock` fixa as dependências transitivas e suas integridades.
A imagem do MiniStack também tem digest fixado; Bun e PostgreSQL usam tags fixadas
sem digest.
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

O workflow manual **Compatibility 0.3 and 0.4** constrói o cliente e executa PostgreSQL,
MiniStack e diagnóstico em containers separados, na rede interna do mesmo Compose.
O cliente está fora dos containers dos serviços, em um terceiro container: acessa
PostgreSQL por TCP e MiniStack por HTTP, sem executar probes dentro desses serviços.
Antes da integração, o runner instala a aplicação principal com lockfile congelado
e scripts de dependências desativados, executando `bun run check`, inclusive os
testes de Money. Aplicação e experimento têm manifests, lockfiles e builds separados.
Não executar Docker na VPS. O código exige `GITHUB_ACTIONS=true` e a marca do
container antes de inicializar o ORM. Esses checks evitam enganos operacionais;
não são uma fronteira de segurança contra execução deliberada.

O job requer a confirmação de orçamento do Actions em US$ 0,00 com **Stop usage**
ativado, como no smoke do MiniStack. O checkbox é declaração do operador,
não consulta de cobrança. Não há AWS real, uploads de artefatos ou caches de CI.
Downloads públicos de imagens/pacotes ocorrem na preparação; os containers
em execução usam somente a rede interna, sem portas publicadas.

Cada execução usa nome de projeto único, senha aleatória mascarada e banco
descartável em tmpfs. PostgreSQL e cliente usam usuários sem root; MiniStack mantém
o usuário padrão da imagem. Todos removem capabilities e não montam o socket Docker.
Limites: job 15 minutos, setup Bun 60s, instalação da aplicação 60s, checks da
aplicação 120s, build do experimento 240s, inicialização
180s (incluindo download do MiniStack), diagnóstico 70s (deadline interno de 45s),
limpeza 30s.
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
6. Do cliente Bun/TypeScript, verificar health do MiniStack e criar fila FIFO com
   nome aleatório. Conferir atributos, ARN, corpo exato e checksum de envio/leitura,
   grupo, deduplicação e sequência; excluir pelo receipt handle e conferir ausência
   após expirar a visibilidade. Excluir a fila no `finally`.

O cliente SQS usa endpoint fixo `http://ministack:4566`, credenciais fictícias e
timeouts; não consulta credenciais do ambiente. URLs retornadas são validadas e
normalizadas para o hostname da rede Compose, conforme a
[orientação do SDK sobre endpoints SQS](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-service-client-notes.html).
`MINISTACK_HOST` configura o hostname anunciado, conforme a
[configuração do MiniStack](https://ministack.org/docs/configuration).

O mapeamento decimal é diagnóstico; não substitui Money ou suas validações.
DDL de fixture não substitui as migrations versionadas dos próximos marcos.
O sucesso local do bootstrap não comprova integração PostgreSQL, Compose,
commit, rollback ou round-trip. Esses critérios dependem da execução real
do workflow, que deve ser autorizada separadamente. A integração SQS também
permanece não executada até essa autorização. Os três workflows
anteriores permanecem independentes e inalterados.
