# Achados da Fase 1 — entrada para a Fase 2

Lista do que ficou aberto ao fim da Fase 1, apurada olhando o app rodando de
verdade (WebdriverIO dirigindo o WebView2, com Postgres real por trás) e não
apenas lendo a saída dos testes. Cada item aqui é dívida conhecida, não
surpresa: o portão está verde e estes problemas passam por ele.

## Bloqueiam um usuário real

### 1. O campo Senha barra o assistente em silêncio — RESOLVIDO (ver Histórico de revisão)

`src/components/FirstRunWizard.tsx` — o `<input>` de Senha nascia `required`.
Quem roda Postgres local com autenticação `trust` não tem senha para digitar, e
com o campo vazio a validação nativa do HTML5 bloqueava o envio **antes** do
`onSubmit`: o clique em "Testar conexão" não disparava nada, sem alerta, sem
mensagem, sem estado de erro. A tela simplesmente não reagia.

Esse era o primeiro contato de qualquer pessoa com o Learno, e ele falhava mudo.

**Conferido na revisão pós-Fase-1 (abaixo): já corrigido.** O campo Senha hoje
usa `required={false}` (só `aria-required`, nunca o atributo nativo) e
`blankRequiredFieldMessage()` verifica explicitamente host/banco/usuário mas
não Senha, com o comentário do próprio arquivo citando este achado como o
motivo da mudança. `first-run-wizard.e2e.mjs` deixa o campo vazio de
propósito e afirma `toHaveValue("")`, então o caso que mais importa neste
projeto — Postgres local sem senha nenhuma — é exatamente o que a prova
exercita. O critério de aceite de PLT-016 se sustenta para ele.

### 2. A senha do Postgres é pedida a cada operação

O app decidiu, deliberadamente, nunca persistir a senha. A consequência é que
toda operação que abre uma conexão nova precisa pedi-la de novo. Hoje o diálogo
de Configurações mostra **dois** campos "Senha do Postgres" (copiar de segurança
e restaurar), e a verificação de banco e o import de `.apkg` acrescentam mais
dois. São quatro campos de senha na mesma tela, para o mesmo banco, na mesma
sessão.

A decisão de não persistir é defensável. A consequência, do jeito que está, não
é usável. Vale reabrir a decisão na Fase 2: manter a senha só em memória durante
a sessão resolve os dois lados.

## Visual

### 3. O ícone do app não é o ícone do app

A marca na barra lateral e a ilustração do estado vazio usam um desenho genérico
de três retângulos coloridos, não a arte pixel dos livros empilhados que está em
`assets/learno-icon-native.png` e em `src-tauri/icons/`. A janela usa o ícone
certo; a interface, não.

### 4. "Exportar como Markdown" ocupa uma barra inteira

O botão atravessa toda a largura da área de conteúdo, logo abaixo do título,
como se fosse uma barra de ferramentas. Exportar é uma ação ocasional e está
com o peso visual da ação principal da tela.

### 5. A trilha de navegação mostra "Sem título" fantasma

Acima do título da página aparece uma entrada "Sem título" que não corresponde a
nenhuma página aberta.

### 6. Posicionamento de sobreposição

A paleta de busca abre alta e deslocada em relação à área de conteúdo, e o
diálogo de Configurações abre encostado à esquerda cobrindo a barra lateral, em
vez de centralizado.

## Testes

### 7. Avisos de `act()` voltaram

`TrashDialog`, `Breadcrumb` e `VersionHistoryDialog` atualizam estado do React
fora de `act()` durante os testes. Foram corrigidos numa rodada e reapareceram
com os componentes novos. Os testes passam, mas o aviso indica asserção
acontecendo antes do React terminar de renderizar — é falso-verde esperando
para acontecer.

### 8. Permissão do diálogo de arquivo não está declarada

`src-tauri/capabilities/default.json` declara `core:default`, `opener:default` e
`shell:allow-execute`, mas nenhuma permissão `dialog:*`. Três recursos já
dependem do seletor de arquivo nativo (backup, restauração, import de `.apkg`).
Funcionou nas provas e2e; se o ACL do Tauri passar a exigir a declaração, os
três quebram juntos.

### 9. FUN-004 e FUN-006 não têm o teste de mouse que seu próprio tipo declarado exige

`src/features/pages/PageTree.test.tsx` (linha ~367) documenta a intenção
original: *"FUN-004/005/006 via mouse (arrastar e soltar) ficam para o
Playwright"* — isto é, os três (reordenar, aninhar, desaninhar por
arrasto) usam a mesma lógica geométrica (`zoneFromPointerY` contra
`getBoundingClientRect()`) que só um WebView real exercita de verdade (jsdom
zera todo `rect`). Só o FUN-005 (aninhar) ganhou esse teste dedicado
(`e2e/specs/page-tree-drag-and-drop.e2e.mjs`). FUN-004 (reordenar) e FUN-006
(desaninhar) continuam com `e2e-webdriverio` declarado no checklist — correto,
é o teste que o critério de aceite (que fala em arrastar com o mouse) exige —
mas hoje só têm prova por teclado (`Alt+ArrowDown`/`Alt+ArrowLeft`,
`vitest`) e pela lógica pura de reordenação (`tree-utils.test.ts`), não pelo
próprio caminho de mouse que o critério descreve. Não é um erro do checklist
(o tipo declarado está certo) nem falta de implementação (é o mesmo código de
drag-and-drop já demonstrado funcionando em FUN-005) — é teste que falta
escrever, mesma categoria dos dois specs que já existem.

## Itens do checklist mal posicionados

Não são defeitos de código — são erros do próprio `docs/CHECKLIST.md`,
encontrados só depois que a Fase 1 foi construída, e corrigidos na revisão
registrada em `docs/CHECKLIST.md` ("Histórico de revisão" ao final daquele
arquivo):

- **PLT-017** pedia medir desempenho com página de 3.000 blocos, view de
  10.000 registros e mapa mental de 1.000 nós. Bloco é Fase 2, database é Fase
  3, mapa mental é Fase 5 — invarificável na Fase 1 por construção. Movido
  para a Fase 5 (a última das três a nascer).
- **PLT-015** (Check Media) depende de manuseio de mídia que nenhuma fase
  anterior à 4 introduz. Movido para a Fase 4.
- **PLT-004** (ponte Tauri↔sidecar para import de `.apkg`) — achado novo,
  encontrado ao varrer o documento inteiro atrás do mesmo erro, como o item
  acima previa que não andaria sozinho. O critério de aceite exige processar
  um `.apkg` real de 50MB; o código de hoje (`ipc::commands::import_apkg`) só
  cobre os caminhos de rejeição, porque o import de fato é SRS-149 (Fase 4).
  Movido para a Fase 4.
- **PLT-013** foi conferido e **não** movido: o mecanismo central (backup por
  cadência + gatilho por "Check Database", ambos Fase 1) já é código real e
  testável hoje; só um dos três exemplos de gatilho citados no seu critério
  (`.colpkg`) é Fase 4, e o terceiro ("sync one-way") não corresponde a
  nenhum item deste documento em nenhuma fase. Registrado aqui em vez de
  mover o ID — ver o raciocínio completo no Histórico de revisão do
  checklist.
- **180 itens** (não 183 — a contagem de 183 estava errada; ver Histórico de
  revisão do checklist) declaravam `e2e-playwright`. O runner que existe e
  funciona é WebdriverIO com `tauri-driver` — o Playwright não dirige o
  WebView2 do Tauri no Windows. O rótulo mentia sobre a ferramenta; todas as
  ocorrências foram renomeadas para `e2e-webdriverio` (ver `docs/e2e.md`).
- Auditoria item a item da Fase 1 confirmou mais 7 casos, além de FUN-023 e
  FUN-037, em que o tipo declarado não batia com o teste real do repositório
  (FUN-002, FUN-008, FUN-009, FUN-011, FUN-019, FUN-022, FUN-035) — todos
  corrigidos para `vitest`/`cargo-test`, o tipo que de fato prova cada
  critério hoje. FUN-004 e FUN-006 foram conferidos e mantidos como
  `e2e-webdriverio` (a lacuna é de teste que falta escrever, não de rótulo
  errado — ver achado #9 acima).

A revisão que corrigiria essas coisas rodou nesta sessão — resultado completo
em `docs/CHECKLIST.md`, seção "Histórico de revisão".
