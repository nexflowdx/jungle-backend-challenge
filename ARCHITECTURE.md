# Arquitetura até o incremento 5.4 (integração nova pendente)

Monólito modular NestJS: `WalletsModule`, `WageringModule`, `MessagingModule` e
`OperationsModule`. O caso de uso de abertura está implementado em Wallets;
`ProcessWagerTransaction` processa BET, WIN e LOSS sem referência. REFUND, ROLLBACK,
referências e entradas HTTP/SQS continuam nos próximos incrementos.
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
o caso de uso de abertura persiste os eventos, mas publicação ainda não existe.

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
ao banco. O desenvolvedor confirmou a aprovação das regressões do Marco 3 no
Actions com PostgreSQL real. Os Marcos 3 e 4 foram validados nesse ambiente,
conforme confirmação do desenvolvedor, assim como os 128 testes até 5.2.
Os 159 testes até 5.3 também foram validados no Actions, conforme confirmação do
desenvolvedor. Os novos casos de 5.4 ainda dependem de execução nesse ambiente.

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
Inbox/Outbox, abertura atômica, infraestrutura transacional, identidade, BET, WIN e LOSS. Testes locais pulam as seis suítes
PostgreSQL. Não se executa Docker na VPS. O runner exige relatório JUnit com pelo
menos 200 casos reais: 55 de persistência, 32 de abertura, 9 de infraestrutura de 5.1,
32 de identidade, 31 de BET e 41 de WIN/LOSS. Cada arquivo deve atingir
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

No incremento 5.1, `ProcessWagerTransaction` apenas recusava operações. Em 5.4,
essa proteção permanece para REFUND, ROLLBACK, OPENING e qualquer operação com referência,
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
HTTP e SQS permanecem nos próximos incrementos.

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
operações usam o snapshot terminal persistido; reversões e a evolução de
PENDING_REFERENCE continuam nos próximos incrementos.

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
PENDING nunca são apresentadas como sucesso. WIN e LOSS com referência continuam
explicitamente indisponíveis antes de abrir transação, sem PENDING_REFERENCE.

Os 21 casos unitários novos verificam orquestração, validações, eventos, replay e
retentativas com o domínio real. Os 41 casos PostgreSQL novos cobrem precisão acima
do limite seguro de number, BRL/USD, limite monetário, LOSS sem movimento, replay,
duplicatas e créditos distintos concorrentes, isolamento entre wallets, espera real
pelo lock, rollback após cada escrita e falhas SQL de outbox e commit diferido.
A integração nova ainda não foi executada: o workflow exclusivamente manual exige
agora os 200 casos com assertivas e zero skips, preservando os 159 anteriores.
O harness de múltiplos processos, referências e as operações posteriores permanecem
pendentes dos respectivos incrementos.
