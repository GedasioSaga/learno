# Achados da Fase 1 — entrada para a Fase 2

Lista do que ficou aberto ao fim da Fase 1, apurada olhando o app rodando de
verdade (WebdriverIO dirigindo o WebView2, com Postgres real por trás) e não
apenas lendo a saída dos testes. Cada item aqui é dívida conhecida, não
surpresa: o portão está verde e estes problemas passam por ele.

## Bloqueiam um usuário real

### 1. O campo Senha barra o assistente em silêncio

`src/components/FirstRunWizard.tsx` — o `<input>` de Senha nasce `required`.
Quem roda Postgres local com autenticação `trust` não tem senha para digitar, e
com o campo vazio a validação nativa do HTML5 bloqueia o envio **antes** do
`onSubmit`: o clique em "Testar conexão" não dispara nada, sem alerta, sem
mensagem, sem estado de erro. A tela simplesmente não reage.

Esse é o primeiro contato de qualquer pessoa com o Learno, e ele falha mudo.

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

## Itens do checklist mal posicionados

Não são defeitos de código — são erros do próprio `docs/CHECKLIST.md`,
encontrados só depois que a Fase 1 foi construída:

- **PLT-017** pede medir desempenho com página de 3.000 blocos, view de 10.000
  registros e mapa mental de 1.000 nós. Bloco é Fase 2, database é Fase 3, mapa
  mental é Fase 5. Invarificável na Fase 1 por construção.
- **PLT-015** (Check Media) depende de manuseio de mídia que nenhuma fase
  anterior à 4 introduz.
- **183 itens** declaram `e2e-playwright`. O runner que existe e funciona é
  WebdriverIO com `tauri-driver` — o Playwright não dirige o WebView2 do Tauri
  no Windows. O rótulo mente sobre a ferramenta; ver `docs/e2e.md`.

A revisão que corrigiria essas três coisas não chegou a rodar (limite de sessão
no meio da rodada). É a primeira tarefa da Fase 2.
