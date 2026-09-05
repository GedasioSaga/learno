# Medições da Fase 3 — o custo real do modelo de dados de database

Este documento existe porque a Fase 3 tem uma decisão de arquitetura que não se resolve
discutindo: **como o valor de uma propriedade de database é armazenado.** As migrações
`0007`–`0009`, escritas antes de qualquer código de database existir, escolheram EAV — uma
linha por par (registro, propriedade) em `database_record_values`, com `value` em `jsonb`.
A justificativa está no comentário da própria migração e é boa: adicionar propriedade vira
`INSERT`, nunca `ALTER TABLE`.

O que ninguém tinha feito era medir. Abaixo estão as medições, com o SQL que as produziu,
na escala que a Fase 4 exige de verdade.

## Como foi medido

PostgreSQL 18 no cluster descartável deste repositório (porta 5433, `fsync` desligado —
ver `scripts/dev-db.ps1`), nesta máquina. **50.000 registros × 15 propriedades = 750.000
linhas de valor**, geradas por `generate_series`, com uma propriedade `select` (4 opções),
uma `number`, uma `date` e doze de texto. Todos os números são `EXPLAIN (ANALYZE)` com o
cache quente, isto é, o melhor caso da máquina.

Scripts: `bench-eav.sql`, `bench-eav-2.sql` e `bench-denorm.sql`, no scratchpad da sessão.
O esquema `bench` é descartável e não toca nenhuma tabela do produto.

As duas formas comparadas:

- **EAV**, como as migrações têm hoje: `record_values(record_id, property_id, value jsonb)`,
  com os três índices que `0009` cria.
- **Denormalizado**: uma linha por registro com `props jsonb` carregando todas as
  propriedades, mais um índice de expressão por propriedade que se queira filtrar ou
  ordenar.

## Os números

| Operação | EAV | Denormalizado | Fator |
|---|---|---|---|
| Filtro por uma propriedade + contagem | 168 ms | **5,9 ms** | 28× |
| Filtro + ordenação + janela de 50 linhas, com as 15 propriedades | 336 ms | **0,42 ms** | 800× |
| Soma de rodapé sobre 50.000 registros | 100 ms | **20 ms** | 5× |
| Agrupamento por Status | 73 ms | **27 ms** | 2,7× |
| Escrever uma propriedade de um registro | 1,60 ms | **1,55 ms** | empate |
| Escrever uma propriedade em 1.000 registros (DBS-122) | — | 29,8 ms | — |

Pior caso, para não superestimar o vencedor:

| Pior caso | EAV | Denormalizado |
|---|---|---|
| Filtro que casa pouquíssimas linhas, ordenado por número | — | 72,5 ms |
| Filtro por propriedade **sem** índice dedicado | 84,5 ms | **10,9 ms** |

O pior caso do denormalizado (72,5 ms) ainda é melhor que o **melhor** caso do EAV para a
consulta equivalente (336 ms).

## Três achados que mudam o desenho

### 1. O índice GIN que a migração 0009 cria não serve para o que ela diz que serve

`0009_database_record_values.sql` cria `idx_database_record_values_value` com
`jsonb_path_ops` e justifica assim: *"Filters, sorts, and rollups read the jsonb value
itself; GIN with jsonb_path_ops covers containment/equality lookups"*.

A metade sobre igualdade é falsa. `jsonb_path_ops` atende o operador de containment
(`@>`), não `=`. Nos quatro planos da primeira rodada — todos com predicado de igualdade,
que é a forma natural de um filtro de view — **o índice não foi usado nenhuma vez**; o
planejador caiu em `idx_..._property_id`, leu as 50.000 linhas daquela propriedade e
filtrou. Reescrevendo o mesmo filtro como `@>`, o GIN entra e o tempo cai de 168 ms para
79 ms.

Ou seja: quem escrever o gerador de filtro tem que emitir `@>`, não `=`, ou o índice é
peso morto. Isso não é evidente lendo a migração — o comentário dela induz ao contrário.

### 2. Um índice de expressão numérica é impossível no EAV, e trivial no denormalizado

A tentativa de indexar a ordenação numérica no EAV falhou:

```
CREATE INDEX ... ON record_values (property_id, ((value #>> '{}')::numeric));
ERROR:  invalid input syntax for type numeric: "Revisando"
```

O índice é construído sobre **todas** as linhas da tabela, e a mesma coluna `value` guarda
tipos diferentes conforme a propriedade — a expressão numérica quebra na primeira linha de
uma propriedade de texto. A saída seria um índice **parcial** por propriedade
(`WHERE property_id = '<uuid>'`), isto é, um índice novo a cada propriedade numérica que o
usuário criar, criado em tempo de execução por DDL disparado pela UI. No denormalizado o
mesmo índice é uma linha de DDL e funciona, porque a expressão extrai um campo nomeado de
cada registro.

### 3. O que domina no EAV é o pivot, não o filtro

Nos planos, o filtro sozinho custa dezenas de milissegundos; o que leva a consulta a 336 ms
é remontar as 15 propriedades de cada registro da janela — 15 linhas lidas e agregadas por
registro. É um custo proporcional ao número de propriedades, pago em toda rolagem. No
denormalizado ele simplesmente não existe: as propriedades já vêm juntas na linha.

## O que estes números **não** decidem

Medição não é a única entrada da decisão. O que o EAV dá e o denormalizado não dá de graça:

- **Integridade referencial por valor.** Uma relação apontando para um registro pode ser
  uma FK real numa tabela de aresta; dentro de um `jsonb` não pode.
- **Escrita concorrente em propriedades diferentes do mesmo registro.** No denormalizado,
  duas edições simultâneas reescrevem a mesma linha e a última vence. Num app local de
  usuário único isso é quase teórico, mas a Fase 4 tem revisão automática mexendo em
  propriedades de card enquanto o usuário edita a nota.
- **Histórico por propriedade**, se algum dia for pedido.
- **`updated_at` por valor**, que hoje existe e some se tudo virar um blob só.

Por isso a terceira via merece ser considerada de verdade, e não como meio-termo covarde:
**EAV como fonte da verdade, mais uma projeção denormalizada mantida por trigger** (uma
coluna `props jsonb` no registro, reescrita quando um `database_record_values` muda). Paga
escrita duas vezes — e a medição mostra que escrever custa 1,5 ms, então há folga — e
compra o caminho de leitura inteiro. Foi a mesma escolha que `pages.search_vector` já fez
neste repositório: coluna derivada, mantida pelo banco, para a leitura não pagar o preço da
normalização.

## O que qualquer proposta de arquitetura precisa responder

1. Qual forma armazena o valor, e se há projeção derivada — com estes números na mão, não
   por preferência.
2. Se o filtro é gerado como `@>` (o único jeito de o GIN existente valer alguma coisa) ou
   se o índice de `0009` deve ser trocado.
3. Como ordenar por uma propriedade numérica sem criar índice parcial por propriedade em
   tempo de execução.
4. Onde uma propriedade **fórmula** ou **rollup** entra nisso: se o valor não estiver
   materializado, filtrar e ordenar por ela obriga a carregar todos os registros, e nenhum
   dos números acima se aplica.

---

## Reconciliação: por que estes números foram superados

As medições acima compararam o EAV **como as migrações 0007–0009 o deixaram** (sem colunas
de ordenação, consulta em uma fase que filtra, ordena e pivota junto) contra um jsonb por
registro. Nessa comparação o denormalizado ganhou de 5× a 800×.

A arquitetura da Fase 3 (`docs/FASE-3-ARQUITETURA.md`) mediu outra coisa, e a medição dela
vale mais, porque o EAV que ela propõe não é o que eu medi:

- colunas **geradas** `sort_num` / `sort_text` em `database_record_values`, com índices —
  então ordenar e filtrar não passa mais por `jsonb` cru;
- consulta em **duas fases**: `open_view_query` resolve a lista ordenada de ids uma vez e a
  guarda atrás de um token; `fetch_view_window` vira fatia de array mais busca por PK.

Com isso o pivot que eu medi em 336 ms cai para **1,2 ms** para 50 registros × 15
propriedades, e a projeção denormalizada faria 0,34 ms — diferença irrelevante num
orçamento de 16 ms por quadro. E o read model perde num caso que eu não tinha medido:
cabeçalhos de grupo custam 5 ms no EAV contra 25 ms nele.

Ou seja: **o problema que eu medi era real, e a solução não era trocar de forma — era parar
de ordenar por `jsonb` e parar de pivotar a cada janela.** Registro isso porque a conclusão
que eu tinha tirado ("o denormalizado ganha em todos os cenários") estava certa sobre o
código de hoje e errada sobre o desenho de amanhã, e a diferença é exatamente o tipo de
coisa que uma medição isolada esconde.

O que sobrevive das minhas medições, e continua valendo:

1. **O índice GIN de `0009` não serve para `=`.** A arquitetura o troca. Confirmado.
2. **Índice de expressão numérica é impossível sobre `value` no EAV.** É por isso que
   `sort_num` existe como coluna gerada em vez de índice de expressão.
3. Os números crus de custo de escrita (1,5 ms por valor) seguem válidos e sustentam a
   escolha de materializar fórmula e rollup.

## Duas invariantes que eu não tinha encontrado, e verifiquei depois

**A ordenação de `jsonb` é por quantidade de chaves antes do conteúdo.** Verificado:

```sql
SELECT '{"start":"2026-01-01","end":"2026-01-02"}'::jsonb > '{"start":"2026-02-01"}'::jsonb;
-- t
```

Um intervalo de 1 a 2 de janeiro ordena **depois** de um dia 1 de fevereiro. Uma database
em que ninguém ligou "End date" passa em todos os testes e quebra no dia em que alguém
liga. Daí a regra de nunca ordenar por `value`.

**O btree tem teto de tamanho de linha, e o teste ingênuo é falso-verde.** Verificado:

```
INSERT ... to_jsonb(repeat('x', 100000))            -> passa (comprime)
INSERT ... to_jsonb(md5 concatenado, ~6 KB)         -> ERROR: index row size 6424
                                                       exceeds btree version 4 maximum 2704
```

Cem mil caracteres repetitivos passam; seis mil de prosa real quebram a gravação. Um
fixture com texto repetido deixa verde um índice que falha na mão do usuário — por isso o
truncamento em 256 e o predicado duplo existem, e por isso o fixture tem que usar md5.
