# Pending Reference Worker

Processo independente para resolução periódica de transações
com status PendingReference.

## Funcionamento

- Executa um lote a cada 60 segundos.
- Processa até 50 candidatos por lote.
- Reavalia o estado da transação dentro da transação PostgreSQL.
- Utiliza bloqueio da carteira para proteger operações concorrentes.
- Registra resultados e falhas no stdout/stderr.
- Encerra a execução em caso de falhas no lote.

## Configuração

Variáveis obrigatórias:

- PGHOST
- PGPORT
- PGDATABASE
- PGUSER
- PGPASSWORD

## Execução

Com PostgreSQL acessível e as variáveis configuradas:

docker compose -f infra/worker/compose.yaml up -d --build

## Logs

docker compose -f infra/worker/compose.yaml logs -f

## Encerramento

docker compose -f infra/worker/compose.yaml down

## Observações

O worker não executa migrações do banco.

O PostgreSQL deve estar previamente configurado e acessível
pela rede do contêiner.

Esta configuração é uma referência de implantação.
Não foi validada em ambiente de produção.
