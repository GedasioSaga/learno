// EDT-030 (docs/CHECKLIST.md) — "colar uma URL sobre um bloco vazio oferece
// um menu com Create bookmark / Create link (mention)". Rodada anterior só
// tinha testes de unidade que chamavam `confirmBookmarkCard`/
// `confirmInlineLink` diretamente (`paste-plugin.test.ts`) — nunca o
// componente React `BookmarkPasteMenu` (`paste-menu.tsx`), nunca um clique
// real nos botões `role="menuitem"`. O checklist declara este item
// `e2e-webdriverio`, com razão: é comportamento de UI (o menu aparecer,
// clique escolher), não lógica pura.
//
// TÉCNICA DE "COLAR": não existe automação de clipboard do SO neste runner
// (nem `tauri-driver`/WebdriverIO expõem uma, nem colocar algo na área de
// transferência do SO seria hermético entre execuções). Em vez disso, este
// spec despacha um `ClipboardEvent("paste", { clipboardData })` de verdade
// no DOM do corpo do editor via `browser.execute` — dentro do WebView2 real
// (Chromium), não do jsdom que bloqueia isso nos testes unitários (ver o
// comentário no topo de `paste-plugin.test.ts`). `ClipboardEvent` com
// `clipboardData` no dicionário de inicialização é padrão (não é um mock: é
// o mesmo evento "paste" que o SO dispararia, construído à mão em vez de
// vindo do SO), e chega ao `handlePaste` do plugin exatamente pelo mesmo
// caminho de listener que uma colagem real usaria. Cada teste abre sua
// própria página nova (nunca editada) para garantir um bloco vazio "de
// fábrica" sem precisar navegar o cursor por cima de um bookmark (nó atômico).
import { TEST_DB } from "../lib/env.mjs";
import { psqlQuiet, sqlLiteral } from "../lib/psql.mjs";

const STAMP = Date.now();
const PAGE_MENU_TITLE = `E2E Bookmark Menu ${STAMP}`;
const PAGE_CARD_TITLE = `E2E Bookmark Card ${STAMP}`;
const PAGE_MENTION_TITLE = `E2E Bookmark Mention ${STAMP}`;
const BOOKMARK_URL = "https://exemplo-e2e.test/pagina";
const BOOKMARK_HOSTNAME = "exemplo-e2e.test";

function fieldFor(label) {
  return $(`//label[normalize-space(text())="${label}"]/following-sibling::input`);
}

function treeItemByTitle(title) {
  return $(`//div[@role="treeitem"][contains(., "${title}")]`);
}

/** O corpo do editor de blocos da página aberta - `aria-label` fixo em `core/Editor.tsx`, mesmo seletor que os outros specs de bloco usam. */
function editorBody() {
  return $('[aria-label="Corpo da página"]');
}

async function createRootPage(title) {
  await $('button*=Nova página').click();
  const input = await $('input[aria-label^="Título de"]');
  await input.waitForDisplayed({ timeout: 5000 });
  await input.setValue(title);
  await browser.keys("Enter");
  await treeItemByTitle(title).waitForDisplayed({ timeout: 5000 });
}

async function openPage(title) {
  await treeItemByTitle(title).click();
  const body = await editorBody();
  await body.waitForDisplayed({ timeout: 10000 });
  await body.click(); // cursor no primeiro (e único) parágrafo vazio da página recém-criada
}

/**
 * Despacha um `paste` real com `text` como payload `text/plain` no corpo do
 * editor - equivalente, do ponto de vista do listener de `handlePaste` do
 * ProseMirror, a colar via Ctrl+V com `text` na área de transferência.
 */
async function pasteUrl(text) {
  await browser.execute((payload) => {
    const target = document.querySelector('[aria-label="Corpo da página"]');
    if (!target) throw new Error('corpo do editor ("Corpo da página") não encontrado');
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", payload);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
    target.dispatchEvent(event);
  }, text);
}

function pasteMenu() {
  return $('[role="menu"][aria-label="Colar URL como"]');
}

async function clickMenuItem(label) {
  const item = await $(`button=${label}`);
  await item.waitForDisplayed({ timeout: 5000 });
  await item.click();
}

/** O cartão de bookmark (`bookmark-card.ts`'s `renderBookmarkCard`) - `role="button"` com aria-label "Abrir <host> em uma nova janela". */
function bookmarkCardLink() {
  return $(".ed-bookmark__link");
}

describe("EDT-030 — menu de escolha ao colar URL sobre bloco vazio", () => {
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

    await createRootPage(PAGE_MENU_TITLE);
    await createRootPage(PAGE_CARD_TITLE);
    await createRootPage(PAGE_MENTION_TITLE);
  });

  after(() => {
    const titles = [PAGE_MENU_TITLE, PAGE_CARD_TITLE, PAGE_MENTION_TITLE].map(sqlLiteral).join(", ");
    psqlQuiet(`delete from pages where title in (${titles})`);
  });

  it("EDT-030: URL colada em bloco vazio abre o menu oferecendo Criar bookmark e Criar link/menção", async () => {
    await openPage(PAGE_MENU_TITLE);
    await pasteUrl(BOOKMARK_URL);

    const menu = await pasteMenu();
    await menu.waitForDisplayed({ timeout: 5000 });

    // Texto acessível do menu inteiro - evita depender da forma exata que o
    // driver devolve uma coleção de elementos, e ainda assim só passa se os
    // dois `role="menuitem"` pedidos pelo checklist estiverem realmente no DOM.
    const menuText = await menu.getText();
    expect(menuText).toContain("Criar bookmark");
    expect(menuText).toContain("Criar link/menção");

    // Nada foi inserido enquanto o menu está pendente - o bloco continua vazio (EDT-030: o paste "não decide pelo usuário").
    const paragraphText = await $(".ed-paragraph").getText();
    expect(paragraphText).toBe("");
  });

  it('EDT-028/EDT-030: escolher "Criar bookmark" converte o bloco vazio num cartão com host, título e URL', async () => {
    await openPage(PAGE_CARD_TITLE);
    await pasteUrl(BOOKMARK_URL);
    await pasteMenu().then((menu) => menu.waitForDisplayed({ timeout: 5000 }));

    await clickMenuItem("Criar bookmark");

    const card = await bookmarkCardLink();
    await card.waitForDisplayed({ timeout: 5000 });
    await expect(card).toHaveAttribute("aria-label", `Abrir ${BOOKMARK_HOSTNAME} em uma nova janela`);

    const title = await $(".ed-bookmark__title").getText();
    expect(title).toBe(BOOKMARK_HOSTNAME); // `fetchBookmarkMetadata` (CORE GAP documentado) cai no hostname - nenhum título real foi buscado
    const urlLabel = await $(".ed-bookmark__url").getText();
    expect(urlLabel).toBe(BOOKMARK_HOSTNAME);

    // O menu de escolha some depois de resolvido - não fica pairando sobre o cartão recém-criado.
    await pasteMenu().then((menu) => menu.waitForExist({ reverse: true, timeout: 5000 }));
  });

  it('EDT-030: escolher "Criar link/menção" insere a URL como texto inline no mesmo bloco, não um cartão', async () => {
    await openPage(PAGE_MENTION_TITLE);
    await pasteUrl(BOOKMARK_URL);
    await pasteMenu().then((menu) => menu.waitForDisplayed({ timeout: 5000 }));

    await clickMenuItem("Criar link/menção");

    const paragraphText = await $(".ed-paragraph").getText();
    expect(paragraphText).toBe(BOOKMARK_URL);
    // Continua parágrafo comum - nenhum cartão de bookmark nasceu desta escolha.
    await expect($(".ed-bookmark__link")).not.toBeExisting();
  });
});
