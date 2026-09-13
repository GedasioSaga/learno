// FUN-005 — "Drag-and-drop para aninhar página" (docs/CHECKLIST.md): soltar
// uma página sobre outra a torna sub-página desta. `src/features/pages/
// PageTree.tsx` decide se o solto vira "antes"/"depois"/"aninhar" a partir
// de `event.clientY` contra `getBoundingClientRect()` do alvo (função
// `zoneFromPointerY`). Em jsdom (Vitest) todo elemento tem rect zerado —
// não existe layout de verdade — então essa lógica geométrica nunca é
// exercitada por um teste de componente; só um WebView real, com layout
// real, prova este critério de aceite.
//
// Setup do teste (não é o que este teste verifica): depois da migração para
// SQLite (docs/MIGRACAO-SQLITE.md) não existe mais assistente de primeira
// execução — `FirstRunWizard` foi apagado. `App.tsx` chama `openWorkspace()`
// ao subir, que abre direto o arquivo do banco na pasta de dados do app e
// aplica as migrações; não há formulário para preencher nem "Continuar" para
// clicar. O app só demora a aparecer porque essa abertura + migração ainda
// precisam rodar na primeira execução da sessão — daí o timeout generoso no
// primeiro elemento esperado abaixo.

import { scalar, waitFor } from "../lib/db.mjs";

const STAMP = Date.now();
const PARENT_TITLE = `E2E Destino ${STAMP}`;
const CHILD_TITLE = `E2E Origem ${STAMP}`;

function treeItemByTitle(title) {
  return $(`//div[@role="treeitem"][contains(., "${title}")]`);
}

/** Confirma no banco real — não só no DOM — que `parent_id` mudou (o que o critério de aceite do FUN-005 exige). */
function parentIdOf(title) {
  return scalar("select parent_id from pages where title = ?", [title]);
}

function idOf(title) {
  return scalar("select id from pages where title = ?", [title]);
}

async function createRootPage(title) {
  await $('button*=Nova página').click();
  // A página nasce em modo de renomear (FUN-002/pendingFocusId) — o input
  // de título é o único visível na árvore nesse instante.
  const input = await $('input[aria-label^="Título de"]');
  await input.waitForDisplayed({ timeout: 5000 });
  await input.setValue(title);
  await browser.keys("Enter");
  await treeItemByTitle(title).waitForDisplayed({ timeout: 5000 });
}

describe("FUN-005 — arrastar uma página sobre outra a torna sua sub-página", () => {
  before(async () => {
    // Sem assistente de primeira execução, o primeiro sinal de app pronto é
    // a própria barra lateral (`AppShell.tsx`, `nav[aria-label="Páginas"]`).
    // 30000ms porque essa primeira renderização ainda espera `openWorkspace()`
    // criar/abrir o arquivo SQLite e rodar as migrações pendentes.
    await $('[aria-label="Páginas"]').waitForDisplayed({ timeout: 30000 });
    await $('[aria-label="Árvore de páginas"]').waitForDisplayed({ timeout: 15000 });
  });

  // Sem hook de limpeza: `db.mjs` abre o arquivo só para leitura de propósito
  // (o app está de pé com o mesmo arquivo aberto em WAL), então não há como
  // fazer `DELETE` daqui. Os títulos já carregam `STAMP` (Date.now()) e são
  // exclusivos desta suíte, então uma execução não colide com sobra de outra.

  it("cria duas páginas raiz para o cenário", async () => {
    await createRootPage(PARENT_TITLE);
    await createRootPage(CHILD_TITLE);

    await expect(treeItemByTitle(PARENT_TITLE)).toHaveAttribute("aria-level", "1");
    await expect(treeItemByTitle(CHILD_TITLE)).toHaveAttribute("aria-level", "1");
  });

  it("arrasta a origem para o meio do destino e ela vira sua sub-página", async () => {
    const source = await treeItemByTitle(CHILD_TITLE);
    const target = await treeItemByTitle(PARENT_TITLE);

    // Soltar no meio (não no terço de cima/baixo) é "nest" em
    // `zoneFromPointerY` — dragAndDrop mira o centro do elemento alvo por
    // padrão, então cai exatamente nessa faixa.
    await source.dragAndDrop(target, { duration: 600 });

    // Recém-aninhada, a origem só volta a aparecer na árvore quando o pai
    // (agora com filhos) é expandido — `move()` na store não expande
    // sozinho (src/features/pages/store.ts).
    const expandParent = await target.$('button[aria-label="Expandir"]');
    await expandParent.waitForDisplayed({ timeout: 5000 });
    await expandParent.click();

    const child = await treeItemByTitle(CHILD_TITLE);
    await child.waitForDisplayed({ timeout: 5000 });
    await expect(child).toHaveAttribute("aria-level", "2");
  });

  it("persistiu no banco: parent_id da origem agora é o id do destino", async () => {
    const expectedId = idOf(PARENT_TITLE);

    // `waitFor` em vez de leitura única: o drop já assentou na tela (teste
    // anterior), mas a escrita no SQLite é assíncrona em relação ao clique —
    // ler no instante seguinte pode pegar o valor antigo por sorte de timing.
    const parentId = await waitFor(() => parentIdOf(CHILD_TITLE), (valor) => valor === expectedId, {
      mensagem: `parent_id de "${CHILD_TITLE}" apontar para o id de "${PARENT_TITLE}"`,
    });

    expect(parentId).toBe(expectedId);
  });
});
