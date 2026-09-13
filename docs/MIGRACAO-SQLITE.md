# Migração de PostgreSQL para SQLite

Decisão do usuário em 05/09/2026, reabrindo a escolha travada no grilling de 02/09
("PostgreSQL 18 local como banco principal", com a consequência aceita de que "o
instalador precisa garantir um PostgreSQL na máquina do usuário"). O motivo de reabrir foi
exatamente essa consequência: o app precisa rodar em qualquer computador sem preparação.

Este documento é o **contrato da migração**: a tabela de equivalências que todo mundo
segue, para 21 migrações e ~15.600 linhas de Rust não serem traduzidas de dez jeitos
diferentes. Quando este documento e um arquivo discordarem, este vence até alguém alterá-lo
aqui.

## A evidência que sustenta a decisão

Mesma carga das medições da Fase 3 — 50.000 registros × 15 propriedades = 750.000 linhas de
valor — no mesmo desenho (EAV com colunas geradas `sort_num`/`sort_text` e consulta em duas
fases). PostgreSQL 18 com `fsync` desligado; SQLite com WAL e `synchronous=NORMAL`. Ambos
otimistas na mesma medida.

| Operação | PostgreSQL | SQLite | |
|---|---|---|---|
| Abrir a view: janela sem filtro, ordenada por posição | 0,09 ms | **0,02 ms** | SQLite |
| Hidratar 50 registros × 15 propriedades (fase 2) | 1,2 ms | **0,55 ms** | SQLite, 2× |
| Filtro + ordenação + primeira janela (fase 1) | 49 ms | 54 ms | empate |
| Cabeçalhos de grupo | 73 ms | 74 ms | empate |
| Rodapé: soma sobre 50.000 | 100 ms | **66 ms** | SQLite |
| Rodapé: contar distintos em texto | 164 ms | **131 ms** | SQLite |
| Escrever um valor | 1,5 ms | **0,02 ms** | SQLite |
| Edição em lote de 1.000 valores | 29,8 ms | **12,2 ms** | SQLite, 2,4× |
| Tamanho em disco | 172 MB | **53 MB** | SQLite, 3× menor |

Nenhuma regressão. A arquitetura da Fase 3 relatou 5 ms para cabeçalho de grupo no
Postgres; a medição direta lado a lado deu 73,4 ms no Postgres contra 73,6 ms no SQLite —
a vantagem não se reproduz, e o número de 5 ms media outra coisa.

Busca acentuada, que era a maior dúvida: FTS5 com `tokenize="unicode61 remove_diacritics 2"`
acha `mitocôndria` procurando por `mitocondria` e vice-versa, **nativo**. No Postgres isso
custa `CREATE EXTENSION unaccent`, uma função `immutable_unaccent` e uma coluna gerada
reconstruída — a migração `0015` inteira deixa de existir.

## O que a migração DELETA

Vale registrar porque muda a percepção de custo: boa parte deste trabalho é remoção.

- **`pg_dump` / `pg_restore`**: 54 ocorrências entre `src` e `tests`. Backup vira
  `VACUUM INTO 'destino.sqlite'` — uma linha, atômica, sem processo externo, sem depender de
  binário instalado na máquina do usuário e sem senha.
- **O assistente de primeira execução de conexão** (host, porta, banco, usuário, senha):
  14 arquivos. Não há o que conectar.
- **Achado #2 da Fase 1**, aberto desde então: *"o diálogo de Configurações mostra dois
  campos 'Senha do Postgres'... são quatro campos de senha na mesma tela, para o mesmo
  banco, na mesma sessão... não é usável"*. Resolvido por eliminação: não existe senha.
- **`CREATE EXTENSION`** (3 ocorrências: pgcrypto, unaccent, pg_trgm) e a migração `0015`.
- **`scripts/dev-db.ps1`** e o cluster descartável da porta 5433: um teste passa a criar um
  arquivo temporário, ou usar `:memory:`.

`sqlx-sqlite` e `libsqlite3-sys` **já estão no `Cargo.lock`** como dependência transitiva do
sqlx. Ligar o SQLite não acrescenta superfície de supply chain nenhuma.

## A tabela de equivalências — o contrato

### Tipos

| PostgreSQL | SQLite | Regra |
|---|---|---|
| `UUID` | `TEXT` | Sempre a forma canônica com hífens, minúscula. TEXT e não BLOB para o arquivo continuar legível pelo `sqlite3` na hora de depurar. |
| `UUID DEFAULT gen_random_uuid()` | `TEXT NOT NULL`, **sem default** | O id passa a ser **sempre** gerado no Rust. Isso não é uma concessão: a Fase 2 já tinha decidido que o cliente gera o id (`NewBlock.id` / `NewBlockInput::id`), justamente porque o nó ProseMirror ganha id ao ser digitado. A migração alinha o resto com essa decisão. |
| `TIMESTAMPTZ` | `TEXT` | ISO 8601 em **UTC**, largura fixa: `YYYY-MM-DDTHH:MM:SS.fffZ`. Largura fixa faz a ordenação lexicográfica ser a cronológica. É a mesma regra da invariante I5 da Fase 3, agora valendo para o banco inteiro. |
| `JSONB` | `TEXT` | JSON serializado. Leitura por `json_extract` / `->>`. Não use o JSONB binário da 3.45: `sqlx` fala TEXT e o ganho não paga a incompatibilidade. |
| `BOOLEAN` | `INTEGER` | 0/1. `sqlx` mapeia `bool` sozinho. |
| `BIGINT`, `INTEGER` | `INTEGER` | |
| `TEXT` | `TEXT` | |

### Construções

| PostgreSQL | SQLite |
|---|---|
| `now()` | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` — ou, preferencialmente, o valor vindo do Rust |
| `GENERATED ALWAYS AS (...) STORED` | `GENERATED ALWAYS AS (...) VIRTUAL` — SQLite indexa coluna virtual, e virtual não ocupa disco. Medido funcionando com índice. |
| `tsvector` + `to_tsvector` + GIN + `unaccent` | Tabela virtual `FTS5` com `tokenize="unicode61 remove_diacritics 2"`, sincronizada por gatilho |
| `GIN (x jsonb_path_ops)` | Índice comum sobre a coluna gerada correspondente. O índice GIN já era peso morto para predicado de igualdade — ver `docs/FASE-3-MEDICOES.md`. |
| `CREATE FUNCTION ... plpgsql` | Não existe. Ver "os quatro pontos difíceis" abaixo. |
| Gatilho `FOR EACH STATEMENT` com `REFERENCING NEW TABLE` | Não existe. Vira lógica no caminho único de escrita. |
| `current_setting('learno.bulk_load')` | Não existe. Vira um campo no repositório Rust. |
| `EXCLUDE` (1 ocorrência) | Índice único, ou verificação no Rust |
| `RETURNING` | Suportado (3.35+) |
| `ON CONFLICT` | Suportado |
| `ON DELETE CASCADE` | Suportado, **mas só com `PRAGMA foreign_keys = ON`** — ver abaixo |

### As armadilhas que quebram em silêncio (as quatro previstas, e as três que a execução revelou)

1. **`PRAGMA foreign_keys = ON` é por conexão e vem DESLIGADO por padrão.** Sem ele, todo
   `ON DELETE CASCADE` deste schema simplesmente não acontece, sem erro nenhum: apagar uma
   página deixa blocos, valores e arestas órfãos. Tem que ser ligado no
   `SqliteConnectOptions` do pool, e um teste tem que **provar a cascata**, não a
   configuração — apagar uma página e contar as linhas filhas.
2. **`PRAGMA journal_mode = WAL`** para leitura não bloquear escrita, mais
   `busy_timeout`. Sem WAL, a UI trava enquanto o recálculo de fórmula grava.
3. **SQLite não tem tipagem estrita por padrão.** Uma coluna `TEXT` aceita um inteiro em
   silêncio. Use `STRICT` nas tabelas novas onde couber, e não confie no banco para pegar o
   que o Rust deveria ter pego.
4. **Um único escritor por vez.** É irrelevante para um app local de um usuário, mas
   significa que uma transação longa (o backfill de 50.000 linhas de fórmula) bloqueia
   escritas. O backfill em lotes, que a arquitetura já exige por outro motivo, também
   resolve este.

5. **`sqlx` codifica `Uuid` como BLOB, e o schema guarda id como TEXT.** Esta não estava
   prevista quando o contrato foi escrito; apareceu na primeira execução dos testes e é a
   armadilha mais cara da porta inteira. `sqlx-sqlite` empurra `SqliteArgumentValue::Blob`
   de 16 bytes para um `Uuid` e decodifica com `Uuid::from_slice`
   (`sqlx-sqlite/src/types/uuid.rs`), enquanto a tabela de equivalências acima manda guardar
   id como TEXT canônico. As duas decisões juntas quebram nos dois sentidos — e, graças a
   `STRICT`, quebram alto, não em silêncio:

   - gravar: `cannot store BLOB value in TEXT column pages.id` (código 3091);
   - ler: `ColumnDecode { source: ParseByteLength { len: 36 } }`.

   A saída é `src/db/ids.rs`: `DbId`/`DbIdOpt`, que são TEXT dos dois lados, mais o trait
   `IdBind` (`.bind(page_id.db())`). Toda struct de leitura declara
   `#[sqlx(try_from = "DbId")]` no campo, sem mudar o tipo dele. São 189 pontos de ligação
   no projeto; concentrar isso num módulo é o que torna a regra revisável em um lugar só.

6. **Um `Encode` que devolve `IsNull::Yes` NÃO pode empurrar valor nenhum.** O
   `SqliteArguments::add` do `sqlx` empurra o `Null` ele mesmo ao receber essa resposta, e
   **não trunca** o que o `encode` tiver deixado no vetor. Empurrar também produz DOIS
   argumentos para um placeholder só e desloca todos os seguintes. O sintoma aparece longe
   da causa: o primeiro sinal disto foi `NOT NULL constraint failed: pages.title` num INSERT
   cujo título estava perfeitamente preenchido — o `parent_id` nulo tinha comido o
   placeholder do título. Fica pinado pelo teste
   `id_nulo_consome_um_placeholder_so_e_nao_desloca_os_seguintes` em `src/db/ids.rs`.

7. **`$1` continua funcionando, e reusar `$1` consome UM argumento.** O SQLite trata `$1`
   como parâmetro *nomeado*, indexado pela ordem de primeira aparição — então `$1, $2, $3`
   em ordem crescente se comporta exatamente como posicional, e as 249 ocorrências de `$N`
   do projeto não precisaram ser reescritas. O que muda é o reuso: em Postgres, repetir
   `$1` referencia o mesmo argumento; em SQLite também — mas quem lê o SQL esperando
   "um `?` por argumento" erra a conta. Só um lugar do projeto reusa (`blocks.rs`,
   `id = $1 OR synced_source_id = $1`), e ele está correto.

### Os quatro pontos difíceis, e o que fazer com cada um

| O que é | Onde | Saída |
|---|---|---|
| `bump_database_data_version` — gatilho de statement com transition table | `0017` | Vira uma linha em `apply_record_value_changes`. A invariante I4 já garante que existe **um único caminho de escrita**, então o gatilho é redundante ali. |
| `cleanup_orphaned_relation` — usa regex `!~*` para validar UUID | `0018` | Vai para o Rust, no repositório de relações |
| `touch_record_from_value` — usa o GUC `bulk_load` | `0017` | Gatilho comum de SQLite para o caso normal; o modo de carga em lote vira um campo do repositório que pula o gatilho desabilitando-o na transação |
| `immutable_unaccent` + `tsvector` | `0015`, `0004` | Substituídos por FTS5. A `0015` deixa de existir |

## Ordem da porta

1. **Fundação**: `Cargo.toml` (feature `sqlite` no lugar de `postgres`), `db/pool.rs`
   (caminho do arquivo, os PRAGMAs, bootstrap de migração), e um alias de tipo único
   (`pub type Db = sqlx::Sqlite;`) para que `Transaction<'_, Postgres>` vire
   `Transaction<'_, Db>` em 195 lugares de forma mecânica e reversível.
2. **As 21 migrações**, por um dono só, porque elas são interdependentes (a `0015`
   reconstrói o que a `0004` criou; a `0007` altera o que a `0003` deixou pendente).
3. **Os repositórios**, em paralelo, um dono por arquivo.
4. **Backup, configuração e primeira execução** — a maior parte é remoção.
5. **Testes e portão**, incluindo o teste de cascata do ponto 1 acima.
