# Arquitetura implementada até o Marco 3 (integração PostgreSQL pendente)

Monólito modular NestJS: `WalletsModule`, `WageringModule`, `MessagingModule` e
`OperationsModule`. Neste estágio os módulos delimitam responsabilidades; ainda
não implementam casos de uso ou integrações da aplicação definitiva.
As camadas serão adicionadas conforme seus casos de uso, preservando o domínio
em TypeScript puro, sem decorators ou dependências de NestJS/ORM.

O build usa TypeScript strict com emissão de metadados; Bun 1.4.4 executa o JS.
Os tipos `@types/bun` 1.4.4 exigiram atualizar `@types/node` de 24.19.2 para
26.2.0 na aplicação: a combinação anterior falhou em `util` e `tls`. A versão
segue o [manifesto do Bun](https://github.com/oven-sh/bun/blob/bun-v1.4.4/package.json);
`skipLibCheck` continua desabilitado. O experimento 0.3 mantém seus tipos originais.
Desenvolvimento e testes também usam emissão por `tsc`, pois o experimento 0.3
validou esse caminho de injeção por tipo. `bun run check` verifica tipos, build,
bootstrap sem portas/serviços externos e testes locais; `bun run dev` compila
e acompanha alterações, iniciando HTTP apenas em `127.0.0.1:3000`.
Não há endpoints financeiros ou health implementados neste incremento.

MikroORM 6.6.18 e PostgreSQL possuem mapeamentos separados do domínio em
`src/database`. A prova descartável PG/SQS fica em
`experiments/compatibility-03`, exclusivamente no workflow manual de compatibilidade;
sua execução remota depende de autorização. A aplicação base ainda não se conecta
a banco ou filas; `createPersistence` inicializa explicitamente o ORM e cada
requisição/trabalho deverá usar `em.fork()`. Não há sincronização automática de schema.

`Money` é imutável (campos privados e instância congelada), com centavos em
`bigint` e limite simétrico de magnitude `92233720368547758.07`. Os contratos
aceitam somente strings não negativas com exatamente duas casas decimais;
zeros à esquerda são normalizados. A serialização JSON retorna `{ amount,
currency }`, sem expor `bigint`. `toString()` retorna apenas o decimal com duas
casas. BRL e USD são o conjunto explícito inicial de códigos ISO-4217 suportados.
Todas as operações binárias, inclusive comparação e igualdade, rejeitam moedas
diferentes com erro de domínio. Subtração e negação podem produzir resultados
internos negativos; esses resultados continuam sujeitos ao limite e não são
aceitos pela factory de entrada externa. A Wallet protege o saldo não negativo;
as constraints correspondentes foram escritas no Marco 3 e aguardam integração real.

Essa escolha segue o plano aprovado e evita dependência de uma biblioteca decimal
para soma/subtração em escala fixa. O mapeamento persiste unidades em
`NUMERIC` sem precisão/escala declaradas, com checks explícitos de faixa,
escala e não-negatividade.

## Domínio financeiro — incrementos 2.1 a 2.5

`Wallet.open` inicia em versão 1. Abertura positiva exige os IDs do lançamento
e da transação interna OPENING, fornecidos pelo futuro caso de uso de abertura,
e produz um crédito de zero ao saldo inicial sem incrementar a versão.
Abertura zero não gera lançamento. `debit`/`credit` constroem e validam o
lançamento antes de alterar saldo, versão e data. Zero e negativos são
recusados nesses métodos: ausência de movimento não deve virar ledger.
`pendingLedgerEntries` expõe uma cópia congelada dos lançamentos novos da
instância e recusa reutilizar suas identidades. Não representa histórico
carregado nem garantia de deduplicação persistente.

`WagerTransaction.process` contém apenas comportamento de domínio: aplica
BET/WIN/LOSS/reversões à Wallet, registra snapshots e transiciona ou rejeita.
Não abre transações SQL nem publica eventos. OPENING tem factory interna
separada e sua conclusão acompanha a abertura, evitando um segundo crédito.
Valores externos são positivos, exceto LOSS, que admite zero e nunca gera
ledger, alteração de versão ou `WalletBalanceChanged`.

Transições permitidas: `PENDING` e `PENDING_REFERENCE` podem concluir como
`PROCESSED`, `REJECTED` ou `FAILED`. Havendo referência externa, podem aguardar
em `PENDING_REFERENCE`; novas tentativas mantêm o primeiro snapshot pendente.
Os três estados terminais bloqueiam qualquer transição e preservam saldo e
horário históricos. `matchesPayload` compara hashes fornecidos; a geração do
hash canônico e a idempotência persistente pertencem aos próximos marcos.

`ReferencePolicy` valida identidade por provider/ID externo, player, wallet,
moeda e rodada. WIN com referência exige BET; REFUND exige BET; ROLLBACK aceita
BET, WIN ou REFUND e inverte a direção. Reversões exigem valor integral.
Referências ausentes ou ainda pendentes aguardam; rejeitadas/falhas rejeitam
a dependente. Não há restrição adicional de gameId.

Conforme o plano aprovado, a unicidade da reversão é por referência **e tipo**:
REFUND e ROLLBACK da mesma BET são permitidos, inclusive elevando o saldo de
200.00 para 300.00 após uma BET de 100.00. Essa política preserva a consistência
saldo/ledger, mas permite dois créditos econômicos sobre a mesma aposta.
Reversões rejeitadas não consomem a possibilidade de uma reversão posterior.

`FailureCode` define a taxonomia em `wager-transaction.types.ts`: insuficiência
de BET (`INSUFFICIENT_FUNDS`) e de reversão (`REVERSAL_INSUFFICIENT_FUNDS`) são
distintas. Há códigos específicos para moeda, limite, contexto/tipo/valor da
referência, referência rejeitada/falha/inexistente, autorreferência e reversão
já aplicada. Falha permanente possui `PERMANENT_INFRASTRUCTURE_FAILURE`.
O agendamento e o TTL das referências ainda não estão implementados.

Ledger e eventos são congelados; datas são copiadas defensivamente. As factories
`rehydrate` recuperam snapshots sem repetir transições, criar lançamentos ou
resetar versões. A Wallet verifica invariantes estruturais do snapshot; ledger
e transações confiam nos dados persistidos, cuja integridade exigirá o schema.
Os quatro eventos mínimos têm classes concretas, versão 1, dados JSON imutáveis,
MoneyProps e datas ISO no envelope. O mapper da outbox preserva esse envelope;
casos de uso e publicação posterior ao commit ainda não existem.

O chamador deverá carregar referência e reversões sob lock da Wallet no
PostgreSQL. As unicidades estão escritas nas migrations; locks dos casos de uso,
replay entre instâncias e testes com três processos pertencem aos próximos marcos.

## Persistência — incrementos 3.1 a 3.5

`MoneyAmountType` mantém o valor como string nas duas direções e declara `numeric`
sem modificador. Moeda fica em coluna separada; os mappers reconstroem `Money`
pelas factories existentes. Registros ORM carregam somente estado. O resultado
histórico tem moeda própria para preservar rejeições por moeda incompatível.
`version` é explícita, sem incremento automático do ORM.

`MoneyAmountType` preserva `null` nas duas direções para snapshots monetários
opcionais; valores presentes continuam sujeitos à validação decimal estrita.
Os relacionamentos escalares declaram `wallet_id` e `transaction_id` explicitamente
para corresponder às migrations, preservando `mapToPk` e as dependências da Unit
of Work. Testes locais verificam metadados, SQL gerado e snapshots sem conectar
ao banco; regressões de persistência, hidratação e atualização no PostgreSQL
continuam pendentes de execução no ambiente isolado.

Quatro migrations reversíveis criam Wallet/transações, ledger, correspondência
financeira e Inbox/Outbox. CHECKs impedem escala excedente, valores especiais,
negativos, excesso de faixa e aritmética inválida. FKs compostas preservam
identidades, moedas e contexto das referências. O índice de reversões processadas
mantém unicidade por referência e tipo; rejeições não consomem essa identidade.

As constraints diferidas verificam cada transição capturada da wallet, cada novo
lançamento e o estado final da transação. Consultam apenas índices por identidade
e versão, incluindo predecessor/sucessor; não somam todo o histórico. Abertura
positiva usa versão 1; abertura zero não tem ledger e a primeira movimentação usa
versão 2. LOSS e estados sem efeito financeiro não admitem lançamentos. A verificação
de ledger bloqueia sua wallet também para escritores SQL diretos. As funções fixam
o search_path para evitar tabelas temporárias ocultando tabelas financeiras.

Triggers recusam UPDATE/DELETE/TRUNCATE do ledger. `runtimePrivilegesSql` fornece
os grants para uma role separada, sem propriedade das tabelas, DDL ou alteração
de lançamentos. Criação de role/credenciais não ocorre na aplicação ou migrations.
Um proprietário/superusuário pode desativar proteções; a aplicação não deverá usar
essas credenciais. O teste de integração verifica os privilégios efetivos da role.

Inbox possui chave composta mensagem/consumidor e hash estável. Outbox mantém
envelope, tentativas, agenda, publicação, lease e token, com índices parciais.
Transações têm campos de agenda para referências futuras. Nenhum worker ou
publicador foi implementado neste marco.

Há um patch versionado de uma linha nas declarações do MikroORM 6.6.18 para
compatibilidade com `exactOptionalPropertyTypes`; não altera o runtime. `strict`,
`exactOptionalPropertyTypes` e a checagem de bibliotecas permanecem ativos.

`persistence-integration.yml` é exclusivamente manual e reutiliza o PostgreSQL
17.12 aprovado, em tmpfs/rede interna sem portas publicadas. Seu runner recusa
outros hosts, bancos e ambientes. A suíte cobre migrations up/down/up, SQL inválido,
precisão, concorrência de escritores, privilégios e rollback financeiro com
Inbox/Outbox. A execução em PostgreSQL real está pendente de autorização no Actions;
testes locais pulam explicitamente essa suíte. Não se executa Docker na VPS.
O runner de integração exige relatório JUnit com pelo menos 55 testes reais,
assertivas e zero skips/falhas; relatório ausente ou indisponibilidade do banco
falha o job. A contagem local de skips inclui também hooks, excluídos dos 55 casos.
