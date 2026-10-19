# Learno — backlog consolidado

**Data:** 13/09/2026 · **Base:** `master` em `7f5f207`.

**Como foi produzido.** Juntei 4 análises feitas só com leitura, sem editar o repo:

1. **Docs** (44 itens): o que os próprios documentos (`HANDOFF.md`, `docs/CHECKLIST.md`, `docs/ACHADOS-FASE-*.md`, `docs/FASE-3-ARQUITETURA.md`) dizem que falta. Essa análise não conferiu o código.
2. **Código** (30 itens): testes de contrato, handlers falsos, comandos sem tela e motores sem comando. Rodou `npx vitest run src/lib/comandos-alcancaveis.test.ts src/lib/contrato-ipc.test.ts`, com 6 testes passando e 2 falhando.
3. **Produto** (53 itens): lacunas de funcionalidade por seção, comparadas com o app de referência. **Saiu de leitura de código, não do app rodando.** "Ausente" quer dizer que não foi achado nos arquivos.
4. **Qualidade** (17 itens): CI, logs, assinatura, updater, bundle e infra.

**Deduplicação.** Os itens repetidos entre as análises viraram uma linha só. Conferi com `rg` os itens de docs que podiam já estar feitos:

- **Saíram por já estarem feitos no código:**
  - leitor PDF/EPUB (`src/features/biblioteca/leitor/`);
  - tela da Trilha (`src/features/trilha/`);
  - UI de databases "sempre com erro" (`src/features/databases/loader/resolve-schema.ts`, com e2e `database-tabela`);
  - DBS-026 `updated_at` (os gatilhos existem em `src-tauri/migrations/0017_database_value_invariants.sql:104`);
  - permissão `dialog:*` (`src-tauri/capabilities/default.json:20-21`);
  - senha do Postgres (o app migrou para SQLite).
- **Os marcados `(verificar)`** têm sinal de que já foram resolvidos, mas não confirmei.

**Tamanho (normalizado):** P = até 1 dia · M = alguns dias a 1 semana · G = mais de 1 semana ou subsistema novo.

## Top 10 para as próximas sessões

A ordem põe primeiro o que destrava o resto.

1. ~~**Fazer os 2 testes de guarda do vitest passarem.**~~ **Feito em 13/09/2026.** As 6 structs de Rotina e Tags ganharam interface em `ipc.ts`; "criar categoria" ganhou tela nos dois formulários de Finanças (`NovaCategoria.tsx`); os 11 comandos de tags e rotina foram declarados em `REGISTRADOS_SEM_TELA`, com o motivo.
2. ~~**Estabilizar o vitest sob carga.**~~ **Feito em 13/09/2026.** A causa do flake era o `findBy*` com limite padrão de 1 s disputando com debounce real; agora `asyncUtilTimeout` 5 s (`src/test/setup.ts`), `testTimeout` 15 s e CSS processado só onde algum teste o lê (`vite.config.ts`). Duas suítes simultâneas passaram 2226/2226.
3. ~~**Criar o CI de teste em push/PR** (`ci.yml`): tsc, vitest, clippy, cargo test e pytest.~~ **Feito em 13/09/2026** (`.github/workflows/ci.yml`). A primeira execução pegou um teste que dependia do `rg` instalado. Depois da correção, a run `34793296565` ficou verde nos 3 jobs.
4. ~~**Implementar a importação real de `.apkg`.**~~ **Feito em 13/09/2026, sem mídia.** Notas, cartões com agendamento e histórico entram, nos formatos novo e antigo, em `.apkg` e `.colpkg`. Validado numa coleção real de 24 mil notas em 6,6 s. A mídia virou item próprio abaixo.
5. ~~**Gravar logs persistentes, com panic hook e ErrorBoundary global.**~~ **Feito em 13/09/2026**: um arquivo por dia em `%LOCALAPPDATA%\com.learno.app\logs`, 7 guardados; pânico com pilha; erros da interface no mesmo arquivo; tela de erro global; Configurações > Diagnóstico.
6. ~~**Creditar XP automaticamente em revisão, pomodoro e bloco.**~~ **Feito em 14/09/2026.** Revisão e foco já creditavam na mesma transação; faltava o bloco, que agora é pago pelo foco iniciado em "Focar neste bloco" (Plano do dia e Cronograma). O resumo de sessão também ganhou tela.
7. ~~**Instalar o plugin de notificação do sistema.**~~ **Feito em 14/09/2026**: aviso do Windows no fim de cada fase do Pomodoro e lembrete 5 min antes dos blocos de hoje, com o app aberto. Som próprio e lembrete com o app fechado ficam de fora.
8. **Criar o navegador de cartões (editar, apagar, suspender).** Hoje um cartão com erro não tem conserto.
9. **Criar o pipeline de views do database (filtro, ordenação e views salvas).** Ele destrava kanban, calendário e galeria.
10. **Assinar o instalador com Authenticode.** Hoje todo usuário novo esbarra no SmartScreen e no antivírus.

---

## Prioridade Alta

### Correções e dívida

- [x] **Criar categoria em Finanças** — o wrapper existe, mas nenhuma tela o chama, e o usuário fica preso às 13 categorias semeadas. Também é um dos 2 testes de guarda vermelhos (P) — `src-tauri/src/ipc/financas_commands.rs:31`
- [x] **Interfaces TS para as structs de Rotina e Tags** — `Rotina`, `ItemDeRotina`, `DiaDeRotinaPulado`, `AplicacaoDeRotina`, `TagSummaryRow` e `TagPageRow` estão fora do teste de contrato (P) — `src-tauri/src/db/cronograma.rs:264`
- [ ] **Tela de navegação por #tags** — `list_all_tags` e `list_pages_for_tag` não têm wrapper nem tela, então o índice de tags só existe no backend (M) — `src-tauri/src/ipc/block_commands.rs:131`
- [x] **Importação real de `.apkg` (notas, agendamento, histórico)** — feita em 13/09/2026 no Rust (`src-tauri/src/anki/`). Cobre PLT-004 e SRS-149 sem mídia.
- [ ] **Mídia do Anki e Check Media** — a importação conta a mídia e não a copia, porque a tela de estudo não mostra imagem nem áudio. Depende de "campos ricos" em Cartões. Cobre o resto de SRS-149 e PLT-015 (M) — `src-tauri/src/anki/importar.rs`
- [ ] **Importar sem o agendamento** — opção de trazer os cartões como novos (SRS-150) (P) — `src-tauri/src/anki/importar.rs`
- [x] **Crédito automático de XP** — `registrar_xp_revisao_cartao`, `registrar_xp_pomodoro_concluido`, `registrar_xp_bloco_cronograma` e `resumo_de_sessao` nunca são chamados (M) — `src-tauri/src/ipc/gamificacao_commands.rs:49`
- [ ] **Remover o comentário velho em Estatísticas** — ele diz que um erro é "esperado", mas `study_stats` existe, então um erro real seria ignorado (P) — `src/features/cartoes/Estatisticas.tsx:51`
- [ ] **Mídia com pasta de dados customizada** — falta `fs_scope().allow_directory` no `save_data_dir`, e o bloco de mídia falha para quem trocou a pasta (P) — `src-tauri/capabilities/default.json:4`
- [ ] **Detecção de ciclo entre fórmulas** — só a auto-referência direta é barrada. Sem a DFS completa, fórmulas que dependem uma da outra podem entrar em loop na cascata (M) — `src-tauri/src/ipc/formula_commands.rs:126`

### Features por seção

- [ ] **Cartões: navegador de cartões (buscar, editar, apagar, suspender, enterrar, marcar)** — `update_note`, `delete_note` e `list_notes` não têm tela, e `flags`/`is_leech` não têm interface (M) — `src/features/cartoes/AbasDeCartoes.tsx:6`
- [ ] **Cartões: limite diário de novos e de revisões por baralho** — sem ele, importar 500 cartões vira avalanche no dia seguinte (P) — `src/features/cartoes/OpcoesDoBaralho.tsx:26`
- [ ] **Cartões: desfazer a última resposta** — apertar "Errei" sem querer é frequente e hoje não tem volta (P) — `src/features/cartoes/EstudoSessao.tsx:21`
- [ ] **Notas: pipeline de views do database (filtro, ordenação, views salvas, abas)** — `open_view_query` não existe, e `set_view_config`/`reorder_view`/`delete_view` não têm tela (G) — `src-tauri/src/ipc/database_commands.rs:240`
- [ ] **Notas: visões kanban, calendário, galeria e lista** — são o principal motivo de usar database. Depende do pipeline de views (G) — `src/features/databases/views/table/`
- [ ] **Notas: modelos de página do usuário** — criar "aula" ou "resumo" em 1 clique. Hoje só existe template de registro (M) — `src-tauri/src/db/pages.rs:439`
- [ ] **Mapa mental: desfazer/refazer** — um arrasto ou uma exclusão errada no canvas não tem Ctrl+Z (M) — `src/features/mapa-mental/store.ts`
- [ ] **Mapa mental: recolher/expandir ramos** — a coluna `collapsed` existe, mas não há interface (P) — `src-tauri/src/db/mindmap.rs:65`
- [ ] **Biblioteca: busca dentro do livro e no acervo** — "onde o autor fala de X" é a tarefa nº 1 de quem estuda por PDF (M) — `src/features/biblioteca/PainelDeBiblioteca.tsx:286`
- [ ] **Biblioteca: painel e exportação de destaques** — os destaques ficam presos no livro (M) — `src/features/biblioteca/leitor/LeitorDeLivro.tsx:193`
- [ ] **Biblioteca: resumo de capítulo com interface** — falta decidir entre a tabela antiga `library_chapter_notes`, que tem comandos sem tela, e as páginas da migração 0038. O texto já gravado está invisível (M) — `src/lib/comandos-alcancaveis.test.ts:199`
- [ ] **Trilha: progresso agregado (% da trilha e por raia)** — hoje só existe o estado por etapa (P) — `src-tauri/src/db/trilha.rs:1016`
- [ ] **Cronograma: arrastar e redimensionar blocos** — o catálogo promete blocos "arrastáveis", mas a grade não tem handler de arrasto (M) — `src/features/navegacao/catalogo.tsx:97`
- [ ] **Cronograma: lembrete antes do bloco** — cronograma sem aviso é esquecido. Depende do plugin de notificação (M) — `src-tauri/Cargo.toml`
- [ ] **Prazos: lista de tarefas genérica com captura rápida** — sem to-do, o estudante abre o Todoist em paralelo (M) — `src/features/hoje/PlanoDoDia.tsx`
- [ ] **Pomodoro: som e notificação ao fim do ciclo** — com o app minimizado, o fim do foco passa despercebido (P) — `src/features/pomodoro/store.ts:150`
- [ ] **Pomodoro: durações configuráveis e início automático** — hoje `DURACAO_SEGUNDOS` é fixo em 25/5 (P) — `src/features/pomodoro/store.ts:150`
- [ ] **Pomodoro: vincular a sessão a matéria, bloco ou etapa** — `plan_block_id` nunca é preenchido, então o "realizado" não diz o que foi estudado (M) — `src-tauri/src/db/cronograma.rs:37`
- [ ] **Hoje: proteção de sequência (freeze)** — perder 60 dias de sequência por um dia doente faz abandonar o app (P) — `src-tauri/src/db/gamificacao.rs:303`
- [ ] **Finanças: orçamento por categoria com alerta** — saber antes de estourar é o recurso central do YNAB e do Mobills (M) — `src-tauri/src/db/financas.rs:516`

### Transversal

- [ ] **Onboarding com dados de exemplo** — o assistente sumiu na migração para SQLite, e um app de 8 seções aberto vazio assusta (M) — `src/features/settings/DataFolderSection.tsx:9`
- [ ] **Importar Markdown, vault do Obsidian e export do Notion** — trazer o caderno existente é condição para adotar (M) — `src-tauri/src/backup/markdown_export.rs`
- [ ] **Sync entre dispositivos / backup em nuvem** — hoje só há backup local. O "sync one-way" é citado no código e no PLT-013, mas nunca foi feito (G) — `src-tauri/src/ipc/backup_commands.rs:27`
- [ ] **Busca global em todas as entidades** — o FTS5 cobre só páginas e blocos, sem cartões, livros, mapas, prazos e lançamentos (M) — `src-tauri/src/db/search.rs:1`
- [ ] **Plugin de notificação do sistema (infra comum)** — é pré-requisito do lembrete do cronograma, do som do Pomodoro e do aviso de cartões vencendo (P) — `src-tauri/Cargo.toml`

### Qualidade e distribuição

- [x] **CI de teste/lint em push/PR** — o único workflow é o de release, sem testes, e `-SemTestes` publica sem nada (M) — `.github/workflows/release.yml:7`
- [ ] **Bancos de teste acumulando no `%TEMP%`** — os testes de banco criam `learno-<rótulo>-<uuid>.sqlite` e só apagam no `teardown`; teste que falha antes deixa o arquivo. Em 14/09/2026 eram 7,8 GB desde 05/09, e o disco chegou a 0 GB. Precisa de um guarda com `Drop` (ou uma pasta única por execução, limpa no início) (P) — `src-tauri/tests/support/mod.rs:72`
- [ ] **A suíte e2e apaga os dados reais da máquina** — `e2e/wdio.conf.mjs:117` apaga `%APPDATA%\com.learno.app` inteira (o banco, a mídia e os backups do app instalado ficam lá) e `:169` mata todo `learno.exe` pelo nome. Precisa isolar a pasta do app (um identificador próprio para e2e, ou recusar rodar quando houver `learno.sqlite` ali). Até lá, não rodar e2e na máquina de uso (P) — `e2e/wdio.conf.mjs:111`
- [x] **Logs persistentes, panic hook e ErrorBoundary global** — em release o stdout se perde e não há arquivo de log para pedir ao usuário (M) — `src-tauri/src/lib.rs:45`
- [x] **Estabilizar o vitest sob carga** — `App.test`, `EstudoSessao` e `ConteudoDeTrilha` estouram o tempo na suíte completa, o `SearchPalette` tem flake, e não há `testTimeout`/`maxWorkers` (P) — `vite.config.ts:47`
- [ ] **Assinatura Authenticode do instalador e do sidecar** — SmartScreen para todo usuário novo, e o PyInstaller sem assinatura dispara antivírus (M) — `src-tauri/tauri.conf.json`

## Prioridade Média

### Correções e dívida

- [ ] **Criação de trilha atômica** — `criarTrilhaCompleta` desfaz os passos sem transação, e se o processo cair no meio fica uma database órfã (M) — `src/lib/ipc.ts:2021`
- [ ] **`BlockRow` no teste de contrato** — o editor usa um contrato paralelo com stub em localStorage, sem comparação com o Rust (M) — `src/lib/contrato-ipc.test.ts:113`
- [ ] **Spec do tipo `status` no front** — o backend aceita o tipo, e a UI mostra "tipo desconhecido" (M) — `src-tauri/src/db/databases.rs:71`
- [ ] **Ponte entre vocabulário e cartão** — sem `note_id`/`card_id`, a mesma palavra vira cartão duplicado (M) — `src-tauri/src/ipc/vocabulario_commands.rs:5`
- [ ] **Exclusão definitiva de livro na estante** — hoje o livro só vai para a lixeira, e o arquivo continua ocupando `media/` (P) — `src-tauri/src/ipc/biblioteca_commands.rs:117`
- [ ] **Unificar o filtro por categoria da Biblioteca** — ele roda em TS, e `listar_livros_da_categoria` em Rust fica sem uso, então os dois podem divergir (P) — `src/lib/comandos-alcancaveis.test.ts:219`
- [ ] **Decidir o destino dos comandos IPC sem chamador** — são `list_databases_in_page`, `get_page_breadcrumb`, `criar_trilha`, `etapa_esta_desbloqueada` e `trigger_backup_for_risky_operation`. O doc e o teste se contradizem sobre o último (P) — `src-tauri/src/ipc/backup_commands.rs:31`
- [ ] **Motor de efeitos de registro exposto por comando** — `run_record_effect` não tem `#[tauri::command]`, e a duplicação de página com blocos (E2) não existe (G) — `src-tauri/src/db/effects.rs:32`
- [ ] **Comandos de relação entre databases** — `relation_commands.rs` nunca foi escrito, então a propriedade relation não pode ser criada pela UI (G) — `src-tauri/src/db/relations/repository.rs:246`
- [ ] **Motor de rollup** — não existe, e `change_property_type` recusa converter para relation ou rollup (G) — `src-tauri/src/db/databases.rs:29`
- [ ] **Ponto de extensão no `PageSurface` para as propriedades do registro** — trava DBS-059 e TRL-012 (verificar) (P) — `docs/ACHADOS-FASE-3.md:100`
- [ ] **`copyFrom` de propriedade apagada grava vazio** — viola DBS-117. Já existe um filtro por `MissingKind::Property` (verificar) (P) — `src-tauri/src/db/effects.rs:494`
- [ ] **Lógica `cleanup_orphaned_relation` da 0018 fora do DDL verificado** — o nome não aparece mais no código (verificar) (P) — `docs/ACHADOS-FASE-3.md:123`
- [ ] **Atualizar o CHECKLIST das fases 3 a 6** — a frase "fases 3 a 6 continuam plano, sem código" está falsa, e DBS, TRL, SRS, MAP, POM, BIB e HOJ não têm coluna Feito, então o progresso não é auditável (M) — `docs/CHECKLIST.md:39`
- [ ] **Alinhar critérios do checklist com o código** — EDT-023 (`$$` × `$`), EDT-009 (opacidade × cor), EDT-061 (e2e inexistente), DBS-117 (só "apagada"), 16 itens de fórmula vitest→cargo-test e o gatilho `.colpkg` do PLT-013 (P) — `docs/CHECKLIST.md:120`
- [ ] **Atualizar `docs/e2e.md`** — o doc diz 8 specs e há 13. Também diz que falta `custom-protocol`, e o release v0.1.0 existe (P) — `docs/e2e.md:40`

### Features por seção

- [ ] **Cronograma: tela da rotina diária e aplicar em intervalo** — os 9 comandos não têm tela, e `aplicar_rotina` recusa intervalo de datas (G) — `src-tauri/src/ipc/cronograma_commands.rs:194`
- [ ] **Cronograma: visão mensal** — para planejar a reta final antes da prova (M) — `src/features/cronograma/GradeSemanal.tsx`
- [ ] **Cronograma: exportar/assinar ICS** — para ver os estudos no calendário do celular (M) — `src/features/cronograma/`
- [ ] **Notas: nota diária com atalho** — porta de entrada do Obsidian, e combina com a seção Hoje (P) — `src/features/pages/PageWorkspace.tsx`
- [ ] **Notas: favoritos, abas e visão dividida** — estudar com nota e PDF lado a lado (M) — `src/features/pages/PageTree.tsx`
- [ ] **Notas: explicar "a cada dia" na UI da automação** — na prática é "a cada dia em que o app for aberto" (P) — `docs/FASE-3-ARQUITETURA.md:497`
- [ ] **Cartões: otimizador de parâmetros FSRS** — os pesos são fixos, e o `review_log` é gravado sem ser usado para ajuste (M) — `src-tauri/src/srs/fsrs.rs:107`
- [ ] **Cartões: campos ricos (imagem, áudio, LaTeX) e oclusão de imagem** — anatomia, mapas e idiomas dependem de mídia (G) — `src/features/cartoes/CriarCartao.tsx`
- [ ] **Mapa mental: exportar PNG/SVG/PDF e importar/exportar Markdown/OPML/XMind** — para imprimir, compartilhar e trazer mapas antigos (M) — `src/features/mapa-mental/`
- [ ] **Mapa mental: layouts árvore, organograma e espinha de peixe; forma e ícone no nó** — as colunas `shape`/`icon` existem sem interface (M) — `src/features/mapa-mental/CartaoNode.tsx:33`
- [ ] **Biblioteca: metadados automáticos (ISBN/DOI) e citação ABNT/BibTeX** — trabalho acadêmico exige referência (M) — `src-tauri/src/db/biblioteca.rs:413`
- [ ] **Biblioteca: tema de leitura (sépia/escuro) e sumário no PDF** — para leitura longa à noite e PDF de 400 páginas (P) — `src/features/biblioteca/leitor/epub/LeitorEpub.tsx:296`
- [ ] **Biblioteca: balão ao clicar na palavra marcada** — hoje o sublinhado ondulado só marca a palavra no texto. Clicar nela deveria abrir um balão com o significado, os sinônimos e os antônimos. Adiado pelo usuário em 18/10/2026 (M) — `src/features/biblioteca/leitor/marcacao-de-vocabulario.ts:215`
- [ ] **Trilha: domínio derivado da retenção do baralho ligado** — fecha a tese do produto: a trilha avança pelo que você sabe de fato (M) — `src-tauri/src/db/trilha.rs:48`
- [ ] **Prazos: recorrência** — para entregas semanais e revisões fixas (P) — `src-tauri/src/db/prazos.rs:46`
- [ ] **Prazos: prioridade e subtarefas** — para quebrar um TCC em etapas (P) — `src-tauri/src/db/prazos.rs`
- [ ] **Pomodoro: mini-janela sempre visível ou ícone na bandeja** — para ver o tempo restante com o PDF em tela cheia (M) — `src/features/pomodoro/`
- [ ] **Hoje: medalhas desbloqueáveis** — hoje "Conquistas" são só recordes, sem metas de médio prazo (M) — `src/features/gamificacao/PainelDeConquistas.tsx:28`
- [ ] **Hoje: meta diária configurável com anel de progresso** — uma meta pessoal pesa mais que desafio gerado (P) — `src/features/hoje/ConteudoDeHoje.tsx:36`
- [ ] **Finanças: contas e cartão de crédito (fatura, fechamento, parcelas)** — o parcelado é a maior surpresa do mês (G) — `src-tauri/src/db/financas.rs`
- [ ] **Finanças: importar extrato OFX/CSV e exportar CSV** — digitar cada lançamento à mão faz largar o app (M) — `src/features/financas/Lancamentos.tsx`
- [ ] **Finanças: gráficos e busca em lançamentos** — hoje só há listas (P) — `src/features/financas/VisaoGeral.tsx:45`

### Transversal

- [ ] **Tela de atalhos (Ctrl+/) e atalhos personalizáveis** — os atalhos que já existem não são descobertos (P) — `src/components/AppShell.tsx:57`
- [ ] **Companheiro mobile para revisão de cartões** — é na fila do ônibus que o SRS mais rende. Depende do sync (G) — n/a
- [ ] **Acessibilidade: focus trap, teclado no canvas e `aria-rowcount`/`aria-rowindex` na grade virtualizada** — invisível a olho nu e devastador para leitor de tela (M) — `docs/FASE-3-ARQUITETURA.md:828`

### Qualidade e distribuição

- [ ] **e2e por seção: Mapa mental, Trilha, Cronograma, Biblioteca, Hoje** — o e2e é a única camada que atravessa o IPC de verdade, e as 13 specs atuais não cobrem essas seções (M) — `e2e/specs/`
- [ ] **Testes cruzados T1 nos 5 pontos que disputam o mesmo DOM** — virtualização × editor, arrasto × abrir etc. Cada suíte isolada deixa essa família de bug passar (M) — `docs/FASE-3-ARQUITETURA.md:805`
- [ ] **e2e de DBS-016 com pasta de dados customizada** — na pasta padrão o teste fica verde sobre feature quebrada (P) — `docs/FASE-3-ARQUITETURA.md:858`
- [ ] **Gate de e2e no release/CI** — a suíte que pegou 3 bugs reais não protege nenhum release (M) — `scripts/publicar.ps1:47`
- [ ] **Updater: "Verificar agora", versão atual e notas da versão** — a falha do check é engolida, e `update.body` nunca é lido (P) — `src/components/AtualizadorBanner.tsx:26`
- [ ] **Actions fixadas por SHA; `setup-python@v6`; Node fixo** — o job recebe a chave de assinatura do updater (P) — `.github/workflows/release.yml:19`
- [ ] **Proteção de branch na `master`** — push direto sem CI, e as tags de release saem dela (P) — n/a (config do GitHub)
- [ ] **Lazy load dos leitores PDF/EPUB** — o chunk inicial tem 2,3 MB mesmo para quem nunca abre livro (P) — `src/features/biblioteca/leitor/LeitorDeLivro.tsx:14`
- [ ] **Reduzir `target/` (17,8 GB)** — o disco cheio já apareceu como falso bug (`os error 112`). A saída é `debug = "line-tables-only"` ou `CARGO_TARGET_DIR` (P) — `src-tauri/Cargo.toml`
- [ ] **Medir performance em SQLite** — as medições são de Postgres, os penhascos (backfill de 1,79 s, cadência de 25 s, partida fria de 18,3 s) não têm orçamento testado, e o PLT-017 está pendente (M) — `docs/FASE-3-MEDICOES.md:15`

## Prioridade Baixa

### Correções e dívida

- [ ] **Remover ou manter o `EstadoEmConstrucao` genérico** — hoje não aparece para ninguém (P) — `src/features/navegacao/catalogo.tsx:143`
- [ ] **DNS rebinding no cartão de bookmark** — hostname público com registro A privado passa a checagem. É risco residual aceito (M) — `docs/ACHADOS-FASE-2.md:99`
- [ ] **Botão "Abrir" do bloco de arquivo com o plugin `opener`** — hoje ele usa âncora crua, divergente do bookmark (P) — `docs/ACHADOS-FASE-2.md:137`
- [ ] **Avisos de `act()` em `TrashDialog`, `Breadcrumb` e `VersionHistoryDialog`** — falso-verde esperando para acontecer (verificar) (P) — `docs/ACHADOS-FASE-1.md:70`
- [ ] **Resíduos visuais da Fase 1** — ícone genérico, barra "Exportar como Markdown" com peso de ação principal, "Sem título" fantasma no breadcrumb, paleta e Configurações cobrindo a sidebar. Podem ter sido resolvidos na repaginada de 05/09 (verificar) (P) — `docs/ACHADOS-FASE-1.md:44`
- [ ] **Biblioteca: palavra partida ou hifenizada não é marcada** — a busca roda nó de texto por nó de texto, então uma palavra com um `<em>` no meio, ou hifenizada na quebra de linha do PDF ("vo-" e "raz"), fica sem sublinhado. É limitação aceita (M) — `src/features/biblioteca/leitor/marcacao-de-vocabulario.ts:13`

### Features por seção

- [ ] **Notas: visão de grafo e `[[wikilink]]`** — hábito de quem vem do Obsidian (M) — `src/features/editor/marks/mention-page/`
- [ ] **Mapa mental: copiar/colar nós, busca no mapa e minimapa** — para navegar em mapa grande (P) — `src/features/mapa-mental/ConteudoDeMapaMental.tsx:214`
- [ ] **Trilha: trilhas-modelo exportáveis em JSON** — para reaproveitar o edital montado por outra pessoa (M) — `src-tauri/src/db/trilha.rs`
- [ ] **Prazos: rastreador de hábitos** — hábito é o motor do estudo contínuo, e `routine_id` não é hábito (M) — `src-tauri/src/db/prazos.rs`

### Transversal

- [ ] **Internacionalização (inglês/espanhol)** — não há biblioteca de i18n, e as strings pt-BR estão fixas no código (G) — n/a

### Qualidade e distribuição

- [ ] **Testes do sidecar empacotado na suíte** — os 4 `#[ignore]` precisam do binário do PyInstaller, então a ida e volta Tauri → sidecar não roda no dia a dia (P) — `src-tauri/src/sidecar/mod.rs:344`
- [ ] **Sidecar: lock das dependências de build e pytest no CI/publicar** — só há piso de versão do PyInstaller (P) — `sidecar/pyproject.toml:12`
- [ ] **Dependabot e `npm audit`/`cargo audit` agendados** — inclui as 15 vulnerabilidades de devDependency na cadeia do WebdriverIO (P) — `package.json:79`
- [ ] **Aviso de rollback de migração e teste de upgrade a partir da v0.1.0** — o restore abre com `connect_and_migrate`, sem rede de segurança (P) — `src-tauri/src/ipc/backup_commands.rs:290`
- [ ] **Testes faltantes de interação** — EDT-074 com duas páginas abertas, sem refresh, e FUN-004/FUN-006 com arrasto de mouse (M) — `docs/ACHADOS-FASE-2.md:131`
- [ ] **Teste em runtime de CSP, `assetProtocol` e `deny` de 127.0.0.1** — hoje só a sintaxe é validada (M) — `docs/ACHADOS-FASE-2.md:142`
- [ ] **Acessibilidade automática (axe)** — sem ela, regressões de teclado e contraste passam despercebidas (M) — `e2e/wdio.conf.mjs`
- [ ] **Build multiplataforma (macOS, Linux, ARM64)** — hoje é só Windows x64. É decisão de produto e caso de `arquiteto-solucoes` (G) — `.github/workflows/release.yml:14`
