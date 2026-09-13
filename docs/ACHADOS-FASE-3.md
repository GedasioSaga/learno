# Achados da Fase 3 — em aberto

Mesmo espírito de `ACHADOS-FASE-1.md` e `-2.md`: defeito encontrado e dívida conhecida, com
âncora. A Fase 3 ainda está em construção, então este documento cresce.

## Corrigido

### O mecanismo de descoberta de extensões nunca era chamado

`src/features/databases/core/discover-extensions.ts` exporta
`ensureDatabaseExtensionsDiscovered()`, que carrega todo `properties/**/register.ts` e
`views/**/register.ts` por `import.meta.glob` — e **nenhum arquivo do projeto o chamava**.
`rg` achava só a própria definição.

O sintoma seria uma database que abre com todas as células vazias e nenhum tipo de
propriedade disponível, **sem erro nenhum no console**: os specs existem, são testados, e
simplesmente nunca entram no registro. Sete peças de tipo de propriedade estavam sendo
construídas contra um registro que ninguém povoava.

Corrigido chamando no carregamento de `container/DatabaseContainer.tsx`, que é o ponto de
montagem — o mesmo lugar onde o editor faz isso (`features/editor/core/Editor.tsx`).

É a terceira vez neste projeto que a mesma família de defeito aparece: código correto,
testado, e **desconectado do caminho real**. As outras duas foram o autosave que nunca
gravava e a @-menção que nunca gerava backlink.

### Seis defeitos que o `#[ignore]` escondia (05/09/2026)

A migração para SQLite tirou o `#[ignore]` de todo teste de banco — antes eles exigiam um
cluster PostgreSQL de pé e a variável `LEARNO_TEST_DATABASE_URL`, e na prática quase nunca
rodavam. Na primeira execução de verdade, seis defeitos apareceram de uma vez. Nenhum deles
foi encontrado por revisão de código; todos foram encontrados por um teste que passou a
rodar.

| Onde | O que estava errado | Sintoma |
|---|---|---|
| `db/pages.rs` | `UPDATE pages SET deleted_at = now()` | `no such function: now` — mandar página para a lixeira falhava **sempre** |
| `db/record_values.rs` | `sort_num::float8` e `ON CONFLICT ON CONSTRAINT ..._pkey` | sintaxe que só o Postgres aceita |
| `ipc/formula_commands.rs` | `property_id = ANY($2)` | SQLite não tem tipo array |
| `db/search.rs` | o arquivo **inteiro** em `tsvector`/`ts_rank`/`similarity`/`ILIKE` | a busca global (FUN-037) não funcionava de forma alguma |
| `db/relations/repository.rs` | três `INSERT` sem `id`, contando com `DEFAULT gen_random_uuid()` | `NOT NULL constraint failed` em `database_relations.id`, `database_properties.id` e `database_relation_edges.id` |
| `db/page_versions.rs` | `ORDER BY created_at DESC` sem desempate | `created_at` tem precisão de milissegundo no SQLite; dois snapshots do mesmo milissegundo empatavam e "mais novo primeiro" virava ordem indefinida — teste intermitente, causa real |

Todos corrigidos na mesma sessão, com o teste que os pegou continuando a rodar. A lição é a
mesma dos três achados da Fase 2 nomeados em `ACHADOS-FASE-2.md`, num ângulo novo: lá o
problema era teste que não atravessava a fronteira; aqui era teste que atravessava mas que
ninguém executava. **`#[ignore]` por dependência de ambiente é dívida, não configuração.**

### O motor de fórmula nunca foi compilado (05/09/2026)

`src-tauri/src/formula/` existia inteiro — léxico, sintaxe, tipos, avaliação, tabela de
funções, com testes próprios — e `lib.rs` **não declarava `pub mod formula;`**. O
`ipc/mod.rs` também não declarava `formula_commands`, e o `generate_handler!` não
registrava `validate_formula`/`preview_formula`/`list_formula_functions`. Nenhum byte da
peça F0 era compilado, e portanto nenhum dos testes dela rodava.

Descoberto ao investigar outro achado dentro daquele arquivo. Ligado agora: a suíte Rust
foi de 274 para 325 testes só por passar a compilar o que já existia.

É a **quinta** ocorrência da mesma família neste projeto — autosave, @-menção, registro de
extensões, `saveDataDir` sem chamador, e agora um subsistema inteiro. As quatro primeiras
eram uma função sem ponto de chamada; esta é um módulo sem declaração, que é a versão que
nem o compilador reclama. O que as une continua sendo: **nada que exercite a fronteira real
existia**, e a régua de "pronto" aceitava "o código está lá".

### Dois `bind` de id crus que falhavam em silêncio

No mesmo `ipc/formula_commands.rs`, `load_properties` e `load_page_meta` ligavam `Uuid` cru
contra coluna TEXT. Diferente do lado da escrita (que estoura com `cannot store BLOB value
in TEXT column`, porque as tabelas são `STRICT`), no lado da LEITURA a comparação
BLOB-contra-texto simplesmente não casa: zero linha, nenhum erro. Toda database aparecia
sem propriedade nenhuma e `preview_formula` respondia `NotFound` para qualquer página. Hoje
há quatro testes contra banco de verdade cobrindo esse caminho.

### A abertura do banco não era serializada — e o `StrictMode` a chamava duas vezes

`App.tsx` chama `open_workspace` num `useEffect`, e `React.StrictMode` monta cada efeito
duas vezes em desenvolvimento. As duas chamadas abriam o mesmo arquivo em paralelo e as
duas rodavam `migrate()`: contra um banco novo, a perdedora falhava com `table mindmaps
already exists`; contra um existente, `database is locked`. Só a suíte e2e pegou, porque só
ela sobe o app de verdade — e mesmo lá o sintoma era enganoso ("a barra lateral não
apareceu em 30s", em spec diferente a cada rodada) até o dump de tela do `wdio.conf.mjs`
mostrar o `role="alert"` com a mensagem real.

Corrigido em `AppState::lock_workspace_open`, no backend: uma abertura por vez, e a segunda
devolve a configuração em cache sem reabrir. O frontend continua livre para chamar duas
vezes — é o backend que garante.

### A armadilha de id que o contrato de migração não previa

`sqlx-sqlite` codifica `Uuid` como BLOB de 16 bytes; o schema guarda id como TEXT canônico
em tabelas `STRICT`. As duas decisões juntas quebram nos dois sentidos
(`cannot store BLOB value in TEXT column`, `ParseByteLength { len: 36 }`). A ponte é
`src/db/ids.rs` — `DbId`/`DbIdOpt` mais o trait `IdBind` —, e ela é obrigatória em todo
`.bind` de id e em todo campo de id de struct `FromRow`. Detalhe completo, com a armadilha
irmã do `IsNull::Yes`, em `docs/MIGRACAO-SQLITE.md`.

## Em aberto

### 1. `PageSurface` não tem onde encaixar as propriedades do registro

`src/features/pages/PageSurface.tsx` foi extraído de `PageWorkspace` para ser reusado pela
superfície do registro (painel lateral e página cheia). Mas a árvore dele é fechada: título,
depois a região rolável com o editor e os backlinks, sem `children`, `renderProperties` nem
qualquer ponto de extensão entre os dois.

DBS-059 e TRL-012 exigem que o painel mostre **as propriedades do registro** entre o título
e o corpo. Com a prop atual (`pageId` e nada mais), a peça que constrói a superfície do
registro não tem por onde injetá-las. Precisa de um ponto de extensão antes de S1 começar.

### 2. Efeito com `copyFrom` de propriedade apagada não é barrado

`src-tauri/src/db/effects.rs`: `validate_record_effect_references` **detecta** corretamente
que a propriedade de ORIGEM de um `copyFrom` foi apagada, mas `apply_writes` só filtra
escritas cuja propriedade de **destino** está na lista de quebradas. A escrita segue adiante,
`resolve_source` busca o valor de uma propriedade que não existe mais e encontra nada, e o
efeito grava vazio em vez de avisar.

DBS-117 pede exatamente o contrário: configuração quebrada tem que **avisar dizendo o que
falta**, nunca falhar em silêncio. O validador está certo; quem consome o resultado dele
está olhando o campo errado.

### 3. A migração 0018 divergiu do DDL que foi verificado

`docs/FASE-3-SCHEMA.sql` foi aplicado contra um Postgres real e as invariantes que ele
promete foram testadas antes de qualquer peça construir. A migração `0018` escrita depois
contém uma função e um gatilho (`cleanup_orphaned_relation`) que **não estão** nesse DDL.

Pode ser uma boa adição, mas ela não passou pela verificação que o resto passou — e o
contrato diz que quando o documento e um arquivo discordam, o documento vence até alguém
mudá-lo lá. Na migração para SQLite essa função sai de qualquer jeito (plpgsql não existe) e
vira código Rust, então o conserto acontece junto; fica registrado para não se perder.

### 4. Um relatório de peça afirmou como inexistente um arquivo que existia

A peça dos tipos escalares classificou DBS-017 como parcial alegando que
`src-tauri/tests/db_value_invariants.rs` "não existe ainda". O arquivo existia, com 420
linhas, e continha exatamente o teste que ela dizia faltar. O critic leu o arquivo e mostrou.

Não muda o código, mas muda como ler um relatório de peça: **a alegação de ausência é a
mais barata de fazer e a mais cara de acreditar**. Vale conferir por comando, não por
leitura do relatório — foi o que pegou este.

## Nota sobre dois vereditos "VIOLADA" que não são defeito das peças

As peças F0 (núcleo da linguagem de fórmula) e R2 (grafo de arestas) receberam `validade:
VIOLADA` porque o crate não compilava quando os critics rodaram. A causa foi externa a elas:
o `Cargo.toml` foi trocado de `postgres` para `sqlite` no meio da execução, pela migração de
banco que o usuário aprovou. Os erros que os critics viram (`sqlx::postgres` não resolve,
`PgPool` não existe) são consequência disso, não das peças.

Registrado para a auditoria final não contar esses dois como falha — e como lembrete de que
mexer na fundação enquanto agentes constroem em cima dela invalida o julgamento deles.
