// DBS — a database estilo Notion, de ponta a ponta: criar via "/database",
// criar coluna, criar linha, editar célula de texto e apagá-la de volta.
//
// POR QUE ESTA SPEC EXISTE, e por que ela é a única prova que falta: o e2e é
// a ÚNICA camada deste projeto que atravessa o fio de verdade. O vitest
// mocka `src/lib/ipc.ts` e nunca sai do jsdom; os testes Rust chamam as
// funções `_inner` direto, com structs Rust construídos EM Rust, então o
// `serde_json` do meio nunca entra em cena. Este repositório já quebrou SETE
// costuras de IPC em silêncio nesse buraco exato — o Rust serializando uma
// forma e o TypeScript declarando outra, sem erro, sem log e sem nenhum
// teste vermelho (a mais cara delas está documentada no cabeçalho de
// `cartoes.e2e.mjs`).
//
// O PONTO CEGO ESPECÍFICO que só esta spec fecha: `RecordValueChangeInput`
// — o payload de escrita de célula (`src-tauri/src/db/record_values.rs`) —
// é `Deserialize`-only do lado Rust. `src/lib/contrato-ipc.test.ts` só
// itera sobre structs com `Serialize` (é assim que ele lê a FORMA do
// contrato), então ele estruturalmente NÃO CONSEGUE conferir este tipo —
// autodocumentado no comentário de `RecordValueChangeInput` em
// `src/lib/ipc.ts`. Hoje a garantia de que os nomes de campo batem
// (`recordId`/`propertyId`/`value` do TS contra `record_id`/`property_id`/
// `value` com `#[serde(rename_all = "camelCase")]` no Rust) é alguém ter
// lido o código dos dois lados ao mesmo tempo. Se um dos dois nomes
// divergir, a escrita de célula falha (ou pior, grava `null`) em silêncio,
// e nenhum outro teste deste projeto percebe — só um `invoke` de verdade,
// que só existe aqui.
//
// Ela também lê o banco direto, e não só a tela: "apareceu na tela" e
// "gravou no banco" são afirmações diferentes, e confundir as duas é como o
// autosave que nunca gravou bloco passou despercebido neste projeto. Por
// isso cada passo de escrita confere as duas coisas — inclusive a
// invariante I1 (`src-tauri/src/db/record_values.rs`, `database_record_
// values.rs` 0009/0017): célula vazia é a AUSÊNCIA da linha em
// `database_record_values`, nunca um JSON vazio (`""`/`null`/`[]`) — e o
// round-trip de LEITURA, reabrindo a página, para as duas direções (valor
// escrito e valor apagado).
//
// Peças lidas antes de escrever esta spec (para não adivinhar seletor):
// `src/features/editor/blocks/database/actions.ts` e `register.ts` (como o
// "/database" nasce), `src/features/databases/views/table/TableView.tsx`,
// `ValueCell.tsx`, `TitleCell.tsx`, `AddPropertyMenu.tsx`,
// `DatabaseContainerHeader.tsx` (cabeçalho só monta os botões de ação no
// hover em modo inline — DBS-001), `RichTextEditor.tsx`/`rich-text-value.ts`
// (a célula de Texto é um TipTap próprio, `contenteditable`, não um
// `<input>` — `setValue`/`addValue` não servem aqui) e
// `src-tauri/src/ipc/database_commands.rs`.

import { scalar, waitFor } from "../lib/db.mjs";

const STAMP = Date.now();
const PAGINA_TITLE = `E2E Database ${STAMP}`;
const SCRATCH_TITLE = `E2E Scratch ${STAMP}`;
const VALOR_CELULA = `Valor da celula E2E ${STAMP}`;

function treeItemByTitle(title) {
  return $(`//div[@role="treeitem"][contains(., "${title}")]`);
}

/** Corpo do editor de blocos da página aberta — `aria-label` fixo em `core/Editor.tsx`. */
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

/** Abre `title` e espera o corpo do editor e o cabeçalho concordarem — mesmo padrão de `openPage` em `backlinks.e2e.mjs`. */
async function abrirPagina(title) {
  await treeItemByTitle(title).click();
  await editorBody().then((el) => el.waitForDisplayed({ timeout: 10000 }));
  await $(`input[aria-label="Título da página"][value="${title}"]`).waitForDisplayed({ timeout: 5000 });
}

/** Digita "/" mais `query` no corpo do editor, abrindo o menu de blocos (EDT-047) — mesmo helper de `page-link.e2e.mjs`. */
async function typeSlash(query) {
  const body = await editorBody();
  await body.click();
  await browser.keys(["/", ...query.split("")]);
}

/** Clica o item do menu "/" cujo texto acessível é `title` — mesmo helper de `page-link.e2e.mjs`/`backlinks.e2e.mjs`. */
async function chooseSlashItem(title) {
  const item = await $(`//*[contains(@class,"ed-root") or ancestor::*]//*[normalize-space(text())="${title}"]`);
  await item.waitForDisplayed({ timeout: 5000 });
  await item.click();
}

/** A grade da view Tabela — `role="grid"`, nome acessível o `view.name` ("Tabela"), `TableView.tsx`. */
function grid() {
  return $('[role="grid"][aria-label="Tabela"]');
}

/**
 * A célula de VALOR da propriedade "Texto" na única linha da tabela.
 *
 * `TitleCell` e `ValueCell` são as duas únicas coisas que desenham um
 * `<td role="gridcell">` (`TableView.tsx`); com uma linha só e uma
 * propriedade só além do título, `td[role="gridcell"]` devolve exatamente
 * dois elementos NESTA ORDEM DE DOM (título, depois a coluna "Texto") — a
 * mesma ordem em que `TableView` os desenha (`<TitleCell/>` antes de
 * `columns.map(<ValueCell/>)`). Reconsultado a cada chamada (não guardado
 * numa variável) porque a grade se re-renderiza entre abrir/fechar o editor
 * de célula.
 */
async function celulaDeValor() {
  const celulas = await $$('td[role="gridcell"]');
  return celulas[1];
}

/**
 * Abre o menu "+ Propriedade" do cabeçalho da database.
 *
 * DBS-001: em modo inline (é sempre o modo de um bloco de database dentro
 * de uma página, `DatabaseBlockView.tsx`) o cabeçalho só MONTA os botões de
 * ação (`+ Propriedade`, `+ Novo`, `+ View`) no hover — `showToolbar =
 * mode === "fullPage" || isActive`, e `isActive` nasce `false` em modo
 * inline (`DatabaseContainerHeader.tsx`). Não existe outro caminho de
 * teclado até esses botões (nada focável existe no cabeçalho ANTES deles
 * montarem) — hover de mouse de verdade é o único jeito, daí `moveTo()`: um
 * `pointermove` real, que o WebView2 traduz no `mouseenter` nativo que
 * `onMouseEnter={activate}` escuta, exatamente o que um usuário de mouse
 * produziria.
 */
async function abrirMenuDePropriedade() {
  const nomeDaDatabase = await $('span*=Nova database');
  await nomeDaDatabase.waitForDisplayed({ timeout: 10000 });
  await nomeDaDatabase.moveTo();

  const botao = await $('button*=Propriedade');
  await botao.waitForDisplayed({ timeout: 5000 });
  await botao.click();

  const menu = await $('ul[aria-label="Tipo da nova propriedade"]');
  await menu.waitForDisplayed({ timeout: 5000 });
  return menu;
}

/** A `databases.id` cuja `container_page_id` é a página desta spec — a única forma estável de achar a database, já que a tela nunca expõe o id. */
function databaseIdDoBanco() {
  return scalar(
    "SELECT d.id FROM databases d JOIN pages p ON p.id = d.container_page_id WHERE p.title = ?",
    [PAGINA_TITLE],
  );
}

describe("DBS — database inline: criar, escrever célula de texto e apagar (I1), de ponta a ponta", () => {
  // IDs descobertos no banco à medida que cada passo os cria — a tela nunca
  // os expõe, e são a única forma estável de mirar exatamente esta database/
  // propriedade/registro nas consultas seguintes.
  let databaseId;
  let propertyId;
  let recordId;

  before(async () => {
    await $('[aria-label="Páginas"]').waitForDisplayed({ timeout: 30000 });
    await createRootPage(PAGINA_TITLE);
    // Página em branco só para navegar para longe e voltar (força o
    // remount do bloco de database, e com ele um `useDatabase` novo que
    // busca do banco de novo) — o mecanismo do teste de round-trip mais
    // abaixo.
    await createRootPage(SCRATCH_TITLE);
    await abrirPagina(PAGINA_TITLE);
  });

  // Sem `after` de limpeza: `db.mjs` abre o SQLite somente para leitura de
  // propósito, e o banco inteiro é descartado quando a sessão termina de
  // qualquer forma (docs/e2e.md). Os títulos já carregam `STAMP` como
  // prefixo único, então não há colisão com outra spec dentro da mesma
  // suíte.

  it("'/database' cria a database e a view 'Tabela', a grade aparece — e o banco concorda", async () => {
    await typeSlash("database");
    await chooseSlashItem("Database");

    await grid().waitForDisplayed({ timeout: 20000 });

    databaseId = await waitFor(databaseIdDoBanco, (id) => id !== undefined, {
      mensagem: "a database precisava existir no banco, filha da página que a spec criou",
    });

    expect(
      scalar("SELECT COUNT(*) FROM database_views WHERE database_id = ? AND view_type = 'table'", [databaseId]),
    ).toBe(1);
  });

  it("'+ Propriedade' → 'Texto' cria a coluna — na tela e no banco", async () => {
    const menu = await abrirMenuDePropriedade();
    await menu.$('button*=Texto').click();

    // A coluna nasce com o rótulo do tipo como nome ("Texto"), como o Notion
    // — `AddPropertyMenu.tsx`.
    await $('th*=Texto').waitForDisplayed({ timeout: 20000 });

    propertyId = await waitFor(
      () =>
        scalar(
          "SELECT id FROM database_properties WHERE database_id = ? AND name = ? AND property_type = 'text'",
          [databaseId, "Texto"],
        ),
      (id) => id !== undefined,
      { mensagem: "a propriedade 'Texto' precisava existir no banco com property_type = 'text'" },
    );
  });

  it("'Nova linha' cria o registro — na tela e no banco (o registro é uma página, `create_record`)", async () => {
    await $('button*=Nova linha').click();

    // O registro nasce sem título e abre direto a célula de título em modo
    // de edição (`TableView.addRow`) — Escape fecha sem gravar nada (a
    // spec não precisa de título para provar o resto), e o clique já
    // confirmou `onFocusCell`/`onStartEdit` na tela.
    await browser.keys("Escape");

    recordId = await waitFor(
      () => scalar("SELECT id FROM pages WHERE database_id = ? ORDER BY position ASC LIMIT 1", [databaseId]),
      (id) => id !== undefined,
      { mensagem: "o registro precisava existir no banco como uma página com database_id preenchido" },
    );
    expect(scalar("SELECT COUNT(*) FROM pages WHERE database_id = ?", [databaseId])).toBe(1);

    // Duas células de gridcell agora: título + a coluna "Texto" criada no
    // teste anterior — é a pré-condição de `celulaDeValor()`.
    await expect($$('td[role="gridcell"]')).toBeElementsArrayOfSize(2);
  });

  it("editar a célula de Texto grava o valor em database_record_values — o ponto cego do RecordValueChangeInput", async () => {
    const celula = await celulaDeValor();
    await celula.click();

    // Sem clique extra dentro do editor: o TipTap já foca sozinho
    // (`autofocus: "end"`, `RichTextEditor.tsx`) — um clique aqui miraria o
    // CENTRO do elemento e reposicionaria o cursor lá, o que faria o
    // Backspace do teste de apagar (abaixo) remover só a metade da frente
    // do texto em vez do texto inteiro.
    const editor = await $('[role="textbox"][aria-label="Texto"]');
    await editor.waitForDisplayed({ timeout: 5000 });
    await browser.keys(VALOR_CELULA.split(""));
    // Fecha e COMMITA (`RichTextEditor.tsx`: diferente da célula de título,
    // aqui Escape confirma, não cancela — o mesmo caminho do blur).
    await browser.keys("Escape");

    // Tela: o valor aparece na grade.
    await waitFor(() => celulaDeValor().then((el) => el.getText()), (texto) => texto === VALOR_CELULA, {
      mensagem: "a célula precisava mostrar o valor recém-digitado",
    });

    // Banco: é a String JSON exata que `RecordValueChangeInput.value`
    // atravessou o `invoke` — `json_extract(value, '$')` desembrulha a
    // string jsonb crua gravada em `database_record_values.value`
    // (`encodeRichText`: sem marca, é o texto achatado puro).
    await waitFor(
      () =>
        scalar(
          "SELECT json_extract(value, '$') FROM database_record_values WHERE record_id = ? AND property_id = ?",
          [recordId, propertyId],
        ),
      (valor) => valor === VALOR_CELULA,
      { mensagem: "database_record_values precisava gravar o valor exato digitado, para (record_id, property_id) certos" },
    );
  });

  it("reabrir a página lê de volta o valor gravado — fecha o round-trip de leitura para o caso não-vazio", async () => {
    await abrirPagina(SCRATCH_TITLE);
    await abrirPagina(PAGINA_TITLE);
    await grid().waitForDisplayed({ timeout: 20000 });

    await waitFor(() => celulaDeValor().then((el) => el.getText()), (texto) => texto === VALOR_CELULA, {
      mensagem: "depois de reabrir a página, a célula precisava mostrar o mesmo valor que está no banco",
    });
  });

  it("I1: apagar o conteúdo da célula REMOVE a linha do banco — nunca vira \"\" nem null", async () => {
    const celula = await celulaDeValor();
    await celula.click();

    // Sem clique extra — mesmo motivo documentado no teste de escrita acima:
    // reposicionaria o cursor no centro do texto existente, e o Backspace
    // abaixo apagaria só a metade da frente.
    const editor = await $('[role="textbox"][aria-label="Texto"]');
    await editor.waitForDisplayed({ timeout: 5000 });
    // Apaga tudo com Backspace em vez de Ctrl+A: mais previsível dentro de
    // um `contenteditable` de escopo restrito (não precisa que "selecionar
    // tudo" respeite os limites da célula). Uma folga de 5 teclas a mais
    // não machuca — Backspace num campo já vazio é no-op.
    await browser.keys(Array.from({ length: VALOR_CELULA.length + 5 }, () => "Backspace"));
    await browser.keys("Escape");

    // Tela: a célula volta vazia (`renderRichTextValue` devolve `null` para
    // valor vazio).
    await waitFor(() => celulaDeValor().then((el) => el.getText()), (texto) => texto === "", {
      mensagem: "a célula precisava voltar vazia depois de apagar todo o conteúdo",
    });

    // Banco — a invariante I1 propriamente dita: a LINHA some, não um valor
    // vazio gravado por cima dela.
    await waitFor(
      () =>
        scalar(
          "SELECT COUNT(*) FROM database_record_values WHERE record_id = ? AND property_id = ?",
          [recordId, propertyId],
        ),
      (n) => n === 0,
      { mensagem: "I1 violada: apagar a célula precisava REMOVER a linha de database_record_values" },
    );
  });

  it("reabrir de novo confirma que o banco (vazio) é o que a tela mostra — fecha o round-trip também para a exclusão", async () => {
    await abrirPagina(SCRATCH_TITLE);
    await abrirPagina(PAGINA_TITLE);
    await grid().waitForDisplayed({ timeout: 20000 });

    // Sem isto, um bug bem específico passaria batido: a tela mostrando o
    // valor antigo por algum estado otimista que nunca foi limpo, mesmo com
    // o banco já correto (I1 confirmada no teste anterior). Aqui é
    // montagem nova do bloco (`useDatabase` busca do zero), então não há
    // estado antigo nenhum para vazar — só o banco, de novo.
    await waitFor(() => celulaDeValor().then((el) => el.getText()), (texto) => texto === "", {
      mensagem: "depois de reabrir, a célula precisava continuar vazia — nada de sobra de uma sessão anterior",
    });
    expect(
      scalar("SELECT COUNT(*) FROM database_record_values WHERE record_id = ? AND property_id = ?", [recordId, propertyId]),
    ).toBe(0);
  });
});
