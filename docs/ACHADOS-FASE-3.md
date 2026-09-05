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
