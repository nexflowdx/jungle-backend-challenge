# Arquitetura implementada até o Marco 1

Monólito modular NestJS: `WalletsModule`, `WageringModule`, `MessagingModule` e
`OperationsModule`. Neste estágio os módulos delimitam responsabilidades; ainda
não implementam fluxos financeiros ou integrações da aplicação definitiva.
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

MikroORM e PostgreSQL são escolhas aprovadas para a próxima etapa de persistência,
com mapeamentos separados do domínio. A prova descartável PG/SQS fica em
`experiments/compatibility-03`, exclusivamente no workflow manual de compatibilidade;
sua execução remota depende de autorização. A aplicação base ainda não se conecta
a banco ou filas. Migrations e garantias financeiras no schema pertencem aos
incrementos posteriores e ainda não estão implementadas.

`Money` é imutável (campos privados e instância congelada), com centavos em
`bigint` e limite simétrico de magnitude `92233720368547758.07`. Os contratos
aceitam somente strings não negativas com exatamente duas casas decimais;
zeros à esquerda são normalizados. A serialização JSON retorna `{ amount,
currency }`, sem expor `bigint`. `toString()` retorna apenas o decimal com duas
casas. BRL e USD são o conjunto explícito inicial de códigos ISO-4217 suportados.
Todas as operações binárias, inclusive comparação e igualdade, rejeitam moedas
diferentes com erro de domínio. Subtração e negação podem produzir resultados
internos negativos; esses resultados continuam sujeitos ao limite e não são
aceitos pela factory de entrada externa. A regra de saldo não negativo será
responsabilidade da futura Wallet, além das constraints do banco.

Essa escolha segue o plano aprovado e evita dependência de uma biblioteca decimal
para soma/subtração em escala fixa. O futuro mapeamento persistirá unidades em
`NUMERIC` sem precisão/escala declaradas, com checks explícitos; o presente
incremento não implementa esse mapeamento nem garante invariantes no banco.
