// FUN-005 — "Drag-and-drop para aninhar página" (docs/CHECKLIST.md): soltar
// uma página sobre outra a torna sub-página desta. `src/features/pages/
// PageTree.tsx` decide se o solto vira "antes"/"depois"/"aninhar" a partir
// de `event.clientY` contra `getBoundingClientRect()` do alvo (função
// `zoneFromPointerY`). Em jsdom (Vitest) todo elemento tem rect zerado —
// não existe layout de verdade — então essa lógica geométrica nunca é
// exercitada por um teste de componente; só um WebView real, com layout
// real, prova este critério de aceite.
//
// Setup do teste (não é o que este teste verifica): a única porta de
// entrada para o estado "pronto" é o próprio assistente de primeira
// execução/reconexão (`App.tsx` só renderiza a árvore depois que
// `FirstRunWizard` chama `onComplete`, e a senha nunca fica persistida —
// ver `src/App.tsx` — então nem escrever `config.json` na mão adiantaria:
// toda sessão nova sempre nasce em "needs-reconnect" e pede a senha de
// novo). Este arquivo preenche esse mesmo formulário apontando para
// `learno_test`, sem alegar nada sobre PLT-016 (isso é
// first-run-wizard.e2e.mjs) — é só o caminho que existe para chegar à
// árvore de páginas.

import { TEST_DB } from "../lib/env.mjs";
import { psql, psqlQuiet, sqlLiteral } from "../lib/psql.mjs";

const STAMP = Date.now();
const PARENT_TITLE = `E2E Destino ${STAMP}`;
const CHILD_TITLE = `E2E Origem ${STAMP}`;

/** Mesmo par label+input de first-run-wizard.e2e.mjs — nenhum dos dois arquivos importa do outro de propósito (specs independentes, cada um lançando sua própria sessão do app). */
function fieldFor(label) {
  return $(`//label[normalize-space(text())="${label}"]/following-sibling::input`);
}

function treeItemByTitle(title) {
  return $(`//div[@role="treeitem"][contains(., "${title}")]`);
}

/** Confirma no Postgres real — não só no DOM — que `parent_id` mudou (o que o critério de aceite do FUN-005 exige). */
function parentIdOf(title) {
  return psql(`select parent_id from pages where title = ${sqlLiteral(title)}`);
}

function idOf(title) {
  return psql(`select id from pages where title = ${sqlLiteral(title)}`);
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
    await $("h1=Conectar ao Postgres").waitForDisplayed({ timeout: 20000 });

    await fieldFor("Host").setValue(TEST_DB.host);
    await fieldFor("Porta").setValue(String(TEST_DB.port));
    await fieldFor("Banco de dados").setValue(TEST_DB.database);
    await fieldFor("Usuário").setValue(TEST_DB.user);
    // Trust auth (ver first-run-wizard.e2e.mjs sobre o campo Senha nascer
    // `required`) — conteúdo irrelevante para o Postgres, só não pode ficar vazio.
    await fieldFor("Senha").setValue("placeholder-ignorado-por-trust-auth");

    await $("button=Testar conexão").click();
    await $('[role="status"]').waitForDisplayed({ timeout: 15000 });
    await $("button=Continuar").click();

    await $('[aria-label="Árvore de páginas"]').waitForDisplayed({ timeout: 15000 });
  });

  after(() => {
    // Limpeza do próprio banco de teste descartável — mantém a suíte
    // repetível sem acumular páginas de execuções anteriores.
    psqlQuiet(`delete from pages where title in (${sqlLiteral(PARENT_TITLE)}, ${sqlLiteral(CHILD_TITLE)})`);
  });

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

  it("persistiu no Postgres: parent_id da origem agora é o id do destino", () => {
    const parentId = parentIdOf(CHILD_TITLE);
    const expectedId = idOf(PARENT_TITLE);
    expect(parentId).toBe(expectedId);
  });
});
