# HANDOFF — Learno

## Objetivo

Construir o Learno: um aplicativo de desktop para estudo que funde, num único produto,
um editor de blocos no modelo do Notion, um sistema de repetição espaçada no modelo do
Anki, um editor de mapa mental e um temporizador Pomodoro.

A tese do produto está na integração, não na soma: o flashcard nasce dentro da nota.
Selecionar um trecho cria um card; o cloze é marcado inline no próprio bloco; o card
guarda uma referência viva ao bloco de origem, de modo que editar a nota atualiza o
card; e a coleção de cards é exposta como uma database nativa do lado Notion, com
vencimento, intervalo e facilidade virando propriedades filtráveis. Um nó do mapa
mental também vira card, e o Pomodoro se vincula à página aberta ou ao baralho em
estudo.

## Decisões travadas (grilling de 02/09/2026)

| Decisão | Escolha | Alternativa recusada |
|---|---|---|
| Persistência | PostgreSQL 18 local como banco principal | SQLite embutido com sync posterior |
| Papel do Python | Sidecar PyInstaller para tarefas pesadas | FastAPI como camada de dados |
| Escopo v1 | Núcleo + avançado, usuário único | Paridade total com tempo real e nuvem |
| Editor | TipTap sobre ProseMirror | BlockNote, Lexical, contenteditable próprio |
| Ponte nota-card | Integração profunda, card vive na nota | Mundos separados |
| Mapa mental | Canvas livre com nós ancorados, bidirecional | Projeção automática apenas |
| Visual | Híbrido cozy-produtivo | Pixel-art integral; Notion neutro |
| Local do repo | `C:/dev/learno`, fora do OneDrive | Dentro da pasta sincronizada |
| Cadência | Checkpoint ao fim de cada uma das 6 fases | Autônomo até o fim |

Consequência aceita da escolha de persistência: o instalador precisa garantir um
PostgreSQL na máquina do usuário, e não existe modo offline sem o serviço de pé.

## Estado atual

Repositório em `C:/dev/learno`, commit base `fb1cb1b`.

- Scaffold Tauri v2 + React 19 + TypeScript criado e com dependências instaladas.
- Conjunto de ícones gerado a partir de `assets/learno-source.jpg`: o fundo branco foi
  removido por preenchimento a partir da borda (preservando as páginas brancas dos
  livros), a arte foi devolvida à sua grade nativa de pixels e ampliada por vizinho
  mais próximo até um mestre de 1024 px. Resultado em `src-tauri/icons/`.
- Paleta extraída do ícone, para virar token do Tailwind na Fase 1:
  `#d69436` âmbar, `#59d68a` menta, `#0d564d` esmeralda escuro, `#9f582e` terracota,
  `#7d3912` marrom, `#120000` quase-preto.
- Dependências da stack instaladas, todas em versão corrente e com `npm audit` limpo:
  TipTap 3.31, React Flow 12.11, Tailwind 4.3, Zustand 5, TanStack Query 5.102,
  Vitest 4.1, plugins Tauri store/dialog/fs/shell.
- Em andamento: workflow multi-agente que lê as documentações oficiais do Notion e do
  Anki e produz `docs/CHECKLIST.md`, o documento que define o critério de pronto de
  todas as seis fases.

## Próximos passos

1. Fechar `docs/CHECKLIST.md` sob gauntlet (comparação cega entre dois candidatos,
   swap de confirmação, auditoria de completude contra as docs oficiais).
2. Executar a Fase 1 (fundação): schema PostgreSQL e migrações, camada de dados em
   Rust com sqlx, IPC do Tauri, sidecar Python empacotado, assistente de primeira
   execução para a conexão, tema claro e escuro sobre a paleta do ícone, janela e
   ícone. Checkpoint com o usuário ao fim.
3. Fases 2 a 6 na ordem: editor de blocos, databases e views, SRS/Anki, mapa mental e
   Pomodoro, polimento e instalador. Checkpoint ao fim de cada uma.

## Critério de pronto

O loop encerra quando 100% dos itens marcados como essenciais em `docs/CHECKLIST.md`
passam no teste declarado para cada um. Cada item do checklist carrega um critério de
aceite observável por um terceiro e o tipo de teste que o prova, entre `vitest`,
`cargo-test`, `pytest`, `e2e-playwright` e `manual-visual`.

Isso é deliberadamente diferente de "quando estiver bom": o documento é a régua, e a
régua foi escrita antes do código.

## Evidência

- `cargo check --all-targets` no scaffold: 239 crates compilados, saída 0, 1m18s.
  Confirma que o toolchain Rust, o MSVC e o WebView2 desta máquina constroem Tauri.
- `npm audit` após instalar a stack: `found 0 vulnerabilities` em 255 pacotes.
- Serviços de banco: `postgresql-x64-18` em execução, porta 5432 em escuta;
  `MSSQL$SQLEXPRESS` em execução, porta 1433. SQL Server está fora do escopo do v1.
- Autenticação do PostgreSQL local exige senha: `psql -w` retorna
  `fe_sendauth: no password supplied`. Por isso a conexão é pedida ao usuário no
  assistente de primeira execução, e os testes Rust que precisam de banco vivo nascem
  marcados `#[ignore]`, para rodar só quando uma conexão de desenvolvimento for
  fornecida.
- Ícone verificado visualmente após a conversão: fundo transparente, arestas de pixel
  preservadas, cores da arte original intactas.
