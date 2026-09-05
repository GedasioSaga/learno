# HANDOFF — Learno

## Objetivo

Construir o Learno: um aplicativo de desktop para estudo que funde, num único produto,
um editor de blocos no modelo do Notion, um sistema de repetição espaçada no modelo do
Anki, um editor de mapa mental e um temporizador Pomodoro.

A tese do produto está na integração, não na soma: o flashcard nasce dentro da nota.
Selecionar um trecho cria um card; o card guarda uma referência viva ao bloco de origem; e a
coleção de cards é exposta como uma database nativa do lado Notion, com vencimento,
intervalo e facilidade virando propriedades filtráveis.

`docs/CHECKLIST.md` é a régua: **608 itens, 390 essenciais**, em 6 fases, cada um com
critério de aceite em Dado/Quando/Então e o tipo de teste que o prova.

## Onde parar de ler e começar a trabalhar

**Branch `fase3-e-sqlite`. O `master` está em `2091cd9`, o último commit com portão
totalmente verde (Fase 2).** Esta branch NÃO compila: a migração de PostgreSQL para SQLite
está no meio.

Três documentos, nesta ordem, antes de tocar em qualquer coisa:

1. `docs/MIGRACAO-SQLITE.md` — o contrato da migração em curso, com a evidência que a
   justifica e a tabela de equivalências.
2. `docs/FASE-3-ARQUITETURA.md` — o contrato da Fase 3, com as cinco invariantes que valem
   independentemente do banco.
3. `docs/ACHADOS-FASE-3.md` — o que está quebrado agora e por quê.

## Estado atual

- **Fase 1** fechada, 29/29.
- **Fase 2** fechada, 66/66, commitada em `master` com e2e 8/8 contra o app real.
- **Fase 3** em construção. O núcleo (contrato TS, os dois registros, as cinco migrações, o
  caminho único de escrita, a linguagem de fórmula, o kernel de agregação, o grafo de
  arestas, o motor de efeitos) existe. Oito peças de tipo de propriedade e config de view
  também. Faltam ~26 peças do plano de fan-out da §11 da arquitetura.
- **Migração para SQLite**: EM CURSO, e é o que bloqueia todo o resto.

### O que exatamente está no meio

O workflow da porta estava rodando quando esta sessão terminou. Ele já traduziu as migrações
`0001`–`0012` e mexeu em `db/pool.rs`, `formula/core/mod.rs` e `lib.rs`. **As migrações
`0013`–`0021` ainda estão em PostgreSQL.** `cargo check --lib` acusa 27 erros.

Se o workflow não tiver terminado, ele pode ser retomado:

```
Workflow({ scriptPath: "<scratchpad>/porta-sqlite.js", resumeFromRunId: "wf_99a5d3c4-6e5" })
```

Se o scratchpad tiver sido limpo, o contrato em `docs/MIGRACAO-SQLITE.md` é suficiente para
reescrever o plano: ele tem a tabela de equivalências, as quatro armadilhas e a ordem das
peças.

## Próximos passos

1. **Terminar a porta para SQLite.** Ordem: as migrações `0013`–`0021`, depois os
   repositórios (`blocks.rs` tem 13 dos 27 erros, todos da mesma causa: `Vec<Uuid>` ligado a
   `= ANY($1)`, que SQLite não tem, e o `ARRAY[position]` da CTE recursiva), depois backup e
   a remoção do assistente de conexão.
2. **Provar a cascata, não a configuração.** `PRAGMA foreign_keys` vem desligado por padrão
   e é por conexão; sem ele todo `ON DELETE CASCADE` vira no-op sem erro. O teste tem que
   apagar uma **página** e contar blocos, valores e arestas filhas.
3. **Fechar os três achados em aberto** de `docs/ACHADOS-FASE-3.md`: o `PageSurface` sem
   ponto de extensão para as propriedades do registro (bloqueia a superfície do registro,
   DBS-059 e TRL-012); o `copyFrom` de propriedade apagada que não é barrado em
   `effects.rs` (contraria DBS-117); e a migração `0018` que divergiu do DDL verificado.
4. **Retomar o fan-out da Fase 3**, os ~26 itens restantes do plano da §11, agora contra
   SQLite.
5. Fases 4 (SRS/Anki, 118), 5 (mapa, Pomodoro, painel Hoje e Biblioteca, 82) e 6 (219).

## Decisões travadas (não reabrir sem motivo novo)

| Decisão | Escolha | Quando |
|---|---|---|
| Persistência | **SQLite**, arquivo único na pasta de dados | 05/09/2026, revertendo a escolha de 02/09 |
| Papel do Python | Sidecar PyInstaller para trabalho pesado | 02/09 |
| Editor | TipTap sobre ProseMirror, com modelo de blocos próprio | 02/09 |
| Id de bloco/registro | Gerado pelo **cliente** e honrado pelo backend | 03/09 |
| Valor de propriedade | EAV com colunas geradas `sort_num`/`sort_text`, consulta em duas fases | 05/09 |
| Aresta de relação | Tabela própria — a única exceção ao EAV | 05/09 |
| Fórmula | Motor único em Rust, valor sempre materializado | 05/09 |
| Trilha | Eixo é dependência, nunca tempo; arrastar muda a dependência | 05/09 |
| Painel Hoje | Não tem dado próprio; a rotina é do usuário, o app só confere | 05/09 |
| Biblioteca | Livro é registro; PDF e EPUB; dois modos de leitura; barra só aumenta | 05/09 |

Fora de escopo por decisão explícita, para ninguém "consertar" depois: posição livre de nó
na Trilha; eixo de tempo tipo Gantt (é a view `timeline`, outra coisa); OCR de PDF
digitalizado; e converter livro para um formato interno único.

## Critério de pronto

O loop encerra quando 100% dos itens essenciais de `docs/CHECKLIST.md` passam no teste
declarado para cada um. Para a migração de banco especificamente: o portão inteiro verde
(`cargo clippy` limpo, `cargo test` sem exigir cluster, `tsc` limpo, `vitest` verde, e a
suíte e2e 8/8 contra o app real) mais o teste de cascata do passo 2.

## Evidência

- **Último portão totalmente verde** (commit `2091cd9`, Fase 2): `tsc --noEmit` exit 0;
  `vitest` 646 testes; `cargo test -- --include-ignored` 219; `clippy` limpo com
  `unwrap_used`/`expect_used` banidos; `wdio` 8/8 specs, 25 testes, exit 0.
- **Depois disso, na branch**: `vitest` chegou a 974 testes em 123 arquivos e o Rust a 276
  em 14 suítes, ambos verdes — antes de a troca do `Cargo.toml` para SQLite parar o crate.
- **A medição que decidiu o banco** (`docs/MIGRACAO-SQLITE.md`): 50.000 registros × 15
  propriedades nos dois bancos. SQLite empata ou ganha em tudo — 0,02 ms contra 0,09 ms para
  abrir a view, 0,55 contra 1,2 ms para hidratar 50 registros, 12,2 contra 29,8 ms para
  editar 1.000 valores em lote — em 53 MB contra 172 MB de disco. E FTS5 com
  `remove_diacritics 2` acha "mitocôndria" procurando "mitocondria" sem extensão nenhuma.
- **A perda declarada da migração**: `to_tsvector('portuguese')` fazia stemming (procurar
  "correr" achava "correndo"); o FTS5 com `unicode61` não faz. É perda real e está
  registrada para decisão posterior, não escondida.
- **Três defeitos da mesma família**, todos "código correto, testado, desconectado do
  caminho real": o autosave que nunca gravou bloco nenhum (Fase 2), a @-menção que nunca
  gerou backlink (Fase 2) e o registro de extensões de database que ninguém chamava (Fase 3,
  corrigido em `e75f469`). Os três estão nomeados em `docs/ACHADOS-FASE-2.md` e
  `-FASE-3.md`, com a lição: teste que não atravessa a fronteira que a feature atravessa não
  é prova.
- **Dois vereditos "VIOLADA" que não são defeito das peças**: F0 e R2 foram julgados depois
  de o `Cargo.toml` mudar para SQLite no meio da execução delas. Registrado em
  `docs/ACHADOS-FASE-3.md` para a auditoria final não os contar como falha.
- **Ambiente**: o disco `C:` encheu durante a sessão; foram liberados 18,3 GB apagando só
  `src-tauri/target/debug/incremental`, que é cache regenerável. Restam ~12 GB de 477 GB e o
  cache volta a crescer a cada build.
