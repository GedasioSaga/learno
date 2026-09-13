// EDT-050/EDT-051 — "Arrastar para reordenar" e "Arrastar para aninhar"
// (docs/CHECKLIST.md, Fase 2). Ambos declarados e2e no checklist, e com
// razão: `interaction/drag/drop-zone.test.ts` prova a decisão geométrica
// com um retângulo passado à mão, e `interaction/drag/node-move.test.ts`
// prova a cirurgia de árvore em unidade, mas nenhum dos dois exercita um
// `getBoundingClientRect()` de verdade nem um gesto de mouse real — só um
// WebView com layout de verdade faz isso (mesmo motivo documentado em
// `page-tree-drag-and-drop.e2e.mjs`, que este arquivo segue de perto).
//
// Onde soltar, contra as três faixas que `interaction/drag/drop-zone.ts`
// realmente usa (medidas no WebView2: um parágrafo de uma linha ocupa a
// largura toda da coluna, ~980x28px, e a alça mora ~7px à DIREITA da borda
// direita do wrapper — `drag.css`):
//   1. faixa vertical de 30% junto ao topo ou à base do alvo, em QUALQUER x
//      -> reordenar antes/depois (EDT-050);
//   2. fora dessas faixas, os 24px junto à borda DIREITA -> colunas
//      (EDT-033, que este arquivo não exercita);
//   3. todo o resto do interior -> aninhar (EDT-051).
// Por isso EDT-050 mira um ponto calculado explicitamente na faixa de cima
// do wrapper-alvo (`dropRelativeToBlock`, abaixo) em vez de mirar a alça do
// alvo — que, morando à direita e FORA do wrapper, não cairia em zona
// nenhuma dele. EDT-051 solta no centro do parágrafo do alvo: metade da
// altura (interior) e centro da largura (longe dos 24px da direita).

import { column, scalar, waitFor } from "../lib/db.mjs";

const STAMP = Date.now();
const PAGE_TITLE = `E2E Drag ${STAMP}`;

function treeItemByTitle(title) {
  return $(`//div[@role="treeitem"][contains(., "${title}")]`);
}

/** O `div.ed-paragraph` cujo texto é exatamente `text` — cada bloco de teste tem texto único, então basta o texto pra achar o wrapper certo. */
function paragraphByText(text) {
  return $(`//div[contains(@class, "ed-paragraph")][normalize-space(text())="${text}"]`);
}

/** A alça de arrastar do bloco cujo texto é `text` — sobe do parágrafo até o wrapper, desce até a alça (irmã do parágrafo, não ancestral/descendente dele). */
function dragHandleFor(text) {
  return $(
    `//div[contains(@class, "ed-paragraph")][normalize-space(text())="${text}"]/parent::div[contains(@class, "ed-block-wrapper")]//button[contains(@class, "ed-drag-handle")]`,
  );
}

/**
 * Solta a alça do bloco `sourceText` num ponto absoluto (`clientX`/
 * `clientY`, mesmo referencial que `drop-zone.ts`'s `dropZoneFor` usa)
 * calculado a partir do wrapper do bloco `targetText`, nas frações
 * `xFrac`/`yFrac` do seu próprio retângulo - `element.dragAndDrop` só aceita
 * um elemento (solta no centro dele) ou um deslocamento relativo à posição
 * atual (`{x, y}` - ver o tipo `DragAndDropCoordinate` instalado em
 * `webdriverio/build/commands/element/dragAndDrop.d.ts`), nunca "elemento
 * mais um deslocamento interno"; por isso o alvo vira sempre um delta a
 * partir do centro atual da própria alça de origem.
 */
async function dropRelativeToBlock(sourceText, targetText, xFrac, yFrac) {
  const xpathFor = (text) =>
    `//div[contains(@class, "ed-paragraph")][normalize-space(text())="${text}"]/parent::div[contains(@class, "ed-block-wrapper")]`;
  const geometry = await browser.execute(
    (sourceXPath, targetXPath) => {
      const evalOne = (xp) =>
        document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      const sourceWrapper = evalOne(sourceXPath);
      const targetWrapper = evalOne(targetXPath);
      const source = sourceWrapper ? sourceWrapper.querySelector(".ed-drag-handle") : null;
      if (!source || !targetWrapper) return null;
      const w = targetWrapper.getBoundingClientRect();
      const s = source.getBoundingClientRect();
      return {
        wrapperRect: { left: w.left, top: w.top, width: w.width, height: w.height },
        sourceCenter: { x: s.left + s.width / 2, y: s.top + s.height / 2 },
      };
    },
    xpathFor(sourceText),
    xpathFor(targetText),
  );
  if (!geometry) throw new Error(`geometria não resolvida para "${sourceText}" -> "${targetText}"`);
  const { wrapperRect, sourceCenter } = geometry;
  const targetPoint = {
    x: wrapperRect.left + wrapperRect.width * xFrac,
    y: wrapperRect.top + wrapperRect.height * yFrac,
  };
  // Coordenada inteira: o protocolo WebDriver rejeita fracionária em
  // `pointerMove`, e o retângulo do WebView2 vem em subpixel (~27.75px de
  // altura), então arredondar é obrigatório, não cosmético.
  const origem = { x: Math.round(sourceCenter.x), y: Math.round(sourceCenter.y) };
  const destino = { x: Math.round(targetPoint.x), y: Math.round(targetPoint.y) };

  // Sequência explícita de ponteiro em vez de `element.dragAndDrop`.
  //
  // O `dragAndDrop` do WebdriverIO faz pointerDown, um único movimento até o
  // destino e pointerUp colado nele. Isso funciona quase sempre e falhava de
  // vez em quando (1 rodada em 4, medido): o gesto começava — o indicador de
  // solta aparecia na tela —, mas a ordem não mudava nem no DOM nem no banco.
  // O motivo é que `drop-zone.ts` decide a faixa no ÚLTIMO `pointermove` que
  // recebe, e um `pointerUp` disparado no mesmo instante do movimento final
  // pode chegar antes de o handler ter processado aquela posição.
  //
  // Aqui o caminho é: apertar na origem, um movimento intermediário (para o
  // gesto ser reconhecido como arrasto, não como clique), o movimento até o
  // destino, uma PAUSA com o ponteiro parado lá — que é o que garante o
  // `pointermove` final processado — e só então soltar.
  await browser.performActions([
    {
      type: "pointer",
      id: "mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, x: origem.x, y: origem.y },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 100 },
        {
          type: "pointerMove",
          duration: 300,
          x: Math.round((origem.x + destino.x) / 2),
          y: Math.round((origem.y + destino.y) / 2),
        },
        { type: "pointerMove", duration: 300, x: destino.x, y: destino.y },
        { type: "pause", duration: 200 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
}

/**
 * Espera `plainTextOrderOnPage(pageId)` bater com `expected` - o `drop` só
 * dispara `scheduleSave` (ver `core/use-blocks-document.ts`), que espera
 * `SAVE_DEBOUNCE_MS` (600ms) antes de escrever no arquivo SQLite de verdade,
 * então ler a tabela `blocks` no instante seguinte ao `dragAndDrop` é uma
 * corrida. `waitFor` (de `lib/db.mjs`) é quem repete a leitura até a
 * condição valer ou estourar o tempo — e, se estourar, já embute no erro o
 * último valor lido, então uma falha de persistência do arrasto continua
 * distinguível de uma falha de leitura sem precisar de um `catch` próprio
 * aqui (o `browser.waitUntil` da versão Postgres precisava disso porque seu
 * `timeoutMsg` é uma string fixa, montada antes da checagem rodar).
 */
async function waitForOrder(pageId, expected) {
  await waitFor(
    () => plainTextOrderOnPage(pageId),
    (actual) => actual.length === expected.length && actual.every((text, i) => text === expected[i]),
    {
      timeoutMs: 10000,
      intervalMs: 300,
      mensagem: `ordem esperada ${JSON.stringify(expected)}`,
    },
  );
}

function plainTextOrderOnPage(pageId) {
  return column(
    "select plain_text from blocks where page_id = ? and parent_block_id is null and deleted_at is null order by position",
    [pageId],
  );
}

function idOfPage(title) {
  return scalar("select id from pages where title = ?", [title]);
}

describe("EDT-050/EDT-051 — arrastar blocos para reordenar e aninhar", () => {
  before(async () => {
    // Sem assistente de primeira execução (ver `docs/MIGRACAO-SQLITE.md`): o
    // app abre direto no arquivo SQLite da pasta de dados e roda as
    // migrações sozinho — `App.tsx` chama `openWorkspace()` ao subir. O
    // timeout generoso é porque essa primeira abertura ainda cria o arquivo
    // e migra o schema antes da árvore aparecer.
    await $('[aria-label="Páginas"]').waitForDisplayed({ timeout: 30000 });

    await $("button*=Nova página").click();
    const titleInput = await $('input[aria-label^="Título de"]');
    await titleInput.waitForDisplayed({ timeout: 5000 });
    await titleInput.setValue(PAGE_TITLE);
    await browser.keys("Enter");
    await treeItemByTitle(PAGE_TITLE).waitForDisplayed({ timeout: 5000 });
    await treeItemByTitle(PAGE_TITLE).click();

    const body = await $('[aria-label="Corpo da página"]');
    await body.waitForDisplayed({ timeout: 15000 });
    await body.click();
    // Três parágrafos irmãos: A, Enter cria o próximo (EDT-001), e assim
    // por diante — o mesmo caminho que qualquer digitação normal usa.
    await browser.keys(["A", "Enter", "B", "Enter", "C"]);
    await paragraphByText("C").waitForDisplayed({ timeout: 5000 });

    // Espera a digitação chegar ao banco ANTES do primeiro arrasto: sem isto
    // uma falha de persistência do arrasto e uma falha de persistência da
    // digitação chegariam ao mesmo `timeoutMsg`, e o teste apontaria para o
    // culpado errado.
    await waitForOrder(idOfPage(PAGE_TITLE), ["A", "B", "C"]);
  });

  // Sem limpeza: `lib/db.mjs` abre o SQLite em modo somente leitura de
  // propósito (o app está de pé com o arquivo em WAL — ver o comentário de
  // `open()` lá), então não há DELETE possível daqui. Não é necessário
  // também: o banco inteiro é descartado entre sessões de teste
  // (`wdio.conf.mjs` apaga `APP_DATA_DIR` antes de subir), e `PAGE_TITLE`
  // já carrega `STAMP` para não colidir com outra execução da mesma sessão.

  it("EDT-050: arrasta C para a faixa de cima de B — nova ordem A, C, B", async () => {
    // yFrac 0.25 < 0.3 cai na faixa de "reordenar antes" de `dropZoneFor`;
    // xFrac 0.2 mantém o ponto longe dos 24px de zona de colunas à direita
    // (irrelevante nesta faixa, mas deixa o teste explícito sobre em qual
    // das três zonas ele mira).
    await dropRelativeToBlock("C", "B", 0.2, 0.25);

    await waitForOrder(idOfPage(PAGE_TITLE), ["A", "C", "B"]);
  });

  it("EDT-051: arrasta a alça de C para o meio do parágrafo de A — C vira filho indentado de A", async () => {
    const sourceHandle = await dragHandleFor("C");
    const targetParagraph = await paragraphByText("A");

    // O centro do parágrafo é metade da altura do wrapper (fora das duas
    // faixas de 30% que reordenam) e metade da largura (longe dos 24px de
    // zona de colunas junto à borda direita) — a zona de aninhar.
    await sourceHandle.dragAndDrop(targetParagraph, { duration: 600 });

    const pageId = idOfPage(PAGE_TITLE);
    // C saiu da lista de irmãos de topo — só A e B continuam lá.
    await waitForOrder(pageId, ["A", "B"]);

    const parentOfC = scalar(
      "select parent_block_id from blocks where page_id = ? and plain_text = 'C' and deleted_at is null",
      [pageId],
    );
    const idOfA = scalar("select id from blocks where page_id = ? and plain_text = 'A' and deleted_at is null", [
      pageId,
    ]);
    expect(parentOfC).toBe(idOfA);
  });
});
