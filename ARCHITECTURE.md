# Arquitetura até 7.2 (validação PostgreSQL/SQS do incremento pendente)

Monólito modular NestJS: `WalletsModule`, `WageringModule`, `MessagingModule` e
`OperationsModule`. O caso de uso de abertura está implementado em Wallets;
`ProcessWagerTransaction` processa BET, WIN sem referência e LOSS. WIN com referência
é validada ou aceita duravelmente em PENDING_REFERENCE. REFUND e ROLLBACK usam a
mesma fronteira para reversões integrais. POST /wallets e POST /wagering/transactions
expõem esses casos de uso desde 5.8. O 7.2 acrescenta inbox atômica e ACK explícito após commit, mantendo SQS
inativo no bootstrap. Consumo operacional, resolução de pendências e consultas
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


## 7.2 — Inbox atômica e ACK após commit

A chave é (envelope.messageId, consumerName='wager-transactions'), na tabela
inbox_messages existente. O ID lógico sobrevive à republicação, que recebe outro
MessageId do SQS; o receipt handle pertence apenas à entrega atual. Ambos os campos
de transporte, além do grupo FIFO, ficam fora da identidade/hash da inbox.

O SHA-256 da mensagem usa uma projeção canônica versionada (version='1'), com
business (JSON já ordenado pelo WagerRequestFingerprint), idempotencyKey,
occurredAt normalizado via ISO UTC e type. Todos os campos validados do conteúdo
são cobertos; messageId integra a chave. Money é normalizado pelo domínio, sem
number. Ordem de chaves e zeros à esquerda não mudam o hash; uma mudança no timestamp,
na chave financeira ou nos campos de negócio é uma colisão do mesmo ID lógico.
Esse hash de mensagem é separado do fingerprint financeiro, que continua excluindo
metadados e mantém o contrato HTTP anterior.

ProcessWagerTransaction.execute aceita uma identidade de inbox opcional, sem SDK
ou ORM na aplicação. A porta transacional oferece inbox.claim/complete no mesmo
scope financeiro. O adapter PostgreSQL implementa esse recurso; adapters somente
HTTP podem omiti-lo, mas uma execução com mensagem falha antes da wallet se o
recurso não existir. Não há wrapper com segunda transação externa ou commit de
reserva de identidade. O pipeline financeiro foi extraído em um método privado,
preservando as operações e a ordem de gravações já validadas.

Ordem por tentativa: BEGIN → INSERT inbox ON CONFLICT DO NOTHING → SELECT inbox
FOR UPDATE → verificar hash → lock da wallet → identidade/operação financeira →
wallet/resultado/ledger/outbox → inbox.processed_at → COMMIT → resolver execute →
DeleteMessageCommand com o receipt handle recebido. O INSERT aguarda o vencedor
concorrente sem deixar a transação abortada. Conteúdo divergente lança
WAGER_INBOX_CONFLICT e reverte a tentativa inteira. A constraint composta existente
continua sendo a garantia definitiva; consultas prévias não decidem exclusividade.
O adapter recusa commit de uma reserva sem conclusão e não permite reivindicar
outra mensagem nem adquirir inbox após o lock de wallet.

Inbox concluída exige replay financeiro histórico, sem nova movimentação. Ela
não substitui o resultado financeiro (não existe snapshot/result ID na tabela);
a identidade de negócio imutável permite reconstruí-lo dos dados da transação.
Se esses dados estiverem ausentes, a execução falha e reverte, sem autorizar uma
nova operação. Uma linha antiga não concluída, com hash compatível, pode ser
retomada sob lock e concluída atomicamente. processed_at existente não é reescrito.

Uma colisão UNIQUE financeira continua sendo tratada somente após rollback.
A inbox da tentativa perdedora também reverte; a recuperação consulta o vencedor
em nova transação e, se for replay, outra tentativa reserva inbox, trava wallet,
carrega o resultado e conclui inbox no mesmo commit. Falhas genéricas de banco
não são reinterpretadas como conflito ou aceitação.

PROCESSED, REJECTED e PENDING_REFERENCE representam consumo durável e recebem
ACK. processed_at significa mensagem consumida, não resolução financeira terminal;
um replay pendente preserva o snapshot mesmo após a referência chegar. Rejeição
financeira não é falha técnica. Erro antes/durante commit não envia DeleteMessage.
Falha de ACK depois de commit propaga; redelivery encontra inbox/identidade
persistidas e não repete efeitos. Um erro ambíguo na conexão durante COMMIT também
não recebe ACK; a entrega seguinte verifica o estado durável.

SqsWagerDelivery trata uma entrega explícita e aguarda o handler antes de excluir.
MessagingModule fornece esse componente apenas quando registrado explicitamente;
bootstrap não inicia polling, consumer ou retry. O cliente SDK mantém maxAttempts=1.
Backoff, DLQ e shutdown operacional continuam para 7.3–7.4.

Os testes unitários com portas em memória verificam a orquestração e não provam
atomicidade SQL. A suíte sqs-inbox acrescenta 17 casos reais: entrega/ACK, reinício,
colisões, identidades independentes, HTTP→SQS, rejeição e pendência históricas,
concorrência com locks observados (inclusive vencedor revertido), falhas pré-commit, erro diferido de commit,
falha de ACK e colisão UNIQUE financeira. As filas usam o MiniStack já aprovado,
sem portas publicadas, no mesmo Compose interno do PostgreSQL descartável.
O runner manual exige 364 casos (347 anteriores + 17 novos), assertivas por caso,
zero skips/falhas e recusa ambiente/endpoint externo. Custos, permissões e limites
do workflow foram preservados. Os testes reais deste incremento não foram
executados na VPS nem estão declarados aprovados antes do CI.

## 7.3.3 — Encaminhamento explícito à DLQ e ACK seguro

`SqsWagerDlq` é um adaptador chamado explicitamente, sem registro no bootstrap,
polling ou alteração de receiver, delivery, retry SQL e processamento financeiro.
Recebe a entrega bruta e evidência financeira fornecida pelo chamador; exceções
nunca provam rollback. Apenas `send-to-dlq` da política 7.3.1 permite publicar.
Resultados duráveis PROCESSED, REJECTED e PENDING_REFERENCE e resultados incertos
bloqueiam o encaminhamento, mesmo após esgotamento ou falha de ACK.

Corpo, MessageId original, ReceiptHandle atual, MessageGroupId e contador precisam
estar disponíveis e válidos. Ausências não recebem valores substitutos. O corpo
é enviado sem parse ou serialização; grupos ausentes ou inválidos bloqueiam envio
e exclusão com diagnóstico do campo. Recusas do SQS ao corpo também preservam a
origem. As URLs de origem e destino devem identificar filas FIFO distintas.

Antes do envio, `GetQueueAttributes` consulta primeiro a origem, exigindo HTTP 200,
origem FIFO e ausência de RedrivePolicy, e depois o destino, exigindo HTTP 200 e
FifoQueue=true. Falha ou resposta incompleta em qualquer consulta bloqueia envio e
exclusão, com diagnóstico da fila. A verificação não é armazenada em
cache. `assertExplicitMode()` também precisa ser chamado antes de qualquer futuro
consumidor receber mensagens: verificar apenas no encaminhamento não protege
mensagens incertas contra movimentação nativa. A configuração não deve mudar durante
o consumo; a consulta não elimina uma corrida com alterações externas da fila.
O smoke histórico `.github/workflows/ministack-smoke.yml`, com maxReceiveCount=3,
permanece isolado e inalterado. As filas de integração da inbox não têm redrive.
A política explícita permite até cinco recebimentos; mudar o redrive nativo para
cinco ainda permitiria mover resultados incertos ou já persistidos sem autorização.
Assim, o modo explícito exige ausência de redrive nativo e permissão
`sqs:GetQueueAttributes` nas duas filas, sem alterar automaticamente a infraestrutura.

`SendMessage` usa MessageDeduplicationId igual ao SHA-256 da serialização do array
`['wager-dlq-v1', sourceQueueUrl, sourceMessageId]`, com URL normalizada. A identidade
não depende do receipt handle nem do contador e é transportada no atributo
`dlqTransferId`, junto de `sourceQueueUrl` e `sourceMessageId`. Não representa um
identificador financeiro nem depende da validade do JSON recebido.

Somente uma resposta HTTP 200 com MessageId válido, SequenceNumber decimal de até
128 bits e MD5OfMessageBody correspondente ao corpo confirma o envio FIFO. Então
o adaptador exclui a origem com o receipt handle atual e exige HTTP 200 no ACK.
Falha ou resposta incompleta no envio mantém publicação incerta e não emite
DeleteMessage. ACK falho ou sem confirmação mantém o registro do envio confirmado;
redelivery pode repetir SendMessage com a mesma identidade. Um ACK perdido pode já
ter excluído a origem; sua falha não é evidência de alteração do estado financeiro.

A deduplicação FIFO limita-se à janela de cinco minutos; redeliveries posteriores
podem gerar duplicatas na DLQ. Não há transação atômica entre enviar e excluir,
nem promessa de exatamente uma publicação. O futuro consumidor da DLQ precisará
deduplicar persistentemente por `dlqTransferId` antes de produzir efeitos; essa
persistência e esse consumidor não são implementados neste incremento.
Referência: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagededuplicationid-property.html

`SqsWagerDlqError` distingue validação, configuração, publicação e ACK, preservando
causa, falha original e estado de publicação (não tentada, incerta ou confirmada).
Esses erros de transporte não podem ser convertidos em falha financeira ou FAILED.
Os testes unitários usam respostas controladas e barreira de promessa para verificar
a ordem dos comandos. Não substituem validação futura com SQS real/emulado.

## 7.3.4 — Validação integrada de retry, DLQ e proteção financeira

A suíte `sqs-retry-dlq` acrescenta 13 casos SQS: corpo bruto inválido, alteração
real da visibilidade com redelivery natural, contagem até cinco recebimentos,
publicação FIFO seguida de exclusão, perda/falha de publicação e de ACK por wrappers
explícitos, deduplicação na janela FIFO, falha de visibilidade e bloqueio de redrive
nativo com limites três e cinco. As filas são únicas por teste e excluídas em
`finally`, sequencialmente, origem antes da DLQ. Falhas de limpeza não impedem
as demais exclusões e preservam o erro original como causa e item do AggregateError.

`sqs-financial-protection` acrescenta seis casos com PostgreSQL e MiniStack reais:
PROCESSED (BET de 25.00 sobre 100.00), REJECTED (BET de 101.00 sem saldo suficiente)
e PENDING_REFERENCE (WIN com referência ausente), cada qual após ACK falho e após
perda simulada de resposta. O teste observa o resultado somente depois que o caso
de uso real resolve após COMMIT. No cenário de perda, um wrapper lança depois dessa
resolução; não interrompe a conexão PostgreSQL nem simula um COMMIT realmente ambíguo.
O estado fornecido aos adaptadores continua explicitamente incerto, enquanto leituras
independentes no banco estabelecem o resultado esperado pelo teste.

Depois de cinco recebimentos reais, resultados persistidos ou incertos precisam
retornar hold, sem comandos de retry, publicação ou exclusão. A DLQ é consultada
para confirmar ausência de mensagens. O teste compara snapshots antes/depois do
bloqueio e do replay por uma nova instância do handler: saldo, versão da wallet,
transações, ledger, outbox e inbox concluída permanecem intactos. A soma do ledger
reconstrói o saldo; rejeição e pendência não criam lançamento financeiro. O replay
preserva inclusive o resultado pendente e permite ACK após a confirmação durável.
Nenhum FAILED, worker ou consumidor novo foi introduzido.

O runner anterior tinha uma lista explícita de arquivos, sem descoberta por glob.
Agora ele e o validador JUnit compartilham um manifesto explícito de suítes e seus
mínimos. Os 364 casos históricos e seus mínimos individuais foram preservados;
os 13 casos SQS e seis financeiros elevam o mínimo obrigatório para 383. Cada arquivo
precisa atingir seu próprio mínimo com casos nomeados e assertivas; aumentar o total
de outro arquivo não substitui uma suíte ausente. Skips, falhas, erros e relatórios
incompletos continuam bloqueando a aprovação. Testes unitários do relatório cobrem
ausência das novas suítes, hooks sem nome e casos sem assertivas.

Workflows, gatilhos manuais, limites e infraestrutura permanecem inalterados. Os novos
casos são compilados localmente; serviços e execução integrada só são permitidos no
runner isolado do Actions, mediante autorização. A imagem continua MiniStack 1.5.39
com o digest existente. Incompatibilidades não recebem fallback para mocks ou skips.
Não há validação declarada do fluxo integrado antes dessa execução. Permanecem fora
da prova: falha real de conexão durante COMMIT, IAM da AWS, semântica integral de rede
do SQS e deduplicação persistente além da janela FIFO de cinco minutos. Os wrappers
de perda de resposta comprovam o comportamento conservador do cliente sob falhas
controladas, sem substituir persistência e transporte reais no caminho principal.

## 8.1 — Reserva limitada da outbox

`OutboxReservation` define uma reserva explícita e limitada, separada dos produtores
financeiros. `outboxReservationParameters` valida as opções antes de adquirir conexão:
lote inteiro de 1 a 100 eventos e lease inteiro de 1 a 3600 segundos, com default de
30 segundos. Esses limites são escolhas de capacidade e proteção operacional; o
README exige concorrência e recuperação, sem prescrever os valores. O chamador deve
reservar somente a quantidade que pode começar a trabalhar imediatamente.

`ReservedOutboxEvent` expõe um snapshot separado do contexto ORM, com identidade e
payload originais, tentativas, agenda e a nova concessão (`leaseToken`, `leaseUntil`).
O token identifica a reserva, não um novo evento financeiro. O contrato devolve
eventos somente após COMMIT e não oferece publicação, confirmação, ACK ou polling.

`PostgresOutboxReservation` reutiliza `runPostgresTransaction`, com fork próprio e
uma transação SQL curta. A seleção exige `published_at IS NULL`, agenda nula ou
vencida e lease nulo ou expirado, comparados a `statement_timestamp()` do PostgreSQL.
A ordem é `next_attempt_at NULLS FIRST, occurred_at, id`, com limite e
`FOR UPDATE SKIP LOCKED`: linhas já bloqueadas são ignoradas, sem bloquear toda a
fila ou adquirir locks financeiros. Essa distribuição de trabalho não representa
uma visão financeira global nem uma promessa de justiça entre publishers.

Na mesma transação, um UPDATE em lote com `jsonb_to_recordset` atribui UUID novo por
evento, incrementa `attempts` e calcula `lease_until` com o relógio do banco. A agenda
e `published_at` não são alterados. O adapter verifica a cardinalidade, restaura a
ordem da seleção após `UPDATE RETURNING` e só entrega as concessões após COMMIT.
Payload e datas são copiados, sem expor entidades do Identity Map; o congelamento
externo não deve ser confundido com imutabilidade profunda de todo objeto retornado.
Erro na reserva ou perda da resposta de COMMIT não comprova que uma reserva deixou
de existir: a elegibilidade persistida e a expiração continuam decidindo a retomada.

O Marco 8.1 pode ser construído sobre a outbox já gravada atomicamente por abertura e
processamento financeiro; tecnicamente não depende do consumidor contínuo ou do
shutdown do Marco 7.4. Isso não conclui nem remove esses requisitos de operação. A
reserva não deve adquirir locks de wallet, alterar dinheiro, reabrir resultados ou
modificar IDs, payloads e datas originais dos eventos. A fronteira transacional dos
produtores permanece responsável pela visibilidade de eventos somente após COMMIT.

Lease é exclusividade temporária no banco, não garantia de exatamente uma publicação.
O Marco 8.2 deverá publicar fora da transação de reserva e confirmar/reagendar apenas
quando `id` e token ainda corresponderem à concessão atual. O Marco 8.3 demonstrará
quedas em torno do envio e recuperação completa: um envio antigo pode completar
após expiração e causar duplicata. O `eventId` precisa permanecer estável e o
consumidor futuro precisa deduplicar persistentemente. Esgotamento de tentativas
não deve descartar silenciosamente eventos da outbox.

A suíte `outbox-reservation` prepara 14 casos PostgreSQL: lote vazio, filtros de
elegibilidade, ordem e limite, três durações de lease (default, mínimo e máximo),
exclusão de lease ativo, retomada de lease expirado com token novo, rollback de lote,
dois reservadores com sessões independentes, progresso com linha concorrente ainda
bloqueada, liberação dos locks após COMMIT e eventos de produtores antes do COMMIT ou
revertidos. A prova de `SKIP LOCKED` usa barreiras e exige progresso antes de liberar
o lock concorrente; não usa uma espera temporal como substituto de concorrência.
O prazo do lease é comparado com leituras do relógio do banco que envolvem a reserva.

A fixture mantém o backlog não publicado preexistente bloqueado em uma sessão
própria, apenas durante cada caso sequencial, para que o adapter global o ignore por
`SKIP LOCKED`. Ela não modifica nem exclui eventos de outros testes, insere IDs
próprios e libera locks e limpa esses IDs em `finally`, preservando o erro original
se a limpeza também falhar. Não é um filtro de produção por prefixo ou publisher.
O manifesto compartilhado entre runner e relatório acrescenta essa suíte aos 383
casos anteriores: mínimo obrigatório de 397 casos em 15 suítes, com assertivas e
zero skips/falhas. Publicação real, fencing da confirmação e recuperação após morte
do publisher continuam para 8.2 e 8.3.

Nenhuma validação integrada de 8.1 é declarada antes da execução autorizada no Actions
com PostgreSQL real. Typecheck, compilação e unitários locais não demonstram a
exclusividade de locks entre sessões nem a recuperação persistente após expiração.

## Marco 8.5 — Expiração de referências pendentes

O prazo é fixo em `createdAt + 24 horas`; `now >= deadlineAt` caracteriza expiração.
Retentativas mantêm esse prazo, inclusive quando uma agenda antiga possui deadline
calculado a partir da tentativa. A seleção PostgreSQL usa a data de criação para
incluir expiradas mesmo com próxima tentativa futura ou deadline persistido nulo.
O índice parcial existente continua disponível; nenhum campo ou migration é necessário.

Sob os locks existentes de carteira e transação, a aplicação consulta novamente a
referência e executa as regras do domínio. Se continuar pendente ao expirar
(referência ausente ou ainda não processada), chama
`fail(ReferenceNotFound, wallet.balance, at)`. Referências disponíveis continuam
produzindo processamento ou rejeição conforme as regras existentes.

A especificação explícita do Marco 8.5 determina `FAILED/REFERENCE_NOT_FOUND`,
divergindo do `REJECTED` descrito no item 7.1 do README. A implementação segue essa
especificação e grava `WagerTransactionFailed` com o contexto original na mesma
transação SQL da conclusão, sem alteração da carteira nem ledger para a expiração.
Falha da outbox reverte a conclusão; workers concorrentes observam a decisão após
o lock e ignoram transações finalizadas. O contador `failed` do lote inclui tanto
expirações concluídas quanto erros técnicos; apenas os últimos geram log de erro.
O replay pelo worker é ignorado após conclusão. O contrato existente de
`ProcessWagerTransaction` ainda não retorna `FAILED`: reenvios pelo fluxo de aceite
produzem `WagerResultUnavailableError`, sem repetir efeitos financeiros.

Os testes PostgreSQL acrescentam retentativas sem renovação, limite exato e posterior,
referência disponível, snapshot final do saldo, rollback, dois workers com barreiras
de lock e seleção com próxima tentativa futura. Sua validação exige execução no
ambiente isolado PostgreSQL/SQS; testes locais não comprovam essas garantias SQL.

## Marco 9.1 — Leitura do ledger

`GET /wallets/:walletId/ledger` usa `ReadWalletLedger` e a porta
`WalletLedgerReader` no módulo de carteiras. O adaptador PostgreSQL reutiliza o
índice `(wallet_id, created_at, id)` com ordenação `created_at DESC, id DESC`,
predicado keyset `(created_at, id) < (cursorTimestamp, cursorId)` e `LIMIT limit + 1`.
Não utiliza OFFSET, locks financeiros, flush ou gravações. Não altera os fluxos de
processamento, inbox ou outbox.

O limite padrão é 50; valores inteiros de 1 a 200 são aceitos como strings na query.
A resposta contém `items`, `hasNextPage` e `nextCursor` (null na última página).
Cada item contém `id`, `walletId`, `transactionId`, `direction`, `money`,
`balanceBefore`, `balanceAfter`, `walletVersion` e `createdAt`. Dinheiro é serializado
pelo `Money` existente como strings decimais. Carteira sem lançamentos retorna
lista vazia; carteira inexistente retorna 404 após autorização. Cursor ou limite
inválido retorna 400.

O cursor é um contrato opaco versionado em base64url canônico com carteira,
timestamp UTC e identificador. O parser valida estrutura, versão, calendário,
limite de tamanho e vínculo com a carteira. Não é criptografado nem assinado:
possuir ou construir um cursor não concede autorização. A consulta sempre filtra
pela carteira da rota e usa parâmetros SQL.

O timestamp é formatado em SQL com seis dígitos fracionários e UTC, transportado
como string e convertido diretamente para `timestamptz` na comparação SQL.
Não passa pelo `Date` do JavaScript, que perderia microssegundos. Por essa razão,
a projeção de leitura não usa o mapper de domínio baseado em `Date` para esse campo.

A paginação não mantém um snapshot entre requisições. Lançamentos novos com chave
menor que a do cursor podem aparecer nas próximas páginas; lançamentos com chave
maior exigem reiniciar a consulta. A ordem é estável para os registros existentes, sem
repetição causada por inserções à frente do cursor. Isso não é reconciliação.

**Limitação de acesso:** `ProviderAuthenticationGuard` continua sendo o ponto de
extensão existente, que aceita todas as requisições. Ele não comprova identidade
nem propriedade da carteira. A nova rota também exige `WalletLedgerAccessGuard`,
que nega acesso por padrão (403), antes de consultar o banco. Uma integração
confiável de identidade e propriedade deve fornecer `WalletLedgerAccess` na
composição HTTP para habilitar a leitura. Nenhum header fornecido pelo cliente
concede acesso na implementação padrão. A integração com IdP permanece pendente;
os testes fornecem permissões apenas como fixtures locais. Os endpoints anteriores
preservam seu comportamento.

A suíte `wallet-ledger` está no manifesto obrigatório da integração em containers,
com casos de precisão monetária e de microssegundos, desempate, múltiplas páginas,
isolamento, autorização, entradas inválidas, inserção entre páginas e comparação
do estado financeiro antes/depois. Sua aprovação depende de execução real no
ambiente isolado; testes unitários não substituem essa evidência.

## Marco 9.2 — Reconciliação interna somente leitura

`ReconcileWallet` recebe `WalletReconciliationSource`. O adaptador
`PostgresWalletReconciliationSource` abre um EntityManager próprio e uma única
transação `REPEATABLE READ READ ONLY`, usando as opções nativas do MikroORM/Knex.
Leitura da carteira e agregação do ledger usam esse mesmo manager, conexão e
snapshot. Não há `FOR UPDATE`, alterações financeiras, eventos ou correções.
O serviço pode ser registrado opcionalmente em `WalletsModule.register` ou
instanciado por um consumidor interno com o adaptador. O complemento HTTP expõe
`POST /wallets/:walletId/reconciliation`, delegando integralmente ao mesmo serviço.
O endpoint reutiliza `WalletLedgerAccessGuard` e sua política por carteira: permanece
bloqueado por padrão (403), antes de qualquer consulta, até uma integração confiável
validar identidade e permissão para a carteira. O guard de provedor existente, que
aceita todas as requisições, não concede essa autorização.

Respostas CONSISTENT e DIVERGENT usam HTTP 200, com `consistent` true e false,
respectivamente. INCONCLUSIVE também usa 200, com `consistent`, `calculatedBalance`
e `difference` nulos e motivos explícitos. Carteira inexistente retorna 404 somente
após autorização; falhas transitórias retornam 503 e falhas inesperadas, 500, sem
SQL, credenciais ou detalhes internos. A composição antiga sem adaptador continua
válida e retorna 503 se uma consulta autorizada não tiver o serviço disponível.
Nenhuma CLI pública ou autenticação fictícia foi adicionada.

A abertura positiva já existe como `OPENING` processada e crédito da versão 1,
com saldo anterior zero. A reconciliação exige correspondência entre lançamento,
transação, carteira, moeda e valor. Esse valor é o `initialBalance`; créditos e
débitos posteriores **excluem OPENING**. Assim, `calculatedBalance = initialBalance
+ credits - debits` contabiliza a abertura exatamente uma vez.

Sem OPENING, zero só é inferido quando não há transação nem lançamento de abertura
e existe carteira de versão 1 com saldo zero e ledger vazio, ou primeiro lançamento
da versão 2 com saldo anterior zero. Também são verificadas sequência de versões,
continuidade de saldos, moeda, aritmética, estado e correspondência das transações,
além de operações processadas sem lançamento. As verificações complementam as
constraints e triggers existentes; não reexecutam toda a política de referências.
Histórico sem evidência de abertura retorna `INITIAL_BALANCE_UNPROVEN`, sem
inventar valor inicial. Outros indícios incluem `INVALID_LEDGER_ENTRIES`,
`INVALID_LEDGER_SEQUENCE` e `MISSING_FINANCIAL_ENTRIES`.

O relatório traz carteira, moeda, saldo persistido, abertura, créditos posteriores,
débitos, saldo calculado, diferença **persistido menos calculado**, contagem,
`consistent` e status `CONSISTENT`, `DIVERGENT` ou `INCONCLUSIVE`. Na ausência de
evidência ou com ledger inválido, saldo calculado e diferença são nulos;
`consistent` também é nulo. Falhas SQL/conexão e carteira inexistente propagam
erros distintos, sem serem convertidas em divergências financeiras.

Agregações e subtração ocorrem em `NUMERIC` no PostgreSQL, sem ponto flutuante e
sem limitar o volume histórico ao teto de um Money individual. O Money existente
valida o saldo persistido; agregados e diferença assinada são serializados como
strings decimais com duas casas. Não houve alteração de Money, schema ou migrations.

A suíte `wallet-reconciliation` faz parte do manifesto obrigatório de integração.
Para divergências artificiais, cria um schema `reconciliation_fixture_<uuid>` com
`LIKE public.<tabela> INCLUDING DEFAULTS`, sem copiar checks, FKs, índices únicos
ou triggers; copia apenas as carteiras de teste necessárias e altera somente essas
cópias. Nenhuma proteção das tabelas públicas é desativada. O schema é removido no
encerramento. Os testes também verificam que a corrupção equivalente na tabela
pública é rejeitada pelos triggers normais. A fixture usa configuração de schema
própria do ORM, e o adaptador qualifica os nomes das tabelas sem alterar search_path.

Os testes PostgreSQL incluem barreira após a leitura da carteira, commit concorrente
por outro manager, preservação do snapshot, verificação de isolamento/read-only e
rejeição de escrita pelo banco. Essas garantias só são validadas com execução real;
os testes unitários de contratos não substituem essa evidência. Logs e métricas de
divergência ficam para os próximos incrementos do Marco 9.3, conforme o escopo autorizado.

## Marco 9.3.1 — Logs JSON e correlação

`operations/json-logger.ts` emite uma linha JSON com `timestamp`, `level`, `event`
e apenas os identificadores conhecidos: `correlationId`, `messageId`,
`transactionId`, `walletId`, `providerId`. Eventos pertencem a uma lista fixa;
identificadores são strings ASCII limitadas a 256 caracteres, sem espaços/controles.
Campos extras, erros arbitrários, tokens, credenciais, receipt handles, jogadores,
causationId e payloads financeiros não são serializados. O adaptador de logger do
Nest mantém o formato JSON e descarta mensagens arbitrárias do framework.

`AsyncLocalStorage` mantém os identificadores originais em cópias imutáveis por
execução; a filtragem da saída não normaliza a correlação dos comandos/eventos.
IDs incompatíveis com a política de saída são omitidos do log. HTTP usa middleware
instalado por `createHttpApplication` antes do parser JSON e dos guards. Um único
`X-Correlation-Id` de 1 a 128 caracteres em `[A-Za-z0-9._:-]` é aceito; ausências,
duplicatas e valores inválidos geram UUID. O identificador é devolvido no header,
inclusive em respostas de erro, e repassado aos comandos de abertura/processamento.
Ele continua excluído de payloadHash e idempotencyKey e não concede autorização.

O handler SQS inicia contexto próprio com o messageId do envelope, preservando a
correlação e causationId já utilizados no comando. O identificador de transporte
SQS não é messageId de domínio. Na publicação da outbox, a correlação vem do payload
persistido; o ID retornado pelo broker e o causationId não são convertidos em
messageId para logging. Referências terminais reutilizam o contexto original já
lido pelo fluxo existente, sem consulta extra. Se esse contexto não foi carregado
(por exemplo, reagendamento/skip), o log omite correlationId; não inventa contexto.
Eventos já persistidos e corpos publicados permanecem inalterados.

Logs de abertura e processamento são emitidos após o retorno do commit. O handler
SQS registra `sqs.command_committed` antes do ACK existente, sem antecipá-lo;
`outbox.publication_confirmed` confirma apenas o envio ao SQS, não o registro de
confirmação no banco. Falhas preservam as exceções e políticas existentes. Bootstrap
e worker de referências substituem seus logs pontuais por eventos JSON sanitizados.

A escrita é best effort: o logger captura os campos na emissão, agenda a saída por
microtask e usa `fs.write` assíncrono com callback de erro tratado. Sinks injetados
podem lançar ou rejeitar promises; essas falhas são contidas e nunca aguardadas
pelo negócio. Não há retry de logging, persistência ou garantia de entrega/flush.
Logs podem se perder por indisponibilidade, encerramento ou escrita parcial; sob
pressão de saída, a implementação não oferece uma fila durável nem garantia de
memória limitada. Um sink personalizado que bloqueie sincronamente também não
pode ser preemptado pelo JavaScript. O sink padrão não espera pelo I/O.

Testes cobrem whitelist, JSON, headers, isolamento concorrente com barreiras,
correlação persistida, replay com outro header, ordem commit/ACK e falhas síncronas
e assíncronas do logger. Casos PostgreSQL/MiniStack foram acrescentados/ajustados
no runner existente; sua aprovação exige execução real. Este incremento não
implementa métricas, health checks ou novos workers.
