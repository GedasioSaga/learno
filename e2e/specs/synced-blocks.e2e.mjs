// EDT-073/074/076/077/078 (docs/CHECKLIST.md) — synced-blocks
// (`src/features/editor/synced/`). NÃO EXECUTADO por esta rodada (instrução
// da tarefa).
//
// Escrito só contra a metade de EDT-073 que tem caminho real de UI: "Turn
// into > Bloco sincronizado" (`synced/register.ts`) e o indicador
// (`.ed-synced-badge`, `synced-decorations.ts`) — reusa o handle de
// "Turn into" que `interaction/turn-into/turn-into-handle.ts` já expõe
// (`[data-testid="block-handle-turn-into"]`, menu `role="menu"
// aria-label="Transformar em"`, itens `role="menuitemradio"`), lido do
// arquivo real desse outro construtor, não suposto.
//
// EDT-074/076/077/078 NÃO estão cobertos aqui — e não é por preguiça de
// escrever o cenário, é porque não há caminho de UI pra montar o "dado" que
// cada um pede ("3 cópias coladas", "original com 5 cópias"):
// `create_synced_block_copy` (o único jeito de uma cópia nascer com
// `synced_source_id` já apontado) exige `placement.pageId`, e nenhum ponto
// de extensão que `core/block-spec.ts` expõe (`SlashMenuItem`/`TurnIntoItem`
// /`FormattingMenuItem`, todos só recebem `editor`) tem como saber qual
// página está aberta — `core/Editor.tsx` não expõe isso a extensão nenhuma
// (ver o `core_gaps` no relatório desta peça). Semear cópias direto via SQL
// não resolve: os botões de EDT-076/077/078 só aparecem para um bloco que
// `synced-store.ts` (cache local, `localStorage`) já conhece, e uma linha
// inserida por fora da UI nunca passa por `markSynced`. A lógica dos cinco
// itens está coberta de ponta a ponta em `src/features/editor/synced/
// synced-actions.test.ts` (chamando os comandos reais do backend, só com
// `invoke` mockado) — este arquivo é o que falta no dia em que
// `Editor.tsx` passar a expor `pageId` às extensões.

import { TEST_DB } from "../lib/env.mjs";

const STAMP = Date.now();
const PAGE_TITLE = `E2E Bloco Sincronizado ${STAMP}`;

function fieldFor(label) {
  return $(`//label[normalize-space(text())="${label}"]/following-sibling::input`);
}

function treeItemByTitle(title) {
  return $(`//div[@role="treeitem"][contains(., "${title}")]`);
}

function editorBody() {
  return $('[aria-label="Corpo da página"]');
}

async function createRootPage(title) {
  await $("button*=Nova página").click();
  const input = await $('input[aria-label^="Título de"]');
  await input.waitForDisplayed({ timeout: 5000 });
  await input.setValue(title);
  await browser.keys("Enter");
  await treeItemByTitle(title).waitForDisplayed({ timeout: 5000 });
}

async function openPage(title) {
  await treeItemByTitle(title).click();
  await editorBody().then((el) => el.waitForDisplayed({ timeout: 10000 }));
}

async function typeParagraph(text) {
  const body = await editorBody();
  await body.click();
  await browser.keys(text.split(""));
}

/** O handle de "Turn into" que `interaction/turn-into/` já expõe - reusado aqui, não reimplementado. */
async function openTurnIntoMenu() {
  const trigger = await $('[data-testid="block-handle-turn-into"]');
  await trigger.waitForDisplayed({ timeout: 5000 });
  await trigger.click();
  const menu = await $('[role="menu"][aria-label="Transformar em"]');
  await menu.waitForDisplayed({ timeout: 5000 });
  return menu;
}

async function chooseTurnInto(menu, title) {
  const item = await menu.$(`.//button[@role="menuitemradio"][contains(., "${title}")]`);
  await item.waitForDisplayed({ timeout: 5000 });
  await item.click();
}

function syncedBadge() {
  return $('.ed-synced-badge[aria-label="Bloco sincronizado"]');
}

describe("EDT-073 — Turn into > Bloco sincronizado", () => {
  before(async () => {
    await $("h1=Conectar ao Postgres").waitForDisplayed({ timeout: 20000 });

    await fieldFor("Host").setValue(TEST_DB.host);
    await fieldFor("Porta").setValue(String(TEST_DB.port));
    await fieldFor("Banco de dados").setValue(TEST_DB.database);
    await fieldFor("Usuário").setValue(TEST_DB.user);
    await fieldFor("Senha").setValue("placeholder-ignorado-por-trust-auth");

    await $("button=Testar conexão").click();
    await $('[role="status"]').waitForDisplayed({ timeout: 15000 });
    await $("button=Continuar").click();

    await $('[aria-label="Árvore de páginas"]').waitForDisplayed({ timeout: 15000 });

    await createRootPage(PAGE_TITLE);
    await openPage(PAGE_TITLE);
  });

  it('dado um parágrafo selecionado, "Turn into > Bloco sincronizado" ganha o indicador visual', async () => {
    await typeParagraph("Anotação reutilizável");

    const menu = await openTurnIntoMenu();
    await chooseTurnInto(menu, "Bloco sincronizado");

    await syncedBadge().then((el) => el.waitForDisplayed({ timeout: 5000 }));
  });

  it('reabrir "Turn into" no mesmo bloco mostra a opção marcada (isActive)', async () => {
    const menu = await openTurnIntoMenu();
    const item = await menu.$(`.//button[@role="menuitemradio"][contains(., "Bloco sincronizado")]`);
    await expect(item).toHaveAttribute("aria-checked", "true");
    await browser.keys("Escape");
  });
});
