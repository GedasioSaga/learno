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

**Branch `fase3-e-sqlite`.** A migração de PostgreSQL para SQLite está **concluída** — Rust,
TypeScript, testes e e2e. O portão inteiro está verde, o e2e incluído (8/8 specs contra o
app real, rodado quatro vezes seguidas).

Três documentos, nesta ordem, antes de tocar em qualquer coisa:

1. `docs/MIGRACAO-SQLITE.md` — o contrato da migração, com a tabela de equivalências e as
   sete armadilhas (as quatro previstas mais as três que só a execução revelou).
2. `docs/FASE-3-ARQUITETURA.md` — o contrato da Fase 3, com as cinco invariantes que valem
   independentemente do banco.
3. `docs/ACHADOS-FASE-3.md` — o que está quebrado agora e por quê.

## Estado atual

- **Fase 1** fechada, 29/29 — com PLT-002/011/016/020 reescritos para o mundo SQLite (ver a
  seção de revisão no fim de `docs/CHECKLIST.md`).
- **Fase 2** fechada, 66/66, commitada em `master` com e2e 8/8 contra o app real.
- **Fase 3** em construção. O núcleo (contrato TS, os dois registros, as cinco migrações, o
  caminho único de escrita, a linguagem de fórmula, o kernel de agregação, o grafo de
  arestas, o motor de efeitos) existe. Oito peças de tipo de propriedade e config de view
  também. Faltam ~26 peças do plano de fan-out da §11 da arquitetura.
- **Migração para SQLite**: concluída no código. Ver a seção Evidência.

### O que a migração mudou, em uma tela

- O banco é `learno.sqlite` dentro da pasta de trabalho. Sem servidor, sem host, porta,
  usuário ou senha — em lugar nenhum do código.
- **O assistente de primeira execução deixou de existir** (`FirstRunWizard.tsx` apagado). O
  app abre direto: `App.tsx` chama `open_workspace`, que cria o arquivo e migra. Trocar de
  pasta virou configuração (`save_data_dir`), e trocar leva o banco junto quando a pasta
  nova está vazia.
- Backup deixou de ser `pg_dump` e virou `VACUUM INTO`; restaurar verifica o arquivo
  (`PRAGMA integrity_check` mais a presença de `_sqlx_migrations`) antes de substituir,
  fecha o pool, troca, reconecta, e deixa o banco anterior copiado ao lado.
- **A ponte de id é obrigatória**: `src/db/ids.rs` (`DbId`/`DbIdOpt`/`IdBind`). O `sqlx`
  codifica `Uuid` como BLOB e o schema guarda id como TEXT; ligar um `Uuid` cru falha. Todo
  `.bind` de id usa `.db()`, e toda struct `FromRow` usa `#[sqlx(try_from = "DbId")]`.
- Nenhum teste de banco é mais `#[ignore]`. Os 4 que sobram são do sidecar Python.

## Próximos passos

1. **O leitor de PDF/EPUB depende de uma decisão do usuário**, e ela está pendente:
   instalar `pdfjs-dist` e `epubjs` (regra 12 — avisar antes de instalar). Sem a resposta,
   a Biblioteca continua sendo só a estante, e os quatro comandos `abrir_livro`,
   `registrar_progresso`, `listar_anotacoes` e `criar_anotacao` seguem registrados sem
   nenhuma tela que os chame — declarados como dívida em
   `src/lib/comandos-alcancaveis.test.ts`.
2. **A Trilha ainda não tem tela.** O backend está pronto e testado (11 testes de
   integração, níveis por Kahn, ciclo tratado) e o contrato TypeScript está escrito, mas
   `src/features/trilha/` não existe — a seção mostra "Em construção". Ela depende de a UI
   de databases existir, porque o `viewId` que ela consome nasce de uma view.
3. **A UI de databases é o elo que falta.** Os 19 comandos existem e os wrappers TS também;
   nenhum componente os chama ainda. `DatabaseBlockView.tsx` devolve erro sempre, à espera
   de `get_database_schema`.
4. **Cobertura de e2e por seção.** Só existe para editor, páginas e tema, mais a spec nova
   de Cartões. Faltam Mapa mental, Trilha, Cronograma, Biblioteca e Hoje. Isto importa mais
   do que parece: o e2e é a ÚNICA camada deste projeto que atravessa o fio de verdade — o
   vitest mocka o `ipc.ts` e os testes Rust chamam as funções `_inner` direto, com structs
   Rust construídos em Rust, então o `serde_json` do meio nunca entra em cena. As sete
   costuras de IPC quebradas viviam exatamente nesse buraco.
5. Fechar os três achados em aberto de `docs/ACHADOS-FASE-3.md` e retomar o fan-out da §11.

## As três travas contra o defeito mais repetido do projeto

Este repositório já entregou **dez vezes** código pronto, testado, revisado — e inalcançável.
Autosave que nunca gravou bloco; @-menção sem backlink; registro de extensões sem chamador;
`saveDataDir` órfão; o motor de fórmula inteiro fora do `lib.rs`; a seção Cartões mostrando
"Em construção" com tudo pronto; `deckForecast` exposto e nunca chamado; `study_stats` com
repositório completo e nenhum comando; `excluir_livro_definitivamente` fora do
`generate_handler!`; e o subsistema de databases inteiro — nove migrações, ~2.600 linhas de
Rust, 64 arquivos de componente, e os únicos `INSERT INTO databases` do projeto vivendo
dentro de fixtures de teste.

Nenhuma foi pega por revisão nem por suíte verde, porque cada teste provava a PEÇA e o que
faltava era a LIGAÇÃO. As três travas abaixo testam só a costura:

| Arquivo | O que impõe |
|---|---|
| `src/features/navegacao/toda-tela-e-alcancavel.test.ts` | todo `ConteudoDe*` que existe está montado em `App.tsx` |
| `src/lib/comandos-alcancaveis.test.ts` | todo `#[tauri::command]` está no `generate_handler!`; todo comando chamado existe; **todo comando registrado é chamado** (dívida declarada em `REGISTRADOS_SEM_TELA`, com motivo) |
| `src/lib/contrato-ipc.test.ts` | campo por campo, o que o Rust serializa bate com o que o `ipc.ts` declara — nomes, `rename_all` do serde, e `Option<T>` que chega `null` onde o TS prometeu valor |

As três leem o TEXTO dos dois lados de propósito: tipo TypeScript some na compilação e
`generate_handler!` é macro que só existe depois do `cargo build`, então não há como
importar nenhum dos dois em tempo de execução.

**Cada uma foi verificada quebrando o código de propósito e vendo o teste ficar vermelho.**
Trava que nunca falhou não prova que guarda.

## A repaginada visual (05/09/2026)

O app tinha cara de rascunho: paleta clara nascida do ícone, escuro feito por tradução
literal dela, e a escolha de tema num botão solto que só alternava dois estados. Agora:

- **Cinco temas**, cada um um bloco `[data-theme="<id>"]` em `src/styles/theme.css`:
  Âmbar noturno (escuro, o padrão), Papel, Grafite, Meia-noite e Alto contraste. Mais
  "seguir o sistema", resolvido em JavaScript.
- **`docs/DESIGN-TOKENS.md`** é o contrato do sistema visual — tokens por tema com o
  contraste MEDIDO de 28 pares em cada, escala tipográfica, régua de espaçamento, níveis de
  elevação, os seis estados de um controle e as regras de movimento. Tela nova valida contra
  ele (§10).
- **Instalação nova abre em Âmbar noturno**, não seguindo o sistema: a primeira impressão é
  sempre a identidade do produto.
- **A preferência foi para o `config.json`** (`get_theme`/`save_theme`), com o
  `localStorage` rebaixado a cache de primeiro paint. O tema era a última configuração fora
  do store.
- **Configurações viraram tela com navegação** (Aparência, Banco de dados, Backup,
  Importar). As quatro seções que já existiam foram remontadas, não reescritas.
- **Toda cor passou a seguir o tema.** Uma camada de matiz (`--matiz-*`, definida uma vez)
  mais `color-mix` com os tokens do tema substituiu a paleta paralela das etiquetas de
  database e a do menu de cor do editor — um tema escuro produz etiqueta escura sozinho. As
  14 sombras de preto fixo do editor viraram a escala de elevação.

### O que a inspeção visual pegou, e nenhum teste pegaria

- **As seis amostras da tela de Aparência saíam todas iguais.** O `@theme` do Tailwind
  resolve `--color-paper: var(--paper)` UMA vez, em `:root`; o valor que desce por herança
  já é a cor final, não a referência. Um `data-theme` aninhado trocava `--paper` e o
  utilitário `bg-paper` não mudava nada. Corrigido com uma regra `[data-theme]` que refaz a
  indireção em todo elemento temado. Sem olhar a tela, a suíte continuaria verde com seis
  amostras mentindo sobre o tema que representam.
- **"Exportar como Markdown" era uma faixa da largura inteira** no cabeçalho da página: o
  controle mais raro da tela era o mais gritante. Virou ação secundária ao lado de
  "Histórico", com o nome acessível inteiro preservado.
- **O editor não tinha largura de leitura** — o texto ia de ponta a ponta da janela. Agora
  respeita `--measure` (65ch).

## A fatia de 05/09/2026 — o app virou produto

Antes desta fatia o app inteiro era uma tela: árvore de páginas + editor. O schema de
estudo (decks, notes, cards com SM-2 e FSRS, review_log, mindmap, pomodoro) existia desde a
Fase 1 e **nada o alcançava** — zero repositório, zero comando, zero tela.

Agora existe uma casca de navegação com sete seções (`src/features/navegacao/`): rail
estreito + painel por seção + conteúdo, com `Ctrl+1`…`Ctrl+7`. Três estão vivas (Hoje,
Notas, Cartões, Mapa mental); Trilha, Cronograma e Biblioteca aparecem no rail com um
estado que diz o que serão — sem número inventado.

- **Backend novo**: `src/srs/` (agendador SM-2 puro, tempo por parâmetro, fuzz determinístico
  por semente), `db/decks.rs`, `db/notes.rs`, `db/cards.rs`, `db/mindmap.rs`,
  `db/pomodoro.rs`, mais os comandos IPC de cada um.
- **Banco novo**: `0022_biblioteca.sql`, `0023_trilha.sql`, `0024_cronograma.sql`. As 24
  migrações aplicam juntas num arquivo novo — verificado, não presumido.

### Os dois defeitos que o paralelismo produziu, e como foram arbitrados

1. **Vocabulário divergente entre peças.** O agendador publicou `easy_bonus_pct` e a fila de
   estudo consumia `easy_bonus_permil`. Build quebrado. Confirmada a escala **×100**: a
   coluna é `ease_factor INTEGER DEFAULT 250`, então os deltas são ±15, não ±150 — o brief
   do orquestrador estava errado e o agente acertou ao contrariá-lo.
2. **`create_note` falharia sempre**, na serialização: Rust esperava `Vec<String>` posicional
   e o frontend mandava objeto por nome. Nenhum teste pegou porque todos chamavam o `_inner`
   direto, sem atravessar a fronteira de IPC. Resolvido **para objeto por nome nos dois
   lados** — contrato posicional deslocaria em silêncio o conteúdo de toda nota já gravada
   quando o usuário renomeasse ou reordenasse um campo do tipo de nota.

### A sexta ocorrência do defeito de sempre, e a trava que ela ganhou

`src/features/cartoes/` estava inteiro — árvore de baralhos, sessão de estudo, criação de
nota, tudo testado — e a seção mostrava "Em construção", porque `montarSecoes` em `App.tsx`
não a listava. Sexta vez que este projeto perde uma feature por código correto sem ponto de
chamada.

Desta vez ganhou trava: `src/features/navegacao/toda-tela-e-alcancavel.test.ts` varre o
código atrás de todo `ConteudoDe*` exportado e falha se algum não estiver montado em
`App.tsx`. Ela se mantém sozinha — uma seção nova entra na conta no instante em que o
arquivo aparece.

## Decisões travadas (não reabrir sem motivo novo)

| Decisão | Escolha | Quando |
|---|---|---|
| Persistência | **SQLite**, arquivo único na pasta de dados | 05/09/2026, revertendo a escolha de 02/09 |
| Papel do Python | Sidecar PyInstaller para trabalho pesado | 02/09 |
| Editor | TipTap sobre ProseMirror, com modelo de blocos próprio | 02/09 |
| Id de bloco/registro | Gerado pelo **cliente** e honrado pelo backend | 03/09 |
| Id no banco | TEXT canônico com hífens, sempre pela ponte `db::ids` | 05/09 |
| Valor de propriedade | EAV com colunas geradas `sort_num`/`sort_text`, consulta em duas fases | 05/09 |
| Aresta de relação | Tabela própria — a única exceção ao EAV | 05/09 |
| Fórmula | Motor único em Rust, valor sempre materializado | 05/09 |
| Primeira execução | Sem assistente: abre, cria o arquivo, migra e funciona | 05/09 |
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
suíte e2e contra o app real). Tudo isso está satisfeito.

## Evidência

### Repo público e auto-update pelo GitHub (13/09/2026)

- Repo `https://github.com/GedasioSaga/learno` (público, branch `master`). Release v0.1.0 publicado pelo run `34788793978` (`gh run watch --exit-status`: exit 0). Assets: `learno_0.1.0_x64-setup.exe` (17,3 MB), `.sig` e `latest.json`.
- `releases/latest/download/latest.json` responde `version=0.1.0` com assinatura de 416 bytes.
- `cargo test`: todas as suítes `ok` (lib: 894 passed, 0 failed). `tsc --noEmit`: exit 0. `AtualizadorBanner.test.tsx`: 6/6.
- **Pendente:** 2 testes-guarda do vitest falham desde antes (`comandos-alcancaveis`, `contrato-ipc`). É dívida de Rotina/Finanças: comandos sem tela e structs fora do contrato. Por isso `publicar.ps1` precisa de `-SemTestes` até corrigir.
- Não testado ainda: instalar a v0.1.0 e ver o banner oferecer a v0.1.1 de verdade.

### Biblioteca: estante organizada e páginas de anotação (08/09/2026)

Portão inteiro, verde:

- `rtk proxy cargo test`: **929 testes, 0 falhas**.
- `rtk proxy cargo clippy --all-targets --all-features -- -D warnings -W clippy::unwrap_used
  -W clippy::expect_used`: **0 erros**.
- `rtk proxy npx tsc --noEmit`: **exit 0**.
- `rtk proxy npx vitest run`: **1882 testes em 200 arquivos, 0 falhas**.

O que entrou: categorias aninhadas (0036), título/autor editáveis e ordem personalizada da
estante (0037), páginas de anotação criadas pelo usuário no leitor (0038), painel de categorias
repaginado, capa do EPUB, e o CSP liberando `blob:`.

#### ARRASTAR NA ESTANTE: TRÊS causas empilhadas, e as duas primeiras foram palpite meu

Vale ler antes de mexer em qualquer arrastar-e-soltar deste projeto. O usuário reportou "fica o
sinal de negação"; eu remendei o JavaScript **duas vezes** antes de achar a causa real.

1. **`dragDropEnabled` do Tauri — A CAUSA DE VERDADE.** Em `tauri.conf.json`, a opção da janela
   nasce `true` (confirmado no `config.rs` do `tauri-utils` via ctx7). Com ela ligada, o Tauri
   registra no WebView2 o manipulador de arrastar-arquivo do SISTEMA OPERACIONAL, que intercepta
   o gesto **antes de a página vê-lo**. Nenhuma correção em JavaScript resolve, porque o evento
   não chega. Agora está `false`, e a linha está documentada em `GradeDeLivros.tsx` — quem a
   reativar quebra o arrastar da estante E o da árvore de páginas junto.
2. **A `<img>` da capa roubava o gesto.** Imagem é arrastável por padrão; como a capa é a maior
   área do cartão, o navegador tentava arrastar a IMAGEM em vez do cartão. `draggable={false}`.
3. **`preventDefault` depois de um guarda de estado do React.** `dragover` só autoriza o drop se
   chamar `preventDefault`, e a chamada estava atrás de um `if` que lia `arrastandoId` — estado
   escrito em `dragstart`. Os primeiros eventos chegam antes do re-render, o `if` lia `null`, e o
   gesto nascia proibido. Autorizar sempre; o estado serve só para o destaque.

**E um quarto defeito, que só o relato preciso do usuário revelou:** "num sentido deixa, no outro
não". Soltar sobre um cartão significava sempre "pousa logo DEPOIS dele" — então arrastar o
segundo sobre o primeiro pedia "põe o segundo depois do primeiro", que é onde ele já estava. Não
era recusa, era pedido sem efeito, e **metade dos arrastes de um par era inútil por construção**.
Agora vale o LADO do cartão (metade esquerda = antes, direita = depois), com marca no lado onde
o livro vai cair. O comentário antigo dizia que numa grade não havia eixo óbvio para
antes/depois; estava errado — a grade flui da esquerda para a direita.

#### Duas armadilhas de TESTE desta rodada (as duas davam verde provando nada)

- **`clientX` não sobrevive ao evento sintético.** O jsdom não implementa `DragEvent`, então a
  testing-library cai num `Event` genérico e descarta propriedades de mouse. Todo teste de
  "metade esquerda" media a metade direita e passava com o defeito de volta. Os eventos agora são
  construídos à mão (`createEvent` + `Object.defineProperty`) em `GradeDeLivros.test.tsx`.
- **Teste de ciclo em categoria passava sem exercitar nada.** `listar_livros_da_categoria` junta
  com `library_book_categories`; sem NENHUM livro ligado, a consulta é trivialmente vazia e o
  SQLite nem percorre a recursão. O teste terminava rápido e passava mesmo com
  `MAX_CATEGORY_DEPTH` removido. Medido: com um livro ligado e o teto em 100 milhões, a consulta
  leva ~58s; com o teto real, 0,1s. O teste agora liga um livro.

#### ARMADILHA DE GIT: 29 arquivos staged como VAZIOS

`git ls-files -s src/features/biblioteca/` mostrava blob `e69de29…` (o hash do arquivo vazio) em
29 arquivos, com o conteúdo real intacto no disco. **Um `git commit` gravaria a Biblioteca inteira
em branco.** Herança de sessão anterior, não das mudanças do dia. Resolvido com `git add`
novamente, conferindo tamanho de índice contra disco. Se aparecer de novo:
`git ls-files -s | grep e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`.

#### Dívida declarada nesta rodada

- `listar_livros_da_categoria` (Rust) sem tela: o filtro expande descendentes no TypeScript, com a
  árvore que a tela já tem em memória. A travessia existe nos DOIS lados e nada trava as duas
  juntas — quem ligar o comando um dia deve APAGAR a versão TypeScript no mesmo commit.
- `salvar_resumo_de_capitulo` / `listar_resumos_do_livro` / `remover_resumo_de_capitulo`: a feature
  foi substituída por páginas do usuário (0038). A tabela antiga continua no banco e **nenhuma
  tela lê os resumos já escritos**. As duas saídas honestas: importar os resumos antigos para
  páginas, ou apagar tabela e comandos juntos depois de confirmar que não há nada escrito.

#### Disco

**3,7 GB livres.** `src-tauri/target/debug` = 13,7 GB; o temporário do Claude = 7,2 GB, quase todo
de OUTROS projetos do usuário (Magic 3,7 GB, Projeto Genesis 2,8 GB) — não apagar sem pedir. Já
zerou uma vez nesta sessão e quebrou build.

### Tags `#assim` (07/09/2026) — backend

Bar: Obsidian. Tag inline no meio do texto, aninhada com `/`, com um jeito de ver todas e
chegar às notas de cada uma.

**O estado que motivou a peça:** páginas não tinham tag nenhuma, e as tags de CARTÃO
existiam pela metade — `notes.tags` guarda, `createNote` aceita, `CriarCartao.tsx` tem campo
para digitar, e **nada em lugar nenhum filtra ou navega por tag**. As tags entram e nunca
mais são vistas. Por isso os comandos de consulta (`list_all_tags`, `list_pages_for_tag`)
foram critério de aceite desta peça, não extra: sem eles a tag é enfeite, e o enfeite já
existia.

**Onde a tag mora:** tabela de índice (`0041_tags.sql`: `tags` + `block_tags`), alimentada
pelo Rust em cada ponto de escrita de bloco. Trigger SQL foi descartado por um motivo
concreto: a extração precisa ser Unicode-aware — acento, emoji, casefold — e o SQLite não
faz isso, nem dá para registrar função customizada pelo driver `sqlx`. Coluna denormalizada
em `pages` foi descartada por duplicar a fonte de verdade.

O custo dessa escolha está escrito no topo de `db/tags.rs`: chamar à mão em cada caminho de
escrita reintroduz o risco de "N lugares podem esquecer" que o comentário de
`block_page_links` já nomeia. Os pontos cobertos estão listados lá — `create`,
`create_in_tx`, `create_synced_copy`, `update`, `apply_changes` e o `INSERT` bruto de
`duplicate_blocks_for_page`, que é a armadilha que o comentário do trigger de backlinks já
apontava.

`block_tags` guarda só `block_id`/`tag_id`, **sem `page_id`** — a página vem de JOIN vivo com
`blocks.page_id`, o que elimina qualquer bookkeeping ao mover bloco.

Decisões, todas testadas: identidade **case-insensível** (`#Biologia` == `#biologia`), como
no Obsidian; `#tag` dentro de bloco de código **não conta** (span de código inline dentro de
parágrafo não é tratado, e isso está declarado no código); hierarquia resolvida na
**consulta**, não materializada no índice, com `substr`/concatenação em vez de `LIKE` para
não deixar o `_` do wildcard virar coringa acidental.

**Um defeito que o disco escondeu.** O builder escreveu o teste certo — `##biologia` não é
tag — e **não conseguiu rodá-lo**: o disco chegou a 545 MB e o `cargo test` falhou com
`Espaço insuficiente no disco (os error 112)`. O `clippy` passou limpo no mesmo instante,
porque ele só faz `check` e não precisa linkar a biblioteca inteira. Ou seja: **um portão
verde que não provava nada sobre comportamento.** O builder parou e avisou em vez de apagar
nada, que é a regra desta máquina.

A causa, depois que houve espaço: `is_tag_boundary` respondia **duas perguntas diferentes**
com uma função só — "o que termina uma tag" e "o que pode vir antes de uma tag". Para `#` as
respostas divergem: ele termina uma tag, mas não pode abrir a seguinte. Em `##biologia` o
primeiro `#` era corretamente recusado, e aí o **segundo** era aceito, porque o `#` à
esquerda contava como fronteira válida. Corrigido separando as duas perguntas, com o porquê
no código.

Portão desta rodada:

- `cargo clippy --all-targets --all-features -- -D warnings -W clippy::unwrap_used
  -W clippy::expect_used`: **exit 0**.
- `cargo test --jobs 2`: **25 suítes, 879 testes, 0 falhas**, incluindo 12 de integração de
  tags contra banco real — hierarquia alcançando página que só tem a tag aninhada,
  case-insensível ponta a ponta, dedupe por página, editar remove a tag, apagar bloco remove
  a tag, mover bloco leva a tag para a página nova, duplicar página leva a tag, cópia
  sincronizada ganha tags próprias, página na lixeira some da tag, e migração sobre banco
  pré-existente.

**Falta a peça de tela:** a marca `#` no editor e o painel para navegar. Sem ela as tags
novas repetem exatamente o estado das tags de cartão — gravadas e inalcançáveis. É a próxima.

### O gesto do produto (07/09/2026) — selecionar um trecho vira lacuna

A rodada anterior entregou o cloze inteiro — tipo de nota, parser, um cartão por lacuna,
renderização na tela de estudo — e ele era **inalcançável pelo gesto que o produto promete**:
só dava para criar digitando `{{c1::}}` à mão, o que ninguém faz. O tipo mais usado do Anki
estava no app, e o gesto da tese (*"selecionar um trecho cria um card"*) só produzia
frente/verso. É o defeito histórico deste repositório numa variante nova: não código sem
chamador, mas **feature sem o gesto**.

**A decisão de desenho: as lacunas são marcadas dentro do formulário, sobre uma cópia do
texto do bloco — nunca na página.** Acumular seleções na própria página exigiria decorações
no editor que *parecem* edição, e "criar um cartão editou minha nota" é a surpresa que se
descobre tarde e custa confiança. Uma cópia dentro de um diálogo deixa o bloco visivelmente
intocado atrás. Além disso, a prévia de quantos cartões nascem só faz sentido ao lado do
texto, e só existe se houver um lugar para ela antes de salvar.

**A distinção do Anki foi preservada, e ela não é detalhe:** `Ctrl+Shift+C` incrementa o
número (duas perguntas separadas) e `Ctrl+Shift+Alt+C` reusa o mesmo (uma pergunta com dois
buracos). Isso muda quantos cartões nascem e é decidido no gesto. Aparece na tela sem
explicação escrita: cada botão **carrega o número que vai produzir** (`Nova lacuna [2]` vs
`Mesma lacuna [1]`), desenhado com a mesma peça visual da lacuna na tela de estudo, e a
lista abaixo mostra uma prévia por cartão. "Nova lacuna" faz um cartão a mais **aparecer**;
"Mesma lacuna" só abre outro buraco no que já existia. O botão de salvar diz "Criar N
cartões".

Detalhe de modelo que segue o Anki: remover a `c1` **não renumera** a `c2` — a próxima é
`c3`. O número de cartões é sempre derivado das lacunas, nunca guardado.

**O invariante mais importante está provado por teste:** `create-cloze.test.tsx` monta um
editor TipTap real, seleciona um trecho, executa o gesto inteiro até `criarNotaComOrigem`, e
confere que `editor.getJSON()` é **byte a byte idêntico** antes e depois. A mesma asserção
prova a tese: o texto vira `A {{c1::mitocôndria}} produz ATP…`, com `sourceBlockId` e
`sourceTextFrozen` preenchidos — a referência viva ao bloco de origem.

`lacunas.ts` é um **gerador, não um parser** — e isso está escrito no `///` dele, de
propósito. A gramática de cloze continua morando só no Rust; este arquivo produz a marcação
a partir de índices que ele mesmo controla, e nunca lê marcação de volta.

Bordas cobertas por teste: seleção vazia e só-espaço; seleção que já contém `{{` ou `}}`
(abre sem lacuna, com o motivo, salvar desabilitado); texto do bloco vazio; sobreposição de
lacunas; seleção fora do texto; ausência do tipo Cloze; ausência de baralho; erro do
backend; e **uma nota que acabaria sem nenhuma lacuna não pode ser criada** — o `submit`
forçado é barrado sem chamar o backend, porque um cartão sem lacuna nasce sem nada para
perguntar.

Portão desta rodada:

- `rtk proxy npx tsc --noEmit`: **exit 0**.
- `rtk proxy npx vitest run`: **2064 testes em 217 arquivos**, três travas verdes.
- `cargo clippy --all-targets --all-features -- -D warnings -W clippy::unwrap_used
  -W clippy::expect_used`: **exit 0**.
- `npm run test:e2e`: **13 specs, 0 falhas**, contra o app Tauri real.

**Fora do escopo, declarado:** dica (`{{c1::texto::dica}}`) pelo gesto; editar as lacunas de
uma nota cloze que já existe (depende da tela de edição de nota, que não existe — é por isso
que `update_note`, `delete_note` e `list_notes` seguem em `REGISTRADOS_SEM_TELA`). Seleção
que atravessa blocos cai para "o trecho é o texto inteiro", sem `blocoOrigemId`: funciona,
mas perde o contexto ao redor, e está documentado no `CreateClozeButton`.

**Não verificado:** a tela não foi aberta. Os tokens usados são os já medidos em
`DESIGN-TOKENS.md`, mas isso é argumento, não observação — os cinco temas não foram olhados,
e a animação de entrada e o `selectionchange` real do WebView2 não foram exercitados (o
jsdom prova os índices, não o comportamento do navegador). Nenhuma spec e2e cobre este
gesto.

### Cloze (07/09/2026) — o tipo de cartão que a tese do produto exige

A tese, no topo deste documento: *"o flashcard nasce dentro da nota. Selecionar um trecho
cria um card"*. Cloze é **exatamente** o tipo que nasce desse gesto — o usuário marca a parte
que quer esconder, no lugar onde ela já está escrita. Sem cloze, o gesto central do produto
só produzia frente/verso. E é o tipo mais usado do Anki: quem vem de lá e não o encontra
conclui que o app não serve para o que ele faz.

Bar: Anki. `{{c1::texto}}` e `{{c1::texto::dica}}`; números diferentes geram cartões
diferentes; o mesmo número duas vezes esconde as duas ocorrências **no mesmo cartão**;
números não precisam ser contíguos; lacunas não precisam cair em fronteira de palavra.

**O trabalho de verdade não foi o parser — foi que cloze briga com o modelo de cartões
deste projeto.** Cada entrada de `note_types.templates` gerava exatamente um cartão, na
criação, e `NoteRepository::update` **nunca** tocava `cards`, deliberadamente, para não
apagar intervalo, ease e estado FSRS que o `review_log` construiu. Cloze inverte isso: o
número de cartões depende do **conteúdo do campo**, e editar o texto muda esse número nos
dois sentidos.

As três respostas, cada uma com teste:

- **Acrescentar** uma lacuna cria o cartão correspondente — senão ela existe no texto e nunca
  é estudada.
- **Remover** uma lacuna **suspende** o cartão órfão, nunca apaga. É o mesmo idioma que
  `NoteRepository::delete` já usa (`state = 'suspended'`), e preserva `review_log` e FSRS.
  Documentado que não reativa sozinho se a lacuna voltar: a suspensão sobrescreve `state` sem
  guardar o valor anterior, então não há para onde voltar sem inventar.
- **Sobreviver** a uma edição mantém `interval_days`, `ease_factor`, `fsrs_stability`,
  `fsrs_difficulty`, `fsrs_last_review_at`, `lapses`, `reps` e `due` **idênticos** — provado
  por teste que edita a nota de verdade (troca o conteúdo de `c1`, acrescenta `c3`, mantém
  `c2`) e **relê as colunas do banco**, não a struct devolvida.

Duas decisões de modelagem, ambas com o porquê no código:

- **`note_types.kind`** (migração `0040`, `"standard"` | `"cloze"`) em vez de comparar
  `name == "Cloze"`. Os três tipos antigos são distinguidos por nome só para **semear**;
  cloze precisa disso para decidir **comportamento de escrita** — todo o caminho de geração
  de cartão bifurca ali. Amarrar isso ao rótulo de exibição quebraria em silêncio no dia em
  que renomear tipo de nota existir. É onde o próprio Anki guarda (`notetypes.config.kind`).
- **`cards.template_ordinal` reusado** para carregar o número da lacuna, em vez de coluna
  nova. O `UNIQUE (note_id, template_ordinal)` que já existe é exatamente a garantia que
  cloze precisa — a lacuna N não pode ter dois cartões — e uma coluna dedicada teria que
  reconstruir essa restrição do zero. O campo em `CardRow` documenta os dois significados.

O parser (`src-tauri/src/db/cloze.rs`) é **total**: qualquer desvio de gramática recua um
caractere e trata como literal, o que garante terminação. Testado contra `{{c1::` sem fechar,
`{{c0::}}`, número grande demais para caber, texto vazio, `::` sobrando, chaves
desbalanceadas dos dois lados, aninhamento, e 200 aberturas seguidas sem fechar — este
último é regressão de laço infinito. Uma nota malformada não pode derrubar a sessão de
estudo.

A trava de contrato fez o trabalho dela: `NoteTypeRow` ganhou `kind` no Rust e
`contrato-ipc.test.ts` ficou vermelha com `enviados pelo Rust e ausentes de ipc.ts: kind`.
Depois de declarar o campo, o `tsc` apontou **nove fixtures de teste** que montavam
`NoteTypeRow` sem ele. Vale registrar que o **vitest passou verde durante todo esse
intervalo** — ele não faz checagem de tipo. É a razão de o portão ter os dois.

Portão desta rodada:

- `cargo clippy --all-targets --all-features -- -D warnings -W clippy::unwrap_used
  -W clippy::expect_used`: **exit 0**.
- `cargo test --jobs 2`: **853 testes, 0 falhas**, sem quebrar nada de `notes`, `cards` ou
  `srs`.
- `rtk proxy npx tsc --noEmit`: **exit 0**.
- `rtk proxy npx vitest run`: **2011 testes em 212 arquivos**, três travas verdes.

**Cloze aparece na tela, e a decisão de onde mora o parser tem argumento melhor do que o
que eu tinha.** A pergunta era: reimplementar a gramática em TypeScript (duas gramáticas
divergindo em silêncio) ou o backend mandar a string já renderizada? Ambas foram rejeitadas,
e a segunda pelo motivo que só aparece quando se pensa no que a TELA precisa fazer: para
**destacar** a lacuna, o TypeScript teria que procurar `[...]` dentro do texto — uma segunda
gramática disfarçada, e ambígua, porque colchete é texto legítimo numa nota.

A saída adotada: o backend manda **`Vec<ClozeSegment { text, hidden, hint }>`**, e o
TypeScript só percorre a lista escolhendo o `<span>`. Zero interpretação do lado da tela. E
`render_cloze` foi reescrita **por cima** de `segment_cloze`, com um teste que cruza as duas
em todos os casos hostis — então elas não podem discordar.

`CardToStudy` ganhou `cloze: Option<Vec<ClozeSegment>>`, e a trava de contrato cobrou o
campo novo na fixture de `EstudoSessao.test.tsx`, como deveria.

Na tela: a lacuna é um campo âmbar com linha de base, largura mínima para não sumir quando
vazia, e a dica em itálico dentro dela quando existe. **O texto escondido não entra no
DOM** — não é escondido por CSS, e há teste para isso. Um cartão que aponta para uma lacuna
que o texto não tem mostra o texto inteiro mais um aviso, com os botões ainda funcionando:
uma nota quebrada faz perder o cartão, não o app. Âmbar foi a única família que passou nos
cinco temas em texto corrido.

Sem animação ao revelar, por regra: é ação de alta frequência e, pelo espaço, iniciada por
teclado.

**Contexto sobre importação, verificado:** `sidecar/learno_sidecar/handlers/apkg.py` é um
**stub declarado** — ele confirma que o arquivo é um zip válido e devolve
`notes_imported: 0`, sempre, para qualquer `.apkg`. Isso está escrito no docstring do
próprio arquivo, num comentário de `ImportApkgSection.tsx`, e chega ao usuário como
`"arquivo.apkg": 0 nota(s) importada(s)`. É dívida honesta, não engano. A consequência para
cloze é que **não existe caminho de importação nenhum**: o tipo serve só para notas criadas
dentro do Learno.

### Menu de coluna (07/09/2026) — cinco comandos saem da dívida de uma vez

O cabeçalho de coluna de uma database **não tinha menu nenhum**, e era só por isso que
quatro comandos registrados no `generate_handler!` viviam em `REGISTRADOS_SEM_TELA`, com o
motivo escrito: "o cabeçalho da coluna não abre menu". Uma tela quitou os quatro e destravou
o quinto.

Bar: o menu do cabeçalho de coluna do Notion.

**Caminho:** `/` → **Database** → clicar no cabeçalho de qualquer coluna de propriedade. O
painel abre com o nome já focado e selecionado. Itens: renomear inline, **Tipo ›** (segunda
página do mesmo painel, tipo atual marcado), **Editar fórmula…** (só para tipos com
`renderConfigForm`), **Mover para a esquerda/direita**, e **Apagar propriedade** com
confirmação que diz quantos registros perdem valor.

Saíram de `REGISTRADOS_SEM_TELA`: `rename_property`, `change_property_type`,
`reorder_property`, `delete_property`. `set_property_config` — criado nesta mesma iteração —
nunca precisou entrar.

**A dívida que motivou a iteração está fechada:** editar a expressão de uma Fórmula depois
de criada era **impossível**. O `FormulaConfigForm` já suportava o modo "existente", com
botão "Salvar fórmula" e tudo, e nada nunca o abria — o próprio defeito histórico deste
projeto, em miniatura, dentro de código escrito para consertá-lo. `NewPropertyDialog` virou
`PropertyConfigDialog` com `mode: "create" | "edit"`, e agora alguém o abre.

**Trocar o tipo são DUAS chamadas, não uma transação.** `change_property_type`
(`db/databases.rs:384`) faz `UPDATE ... SET property_type` e **nunca toca `config`** — isso
é defeito pré-existente, confirmado com âncora e não corrigido aqui. Por isso o carregador
manda `set_property_config` com o `defaultConfig` do tipo novo logo atrás, pelo mesmo
caminho que a criação já usa. Se a segunda falhar, o banco fica com tipo novo e config
antiga; `failWrite` recarrega e avisa. A falha é **contida**: o `ErrorBoundary` por célula
(da rodada da tabela) transforma um `renderValue` que estoure com config do tipo errado em
"valor ilegível" naquela célula, em vez de derrubar a tela — e `formatNumberValue` tem
`default:` desde a rodada das fórmulas, então a célula não volta a ficar muda. Tornar isso
atômico exige `change_property_type` aceitar `config` no Rust; fica nomeado.

**A corrida de escrita estrutural foi herdada certa, não repetida.** As duas rodadas
anteriores tiveram um defeito crítico da mesma classe (`applyValueChanges` e
`refreshFormulaColumns`, os dois com resposta velha sobrescrevendo a nova). Aqui
`structuralWrite` termina em `reload()`, e `reload()` já incrementa `requestRef` no início e
confere antes de cada `setState` — duas ações estruturais rápidas disparam dois `reload()`,
e o mais velho é descartado. Verificado por leitura direta.

`filledCount` (`views/table/TableView.tsx:239`), que alimenta o aviso de exclusão, conta por
`property.id in record.values` — **presença, não truthiness**. É a diferença entre dizer a
verdade e mentir sobre uma coluna cheia de `0` ou `false` (invariante I1).

Portão desta rodada:

- `rtk proxy npx tsc --noEmit`: **exit 0**.
- `rtk proxy npx vitest run`: **2011 testes em 212 arquivos, 0 falhas**, três travas verdes.
- `npm run test:e2e`: **13 specs, 0 falhas**, contra o app Tauri real.

**O que ficou de fora, e por quê:** esconder, ordenar, filtrar e congelar pela coluna
dependem do pipeline `open_view_query`, que não existe; duplicar propriedade não tem
comando; arrastar cabeçalho é peça própria. Nada disso aparece na tela — controle que não
faz nada é defeito, não rascunho. "Mover" some quando a view tem `columnOrder` próprio,
porque aí `position` não é o que a tela mostra e o item não faria nada visível.

**Não verificado:** o menu não foi exercitado por spec e2e própria (a suíte passa, mas
nenhuma spec clica nele). É a mesma lacuna que a rodada das fórmulas tinha antes da
`database-formula.e2e.mjs`, e vale o mesmo aviso: o e2e é a única camada que atravessa o
`serde_json` de verdade.

**Nota de ambiente:** um agente rodou `taskkill /IM node.exe` para derrubar um harness de
inspeção próprio. Isso mata **todo** processo node da máquina, não só o dele. Nesta ocasião
o servidor do outro projeto sobreviveu (mesmo PID antes e depois), mas foi sorte. Matar por
nome de imagem nunca é aceitável aqui — o PID é conhecido, e esta máquina roda mais de um
projeto Node ao mesmo tempo.

### Fórmulas (06/09/2026) — 40 funções e a propriedade na tela

Existia um motor de fórmula inteiro no Rust — lexer, parser, checagem de tipo estática,
avaliador, registro global — com testes próprios, todos verdes, e
`formula/functions/mod.rs` tinha `register_all()` **literalmente vazio**. Uma linguagem de
fórmula completa que não sabia somar dois números. Do outro lado, três comandos IPC
registrados no `generate_handler!` **sem nenhum chamador**, declarados em
`REGISTRADOS_SEM_TELA` com o motivo "propriedade formula não criável pela UI".

Agora são **40 funções em cinco categorias**: matemática (12), agregação (5), texto (9),
data (14) e lógica (8). A bar foi `docs/CHECKLIST.md`, item por item, em Dado/Quando/Então
(DBS-062/063/066/070/071/073/074/075/076/077).

**Duas travas que atravessam a LIGAÇÃO**, em `ipc/formula_commands.rs`: elas chamam o mesmo
`register_all()` que o comando IPC chama e consultam a mesma tabela global que a paleta
consulta. Sem elas, `register_all()` podia voltar a ficar vazio com a suíte inteira verde —
cada teste do núcleo prova a PEÇA, e o que faltava era a LIGAÇÃO. Elas não afirmam um número
de funções (isso quebraria a cada categoria nova, sem defeito nenhum); afirmam que cada
categoria chegou à tabela e que uma função nomeada de cada uma é encontrável pelo nome.

Essas travas acharam algo que ninguém tinha notado: **a linguagem não tem literal de lista.**
`[1, 2, 3]` morre no lexer com `caractere inesperado: "["`. Não é defeito da agregação — é o
formato da linguagem, e o Notion se comporta igual (lista nasce de relação ou de `split`).
Mas `sum`/`min`/`max`/`median`/`mean` só ficam alimentáveis quando houver propriedade de
relação na tela. Registrado no próprio teste, com o porquê.

**`evaluate_formula_column(databaseId, propertyId)`** é o comando que faltava para uma coluna
de fórmula existir. `list_records` devolve só o que está gravado em
`database_record_values`, e fórmula **não é gravada** — é calculada. Sem esse comando, uma
grade de 500 registros faria 500 chamadas de IPC. Ele carrega tudo de uma vez (fatiado por
`sql::MAX_BIND_PARAMS`, mesma convenção de `list_records`), compila a expressão **uma vez**
para a coluna inteira, e depois só avalia em memória trocando o registro corrente. Testado
com **905 registros**, forçando mais de um chunk, provando que o fatiamento não perde nem
embaralha valor.

Decisões de borda documentadas no código:

- **`if` e `ifs` usam `ParamKind::Lambda` nos ramos**, não `Value` — só o ramo escolhido é
  avaliado, igual ao ternário que o DBS-075 descreve como "atalho para if". Consequência
  testada: `if(cond, a, b)` com `b` vazio devolve vazio quando a condição escolhe `b`, em vez
  de curto-circuitar a chamada inteira (o curto-circuito de vazio só existe para argumento
  `Value`, nunca `Lambda`).
- **`empty()` é a exceção nomeada** de `accepts_empty`: com `false` ela devolveria vazio em
  vez de `true`, o oposto do que o DBS-077 pede.
- **`&&`, `||`, `!` e os comparadores já eram operadores infixos** no avaliador desde o
  começo. Foram registradas só as formas de FUNÇÃO (`and`/`or`/`not`/`equal`/`unequal`), que
  usam mecanismo diferente — nada foi duplicado.
- `today()`/`now()` usam `chrono::Local`, a mesma decisão de
  `db::cards::inicio_do_dia_local_em_utc`. `dateBetween(a,b,u)` = `a - b`. Tokens de
  `formatDate`: `YYYY MM DD HH mm`, e token desconhecido atravessa verbatim em vez de virar
  pânico ou lixo silencioso. `length()` conta **caractere Unicode** (`"café"` = 4, emoji = 1,
  acento combinante NFD = 2 — o preço nomeado de não trazer `unicode-segmentation`).
  Divisão por zero, `sqrt` de negativo e overflow viram `Value::Empty`, nunca `NaN`
  disfarçado. `repeat` tem teto de 10 MB. Agregação ignora item vazio como planilha faz, e
  `sum([])` é 0 enquanto `mean([])` é vazio.

**A propriedade Fórmula na tela.** `properties/formula/register.ts` é descoberto por
`import.meta.glob`, então "Fórmula" aparece no `AddPropertyMenu` sozinho. O spec **não
implementa `renderEditor`** — é assim que a célula fica somente leitura, sem nenhum código
especial na tabela, pelo contrato de `property-spec.ts` — e `normalize` devolve `null`
sempre, para que nenhum caminho grave em `database_record_values`. O editor tem caixa de
expressão monoespaçada com um espelho que sublinha o erro **na posição que o Rust devolveu**
(os `start`/`end` dos diagnósticos já vêm em unidades UTF-16, convertidos de bytes no Rust
exatamente para isso: "Preço" tem 6 bytes e 5 unidades UTF-16), paleta agrupada por
categoria com os textos que vêm prontos em português do `FunctionDef`, e prévia contra um
registro real. Expressão inválida não salva. Caminho: **"+ Propriedade" → "Fórmula"**.

Uma nota honesta na célula: `evaluate_formula_column` devolve `null` para TODOS os registros
quando a expressão não compila, então só o diagnóstico de `validate_formula` distingue "a
fórmula deu vazio" de "a fórmula está quebrada". O carregador chama os dois em paralelo por
causa disso, e a coluna mostra **"⚠ fórmula inválida"** com a mensagem do Rust — nunca uma
coluna em branco fingindo vazio.

**Quatro defeitos que a revisão adversarial achou depois de tudo verde:**

- **Crítico:** `refreshFormulaColumns` usava `requestRef.current` como guarda de "resposta
  mais nova" — e esse ref **só é incrementado em `reload()`**. Não era guarda nenhuma. Duas
  escritas rápidas disparavam dois recálculos, e se o da primeira resolvesse depois, a coluna
  ficava mostrando a conta antiga até a próxima escrita. É a MESMA classe de bug já corrigida
  para `applyValueChanges` na rodada anterior, com a correção não replicada aqui. Fechado com
  contador próprio, e **provado por mutação independente**: removendo a guarda, o teste falha
  com `expected 2 to be 4`.
- Falha transitória de IPC e expressão quebrada caíam no mesmo caminho, e o merge substituía
  o último valor calculado válido pelo sentinela de erro — um soluço de rede fazia uma
  fórmula certa virar "inválida". Agora `unavailable` é distinguido de `error`, e uma chamada
  que falhou não apaga o último valor bom.
- `isEmptyFormulaValue` não tratava lista vazia como vazia, ao contrário de `multi_select` e
  `files`. Com "Ocultar se vazia" ligado, a coluna ficava visível e em branco.
- O diálogo de criação fechava de forma síncrona, sem esperar `create_property`. Se falhasse,
  o usuário via o diálogo fechar (lendo isso como sucesso), perdia a expressão digitada, e o
  erro aparecia depois solto ao lado da tabela.

A revisão procurou especificamente por **`0` e `false` de fórmula virando "vazio"** no
caminho até o pixel — a armadilha que `property-spec.ts` documenta, e mais fácil de errar
numa fórmula, onde `0` e `false` são resultados legítimos e comuns. **Não achou nada.**

Portão desta rodada:

- `rtk proxy npx tsc --noEmit`: **exit 0**.
- `rtk proxy npx vitest run`: **1984 testes em 210 arquivos, 0 falhas**, três travas verdes.
- `cargo clippy --all-targets --all-features -- -D warnings -W clippy::unwrap_used
  -W clippy::expect_used`: **exit 0**.
- `cargo test --jobs 2`: **24 suítes, 0 falhas**, com 123 testes só de `formula`.
- `npm run test:e2e`: **13 specs, 0 falhas**, rodado 5 vezes (a sexta pegou o flake de
  `block-selection` descrito acima).

`validate_formula`, `preview_formula` e `list_formula_functions` **saíram** de
`REGISTRADOS_SEM_TELA`. `evaluate_formula_column` nunca precisou entrar.

**A spec e2e existe e passa: `e2e/specs/database-formula.e2e.mjs`, 8/8.** Ela é a única
camada que atravessa o `serde_json` de verdade para `FormulaColumnValue` — a trava
`contrato-ipc.test.ts` **estruturalmente não alcança** esse tipo, porque só itera sobre
structs com `Serialize`. Os oito passos conferem tela **e** banco: a paleta lista funções
vindas de `list_formula_functions`; expressão inválida mostra o erro do Rust e desabilita o
botão; a criação grava `property_type = 'formula'` com a expressão no `config`; **o valor
calculado aparece diferente por registro**; a célula não abre editor e **nunca** cria linha
em `database_record_values`; e editar o valor de origem recalcula a coluna.

**A spec achou um defeito de produto que nada mais tinha pego.** Toda propriedade **Número**
criada pelo fluxo normal nascia com `config: "{}"`, porque `create_property`
(`db/databases.rs`) grava `{}` quando o config vem ausente — por desenho, já que o Rust não
conhece `PropertySpec`, que é TypeScript. E `formatNumberValue` tinha um `switch (format)`
**sem `default:`**. O `tsc` nunca reclamou, porque o parâmetro é tipado `NumberFormat` e o
compilador considera o `switch` exaustivo — mas `format` atravessa uma fronteira de runtime
(JSON do banco) e chegava `undefined`. A função saía sem `return`, devolvia `undefined` com
assinatura de `string`, e **a célula ficava muda para sempre**: o valor certo no banco,
invisível na tela, sem erro no console, e recarregar não resolvia porque o `config`
persistido continuava `{}`.

Corrigido nas duas camadas, porque as duas estavam erradas:

- `formatNumberValue` ganhou `default:` — uma função total não pode mentir sobre o próprio
  tipo de retorno quando a entrada vem de fora do compilador.
- `addProperty` (`loader/use-database.ts`) passa a mandar o `defaultConfig` do
  `PropertySpec` quando não há config explícita. O padrão de cada tipo mora do lado que o
  conhece, e não vira uma segunda cópia dentro do Rust que sairia de sincronia na primeira
  vez que alguém mudasse um `defaultConfig`. Isso conserta Número, e também Data e Seleção,
  que leem `config` ao renderizar pelo mesmo caminho.

O teste `1b` da spec foi escrito para **falhar** enquanto o defeito existisse, e ficou verde
sozinho depois da correção — que é a única forma honesta de saber que a correção corrigiu o
que se propôs. E a trava de costura em `register.test.tsx` ganhou um caso novo fixando que
Número nasce com `{ format: "plain" }`, não com config vazia.

**Um teste e2e instável, nomeado:** `block-selection.e2e.mjs` falhou **1 vez em 6** rodadas
da suíte completa. **Isolada, passou 6 de 6.** Ou seja: só quebra sob a carga das 13
instâncias de `learno.exe` em sequência, que é a assinatura de contenção de recurso
derrubando uma interação sensível a tempo — o mesmo modo de falha que a seção da migração
SQLite já documenta para arrasto de bloco. Não tem relação com databases nem com fórmulas.
Não capturei a asserção exata da falha, e por isso **não afirmo a causa** — fica nomeada
para quem for atacá-la, com a observação de que reproduzir exige a suíte inteira, ~75s por
tentativa e ~17% de acerto.

**O que falta nesta feature, e é dívida real, não esquecimento:**

- **Não existe como editar a expressão de uma coluna já criada.** Só `create_property` aceita
  `config`; não há `set_property_config` no Rust. O formulário já suporta o modo "existente",
  mas nada o abre.
- Filtro, ordenação e agregação da coluna de fórmula: `filterOperators: []`, `sort: "none"`,
  porque o pipeline de consulta (`open_view_query`) não existe.
- Fórmula referenciando outra fórmula (DBS-084): `load_properties` exclui `formula` do
  schema, então a coluna inteira recebe `null` — comportamento decidido e testado, não
  acidente.
- `related()` continua vazio, então fórmula sobre relação de verdade fica fora — a mesma
  limitação que `preview_formula` já declarava.

**Nota de ambiente:** o disco C: chegou a 100% durante esta rodada e derrubou um
`cargo test` com "Espaço insuficiente no disco". Foram liberados 2,6 GB apagando só
`src-tauri/target/debug/incremental`, cache regenerável (mesmo precedente registrado na
seção da migração SQLite). O consumo está majoritariamente **fora deste repositório**: 471
GB usados de 477, e o `target/` inteiro é 15 GB.

### Databases (06/09/2026) — o subsistema saiu do papel e virou tela

Era a maior massa de código desconectado do repositório, e a nona ocorrência do defeito
histórico deste projeto em escala: 19 comandos Rust registrados no `generate_handler!`, 64
arquivos de componente, filtro aninhado AND/OR, ordenação multi-campo e agrupamento tudo
escrito e testado — e **zero pixels** disso na tela. `DatabaseBlockView.tsx` devolvia
`status: "error"` incondicionalmente havia rodadas, esperando um `get_database_schema` que
nunca foi escrito. Ele nunca precisou existir: o schema se compõe de `get_database` +
`list_properties` + `list_views`, que já estavam registrados.

Faltavam exatamente duas coisas, e nenhuma delas era grande:

1. **Nenhum comando IPC escrevia valor de célula.** `src-tauri/src/db/record_values.rs` é o
   I4, o ÚNICO caminho de escrita em `database_record_values`, com normalização, cascata,
   automação e "Editado em" numa transação — e nada o alcançava. Uma tabela conseguiria ler
   e não conseguiria editar. Fechado por `apply_record_value_changes` em
   `ipc/database_commands.rs`, que **delega ao repositório** e por isso mantém
   `tests/db_value_invariants.rs` verde (esse teste varre o crate inteiro exigindo que só
   `record_values.rs` emita `INSERT`/`UPDATE`/`DELETE` naquela tabela).
2. **Nenhum tipo de view estava registrado.** Agora existe
   `src/features/databases/views/table/`, descoberto por `import.meta.glob` como o contrato
   manda — nenhum arquivo o importa.

O que entrou junto: `loader/{resolve-schema,use-database}.ts` (compõe os quatro comandos em
paralelo e escreve por `apply_record_value_changes`/`rename_page`/`create_record`);
`ViewRenderContext` estendido com `records` e `mutations`, mudado em `core/view-spec.ts`
como o próprio arquivo pedia; a ação `/database`; e `AddPropertyMenu`.

**Caminho do usuário:** abrir uma página → `/` → **Database**. A grade aparece; "Nova linha"
cria registro, "+ Propriedade" abre o menu de tipo, clicar numa célula abre o editor do tipo
dela.

**A invariante I1 está certa nos dois lados.** `ValueCell` decide vazio por
`spec.normalize`, nunca por `!value` — a armadilha que `property-spec.ts` documenta, porque
`!value` come o `0` do Número e o `false` do Checkbox. Provado por teste de DOM real com os
specs de verdade: digitar `0` grava `0`; desmarcar checkbox manda `null`, nunca `false`.

**Cinco defeitos que duas revisões adversariais acharam depois de tudo verde:**

- **Crítico:** `use-database.ts` não tinha guarda de ordem para escritas concorrentes na
  mesma célula — só a leitura tinha. Duas edições sobrepostas com as respostas voltando fora
  de ordem faziam a resposta VELHA sobrescrever a célula, e nada corrigia depois (não há erro
  para disparar o `reload`). Fechado com sequência por `(recordId, propertyId)`, e provado
  ficando vermelho sem a correção: `AssertionError: expected 1 to be 2`.
- `/database` engolia a falha do `createView` com `.catch(() => undefined)`, deixando uma
  database órfã sem view e sem aviso. Agora **compensa apagando a database**, e se a
  compensação falhar o aviso diz exatamente isso.
- `renderValue` era chamado sem `ErrorBoundary`. O contrato garante que `parse` e `normalize`
  são totais; `renderValue` **não**. Uma célula corrompida derrubaria a árvore React até a
  raiz. Agora vira `valor ilegível` na própria célula.
- `resolve-schema.ts` tratava `value === null` como presente enquanto a escrita otimista o
  tratava como remoção — as duas pontas discordavam do mesmo valor.
- **A costura clique→hook não tinha prova.** Os testes mostravam a UI chamando
  `actions.onAddProperty`, mas `actions` era um `vi.fn()` cru, não o `addProperty` real do
  `useDatabase`. As duas metades provadas, o elo entre elas não — a família de defeito que já
  apareceu onze vezes aqui. Agora `register.test.tsx` monta o `DatabaseBlockView` com o
  `useDatabase` DE VERDADE, só `ipc.ts` mockado.

**Fórmulas: 26 funções, e a trava que faltava.** `formula/functions/mod.rs` tinha
`register_all()` literalmente vazio — uma linguagem de fórmula inteira que não sabia somar
dois números, com o núcleo (lexer, parser, checagem de tipo, avaliador) todo testado e
verde. Entraram matemática (12), agregação (5) e texto (9). E entraram **duas travas** em
`ipc/formula_commands.rs` que atravessam a LIGAÇÃO: chamam o mesmo `register_all()` que o
comando IPC chama e consultam a mesma tabela global que a paleta consulta. Sem elas,
`register_all()` podia voltar a ficar vazio com a suíte inteira verde.

Essas travas acharam algo que ninguém tinha notado: **a linguagem não tem literal de lista.**
`[1, 2, 3]` morre no lexer com `caractere inesperado: "["`. Não é defeito da agregação — é o
formato da linguagem, e o Notion se comporta igual (lista nasce de relação ou de `split`).
Mas significa que `sum`/`min`/`max`/`median`/`mean` só ficam alimentáveis quando houver
propriedade de relação na tela. Registrado no próprio teste, com o porquê.

Decisões de borda documentadas no código: `length()` conta **caractere Unicode** (`"café"` =
4, emoji = 1, acento combinante NFD = 2 — o preço nomeado de não trazer
`unicode-segmentation`); divisão por zero, `sqrt` de negativo e overflow viram `Value::Empty`,
nunca `NaN` disfarçado; `repeat` tem teto de 10 MB; agregação ignora item vazio como planilha
faz, e `sum([])` é 0 enquanto `mean([])` é vazio.

Portão desta rodada:

- `rtk proxy npx tsc --noEmit`: **exit 0**.
- `rtk proxy npx vitest run`: **1944 testes em 207 arquivos, 0 falhas**, três travas verdes.
- `cargo clippy --all-targets --all-features -- -D warnings -W clippy::unwrap_used
  -W clippy::expect_used`: **exit 0**.
- `cargo test --jobs 2`: **784 de lib + todas as suítes de integração, 0 falhas**, com
  `db_value_invariants` verde.
- `npm run test:e2e`: **12 specs, 47 testes, 0 falhas**, contra o app Tauri real.

**A spec e2e fecha um ponto cego que nenhuma outra camada alcança.**
`e2e/specs/database-tabela.e2e.mjs` existe porque `RecordValueChangeInput` — o payload de
escrita de célula — é `Deserialize`-only do lado Rust, e `src/lib/contrato-ipc.test.ts` só
itera sobre structs com `Serialize`. A trava **estruturalmente não consegue** conferir esse
tipo; isso está autodocumentado em `ipc.ts`. Até esta spec, a garantia de que
`recordId`/`propertyId`/`value` batiam com `record_id`/`property_id`/`value` era alguém ter
lido o código. Agora o JSON real atravessa o `invoke`.

Os sete passos conferem tela **e** banco: `/database` cria database e view; "+ Propriedade →
Texto" cria a coluna com `property_type = 'text'`; "Nova linha" cria o registro; editar a
célula grava em `database_record_values`; reabrir a página lê de volta; **apagar o conteúdo
REMOVE a linha** (I1, não vira `""` nem `null`); e reabrir confirma que o banco vazio é o
que a tela mostra. Rodada duas vezes seguidas antes de entrar na suíte.

Na primeira execução ela falhou, e a causa foi da própria spec, não do app: um `.click()`
extra dentro do editor da célula mira o CENTRO do elemento e reposiciona o cursor lá, então
o `Backspace` apagava só a metade da frente do texto. O TipTap já foca no fim
(`autofocus: "end"`). Documentado no comentário do arquivo.

**Dívida honesta, não escondida.** Ficam sem tela, com motivo declarado em
`REGISTRADOS_SEM_TELA`: `rename_property`, `change_property_type`, `reorder_property`,
`delete_property` (o cabeçalho da coluna não abre menu); `set_view_config` (filtro/ordenação
dependem de `open_view_query`, que não existe — persistir config que a tela não honra seria
controle morto); `reorder_view`, `delete_view` (sem abas de view); `list_databases_in_page`.
Ficam de fora da tabela, e por isso **não aparecem como controle**: congelar coluna,
arrastar para reordenar, seleção múltipla, agrupamento, filtro e ordenação, abrir registro
como página.

**Uma falha de teste que não consegui explicar.** Numa rodada da suíte vitest, logo depois de
o builder escrever ~20 arquivos, 1 teste falhou; o `grep` do comando engoliu o nome e eu não
o identifiquei. Rodei a suíte cheia **10 vezes seguidas** depois disso, sem tocar em código:
todas verdes. Hipótese, declarada como hipótese e não como conclusão: cache de transform do
Vite inconsistente logo após a escrita em massa. Fica registrado para a próxima sessão
reconhecer se voltar, em vez de redescobrir.

Diagrama: `docs/diagrams/databases-fluxo.html` — o caminho `/database` → NodeView → loader
→ contêiner puro → registro de views → `PropertySpec` por coluna → comando IPC →
`record_values.rs`, com I1 e I4 como callout. Conferido no browser.

### FSRS-6 (06/09/2026) — o segundo agendador, escolhível por baralho

O agendador do app era SM-2. O Anki adota **FSRS** como padrão desde a 23.10, e ele atinge a
mesma retenção com 20-30% menos revisões, porque modela memória com estabilidade,
dificuldade e recuperabilidade em vez de um fator de facilidade fixo. O schema do Learno já
tinha `cards.scheduler`, `cards.fsrs_stability` e `cards.fsrs_difficulty` — e `answer_card`
recusava explicitamente qualquer coisa que não fosse `'sm2'`. Agora não recusa mais.

**A bar não foi gosto, foi número.** Baixei a implementação de referência
(`open-spaced-repetition/py-fsrs`), rodei ela de verdade e gerei **400 casos × 12 passos =
4.800 passos de agendamento** com avaliações e atrasos sorteados — incluindo o ramo `Hard`
e revisão no mesmo dia, que os três vetores dourados da referência não cobrem. A fixture e o
script que a gera estão versionados em `src-tauri/tests/fixtures/`. O port em Rust reproduz
os 4.800 passos: fase, `step`, estabilidade e dificuldade a 1e-9 relativo, e `intervalo_seg`
exato.

- `src-tauri/src/srs/fsrs.rs` — núcleo FSRS-6 puro, mais 5 testes de unidade (os 3 vetores
  dourados da referência mais 2 de borda).
- `src-tauri/tests/fsrs_diferencial.rs` — os 4.800 passos. **Validado por duas mutações
  independentes**: `hard_penalty × 1.0001` e amortecimento `/9.0` → `/9.0000001`. As duas
  ficaram vermelhas, nomeando caso, passo, esperado e obtido. Teste que nunca falhou não
  prova que guarda.
- `src-tauri/src/db/cards.rs` — `answer_card` despacha por `card.scheduler`; `review_log`
  grava o agendador verdadeiro e o par estabilidade/dificuldade antes e depois.
- `src-tauri/src/ipc/deck_commands.rs` — `get_deck_scheduling_options` e
  `set_deck_scheduling_options`, no `generate_handler!`.
- `src/features/cartoes/OpcoesDoBaralho.tsx` — a tela. Cartões → baralho → "Opções do
  baralho". Antes desta rodada **não existia nenhuma tela de opções de baralho**.

**Decisão travada: cartão existente nunca migra de agendador.** `cards.scheduler` é gravado
uma vez, na criação, lendo `decks.options` naquele instante; `answer_card` despacha pelo
scheduler DO CARTÃO, não do baralho. Trocar o preset só afeta cartão criado depois. Foi
descartado derivar uma memória FSRS a partir do ease/interval SM-2: não existe fórmula de
conversão verificável contra referência nenhuma, e inventar uma seria uma segunda fonte de
comportamento não testável. A tela **diz isso ao usuário** antes de ele trocar — sem esse
aviso ele troca, não vê diferença e conclui que está quebrado.

**O que uma revisão adversarial achou depois de tudo verde, e que o teste diferencial não
alcançava** (o diferencial testa `agendar()` isolado; estes dois vivem na costura):

- `Memoria::ultima_revisao` era derivada de `card.updated_at`, e o trigger
  `cards_set_updated_at` dispara em QUALQUER `UPDATE` na tabela. Ainda não corrompia nada,
  porque só `answer_card` e o suspend escrevem numa linha respondível — mas `buried_until` já
  é lido por toda consulta de fila e ainda não é escrito por comando nenhum. No dia em que
  "enterrar cartão" existisse, `elapsed_days` passaria a contar do instante daquele toque, e
  a estabilidade sairia errada **sem erro e sem teste vermelho**. Fechado com coluna dedicada
  (`0039_cards_fsrs_last_review_at.sql`). O buraco de cobertura que escondia isso era pior
  que o defeito: nenhum teste respondia um cartão FSRS **duas vezes** através do banco. Agora
  existe, e foi provado ficando vermelho com o defeito de volta.
- `interval_dias` no braço FSRS era sempre a diferença de tempo, mesmo com o cartão em passo
  de aprendizagem — o braço SM-2 grava `0` nessa fase. Espelhado.

**A trava de contrato pegou uma regressão nesta mesma rodada:** `CardRow` ganhou
`fsrs_last_review_at` no Rust e o `ipc.ts` não declarou o campo.
`src/lib/contrato-ipc.test.ts` ficou vermelha com `enviados pelo Rust e ausentes de ipc.ts:
fsrsLastReviewAt`. É o que ela existe para fazer.

**Alcançabilidade auditada por fora**, elo a elo, com `arquivo:linha` para cada um: baralho
FSRS faz o cartão novo nascer `scheduler='fsrs'`; o cartão `'fsrs'` chega em
`srs::fsrs::agendar` e não numa branch de erro; as colunas são gravadas e **relidas do
banco** por teste que compara com um recálculo independente; a fila de estudo não filtra por
`scheduler`, então cartão FSRS é tão visível quanto SM-2; os dois comandos estão no
`generate_handler!`. A auditoria foi rodada **antes** de a tela existir e reprovou
corretamente naquele momento, com a própria `comandos-alcancaveis.test.ts` vermelha — a
décima primeira ocorrência do defeito histórico deste projeto foi pega antes de virar
achado, não depois.

Portão desta rodada:

- `cargo clippy --all-targets --all-features -- -D warnings -W clippy::unwrap_used
  -W clippy::expect_used`: **exit 0**.
- `cargo test --jobs 2`: **745 testes de lib + todas as suítes de integração, 0 falhas**
  (`db_cards` 15, `fsrs_diferencial` 1).
- `rtk proxy npx tsc --noEmit`: **exit 0**.
- `rtk proxy npx vitest run`: **1903 testes em 203 arquivos, 0 falhas**, com as três travas
  verdes.
- `npm run test:e2e`: **11 specs, 40 testes, 0 falhas**, contra o app Tauri real.

A spec nova é `e2e/specs/fsrs-opcoes-de-baralho.e2e.mjs`, e ela é a prova que vale mais que
todas as outras juntas para esta feature, porque é a única camada que atravessa o
`serde_json` de verdade. Ela confere na TELA **e** no BANCO, em cinco passos: cartão criado
antes de qualquer configuração nasce `sm2`; escolher FSRS e salvar avisa sucesso e grava em
`decks.options`; cartão criado depois nasce `fsrs` **e o antigo continua `sm2`**; estudar o
cartão FSRS tira `fsrs_stability`, `fsrs_difficulty` e `fsrs_last_review_at` de `NULL` e
reagenda o `due`; reabrir a tela lê FSRS de volta — o que fecha o round-trip de
`get_deck_scheduling_options` e é exatamente onde uma discordância `snake_case`/`camelCase`
entre os dois lados apareceria. Rodada duas vezes seguidas, com tempos diferentes (3,4s e
9,4s), então não é resultado congelado em cache.

Diagramas gerados e conferidos no browser nesta rodada:
`docs/diagrams/arquitetura-learno.html` e `docs/diagrams/agendador-srs.html`.

Ledger do gauntlet desta tarefa (bar, gap e veredito por rodada):
`%TEMP%\claude\C--dev-learno\dcf01276-*\scratchpad\gauntlet-fsrs.jsonl`.

### Rodada de 06/09/2026 — os seis problemas fechados

Portão inteiro, verde, sobre a árvore montada:

- `rtk proxy cargo test`: **876 testes, 0 falhas**.
- `rtk proxy cargo clippy --all-targets --all-features -- -D warnings -W clippy::unwrap_used
  -W clippy::expect_used`: **0 erros**.
- `rtk proxy npx tsc --noEmit`: **exit 0, sem saída**.
- `rtk proxy npx vitest run`: **1812 testes em 199 arquivos, 0 falhas**.

O que entrou, por problema do pedido:

1. **Notas não vaza mais** — filtro por dono da página (`0034_dono_da_pagina.sql`), com o backfill
   seguro porque hoje nenhuma tela permite criar uma view de trilha à mão.
2. **Cartões** — "Digitar a resposta" (diff letra a letra) e "Múltipla escolha" na tela de estudo,
   mais voz para estudar idioma.
3. **Mapa mental** — imagem no nó, e ligação por qualquer uma das quatro alças.
4. **Trilha** — decisão com caminhos: marcar etapa como decisão, nomear caminhos, escolher um, ver
   o outro ramo descartado, trocar com aviso em números.
5. **Cronograma** — grade de horários, matérias com cor, semana modelo.
6. **Biblioteca** — importação corrigida, capa, categorias, resumo por capítulo, palavras novas.

Cinco defeitos que só a execução revelou nesta rodada, e que valem registro:

- **Detecção de ciclo da Trilha estava errada desde sempre** (`db/trilha.rs`,
  `calcular_niveis_topologicos`). O critério era "recebeu nível?", mas o algoritmo grava um nível
  PROVISÓRIO no filho ao visitar o pai. Um ciclo `A ⇄ B` alcançado de fora (uma terceira etapa
  apontando para `A`) fazia `A` voltar com `em_ciclo = false` e um nível inventado — o desenho
  mostrava uma coluna plausível para um grafo sem ordem nenhuma. Os testes que existiam usavam
  ciclos ISOLADOS, onde ninguém de fora grava nível provisório: por isso o defeito sobreviveu. O
  critério certo é "teve o nível FIXADO" (saiu da fila). Teste novo:
  `ciclo_alcancado_de_fora_continua_marcado_como_ciclo`.
- **A trava de alcançabilidade mentia** (`src/lib/comandos-alcancaveis.test.ts`). Usava `\b` antes
  do nome do wrapper, e `\b` casa depois de um ponto: `Reflect.deleteProperty`, num fixture de voz,
  contava como "alguma tela chama `deleteProperty`". Trocado por `(?<![\w.$])`. Uma trava que
  aprova o que deveria pegar é a categoria mais perigosa de defeito deste projeto.
- **Sete comandos de categoria fora do `generate_handler!`** — compilavam, passavam em teste Rust
  (que chama a função direto, sem passar pela macro) e falhariam no app real com "comando não
  encontrado". Agravante: a store carregava livros e categorias num `Promise.all` único, então a
  estante INTEIRA iria para a tela de erro por causa do filtro. Registrados, e os dois desfechos
  separados com `Promise.allSettled`.
- **`NovoBlocoForm` lia o campo errado da store.** Um agente separou `materiasErrorMessage` de
  `errorMessage` (porque uma ação de matéria bem-sucedida apagava, em silêncio, um erro de bloco
  que o usuário não tinha visto) e não varreu os consumidores. A mensagem real do backend ficava
  sempre nula e virava texto genérico. `tsc` não pega: os dois campos são `string | null`.
- **Vazamento de trabalho assíncrono entre testes** (`EstudoSessao.test.tsx`). O teste do duplo
  clique liberava a resposta pendente e terminava esperando só a CHAMADA de `nextCard`, não o
  desenho. A cadeia seguinte (`refreshAllCounts` grava na store global do zustand, depois
  `carregarProximo`) caía DEPOIS do `beforeEach` do teste seguinte, sobre o estado que ele acabara
  de plantar. Falha intermitente de ~1 em 10 no teste da tecla "3". Corrigido esperando o cartão
  seguinte desenhar; 15 rodadas seguidas sem falha depois.

### Rodada de 05/09/2026 — madrugada

Os seis workflows do pedido do usuário (uma seção por problema) voltaram. Portão rodado sobre a
árvore com o Cronograma ainda escrevendo:

- `rtk proxy cargo check --all-targets`: **limpo** (o `criar_bloco` de 7 argumentos já tinha
  todos os chamadores atualizados quando recompilei).
- `rtk proxy cargo test`: **599 no lib + as suítes de integração, 1 falha**, corrigida abaixo.
- `rtk proxy cargo clippy --all-targets --all-features -- -D warnings -W clippy::unwrap_used
  -W clippy::expect_used`: **exit 0**.
- `rtk proxy npx tsc --noEmit`: **sem saída** (exit 0).
- `rtk proxy cargo test --lib db::pool`: **8 passaram**, incluindo
  `migracao_que_falha_e_revertida_para_o_backup_pre_migracao` — o teste que eu quebrei três vezes
  seguidas está finalmente verde e não depende mais da FORMA da última migração.
- `rtk proxy cargo test --test db_pages`: **15 passaram**, incluindo o
  `list_tree_keeps_favorited_and_deeply_nested_notes_pages` que o crítico do problema 1 cobrou.
- `rtk proxy npx vitest run src/features/trilha/store.test.ts`: **38 passaram**.

Três defeitos que só a execução revelou nesta rodada:

- **`tests/db_review_log.rs:175` falhava por relógio de parede, não por defeito.** O teste montava
  o instante como "23:30 UTC do dia UTC de HOJE". Num fuso atrás de UTC — o do usuário, UTC-3 —
  entre 21:00 local e a meia-noite o dia UTC já virou e o local não, então aquele instante é do
  FUTURO local; `db::review_log::stats` corta a janela no início do dia local de amanhã e via zero
  revisão. Passa a usar o dia UTC anterior, que é sempre passado e cai em hoje-local ou
  ontem-local. O irmão em `tests/db_gamificacao.rs:471` já ramificava pelo dia local e está
  correto — não foi tocado.
- **`src/lib/comandos-alcancaveis.test.ts` dava falso positivo.** O tracer usava `\b` antes do
  nome do wrapper, e `\b` casa depois de um ponto: `Reflect.deleteProperty`, num fixture de teste
  de voz, contava como "alguma tela chama `deleteProperty`", e o comando `delete_property` — que
  de fato não tem tela — saía sozinho da lista de dívida. Trocado por `(?<![\w.$])`. É um defeito
  na própria trava, a categoria mais perigosa: uma trava que mente aprova o que deveria pegar.
- **`ativarRaias` não era idempotente** (`src/features/trilha/store.ts`). São duas escritas que não
  formam transação: criar a propriedade `select` "Raia" e apontar a view para ela. Se a segunda
  falhasse, o retry natural do usuário criava uma SEGUNDA propriedade com o mesmo nome. Agora
  consulta `listProperties` e reaproveita a que existir, com dois testes novos (reaproveita a
  `select` existente; ignora uma homônima que não seja `select`).

Dívida que saiu da lista por ter ganhado tela: `list_properties`. Dívida que continua declarada e
agora corretamente: `delete_property`.

### Rodada de 05/09/2026 — noite

Sete workflows integrados. Portão inteiro:

- `rtk proxy cargo test`: **737 testes, 0 falhas**.
- `rtk proxy cargo clippy --all-targets --all-features -- -D warnings -W clippy::unwrap_used -W clippy::expect_used`: **limpo**.
- `rtk proxy npx tsc --noEmit`: **exit 0**.
- `rtk proxy npx vitest run`: **1467 testes em 179 arquivos, 0 falhas**.

O que entrou (as melhorias que o usuário pediu com base no SynapsePro):

- **Trilha** ganhou tela: etapas em colunas pelo nível topológico, flechas desenháveis, raias,
  progresso, aviso de ciclo com botão para desfazer. O eixo é dependência e a posição NUNCA é
  gravada — o nó nem é arrastável, porque deixar arrastar permitiria o desenho contradizer a
  regra de desbloqueio.
- **Gamificação**: XP, níveis, sequência, desafios diários e recordes pessoais. Não há ranking:
  o app é local, de um usuário só, e ranking contra ninguém seria número inventado.
- **XP virou consequência do evento de domínio**, não chamada extra: `answer_card` e
  `finish_pomodoro` creditam na MESMA transação. O desenho anterior dependia de a tela lembrar de
  chamar um comando que, pior, nem tinha como chamar (`registrar_xp_revisao_cartao` exige o id da
  linha de `review_log`, que `answer_card` não devolvia).
- **Prazos** com contagem regressiva, montados em Hoje (o próximo) e no Cronograma (a lista).
- **Plano do dia** em Hoje, ligando Cronograma, Pomodoro e Cartões.
- **Leitor de PDF e EPUB** na Biblioteca, com `pdfjs-dist` e `epubjs` (aprovados pelo usuário).
- **Cartão a partir da origem**: do editor de blocos e de um nó do mapa mental.

Correções que só a execução revelou, e que valem registro:

- O leitor estava QUEBRADO no app real: o `connect-src` do CSP não listava `asset.localhost`, e
  pdf.js usa `fetch` e epubjs usa `XMLHttpRequest` — os dois sob `connect-src`, não sob `img-src`.
  Passava em tudo porque o vitest mocka as duas bibliotecas e o `vite build` nunca executa a
  WebView com CSP real.
- `BibliotecaRepository::open` montava `media_dir.join(file_name)` cru enquanto
  `resolve_safe_media_path` (escrita para tratar o nome vindo do banco como hostil) só era usada
  na exclusão. `join` com caminho absoluto SUBSTITUI a base. Corrigido — mas devolvendo o caminho
  NORMAL, não o canônico: no Windows `canonicalize` traz o prefixo `\\?\`, que o protocolo
  `asset:` não aceita.
- A tela de gamificação prometia XP por revisão com nada creditando.
- O "Plano do dia" comparava foco de Pomodoro com um plano que incluía leitura e revisão, que o
  timer não mede — e o teste que existia afirmava esse comportamento errado.

### A trava de contrato agora audita a própria cobertura

`src/lib/contrato-ipc.test.ts` pulava tipos EM SILÊNCIO em três situações: struct Rust sem par em
TS, struct com `#[serde(flatten)]`, e tipo de entrada (`Deserialize` sem `Serialize`). Um teste
novo denuncia cada ponto cego. Ele acusou 27, triados um a um: **9 viraram apelido, 5 viraram
interface nova, 12 ficaram como dívida declarada** — cada uma nomeando o método Rust procurado e
o comando que não existe.

Isso também revelou que o EDITOR ainda tem contrato paralelo (`src/features/editor/contract.ts`,
espelhando `BlockRow`), fora do alcance da trava. Declarado como dívida; consolidar é o próximo
refactor daquela área.

### Rodada de 05/09/2026 — tarde

Portão inteiro, medido depois de integrar Trilha, espinha de databases e as correções dos
críticos:

- `rtk proxy cargo test`: **615 testes, 0 falhas**, 4 `#[ignore]` (sidecar Python).
- `rtk proxy cargo clippy --all-targets --all-features -- -D warnings -W clippy::unwrap_used -W clippy::expect_used`: **limpo**.
- `rtk proxy npx tsc --noEmit`: **exit 0, saída vazia**.
- `rtk proxy npx vitest run`: **1294 testes em 159 arquivos, 0 falhas**.
- `npx tauri build --debug --no-bundle`: **exit 0**.

Defeitos que ESTA rodada corrigiu, todos invisíveis para as duas suítes antes das travas:

- `mindmaps.page_id` era `NOT NULL` e o painel cria mapa sem página: o clique em
  "+ Novo mapa" morria em silêncio absoluto. Migração `0025_mapa_mental_avulso.sql`
  reconstrói a tabela derrubando FILHO antes de PAI — a ordem inversa faria o `DELETE`
  implícito do `DROP` propagar cascata e apagar os nós de todo mapa existente.
- `CardToStudy.fields` viajava como `Vec<String>` e o TypeScript declarava
  `Record<string,string>`: indexar por nome devolvia `undefined` e a sessão de estudo
  mostrava "(sem conteúdo)" com o cartão íntegro no banco. Agora vão `fields` (mapa) e
  `fieldNames` (ordem), da mesma passada, sem chance de discordarem.
- `BlocoPlanejado` declarava sete campos em português contra sete nomes em inglês do Rust:
  todo cartão do Cronograma renderizava `undefined`. E quatro das cinco atividades nunca
  criavam bloco, porque o TS mandava português no fio e o `CHECK` da tabela só aceita
  inglês.
- `ProgressoDeLeitura` faltava três campos e declarava dois `Option<String>` como
  não-nulos — achado pela trava de contrato, não por pessoa.
- Os três menus suspensos abriam FORA DA TELA: `popover` entra na top layer, onde
  `absolute top-full` posiciona a partir da janela, não do gatilho. `usePosicaoAncorada`
  mede e crava `position: fixed`. O jsdom não faz layout, então toda a suíte ficava verde
  com os menus invisíveis.
- Dois testes que CODIFICAVAM defeito: um afirmava que criar mapa sem página tinha que
  falhar; outro dependia de a última migração colidir sozinha ao ser reaplicada — e a
  `0025`, por reconstruir tabelas, é reaplicável. Trocado por colisão explícita derivada da
  própria migração, que não envelhece.

Pendências honestas desta rodada:

- `e2e/specs/cartoes.e2e.mjs` foi escrita e **ainda não passou por execução**.
- `db::pool::tests::migracao_que_falha_e_revertida_para_o_backup_pre_migracao` falhou UMA
  vez em execução paralela e passou na repetição imediata e isolada. Não reproduzido; a
  hipótese é liberação tardia do handle do arquivo no Windows depois de `pool.close()`.
  Não investigado a fundo.

### Rodada anterior

Medido em 05/09/2026, na branch `fase3-e-sqlite`, depois da migração:

- `cargo test` (sem variável de ambiente nenhuma, sem cluster): **440 testes, 0 falhas**,
  4 `#[ignore]` — os 4 são `sidecar::tests::real_process`, que precisam do sidecar Python
  empacotado, e não têm relação com banco.
- `cargo clippy --all-targets --all-features -- -D warnings -W clippy::unwrap_used -W clippy::expect_used`:
  **limpo**.
- `npx tsc --noEmit`: **exit 0**.
- `npx vitest run`: **1132 testes em 142 arquivos, 0 falhas**.
- `npx wdio run ./e2e/wdio.conf.mjs` contra o app Tauri de verdade: **9 specs, 30 testes,
  0 falhas** — e rodado quatro vezes seguidas para não confundir sorte com estabilidade. A
  nona spec é `tema.e2e.mjs`, que troca os cinco temas no app real, confere que cada um
  pinta um fundo diferente do outro (a regressão silenciosa: um bloco com erro de sintaxe
  não casa e nada acusa) e que a escolha chega ao `config.json`.

O que a execução dos testes revelou, e que nenhuma revisão de código tinha pego — porque
esses testes nunca rodavam antes:

- `db/pages.rs` ainda chamava `now()` (função que o SQLite não tem) ao mandar página para a
  lixeira: `trash` falhava sempre.
- `db/record_values.rs` tinha `sort_num::float8` e `ON CONFLICT ON CONSTRAINT ..._pkey`,
  sintaxe que só o Postgres aceita.
- `ipc/formula_commands.rs` ainda ligava uma lista a `= ANY($2)`.
- `db/search.rs` estava **inteiro** em `tsvector`/`ts_rank`/`similarity`/`ILIKE` — a busca
  global não funcionava de forma alguma. Reescrito para FTS5, com a tradução da entrada do
  usuário para a linguagem de consulta do FTS5 por lista de permissão (um título com `:`
  derrubava a busca com `unrecognized token`).
- `db/relations/repository.rs` inseria `database_relations`, `database_properties` e
  `database_relation_edges` sem `id`, contando com um default que a migração tirou.
- `db/page_versions.rs` ordenava o histórico só por `created_at`, que em SQLite tem precisão
  de milissegundo — dois snapshots do mesmo milissegundo empatavam e "mais novo primeiro"
  virava ordem indefinida. Teste intermitente, causa real; desempatado por `rowid DESC`.

O que a PRIMEIRA execução da suíte e2e revelou, e nenhum teste de unidade pegaria:

- **`React.StrictMode` abria o banco DUAS vezes, em paralelo.** O efeito de `App.tsx` monta
  duas vezes em desenvolvimento, então `open_workspace` saía duas vezes quase junto e as
  duas chamadas rodavam a migração contra o mesmo arquivo. O app mostrava
  `table mindmaps already exists` (migração 13, a perdedora da corrida) ou
  `database is locked`, e a suíte via só "a barra lateral não apareceu em 30s", em spec
  diferente a cada rodada. Corrigido no backend, que é onde dá para garantir:
  `AppState::lock_workspace_open` serializa a abertura e a segunda chamada devolve a
  configuração em cache sem reabrir nada. Pinado pelo teste
  `duas_aberturas_simultaneas_da_mesma_pasta_nao_migram_duas_vezes`.
- **O motor de fórmula inteiro nunca foi compilado.** `src/formula/` existia, com testes
  próprios, e `lib.rs` não declarava `pub mod formula;` — nem `ipc/mod.rs` declarava
  `formula_commands`, nem `generate_handler!` registrava os três comandos. Ligado agora, e a
  suíte Rust saltou de 274 para 325 testes só por passar a compilar o que já existia. É a
  quinta ocorrência da família "código correto, testado, desconectado do caminho real".
- **Dois `.bind(Uuid)` crus em `formula_commands.rs`**, contra coluna TEXT. Esse é o modo de
  falha silencioso da ponte de id: não dá erro, a comparação BLOB-contra-texto simplesmente
  não casa e a consulta devolve zero linha — toda database aparecia sem propriedade nenhuma.
  Corrigidos, com quatro testes novos contra banco de verdade.
- **A própria suíte e2e apagava o banco do usuário.** Ela limpa
  `%APPDATA%\com.learno.app` entre sessões, que antes só tinha configuração e agora tem o
  banco. Passou a usar uma pasta de trabalho temporária, uma por spec.
- **Instâncias órfãs de `learno.exe`.** Matar o `tauri-driver` não mata o app que ele
  spawnou, e o Edge WebDriver da sessão seguinte às vezes se ligava ao WebView2 da sessão
  morta. `afterSession` agora encerra o app também.
- **Um arrasto de bloco falhava 1 rodada em 4.** `element.dragAndDrop` solta o botão no
  mesmo instante do movimento final, e `drop-zone.ts` decide a faixa no último
  `pointermove`; trocado por uma sequência explícita de ponteiro com pausa antes de soltar.

Achados de duas revisões adversariais rodadas ao fim do trabalho, e o que foi feito com
cada um:

- **`validate_data_dir` não exigia caminho absoluto** (revisão de segurança). `save_data_dir`
  é um `#[tauri::command]`, alcançável por qualquer script na WebView, não só pelo diálogo
  nativo: um caminho relativo seria resolvido contra o diretório de trabalho do processo, o
  banco vivo seria copiado para lá e o caminho relativo ficaria gravado no store. Corrigido
  em `config/mod.rs`, com a mesma regra que `validate_backup_output_dir` já usava, mais a
  recusa de `..`, e pinado por teste.
- **A busca não tinha teto de custo** (revisão de segurança, severidade baixa). Um termo de
  uma letra vira varredura de prefixo nas duas tabelas FTS com `bm25` calculado antes do
  `LIMIT`. Limitado a 16 termos e 64 caracteres por termo em `db/search.rs`.
- **`saveDataDir` tinha ficado sem chamador na UI.** O assistente apagado era o único lugar
  que o chamava — a quarta ocorrência do defeito "código correto, testado, desconectado do
  caminho real" deste projeto, e desta vez encontrada antes de virar achado. Criada a seção
  "Pasta de trabalho" em `src/features/settings/DataFolderSection.tsx`, montada no diálogo de
  Configurações de `App.tsx`, com confirmação antes de mover o banco e 6 testes.
- **Trocar de pasta e falhar deixava a sessão sem banco.** `save_data_dir` agora reabre a
  pasta anterior quando a nova não abre, e devolve o erro original.

Evidência anterior, ainda válida:

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
  é prova. Os seis defeitos listados acima são a quarta ocorrência da mesma família, em
  escala: o que os escondia era o `#[ignore]`.
- **Dois vereditos "VIOLADA" que não são defeito das peças**: F0 e R2 foram julgados depois
  de o `Cargo.toml` mudar para SQLite no meio da execução delas. Registrado em
  `docs/ACHADOS-FASE-3.md` para a auditoria final não os contar como falha.
- **Ambiente**: o disco `C:` encheu durante a sessão anterior; foram liberados 18,3 GB
  apagando só `src-tauri/target/debug/incremental`, que é cache regenerável. O cache volta a
  crescer a cada build.

### Esteira gauntlet sobre Mapa Mental, Trilha, Cronograma e Biblioteca (07/09/2026)

Sessão conduzida pela skill `gauntlet-loop`, com bar externa nomeada e comparação cega por
rodada. Ledger completo (bar, ordem A/B por hash, gap, veredito, invariantes) em
`<scratchpad da sessão>/gauntlet-esteira-4-areas.jsonl`.

**Instrumento novo — vitrine.** `src/vitrine/` renderiza telas de feature com fixture, sem
backend Tauri, para permitir screenshot e julgamento por pixel: `?vitrine=cronograma-grade`,
`cronograma-colunas`, `biblioteca-estante`, `mapa-mental-50|200|500`, `trilha-pequena|media|com-decisao`.

**Trilha — `gauntlet vs roadmap.sh: 1 rodada, saída VENCE (confirmada por swap com ordem
invertida; os dois critics escolheram o nosso).** Gap encontrado NA BAR: roadmap.sh não tem
representação visual de "bloqueado" nem legenda para os três tons de check, e as linhas não
têm seta. Testes: 151 em `src/features/trilha`, `tsc` limpo.

**Cronograma — `gauntlet vs Notion Calendar (visão de semana): 4 rodadas, sem saída`**, 3 gaps
fechados em sequência (largura mínima de lane + chip `+N`; card que renderizava só o título;
descarte silencioso do horário). Uma rodada anulada por defeito do próprio instrumento.
Testes: 145 em `src/features/cronograma`.

**Mapa Mental — medido, não estimado.** `layoutRadial` 2665ms → 282ms em 500 nós (~9x);
`arestasComCor` deixou de recalcular a cada quadro de arrasto (dependência trocada por
assinatura de topologia). **Delta em aberto: fluidez de quadro no arrasto NÃO foi provada** —
aba de segundo plano não roda `requestAnimationFrame`, e a medição headless não mede paint.

**Biblioteca — encerrada por ordem do usuário** ("está praticamente pronta"). Não reabrir sem
pedido explícito.

**Bug crítico achado pelo usuário, não pela esteira.** Etapas criadas pela UI ficavam
invisíveis e inalcançáveis: `BarraDaTrilha.tsx` criava com `laneValue` vazio fixo, `layout.ts`
filtrava por igualdade exata e descartava, o resgate só rodava sem nenhuma raia, e o único
controle de mudar raia vivia no cartão que nunca era desenhado — impasse fechado. Confirmado
no banco real (`trail_lanes` = 1 linha 'Estudos'; 4 etapas com valor de agrupamento NULL).
Corrigido em duas camadas, com invariante testado: **etapas que entram no layout == etapas
posicionadas**. Lição de processo registrada no ledger: as fixtures nasciam do formato de dado
ideal, não do caminho real de criação — por isso a vitória cega e 146 testes verdes conviveram
com o bug.

**Três defeitos do instrumento de julgamento, todos registrados no ledger:** captura JPEG
reduzida produziu falso positivo de texto cortado e de sobreposição (uma rodada anulada, dois
terços de um gap inválido); fixture da Biblioteca dava a mesma capa a todo livro. Regra
adotada: julgamento visual só com PNG em escala nativa, e toda acusação de "texto cortado" ou
"blocos sobrepostos" é conferida por `getBoundingClientRect` antes de virar gap.

**Duas mentiras confirmadas do filtro `rtk` sobre exit code** (além da de `tsc` já documentada
em `RTK.md`): `cargo test` que falhou por disco cheio reportou exit 0, e um `vitest run` em
background reportou exit 0 com 2 testes falhando. Portão de qualidade roda com `rtk proxy` e
lê a linha de resumo, nunca `$?`.

**Ambiente — bloqueio real:** disco `C:` com ~2,5 GB livres de 476 GB (0,5%) durante a sessão;
`src-tauri/target` ocupa 10,18 GB (reconstruível). Causou Vite morto três vezes por falta de
memória, renderer do Chrome travando em captura, e um `cargo test` corrompido (erro Windows
1455). Decisão de limpeza pendente com o usuário.

**Dívida pré-existente que permaneceu intocada** (é de Notas/tags, fora do escopo desta
sessão): `comandos-alcancaveis.test.ts` acusa `['list_all_tags','list_pages_for_tag']` e
`contrato-ipc.test.ts` acusa `['TagPageRow','TagSummaryRow']`. Conferir o CONTEÚDO dessa
acusação, não a contagem de arquivos falhando — `deck_maturity` entrou e saiu dela nesta
sessão sem mudar a contagem.
