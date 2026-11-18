# Arquitetura até 7.1 (integração SQS real pendente)

Monólito modular NestJS: `WalletsModule`, `WageringModule`, `MessagingModule` e
`OperationsModule`. O caso de uso de abertura está implementado em Wallets;
`ProcessWagerTransaction` processa BET, WIN sem referência e LOSS. WIN com referência
é validada ou aceita duravelmente em PENDING_REFERENCE. REFUND e ROLLBACK usam a
mesma fronteira para reversões integrais. POST /wallets e POST /wagering/transactions
expõem esses casos de uso desde 5.8. O 7.1 acrescenta contratos e recebimento SQS
inativo no bootstrap. Inbox, consumo operacional, resolução de pendências e consultas
continuam nos próximos incrementos.
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
Os dois endpoints financeiros de escrita estão implementados; health e consultas
permanecem fora do escopo deste incremento.

MikroORM 6.6.18 e PostgreSQL possuem mapeamentos separados do domínio em
`src/database`. A prova descartável PG/SQS fica em
`experiments/compatibility-03`, exclusivamente no workflow manual de compatibilidade;
sua execução remota depende de autorização. O bootstrap de verificação permanece
sem banco ou filas. O start HTTP inicializa createPersistence explicitamente, com
configuração obrigatória, e os adapters usam em.fork() por transação. Não há
sincronização automática de schema ou execução de migrations no start.

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
as constraints correspondentes foram validadas no Marco 3, conforme confirmação
do desenvolvedor sobre a execução no Actions com PostgreSQL real.

Essa escolha segue o plano aprovado e evita dependência de uma biblioteca decimal
para soma/subtração em escala fixa. O mapeamento persiste unidades em
`NUMERIC` sem precisão/escala declaradas, com checks explícitos de faixa,
escala e não-negatividade.

## Domínio financeiro — incrementos 2.1 a 2.5

`Wallet.open` inicia em versão 1. Abertura positiva exige os IDs do lançamento
e da transação interna OPENING, fornecidos pelo caso de uso de abertura,
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
horário históricos. `matchesPayload` compara hashes fornecidos; a aplicação gera
o fingerprint canônico e resolve a identidade persistente desde o incremento 5.2.

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
e transações confiam nos dados persistidos, cuja integridade é protegida pelo schema.
Os quatro eventos mínimos têm classes concretas, versão 1, dados JSON imutáveis,
MoneyProps e datas ISO no envelope. O mapper da outbox preserva esse envelope;
os casos de abertura e processamento persistem eventos; publicação ainda não existe.

O caso de uso carrega referência e reversões sob lock da Wallet no PostgreSQL.
As unicidades estão nas migrations; locks e replay persistente já são usados pelo
processamento. O harness com três processos do Marco 6 está preparado, com execução
financeira ainda pendente no CI isolado.

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
ao banco. O desenvolvedor confirmou a aprovação das regressões do Marco 3 no
Actions com PostgreSQL real. Os Marcos 3 e 4 foram validados nesse ambiente,
conforme confirmação do desenvolvedor, assim como os 128 testes até 5.2.
Os 159 testes até 5.3 também foram validados no Actions, conforme confirmação do
desenvolvedor. Os 200 casos até 5.4 também foram validados no Actions, conforme
confirmação do desenvolvedor. Os 236 casos até 5.5 também passaram no Actions,
conforme confirmação do desenvolvedor. Os 326 casos até 5.6 também passaram no
Actions, conforme confirmação do desenvolvedor. As verificações ampliadas no 5.7
foram validadas no Actions até 5.7, conforme confirmação do desenvolvedor.
Os 331 casos até 5.8 passaram no Actions com PostgreSQL real, conforme confirmação
do desenvolvedor. Os casos de 5.9 e Marco 6 ainda aguardam essa execução.

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
Inbox/Outbox, abertura atômica, infraestrutura transacional, identidade, BET, WIN, LOSS, referências, reversões e HTTP, atomicidade e multiprocesso. Testes locais pulam as onze suítes
PostgreSQL. Não se executa Docker na VPS. O runner exige relatório JUnit com pelo
menos 347 casos reais: 55 de persistência, 32 de abertura, 9 de infraestrutura de 5.1,
32 de identidade, 31 de BET, 41 de WIN/LOSS, 36 de referência, 90 de reversões, 5 de HTTP, 6 de atomicidade e 10 multiprocesso. Cada arquivo deve atingir
seu mínimo com assertivas; hooks não contam. Skips, falhas, relatório ausente ou
indisponibilidade do banco falham o job. A contagem local de skips inclui hooks.

## Abertura atômica — incrementos 4.1 a 4.3

`OpenWallet` recebe player, MoneyProps e contexto de correlação. Reutiliza
`Money.from`, `Wallet.open`, `WagerTransaction.createOpening` e os eventos do
domínio, sem repetir cálculos financeiros. Saldo zero cria apenas a wallet;
saldo positivo cria OPENING processada, crédito no ledger e os eventos
`WagerTransactionProcessed` e `WalletBalanceChanged`, mantendo versão 1.

Como o schema exige provider, game e round também em OPENING, a aplicação usa
`internal:wallet-opening`, `wallet-opening` e `opening:<walletId>`. IDs externos e
chaves internas usam `opening:<walletId>`; o hash SHA-256 representa os campos de
negócio normalizados em ordem estável, sem horário ou metadados de transporte.
É uma convenção interna, não um novo requisito nem idempotência para apostas.

`WalletOpeningUnitOfWork` é a porta transacional. O adapter PostgreSQL abre um
fork por chamada e grava wallet, operação, ledger e outbox na mesma transação.
Cada etapa faz flush para propagar erros no ponto correspondente, mantendo as
constraints financeiras diferidas até o commit. Isso custa até quatro flushes
na abertura positiva; evita depender de gravações ou eventos fora da transação.
Não há publisher, consulta prévia de duplicidade ou lock global. A constraint
`wallets_player_currency_unique` resolve disputas concorrentes; apenas essa
violação vira `WalletAlreadyExistsError`, após rollback. Outros erros propagam.

O resultado imutável só é entregue depois do commit. Relógio e IDs podem ser
injetados para testes. Decoradores da porta exclusivamente em testes injetam
falhas após cada gravação e antes do commit, usando o adapter PostgreSQL real.
Os testes também provocam erro diferido no commit e colisão de outbox e verificam
ausência de dados parciais, retry limpo e saldo reconstruído pelo ledger.

A composição explícita é `WalletsModule.register(new
PostgresWalletOpeningUnitOfWork(orm))`, com ORM inicializado pelo chamador.
O bootstrap padrão continua sem dependências externas. Não foram adicionados
endpoints ou consumidores. O workflow manual existente mantém isolamento,
orçamento zero declarado pelo operador e os mesmos limites de recursos/tempo;
os Marcos 3 e 4 foram validados no Actions, conforme confirmação do desenvolvedor.

## Estrutura de processamento — incremento 5.1

No incremento 5.1, `ProcessWagerTransaction` apenas recusava operações. Em 5.6,
essa proteção permanece para OPENING e BET/LOSS com referência,
antes de qualquer acesso ao banco. OPENING continua exclusiva da abertura.

`WagerProcessingUnitOfWork` prepara a fronteira para os próximos incrementos:
seu callback não recebe EntityManager nem tipos do ORM. `WageringModule.register`
fornece a composição explícita, mantendo o bootstrap padrão sem banco.

O adapter PostgreSQL delega à função de infraestrutura `runPostgresTransaction`,
que abre um fork isolado e executa `transactional`. Retorno depende do commit;
erros do callback, SQL e commit propagam depois do rollback. A configuração ORM,
os mappers e as migrations existentes são reutilizados. O adapter de abertura
permanece intacto; não se extraiu sua implementação já validada.

Os testes unitários verificam indisponibilidade imediata e zero chamadas à
persistência. Separadamente, os testes PostgreSQL de infraestrutura inspecionam
o TransactionContext do MikroORM somente no código de teste e gravam fixtures
descartáveis de wallet. Comprovam escrita efetiva, invisibilidade pré-commit,
rollback, retry da fixture, propagação de erros SQL/commit e isolamento entre
callbacks concorrentes. Essas verificações não representam processamento de apostas.

Os 96 casos até 5.1 foram validados no Actions com PostgreSQL real, conforme
confirmação do desenvolvedor. Continuam exigidos pelo mesmo workflow manual,
com assertivas por arquivo e zero skips. Locks financeiros, processamento,
A entrada HTTP foi acrescentada em 5.8; SQS permanece nos próximos incrementos.

## Identidade persistente — incremento 5.2

`WagerRequestFingerprint` projeta somente providerId, externalTransactionId,
playerId, walletId, roundId, gameId, kind, money e referenceExternalTransactionId
quando presente. O nome persistido permanece `payloadHash`/`payload_hash`.
OPENING continua usando sua convenção interna anterior, sem alteração.

A representação canônica v1 usa chaves ordenadas recursivamente pela ordenação
lexicográfica de `Array.sort()`; valores string são escapados por JSON.stringify,
sem espaços entre elementos. SHA-256 recebe esse texto em UTF-8 e retorna 64
caracteres hexadecimais minúsculos. O contrato projetado tem somente strings e
objetos aninhados, sem arrays nem valores monetários numéricos. Por exemplo:

```json
{"externalTransactionId":"external","gameId":"game","kind":"BET","money":{"amount":"1.00","currency":"BRL"},"playerId":"player","providerId":"provider","roundId":"round","walletId":"wallet"}
```

Esse texto produz `d113aa12eb7035f8125c874cbbd3afc09448b8c06b460dc10ca0ff6f60f80c2d`.
Money é validado pela factory existente: exige duas casas na entrada e normaliza
zeros à esquerda (`001.00` e `1.00` têm o mesmo hash), sem arredondamento ou number.
A moeda compõe o hash. IDs mantêm caixa, espaços e Unicode, sem normalização de
valores. Referência ausente ou undefined é omitida; null e string vazia são
inválidos. IdempotencyKey, hash fornecido pelo chamador, IDs internos, horários,
headers, correlação, mensagem e outros metadados não entram na projeção.
Alterações futuras nessa representação precisam preservar a comparação com hashes
já persistidos; não há recálculo automático de hashes históricos.

`WagerTransactionIdentity` cria candidatas pela factory de domínio, resolve a
identidade dentro da sessão fornecida pelo chamador e retorna apenas os campos
técnicos kind (`identity-created`/`identity-replay`), transactionId e payloadHash.
Mesma chave, provider/ID externo e hash produzem repetição de identidade; chave
com conteúdo divergente gera PAYLOAD_MISMATCH. Provider/ID externo sob outra chave
gera EXTERNAL_ID_REUSED mesmo com hash igual. Identidades apontando para dois
registros diferentes geram CROSSED_IDENTITIES. Consultas prévias apenas antecipam
a classificação; as constraints UNIQUE continuam sendo a garantia definitiva.

A porta agora fornece `WagerProcessingTransaction`, com findIdentityCandidates e
insertPending. As duas operações capturam o mesmo manager do callback transacional
do adapter, sem expor ORM à aplicação. A sessão fecha ao encerrar o callback;
não pode ser usada após commit/rollback ou depois de falha de persistência.
Engolir uma falha de operação no callback não permite confirmar escritas anteriores.

Somente UniqueConstraintViolationException com SQLSTATE 23505 e uma das duas
constraints de identidade vira WagerIdentityCollisionError, por fora da fronteira
transacional e após rollback. `recoverAfterRollback` aceita apenas esse erro,
abre nova transação de leitura e compara o vencedor confirmado. Não reinsere.
PK, FK, outros erros SQL, erros genéricos, deadlocks e timeouts propagam sem
classificação de conflito, resultado fictício, status FAILED ou aceite pendente.
Se não encontrar vencedor, preserva o erro em vez de inventar uma decisão.

Não existe reserva com commit próprio. As fixtures PENDING de 5.2 continuam
controladas e não constituem aceite público. Em 5.3, ProcessWagerTransaction
bloqueia a wallet antes de resolver a identidade e persiste o resultado financeiro
na mesma transação. Em 5.4, WIN e LOSS usam a mesma fronteira. Replays das três
operações usam o snapshot terminal persistido. Em 5.5, WIN com referência pode
persistir PENDING_REFERENCE e retornar o snapshot de aceitação. Em 5.6, as reversões
usam a mesma fronteira; a resolução agendada permanece pendente.

Os 32 casos PostgreSQL novos usam conexões reais, barreiras e observação de espera
por lock no servidor para disputas de identidade. Cobrem leitura da própria
inserção, invisibilidade externa, rollback, recuperação em nova sessão, reinício
do cliente, identidades cruzadas, wallets distintas e lock_timeout local ao teste.
Esses testes de identidade não produzem efeitos financeiros. Seus 128 casos
acumulados foram validados no Actions conforme confirmação do desenvolvedor.
OpenWallet, domínio financeiro, migrations e infraestrutura permanecem intactos.

## Processamento de BET — incremento 5.3

O comando de BET contém os campos usados pelo fingerprint e contexto de correlação.
A entrada é normalizada antes da transação. Cada tentativa cria uma candidata nova,
bloqueia uma única wallet com PESSIMISTIC_WRITE (`FOR UPDATE`), resolve a identidade
e chama o comportamento existente de WagerTransaction, que decide débito ou rejeição.
Não há cálculo monetário na aplicação ou no adapter. Saldo insuficiente preserva
saldo, versão e ledger e grava a rejeição com INSUFFICIENT_FUNDS.

A porta fornece lockWallet, loadTransaction, saveWallet, completeTransaction,
insertLedgerEntry e insertEvents no mesmo contexto SQL de 5.2. Escritas financeiras
exigem a wallet bloqueada. saveWallet também condiciona UPDATE à versão carregada;
completeTransaction atualiza somente uma operação PENDING. Abertura e migrations
não foram alteradas. Identidade, débito, versão, resultado, ledger e eventos são
confirmados juntos. Rejeição grava resultado e WagerTransactionRejected sem atualizar
a wallet ou criar ledger. BET aprovada grava WagerTransactionProcessed e
WalletBalanceChanged. A outbox apenas persiste envelopes; não há publicação externa.

O retorno só resolve após commit. Replay de BET PROCESSED ou REJECTED devolve ID,
status, failureCode quando aplicável e saldo histórico, sem gerar movimento ou evento.
Uma candidata repetida que encontre fixture PENDING não é debitada nem apresentada
como sucesso: retorna WagerResultUnavailableError. O caso de uso não confirma PENDING.
Carteira inexistente produz WALLET_NOT_FOUND sem identidade persistida. A rejeição
de moeda usa a regra já existente do domínio e preserva a moeda do saldo observado.

Colisão de UNIQUE continua exigindo rollback antes da consulta de identidade em
nova transação. Somente a identidade compatível permite carregar o resultado.
Deadlock e falha de serialização reconhecidos pelo driver (40P01/40001) permitem
até três tentativas completas, com objetos novos e backoff com jitter. Timeouts e
falhas genéricas propagam sem falso resultado financeiro ou marcação FAILED.

Os testes unitários verificam orquestração, erros, snapshots e limite de retentativas;
seus recorders não substituem PostgreSQL. Os 31 casos novos de integração usam banco
real, lock observado no servidor e falhas após cada gravação, incluindo erro diferido
no commit e colisão real de outbox. Também cobrem disputas de saldo, duplicatas,
reinício do cliente, wallets independentes, BRL/USD, precisão e reconstrução do saldo
pelo ledger. Seus 159 casos acumulados foram validados no Actions, conforme
confirmação do desenvolvedor. O harness com três processos pertence ao
Marco 6; referências, demais operações, HTTP e SQS não foram antecipados.


## WIN e LOSS — incremento 5.4

A extensão de ProcessWagerTransaction admite WIN e LOSS sem referência no mesmo
fluxo de BET. Fingerprint, identidade persistente, lock pessimista por wallet,
recuperação após UNIQUE, retentativas e contexto SQL permanecem compartilhados.
A aplicação continua delegando todas as decisões monetárias ao domínio existente;
OpenWallet, domínio, migrations e o processamento de BET não foram modificados.
No adapter compartilhado, apenas a mensagem de erro de conclusão deixou de citar BET.

WIN positiva credita Money exato, incrementa a versão e persiste PROCESSED, um
lançamento CREDIT, WagerTransactionProcessed e WalletBalanceChanged na mesma
transação. Zero, negativo ou escala inválida são recusados antes do banco.
Excesso do limite monetário e moeda incompatível produzem REJECTED conforme o
domínio, preservando saldo, versão e ledger e gravando WagerTransactionRejected.

LOSS admite valor zero ou positivo. Persiste PROCESSED e o snapshot do saldo sob
o lock, sem chamar saveWallet ou insertLedgerEntry: saldo, versão e updatedAt
permanecem intactos. Emite somente WagerTransactionProcessed. A validação de moeda
e identidade do domínio também se aplica a LOSS; uma rejeição não altera saldo.
Nenhuma operação publica externamente; a outbox só é persistida antes do commit.

Replay de WIN/LOSS PROCESSED ou REJECTED usa o resultado histórico sem novo efeito
ou evento, inclusive depois de uma BET posterior ou reinício do cliente. Fixtures
PENDING nunca são apresentadas como sucesso. No 5.4, WIN e LOSS com referência
permaneciam indisponíveis; no 5.5 somente WIN com referência passa a ser suportada.

Os 21 casos unitários novos verificam orquestração, validações, eventos, replay e
retentativas com o domínio real. Os 41 casos PostgreSQL novos cobrem precisão acima
do limite seguro de number, BRL/USD, limite monetário, LOSS sem movimento, replay,
duplicatas e créditos distintos concorrentes, isolamento entre wallets, espera real
pelo lock, rollback após cada escrita e falhas SQL de outbox e commit diferido.
Os 200 casos até 5.4 foram validados no Actions, conforme confirmação do desenvolvedor.
O harness de múltiplos processos está descrito no Marco 6; operações posteriores
continuam pendentes dos respectivos incrementos.


## Referência ausente e aceite durável — incremento 5.5

WIN com referência usa a política de domínio e o schema existentes, sem migration.
Após bloquear a wallet e resolver a identidade, findReference consulta por
(providerId, referenceExternalTransactionId) no mesmo EntityManager transacional.
A porta expõe apenas tipos do domínio. A consulta não filtra wallet, jogador,
moeda ou rodada: divergências encontradas precisam chegar ao domínio para rejeição.
Outra operação com o mesmo ID externo em outro provedor não é a referência: a
identidade é composta e sua ausência no provedor solicitado resulta em pendência.

A ordem permanece wallet, identidade e resultado; a leitura da referência não
adquire outro lock de linha nem de wallet. Referências terminais são imutáveis.
Uma referência da própria wallet é observada depois do commit ou rollback do
escritor, que usa o mesmo lock. Leituras não enxergam gravações não confirmadas;
uma referência invisível é ausente nesse instante. Referências de outra wallet
são rejeitadas pelo domínio quando visíveis, sem bloquear uma segunda wallet.

Se a referência BET já estiver PROCESSED e tiver o contexto válido, o domínio
credita WIN e o fluxo financeiro existente confirma versão, resultado, CREDIT e
outbox juntos. Tipo, wallet, jogador, provedor, moeda e rodada seguem as regras
existentes; gameId e igualdade do valor de WIN com BET não são exigências adicionais.
Referência rejeitada/falha, autorreferência e contexto inválido geram REJECTED com
o código do domínio. Referência ausente ou ainda não processada gera PENDING_REFERENCE.

completeTransaction agora persiste a decisão inicial PENDING -> PROCESSED,
REJECTED ou PENDING_REFERENCE, mantendo o requisito de lock e o mesmo contexto SQL.
Em pendência, accepted_balance/accepted_currency recebem o saldo observado sob lock;
balance, balance_currency, completed_at e reference_transaction_id permanecem nulos.
Identidade, payloadHash, snapshot e um WagerTransactionPendingReference são
confirmados juntos. O evento usa o instante de aceitação, pois não há completedAt.
Não há escrita na wallet, mudança de versão/updatedAt, ledger ou WalletBalanceChanged.
A resposta explicita PENDING_REFERENCE; seu campo balance é o snapshot de aceitação,
não um crédito executado nem uma promessa de conclusão.

Replay consulta o resultado persistido antes de carregar qualquer referência e
retorna o mesmo ID, estado e snapshot com idempotentReplay=true. Mesmo que o saldo
mude ou a referência chegue, esse comando não retoma o processamento pendente nem
cria outro evento. Colisões UNIQUE continuam sendo tratadas somente depois do
rollback, em nova transação, preservando conflitos de payload e identidade externa.
Erros SQL, timeouts e falhas de commit propagam; nunca são convertidos em pendência.

Os 25 testes unitários novos cobrem a orquestração e recuperação de identidade.
Os 36 casos novos de PostgreSQL cobrem durabilidade, snapshot exato BRL/USD, replay
após reinício e chegada da referência, duplicatas concorrentes, validações, leitura
da própria inserção na mesma transação, invisibilidade externa, rollback integral,
falhas SQL e FK diferida no commit e espera pelo escritor da referência com commit
ou rollback. Os testes anteriores permanecem; os recorders recebem a nova operação
da porta e as antigas recusas de WIN com referência passam a verificar BET/LOSS.
Os 236 casos até 5.5 passaram no Actions, conforme confirmação do desenvolvedor.
O workflow manual preserva isolamento e controle de custo.
Não há worker, agendamento, TTL, reprocessamento automático, HTTP ou SQS; pendências
permanecem duráveis até um incremento futuro resolvê-las. Reversões são descritas no 5.6.


## REFUND e ROLLBACK — incremento 5.6

REFUND foi habilitada e testada antes de ROLLBACK. O caso de uso reutiliza o fluxo
existente e chama findProcessedReversals quando a operação exige referência e ela
está presente. A porta recebe somente o ID da referência e retorna domínio; o adapter
consulta os tipos REFUND/ROLLBACK em PROCESSED, na wallet bloqueada e no mesmo contexto
SQL. Não há segundo lock de wallet nem lock adicional de referência. A ordem continua
wallet, identidade, leitura de referência/reversões e gravações financeiras.

O domínio existente decide contexto, tipo permitido, valor integral, estado da
referência, duplicidade por tipo e saldo disponível. REFUND exige BET processada e
credita seu valor integral. ROLLBACK de BET credita; de WIN ou REFUND debita. Débito
sem saldo gera REJECTED com REVERSAL_INSUFFICIENT_FUNDS; excesso no crédito usa
AMOUNT_LIMIT_EXCEEDED. Nenhum cálculo monetário foi adicionado fora do domínio.

Saldo, versão, resultado terminal, ledger CREDIT/DEBIT e dois eventos de outbox são
confirmados juntos. Rejeições mantêm wallet/versão/ledger e gravam somente o evento
de rejeição. Referências ausentes ou ainda não processadas usam o mesmo aceite
durável PENDING_REFERENCE de 5.5: snapshot imutável, sem movimento ou evento de saldo.
Replay terminal ou pendente não consulta referências/reversões nem gera novo efeito.
O resultado aceito não promete resolução automática.

A consulta prévia permite persistir ALREADY_REVERSED para uma segunda operação com
identidade distinta. O índice existente transactions_processed_reversal_unique em
(reference_transaction_id, kind), apenas para PROCESSED, permanece a garantia SQL
final. Reversão rejeitada não consome o direito a outra tentativa válida com nova
identidade; repetir a identidade rejeitada retorna sua rejeição original. O teste
que ignora deliberadamente a consulta prévia comprova o erro UNIQUE e rollback de
todas as gravações tentadas. Essa constraint não é tratada como conflito de identidade
nem como replay; falhas SQL continuam sendo propagadas após rollback.

A política aprovada por referência e tipo permanece: REFUND e ROLLBACK da mesma BET
são permitidas, em qualquer ordem e sob concorrência, inclusive 200.00 -> BET 100.00
-> REFUND 200.00 -> ROLLBACK 300.00. ROLLBACK de REFUND remove seu crédito. Isso
preserva a política documentada e não acrescenta uma limitação por referência total.

Os 31 testes unitários novos cobrem as duas fases, replay, retentativas, insuficiência,
pendência e falhas de persistência. Os 90 casos PostgreSQL novos cobrem BRL/USD,
precisão, limites, matriz de referências, contexto, valor integral, rejeições que
não consomem reversões, duplicatas, reinício, concorrência de crédito/débito e
identidade, espera real por lock, commit/rollback de concorrentes, leitura da própria
reversão não confirmada, UNIQUE real e rollback após cada gravação. O runner exige
326 casos reais, preservando os 236 anteriores, com assertivas e zero skips.
Os 326 casos até 5.6 passaram no Actions, conforme confirmação do desenvolvedor.
Domínio financeiro, quatro migrations e OpenWallet permanecem intactos. Não há HTTP,
SQS, worker de pendências, publicação externa, commit ou push neste incremento.


## Resultado histórico e replay estável — incremento 5.7

A auditoria confirmou que o comportamento de produção já estava implementado.
Não foram alterados aplicação, adapters, domínio, migrations, runner ou workflow.
ProcessWagerTransaction.result recebe somente a transação, sem Wallet. O mapper
reidrata balance/balance_currency para estados terminais e accepted_balance/
accepted_currency para pendência; o getter balance usa o snapshot de aceitação
quando não existe resultado terminal. Status, failureCode e ID vêm da mesma
transação persistida. A função result não calcula nem consulta saldo atual.

A identidade é verificada antes de qualquer processamento de referência/reversão.
O replay carrega a transação persistida e retorna imediatamente; não reaplica
movimento, não conclui pendência e não cria eventos. A recuperação de colisão UNIQUE
após rollback também carrega esse resultado. O lock da wallet foi preservado para
manter a ordem transacional existente: ler/bloquear a wallet para coordenação não
significa usar seu saldo para reconstruir a resposta. As constraints existentes
mantêm resultados terminais e o primeiro snapshot de aceitação imutáveis.

Cobertura auditada e reforçada nos próprios casos existentes:

| Operação/estado | Evidência de histórico e reinicialização |
|---|---|
| BET PROCESSED/REJECTED | Saldo muda com outra BET; replay em nova aplicação/conexão mantém resposta original. |
| WIN/LOSS PROCESSED | Outra BET altera o saldo; nova aplicação/conexão reidrata o resultado histórico. |
| WIN/LOSS REJECTED | Rejeição já era testada após outra BET; agora também após reinicialização, preservando failureCode. |
| REFUND/ROLLBACK PROCESSED | Replay após movimentação e reinício já existia; comparação completa dos registros foi acrescentada. |
| REFUND/ROLLBACK REJECTED | Casos de ALREADY_REVERSED agora incluem movimentação posterior e reinício; ROLLBACK por insuficiência também reinicia após receber fundos. |
| WIN/REFUND/ROLLBACK PENDING_REFERENCE | Referência chega e altera saldo; replay em nova aplicação/conexão permanece pendente com o mesmo snapshot de aceitação. |

O helper de integração historical-replay recria um contexto NestJS e o adapter com
outra instância ORM e confirma um backend PostgreSQL distinto. Antes e depois do
replay, compara todos os campos e registros da wallet, transações, ledger e outbox,
incluindo payloads, versões, datas e snapshots decimais como strings. O saldo atual
deve ser diferente do histórico para evitar uma comparação que passe por coincidência.
O replay também é executado com acesso ao saldo da Wallet e operações de processamento/
escrita bloqueados por guardas de teste. Payload alterado e ID externo com chave
nova devem continuar causando conflito na aplicação reinicializada, sem gravações.

Os testes unitários existentes de BET processada/rejeitada passaram a recusar acesso
a wallet.balance durante o replay em uma nova instância do caso de uso. Isso verifica
localmente que a leitura da wallet para lock não fornece o resultado histórico.
As lacunas encontradas eram de evidência de reinicialização e comparação completa
do estado persistido; não foi necessário reescrever produção ou criar novos casos.
A contagem continua em 326 testes PostgreSQL, com os mesmos mínimos por arquivo,
assertivas obrigatórias e zero skips no runner. As assertivas de integração até 5.7 passaram no Actions, conforme confirmação
do desenvolvedor. Não houve HTTP, SQS, worker, migration,
commit, push ou disparo de workflow. Pendências continuam sem resolução automática;
reinicialização neste teste significa novo contexto da aplicação e novo cliente SQL,
não o harness de processos independentes previsto para o Marco 6.


## Entrada HTTP — incremento 5.8

HttpApiModule compõe os mesmos WalletsModule e WageringModule, recebendo suas portas
transacionais e o fechamento opcional do recurso. Controllers recebem OpenWallet e
ProcessWagerTransaction reais; não calculam dinheiro, consultam referências nem
escrevem SQL. createHttpPersistence fornece os adapters PostgreSQL existentes e
fecha o ORM no shutdown. Start/dev exige PGHOST, PGPORT, PGDATABASE, PGUSER e
PGPASSWORD explícitos, sem DSN de fallback. A aplicação escuta em 127.0.0.1:3000.
O bootstrap-only mantém seu caminho sem conexão; um teste separado inicializa a
composição HTTP com os adapters reais e connect:false, sem consultar o banco.

| Rota/resultado | HTTP e contrato |
|---|---|
| POST /wallets | playerId e initialBalance {amount,currency}; retorna id, playerId, balance e version com 201. |
| POST /wagering/transactions | Campos de negócio do README, referência opcional quando suportada e um header Idempotency-Key obrigatório. |
| PROCESSED, inclusive replay | 200 com transactionId, status, balance e idempotentReplay. |
| PENDING_REFERENCE, inclusive replay | 202 com o snapshot de aceitação persistido, sem prometer resolução automática. |
| REJECTED, inclusive replay | 422 com resultado persistido e failureCode original. |
| DTO/header inválido | 400, INVALID_REQUEST, antes de executar o caso de uso. |
| Identidade conflitante ou wallet duplicada | 409, WAGER_IDENTITY_CONFLICT com reason, ou WALLET_ALREADY_EXISTS. |
| Wallet inexistente ou pertencente a outro jogador | 422 com failureCode WALLET_NOT_FOUND/WALLET_MISMATCH; sem fabricar transação ou saldo de resultado. |
| Infraestrutura transitória | 503, SERVICE_UNAVAILABLE, sem resultado financeiro fictício. |
| Falha técnica inesperada | 500, INTERNAL_ERROR, sem SQL, stack trace ou credenciais. |

Os pipes validam objetos e propriedades obrigatórias, rejeitam arrays, null, campos
extras e tipos incorretos. amount precisa ser string decimal; não há transformação
implícita de tipos. Money.from valida moeda, escala e magnitude, e a factory já
existente valida valores positivos e referências obrigatórias, sem duplicar regras
financeiras. LOSS admite zero; OPENING é recusada na API. BET/LOSS com referência
continuam fora do contrato suportado. Excesso de saldo durante processamento continua
sendo rejeição de negócio, não erro de DTO. Body idempotencyKey, payloadHash e
correlationId não são aceitos. Idempotency-Key é um único token ASCII imprimível,
sem espaço ou vírgula; duplicação de header é inválida. Identificadores mantêm a
validação do domínio. O contexto de correlação é gerado no servidor; headers e
metadados de transporte continuam excluídos do fingerprint de negócio existente.

O filtro distingue exceções de contrato, domínio, identidade e infraestrutura.
Time-outs, conexão indisponível e retentativas esgotadas retornam 503; uma fixture
PENDING sem aceite durável também não é convertida em 202. UNIQUE genérica e outros
erros SQL não são tratados como conflito de identidade. Só os conflitos traduzidos
pelos adapters existentes produzem 409. A outbox continua sendo persistida pelo caso
de uso, sem publicação externa pelo controller.

Autenticação não foi implementada, conforme opção permitida pela seção 2 do README.
ProviderAuthenticationGuard é um guard no-op explicitamente ligado aos controllers,
sem senha própria, usuários locais ou token artesanal. O ponto de extensão é substituir
esse guard pela integração com IdP externo/OIDC, validando assinatura, emissor,
audiência, expiração e vínculo entre a identidade autenticada e providerId. A entrada
atual confia no providerId informado: este incremento não fornece controle de acesso.

Os testes HTTP locais usam roteamento, pipes, guard, filtro e serialização reais do
NestJS/Express por streams em memória, sem listener ou conexão de rede. Os casos de
uso e o domínio são reais, com portas transacionais de teste; isso não prova lock,
constraints ou atomicidade SQL. Há teste de composição real do ORM sem conexão e
configuração explícita. Os 93 casos unitários novos cobrem entrada/saída, precisão,
BRL/USD, header, OPENING, erros, replay, conflitos e shutdown; o validador de relatório
ganha quatro casos para exigir a nova suíte PostgreSQL com assertivas e zero skips.

Cinco casos HTTP com PostgreSQL real foram acrescentados ao workflow manual:
aberturas e duplicidade; BET/WIN/LOSS e replay histórico/conflitos; rejeição e DTO
inválido sem escrita; aceite pendente após chegada da referência; REFUND/ROLLBACK e
replay conforme a política por tipo. Até 5.8, o runner exigia 331 casos, preservando
os 326 anteriores. Esses casos passaram no Actions, conforme confirmação do
desenvolvedor. Não foram executados contra um banco local ou serviços da VPS. Também faltam testes HTTP com queda real do
banco/timeout produzindo 503, perda de conexão do cliente após commit e concorrência
HTTP entre processos independentes. As garantias financeiras anteriores continuam
cobertas pelas suítes PostgreSQL dos casos de uso. Não foram implementados consultas,
reconciliação, health, SQS, workers, resolução de pendências ou autenticação real.


## Sprint consolidada — 5.9 e Marco 6

A auditoria encontrou testes SQL de falha após identidade, wallet, resultado,
ledger e outbox, erros SQL e constraints diferidas no commit nas suítes de 5.3–5.6.
Eles permanecem intactos. Não foi encontrado defeito financeiro que justificasse
alterar produção, domínio, OpenWallet, identidade, schema ou migrations. A sprint
acrescenta evidências nos pontos ausentes e usa somente decorators de portas em test/.

### 5.9 — atomicidade e recuperação

Seis casos novos verificam persistência parcial da outbox e a fronteira HTTP:
BET, WIN, REFUND e ROLLBACK falham depois de inserir somente o primeiro evento
SQL, deixando o evento de saldo ausente. O adapter deve desfazer também wallet,
versão, resultado, identidade, ledger e esse primeiro evento. O teste compara todos
os registros e campos antes/depois, repete a identidade e exige uma única execução
financeira seguida de replay. Dois casos HTTP falham após o primeiro evento ou
após todo o callback, antes do commit: respondem 500 sem sucesso financeiro; o
retry normal confirma uma vez e o seguinte devolve replay. O snapshot não é apenas
uma contagem: inclui valores, payloads, versões, datas e todos os registros da wallet.
Os cenários de queda do processo antes/depois do commit são integrados ao Marco 6.

### 6.1 — processos, conexões e sincronização

BunProcessClient inicia três executáveis Bun independentes com Bun.spawn, não
worker_threads nem uma simulação de concorrência no processo do teste. Cada worker
financeiro inicializa seu próprio MikroORM e pool PostgreSQL. Ele recusa iniciar
fora de GITHUB_ACTIONS=true, PERSISTENCE_TEST_CONTAINER=1 e do host/banco/usuário
isolados já usados pelo runner. Não executa migrations nem abre listeners.

O protocolo de teste usa linhas JSON em pipes stdin/stdout. Há confirmação de
readiness, prepare, armed, run, running, checkpoints, release, resultado e stop.
O coordenador aguarda as 50 confirmações de entrada antes de liberar o gate SQL.
Os primeiros pedidos de cada processo chegam ao lock antes dos demais, evitando
depender da ordem de aquisição do pool. Os outros 47 são iniciados enquanto esses
três estão bloqueados. Assim, são 50 pedidos concorrentes distribuídos 17/17/16,
com até cinco conexões por processo, e não 50 sessões SQL ativas simultaneamente.
Com o coordenador, o limite teórico é de 20 conexões SQL, sem alterar o pool da aplicação.

Readiness informa PID do SO e pg_backend_pid. O teste exige três PIDs diferentes
do coordenador e três backends PostgreSQL distintos, conferidos no servidor por
application_name=wager-process-<PID> e pelo banco corrente. Os checkpoints de lock
consultam o backend da transação efetiva. O coordenador segura a wallet, observa os
três pedidos em wait_event_type=Lock no pg_stat_activity e só então libera o gate.
Sleeps curtos apenas repetem consultas a uma condição SQL, com deadline; não decidem
quem pode prosseguir. O CI emitirá evidências JSON de PIDs, backends e contagens.

Há limites de 10 s para startup, 5 s para armar/checkpoints, 12 s por pedido, 8 s
para uma pausa, 4 s para observar locks e 3 s para shutdown, com SIGKILL limitado
caso o filho não encerre. Os casos novos multiprocesso têm deadline de 30 s para
incluir startup e cleanup; o timeout padrão anterior dos demais casos não mudou.
Cada cenário fecha todos os filhos em finally, inclusive os substituídos. O worker
aborta suas pausas ao receber stop/EOF do pai e fecha o ORM após encerrar operações.
O pai verifica também que não restaram sessões desses workers no pg_stat_activity.
Não há pg_terminate_backend, mudança de configuração do PostgreSQL ou serviço extra.

### 6.2–6.4 — cenários financeiros reais preparados

Os dez casos multiprocesso são:

- Uma BET idêntica enviada 50 vezes: uma PROCESSED não replay, 49 replays, um débito,
  uma identidade, versão 2 e um único conjunto de eventos. Depois de outra movimentação,
  substituir um processo deve preservar o resultado histórico em nova conexão.
- Payload divergente e ID externo com outra chave: dois processos esperam pelo
  vencedor e retornam os conflitos previstos, sem segundo efeito.
- Identidade global disputada entre wallets: a segunda operação bloqueia sua wallet
  e espera a UNIQUE ainda não confirmada da primeira; depois do rollback do conflito,
  um terceiro processo deve conseguir movimentar a segunda wallet. Isso exercita
  recuperação após UNIQUE real, não somente consultas antecipadas.
- Duas BETs de 80.00 contra 100.00: uma processada, uma INSUFFICIENT_FUNDS, saldo
  20.00 e exatamente um débito, sem lost update.
- Uma wallet livre progride no terceiro processo enquanto uma segunda instância
  espera a wallet retida pelo primeiro; a liberação não ocorre antes dessa conclusão.
- Três REFUNDs concorrentes: uma processada e duas ALREADY_REVERSED.
- Três ROLLBACKs de WIN concorrentes com saldo para apenas um débito: um processado
  e dois ALREADY_REVERSED, mantendo a validação de duplicidade antes da insuficiência.
- REFUND e ROLLBACK da mesma BET, mais uma REFUND concorrente: dois efeitos permitidos
  por tipo, uma REFUND rejeitada e saldo/ledger consistentes. A política econômica
  documentada foi preservada integralmente.
- Morte do worker com todas as gravações ainda não confirmadas: o observador externo
  não vê estado parcial; dois outros processos repetem a identidade e confirmam um
  único efeito. O ID do candidato morto não pode aparecer no banco.
- Morte após commit e antes da resposta IPC: retries de outros processos encontram
  somente replay, sem novo débito. Um novo processo substitui o morto e repete o replay.

Todos conferem saldo exato reconstruído pelo ledger, versões, direção/valor dos
lançamentos, resultados persistidos e eventos correspondentes na outbox. O harness
usa os casos de uso e adapters reais; nenhum resultado financeiro é simulado.

### Validação, custo e limites

Seis testes locais verificam exclusivamente IPC: três processos Bun reais, 50
mensagens, prepare/run e pause/release, encerramento prematuro, timeout, falha parcial
de startup e recusa do worker financeiro fora do ambiente permitido. A fixture de
IPC não importa persistência nem executa dinheiro; seus resultados têm kind=probe,
que a suíte financeira rejeita. Esses testes não demonstram concorrência PostgreSQL.
O sandbox local bloqueou escrita em pipes com EPERM; apenas testes locais sem banco
foram executados fora dele pela autorização da ferramenta. Nenhuma permissão da VPS
ou do Actions foi alterada.

O runner exige agora 347 casos PostgreSQL com assertivas, zero falhas e zero skips:
os 331 anteriores, seis de atomicidade e dez multiprocesso. O validador testa mínimos
por arquivo e rejeita relatório antigo, suíte ausente, caso sem nome ou sem assertivas.
Workflow e Compose preservam gatilho manual, declaração de orçamento zero, permissões,
limites de tempo, imagens e isolamento. Docker/Compose, PostgreSQL real, Actions,
commit e push não foram executados nesta sprint.

Os marcos 5.9, 6.1, 6.2, 6.3 e 6.4 estão implementados/preparados, mas não validados
financeiramente até o CI isolado executar esses casos. Permanecem riscos de timing,
limites do ambiente e comportamento do driver que só essa execução pode confirmar.
São três processos no mesmo container/servidor de teste; não demonstram partição de
rede entre hosts, failover do PostgreSQL ou queda de toda a máquina. A falha após
commit perde uma resposta IPC, não um ack SQS nem uma conexão HTTP real. Não há
SQS, worker de pendências, publisher, autenticação nova ou mudança da política financeira.


## 7.1 — Contratos e adapter SQS (inativo no bootstrap)

Conforme confirmação do desenvolvedor, 5.9 e Marco 6 passaram no CI com 347 casos
PostgreSQL e zero falhas. Os limites históricos acima registram o estado anterior.
O 7.1 acrescenta somente entrada explícita, ainda sem consumidor operacional.

`WagerTransactionRequested` segue o envelope da seção 10 do README: messageId,
type, occurredAt e data. A validação recusa campos extras, tipos incorretos,
OPENING, identificadores vazios, valores numéricos e datas UTC inválidas (segundos
ou milissegundos). Money e a factory existente de identidade/transação validam
moeda, precisão, limite, positividade e referência obrigatória; nada é calculado
com number. IDs seguem o contrato de identificador não vazio já adotado no domínio.
O handler projeta somente data no comando; messageId vira correlationId/causationId.
O timestamp de transporte não substitui o relógio do caso de uso. Esses metadados
não participam do fingerprint. O ID do envelope é distinto do MessageId do SQS.

`SqsWagerReceiver.receiveOnce()` faz uma única recepção, com endpoint, região,
QueueUrl FIFO, visibilidade (0–43200 s) e espera (0–20 s) explícitos. Solicita um
item e MessageGroupId; preserva grupo e receiptHandle separados do envelope.
Não exige que o grupo seja igual à wallet: isso não consta do contrato original;
a serialização financeira permanece garantida pelo PostgreSQL. O grupo deve ser
um token ASCII imprimível de até 128 caracteres. O recebimento não executa dinheiro.
`SqsWagerCommandHandler.execute()` valida e encaminha ao mesmo ProcessWagerTransaction,
retornando seu resultado ou propagando sua falha sem inventar resultado financeiro.

A dependência AWS SDK SQS v3 usa a versão 3.1170.0 já fixada na prova de
compatibilidade. A factory de cliente recebe endpoint/região explícitos, credenciais
opcionais (cadeia AWS quando omitidas), maxAttempts=1 e useQueueUrlAsEndpoint=false:
o destino de rede é o endpoint configurado, não uma substituição pela QueueUrl.
Não são necessárias credenciais reais para os testes; o cliente simulado recebe
[ReceiveMessageCommand](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sqs/command/ReceiveMessageCommand/).

`MessagingModule.register` recebe explicitamente a instância já composta de
ProcessWagerTransaction e o cliente/configuração. Não presume acesso aos providers
dinâmicos do HttpApiModule e não cria outra persistência nem outro caso de uso.
O bootstrap atual mantém MessagingModule vazio, sem hooks, timers ou polling.
O adapter e o handler ficam disponíveis apenas mediante composição e chamadas
explícitas; não há consumidor financeiro ativado, exclusão de mensagens ou ack.

Os testes unitários usam cliente SQS simulado, validam contratos, configuração,
recebimento, projeção, erros e DI Nest. Uma prova com portas em memória reutiliza a
instância do HTTP e verifica replay entre entradas; não comprova inbox, transporte
SQS ou concorrência SQL. A integração real/emulada, incluindo entrega FIFO e
visibilidade, permanece pendente e não foi executada na VPS.

O 7.2 deverá colocar inbox por (consumerName, messageId) na mesma transação SQL
do processamento e adicionar ack apenas depois do commit, cobrindo redelivery e
entrada HTTP/SQS com PostgreSQL e SQS emulados reais no CI isolado. Retry/DLQ e
shutdown permanecem para 7.3–7.4. Nenhuma migration ou regra financeira mudou.
