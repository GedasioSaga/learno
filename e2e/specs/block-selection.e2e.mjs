// EDT-053/054/059 — "Seleção múltipla de blocos" (docs/CHECKLIST.md). Os
// três dependem de layout/hit-testing real (arrasto na margem via
// `getBoundingClientRect()`, um `ClipboardEvent` de verdade) que jsdom não
// tem — mesmo raciocínio de `page-tree-drag-and-drop.e2e.mjs` sobre
// `zoneFromPointerY`. A lógica pura por trás deles (`siblingIdsBetween`, a
// serialização de clipboard) já tem teste próprio em
// `src/features/editor/interaction/selection/selection.test.ts` — este
// arquivo prova só o gesto de DOM em cima dela.
//
// O assistente de primeira execução aparece UMA vez por sessão do app, e
// todos os `describe` deste arquivo compartilham a mesma sessão (um app
// Tauri por spec — ver `wdio.conf.mjs`). Por isso a conexão mora num
// `before` de arquivo (`connectOnce`) e cada `describe` só abre a sua
// própria página: a versão anterior repetia o formulário de conexão em cada
// `describe` e os dois últimos morriam esperando por um `h1=Conectar ao
// Postgres` que nunca ia voltar a existir.

import { Key } from "webdriverio";

import { TEST_DB } from "../lib/env.mjs";
import { psqlQuiet, sqlLiteral } from "../lib/psql.mjs";

const STAMP = Date.now();
/** Prefixo comum das páginas deste arquivo — uma por `describe`, todas apagadas de uma vez no fim. */
const PAGE_PREFIX = `E2E Seleção ${STAMP}`;

function fieldFor(label) {
  return $(`//label[normalize-space(text())="${label}"]/following-sibling::input`);
}

function treeItemByTitle(title) {
  return $(`//div[@role="treeitem"][contains(., "${title}")]`);
}

/** Todo `.ed-block-wrapper` cujo próprio filho de conteúdo carrega este id — `selection-mouse.ts`'s `ownBlockId`, do lado do teste. */
function blockWrapperById(id) {
  return $(`.ed-block-wrapper:has([data-block-id="${id}"])`);
}

let connected = false;

async function connectOnce() {
  if (connected) return;
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
  connected = true;
}

/** Cria uma página raiz nova, abre-a e devolve o corpo do editor já com o cursor dentro. */
async function openNewPage(title) {
  await connectOnce();
  await $("button*=Nova página").click();
  const titleInput = await $('input[aria-label^="Título de"]');
  await titleInput.waitForDisplayed({ timeout: 5000 });
  await titleInput.setValue(title);
  await browser.keys("Enter");

  await treeItemByTitle(title).waitForDisplayed({ timeout: 5000 });
  await treeItemByTitle(title).click();
  const body = await $('[aria-label="Corpo da página"]');
  await body.waitForDisplayed({ timeout: 10000 });
  await body.click();
  return body;
}

/** Digita uma linha por bloco, um Enter entre elas — cada linha vira um bloco novo (EDT-001). */
async function typeParagraphs(lines) {
  for (const [index, line] of lines.entries()) {
    await browser.keys(line);
    if (index < lines.length - 1) await browser.keys("Enter");
  }
}

/** Ids de bloco na ordem em que aparecem no documento. */
function blockIdsInOrder() {
  return browser.execute(() =>
    [...document.querySelectorAll(".ed-block-wrapper")].map((w) =>
      w.querySelector(":scope > [data-block-id]")?.getAttribute("data-block-id"),
    ),
  );
}

/** Retângulo de um `.ed-block-wrapper` pelo id do bloco — `getLocation()`/`getSize()` porque o elemento do WDIO v9 não tem `getRect` (ver `node_modules/webdriverio/build/types.d.ts`). */
async function wrapperRect(id) {
  const wrapper = await blockWrapperById(id);
  const { x, y } = await wrapper.getLocation();
  const { width, height } = await wrapper.getSize();
  return { x, y, width, height };
}

/**
 * Clica em `element` com Shift realmente pressionado.
 *
 * `element.click({ shift: true })` NÃO faz isso: as opções de `click` no
 * WebdriverIO são só `button`, `x`, `y` e `skipRelease` (ver
 * `node_modules/webdriverio/build/commands/element/click.d.ts`), então uma
 * chave `shift` é ignorada em silêncio e o clique sai sem modificador —
 * medido no WebView2 com um listener de `mousedown`: `shiftKey: false`. O
 * caminho que funciona é a API de ações: `perform(true)` pula o
 * `releaseActions`, deixando a tecla no estado global de entrada da sessão,
 * e o W3C manda esse estado ser aplicado aos eventos de ponteiro seguintes.
 */
async function shiftClick(element) {
  await browser.action("key").down(Key.Shift).perform(true);
  await browser.action("pointer").move({ origin: element }).down().up().perform(true);
  await browser.action("key").up(Key.Shift).perform();
}

after(() => {
  psqlQuiet(`delete from pages where title like ${sqlLiteral(`${PAGE_PREFIX}%`)}`);
});

describe("EDT-053 — seleção por arrasto na margem", () => {
  before(async () => {
    await openNewPage(`${PAGE_PREFIX} arrasto`);
  });

  it("arrastar da margem do bloco 1 até o bloco 3 destaca 1, 2 e 3", async () => {
    await typeParagraphs(["Bloco 1", "Bloco 2", "Bloco 3", "Bloco 4", "Bloco 5"]);
    const ids = await blockIdsInOrder();

    const rect1 = await wrapperRect(ids[0]);
    const rect3 = await wrapperRect(ids[2]);

    // Pré-condição do gesto, checada primeiro para a falha apontar o
    // problema certo — e não é paranoia: até a calha de `selection.css`
    // existir, este teste falhava aqui. Medido no WebView2, `.ed-root`
    // começava no MESMO x de todo `.ed-block-wrapper` (270), porque a faixa
    // vazia de ~32px à esquerda é o `p-8` do container rolável de
    // `Editor.tsx`, FORA do editor. O ponto que satisfaz "à esquerda do
    // wrapper" (o que `selection-mouse.ts` chama de margem) nunca satisfazia
    // "dentro do editor", então nenhum mousedown de margem chegava ao
    // ProseMirror e o gesto não tinha onde acontecer. Se alguém tirar a
    // calha, a falha volta a ser esta mensagem em vez de um "class missing"
    // que não explica nada.
    const marginProbe = await browser.execute((probeX, probeY) => {
      const root = document.querySelector(".ed-root");
      const hit = document.elementFromPoint(probeX, probeY);
      return {
        rootLeft: root?.getBoundingClientRect().left ?? null,
        hitInsideEditor: hit instanceof Element ? Boolean(hit.closest(".ed-root")) : false,
        hitAt: hit instanceof Element ? `${hit.tagName}.${hit.className}` : null,
      };
    }, Math.round(Math.max(rect1.x - 12, 0)), Math.round(rect1.y + rect1.height / 2));
    if (!marginProbe.hitInsideEditor) {
      throw new Error(
        `EDT-053 não implementado no produto: o ponto de margem (x=${Math.round(rect1.x - 12)}) cai fora de ` +
          `\`.ed-root\` (que começa em x=${marginProbe.rootLeft}); ali está ${marginProbe.hitAt}. ` +
          "O editor não tem calha própria à esquerda dos blocos, então nenhum mousedown de margem chega a " +
          "`selection-mouse.ts`. Ver o comentário acima desta asserção.",
      );
    }

    await browser
      .action("pointer")
      .move({ x: Math.round(Math.max(rect1.x - 12, 0)), y: Math.round(rect1.y + rect1.height / 2) })
      .down({ button: 0 })
      .move({ duration: 300, x: Math.round(Math.max(rect3.x - 12, 0)), y: Math.round(rect3.y + rect3.height / 2) })
      .up({ button: 0 })
      .perform();

    for (const id of ids.slice(0, 3)) {
      await expect(blockWrapperById(id)).toHaveElementClass("ed-block-wrapper--selected");
    }
    for (const id of ids.slice(3)) {
      await expect(blockWrapperById(id)).not.toHaveElementClass("ed-block-wrapper--selected");
    }
  });
});

describe("EDT-054 — seleção por Shift+clique", () => {
  before(async () => {
    await openNewPage(`${PAGE_PREFIX} shift`);
  });

  it("bloco 1 selecionado, Shift+clique no bloco 4 estende para 1, 2, 3, 4", async () => {
    await typeParagraphs(["Um", "Dois", "Três", "Quatro"]);
    const ids = await blockIdsInOrder();

    // Clique simples no bloco 1 só posiciona o cursor (é assim que
    // `selection-mouse.ts` trata um clique dentro da caixa do bloco); é o
    // Shift+clique seguinte que estende a partir do bloco do cursor.
    await blockWrapperById(ids[0]).click();
    await shiftClick(await blockWrapperById(ids[3]));

    for (const id of ids) {
      await expect(blockWrapperById(id)).toHaveElementClass("ed-block-wrapper--selected");
    }
  });
});

describe("EDT-059 — copiar/colar preserva tipos e aninhamento", () => {
  before(async () => {
    await openNewPage(`${PAGE_PREFIX} clipboard`);
  });

  it("H2 + lista de 2 itens: colar em outro ponto reproduz o mesmo H2 e a mesma lista", async () => {
    // Atalhos de markdown do próprio schema (core/schema.ts): "## " vira
    // heading nível 2, "- " vira item de lista com marcador.
    await browser.keys("## ");
    await typeParagraphs(["Título"]);
    await browser.keys("Enter");
    await browser.keys("- ");
    await typeParagraphs(["Item 1"]);
    await browser.keys("Enter");
    await typeParagraphs(["Item 2"]);
    await browser.keys("Enter");
    await browser.keys("Parágrafo solto"); // destino da colagem, mais abaixo

    const ids = await blockIdsInOrder();
    const [headingId, , item2Id] = ids;

    // Shift+clique seleciona H2 + os 2 itens como bloco inteiro (EDT-054),
    // não como texto parcial - é essa seleção múltipla que EDT-059 precisa
    // copiar, não uma seleção de texto nativa.
    await blockWrapperById(headingId).click();
    await shiftClick(await blockWrapperById(item2Id));

    await browser.keys(["Control", "c"]);

    // Cursor no fim do parágrafo solto, Enter pra abrir um bloco novo vazio, cola ali.
    await blockWrapperById(ids[ids.length - 1]).click();
    await browser.keys("End");
    await browser.keys("Enter");
    await browser.keys(["Control", "v"]);

    const pasted = await browser.execute(() =>
      [...document.querySelectorAll(".ed-block-wrapper")].slice(-3).map((w) => {
        const content = w.querySelector(":scope > [data-block-id]");
        return { type: content?.getAttribute("data-block-type"), text: content?.textContent };
      }),
    );

    expect(pasted.map((b) => b.type)).toEqual(["heading", "bulletedListItem", "bulletedListItem"]);
    expect(pasted.map((b) => b.text)).toEqual(["Título", "Item 1", "Item 2"]);
  });
});
