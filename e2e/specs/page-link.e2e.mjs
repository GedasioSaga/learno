// EDT-017/FUN-003/FUN-043 (docs/CHECKLIST.md): o bloco "link para página" -
// diferente da @menção (EDT-044, outro construtor), inserir este bloco
// reparenteia a página apontada para baixo da página aberta no momento.
//
// Suposição documentada (não confirmável por este arquivo sozinho — quem
// constrói `interaction/` decide a marcação real do menu "/", ainda
// inexistente neste repositório no momento em que este spec foi escrito):
// o menu abre com `/` dentro do corpo do editor e expõe cada item
// registrado (`registerSlashMenuItem`, `src/features/editor/blocks/
// page-link/register.ts`) como um elemento clicável cujo texto acessível é
// o `title` exato do item ("Sub-página", "Link para página") - é esse
// contrato, não uma marcação específica, que os seletores abaixo assumem.
// Se a marcação real usar outro papel ARIA, só os seletores em
// `openSlashItem`/`typeSlash` precisam mudar, não o resto do spec.

import { TEST_DB } from "../lib/env.mjs";
import { psql, psqlQuiet, sqlLiteral } from "../lib/psql.mjs";

const STAMP = Date.now();
const CURSO_TITLE = `E2E Curso ${STAMP}`;
const MODULO_TITLE = `E2E Módulo 3 ${STAMP}`;
const SUB_PAGE_TITLE = `E2E Sub-página ${STAMP}`;

function fieldFor(label) {
  return $(`//label[normalize-space(text())="${label}"]/following-sibling::input`);
}

function treeItemByTitle(title) {
  return $(`//div[@role="treeitem"][contains(., "${title}")]`);
}

async function createRootPage(title) {
  await $('button*=Nova página').click();
  const input = await $('input[aria-label^="Título de"]');
  await input.waitForDisplayed({ timeout: 5000 });
  await input.setValue(title);
  await browser.keys("Enter");
  await treeItemByTitle(title).waitForDisplayed({ timeout: 5000 });
}

/** Corpo do editor de blocos da página aberta - `aria-label` fixo em `core/Editor.tsx`. */
function editorBody() {
  return $('[aria-label="Corpo da página"]');
}

/** Digita "/" mais `query` no corpo do editor, abrindo o menu de blocos (EDT-047). */
async function typeSlash(query) {
  const body = await editorBody();
  await body.click();
  await browser.keys(["/", ...query.split("")]);
}

/** Clica o item do menu "/" cujo texto acessível é `title` (ver suposição documentada no topo do arquivo). */
async function chooseSlashItem(title) {
  const item = await $(`//*[contains(@class,"ed-root") or ancestor::*]//*[normalize-space(text())="${title}"]`);
  await item.waitForDisplayed({ timeout: 5000 });
  await item.click();
}

/**
 * Deixa `title` com os filhos à mostra na sidebar, esteja ele recolhido ou
 * já aberto. A versão anterior clicava direto em `button[aria-label=
 * "Expandir"]`, o que só existe enquanto o item está RECOLHIDO — expandido,
 * o mesmo botão passa a se chamar "Recolher" (`PageTreeItem.tsx`). FUN-003
 * já deixa "Curso" expandido (a sub-página que ele cria aparece na árvore),
 * então FUN-043 esperava para sempre por um botão que não existia mais e o
 * teste acusava a reparentagem — que, no Postgres, tinha funcionado.
 */
async function expandIfCollapsed(title) {
  const collapsedToggle = await treeItemByTitle(title).then((el) => el.$('button[aria-label="Expandir"]'));
  if (await collapsedToggle.isExisting()) await collapsedToggle.click();
}

describe("EDT-017/FUN-003/FUN-043 — bloco link-to-page", () => {
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

    await createRootPage(CURSO_TITLE);
    await createRootPage(MODULO_TITLE);
  });

  after(() => {
    const titles = [CURSO_TITLE, MODULO_TITLE, SUB_PAGE_TITLE].map(sqlLiteral).join(", ");
    psqlQuiet(`delete from pages where title in (${titles})`);
  });

  it("FUN-003: '/page' dentro de 'Curso' cria uma sub-página que aparece como filha na sidebar", async () => {
    await treeItemByTitle(CURSO_TITLE).click();
    await editorBody().then((el) => el.waitForDisplayed({ timeout: 10000 }));

    await typeSlash("page");
    await chooseSlashItem("Sub-página");

    // FUN-002/pendingFocusId: a sub-página nasce em modo de renomear na
    // sidebar (`usePageTreeStore.createChild`, o mesmo caminho que "+ Nova
    // página" usa) - dar um título aqui é o jeito de identificá-la depois.
    const titleInput = await $('input[aria-label^="Título de"]');
    await titleInput.waitForDisplayed({ timeout: 5000 });
    await titleInput.setValue(SUB_PAGE_TITLE);
    await browser.keys("Enter");

    const subPageRow = await treeItemByTitle(SUB_PAGE_TITLE);
    await subPageRow.waitForDisplayed({ timeout: 5000 });
    await expect(subPageRow).toHaveAttribute("aria-level", "2");
  });

  it("FUN-003 (Postgres): parent_id da sub-página é o id de 'Curso'", () => {
    const parentId = psql(`select parent_id from pages where title = ${sqlLiteral(SUB_PAGE_TITLE)}`);
    const cursoId = psql(`select id from pages where title = ${sqlLiteral(CURSO_TITLE)}`);
    expect(parentId).toBe(cursoId);
  });

  it("FUN-043: 'Link para página' apontando pra 'Módulo 3' dentro de 'Curso' a torna sua filha na sidebar", async () => {
    await treeItemByTitle(CURSO_TITLE).click();
    await editorBody().then((el) => el.waitForDisplayed({ timeout: 10000 }));

    await typeSlash("link");
    await chooseSlashItem("Link para página");

    const searchInput = await $('input[aria-label="Buscar página para vincular"]');
    await searchInput.waitForDisplayed({ timeout: 5000 });
    await searchInput.setValue(MODULO_TITLE);

    const option = await $(`//*[@role="option"][contains(., "${MODULO_TITLE}")]`);
    await option.waitForDisplayed({ timeout: 5000 });
    await option.click();

    // Recém-reparenteada, "Módulo 3" só some da raiz e aparece sob "Curso"
    // enquanto "Curso" estiver expandido - mesma mecânica que
    // `page-tree-drag-and-drop` já exercita para reparent por drag-and-drop.
    await expandIfCollapsed(CURSO_TITLE);

    const moduloRow = await treeItemByTitle(MODULO_TITLE);
    await moduloRow.waitForDisplayed({ timeout: 5000 });
    await expect(moduloRow).toHaveAttribute("aria-level", "2");
  });

  it("FUN-043 (Postgres): parent_id de 'Módulo 3' agora é o id de 'Curso' - a @menção nunca faria isto", () => {
    const parentId = psql(`select parent_id from pages where title = ${sqlLiteral(MODULO_TITLE)}`);
    const cursoId = psql(`select id from pages where title = ${sqlLiteral(CURSO_TITLE)}`);
    expect(parentId).toBe(cursoId);
  });

  it("EDT-017: o bloco link-to-page inserido em 'Curso' mostra o título de 'Módulo 3' e navega até ela ao clicar", async () => {
    const link = await $(`//*[@role="button"][contains(@aria-label, "${MODULO_TITLE}")]`);
    await link.waitForDisplayed({ timeout: 5000 });
    await link.click();

    // Navegou: o cabeçalho da página aberta agora mostra o título de "Módulo 3".
    await $(`input[aria-label="Título da página"][value="${MODULO_TITLE}"]`).waitForDisplayed({ timeout: 5000 });
  });
});
