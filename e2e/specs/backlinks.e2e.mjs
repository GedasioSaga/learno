// FUN-044/FUN-045 (docs/CHECKLIST.md) — rodapé de backlinks e propagação de
// renomeação. NÃO EXECUTADO por esta rodada (instrução da tarefa) — escrito
// contra o comportamento real dos dois arquivos que este builder também
// entrega (`BacklinksSection.tsx`, `use-page-title.ts`) e contra
// `marks/mention-page/mention-page-node-view.ts` (outro construtor, mesma
// rodada), lido para confirmar a marcação real em vez de suposta:
//   - o chip de menção é `.ed-mention-page`, com `aria-label="Ir para a
//     página <título atual>"` e texto `"@<título atual>"` — ambos lidos do
//     estado atual da página, nunca de uma cópia (é o próprio mecanismo de
//     FUN-045 que esta peça descreve no relatório).
//   - o corpo do editor é `[aria-label="Corpo da página"]` e o menu "/" já
//     tem precedente em `page-link.e2e.mjs` (`typeSlash`/`chooseSlashItem`)
//     — reusado aqui só para criar "Termos" como sub-página de "Glossário".
// Suposição não confirmável por este arquivo sozinho: a marcação exata do
// popup de sugestão do "@" (`createSuggestionRender` em
// `mention-page.ts`) — `role="option"` dentro de `role="listbox"
// aria-label="Páginas"`, como o próprio arquivo declara. Se isso mudar, só
// `pickMention` precisa mudar, não o resto do spec.

import { scalar, waitFor } from "../lib/db.mjs";

const STAMP = Date.now();
const AULA4_TITLE = `E2E Aula 4 ${STAMP}`;
const AULA7_TITLE = `E2E Aula 7 ${STAMP}`;
const GLOSSARIO_TITLE = `E2E Glossário ${STAMP}`;
const TERMOS_TITLE = `E2E Termos ${STAMP}`;
const DICIONARIO_TITLE = `E2E Dicionário ${STAMP}`;

function treeItemByTitle(title) {
  return $(`//div[@role="treeitem"][contains(., "${title}")]`);
}

function editorBody() {
  return $('[aria-label="Corpo da página"]');
}

function titleField() {
  return $('input[aria-label="Título da página"]');
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
  await editorBody().then((el) => el.waitForDisplayed({ timeout: 10000 }));
  // A troca de página é assíncrona (Editor.tsx carrega os blocos da nova
  // página) — esperar o título no cabeçalho bater é o sinal de que a troca
  // já assentou, mesmo padrão de `page-link.e2e.mjs`'s última asserção.
  await $(`input[aria-label="Título da página"][value="${title}"]`).waitForDisplayed({ timeout: 5000 });
}

/** EDT-047, mesmo helper de `page-link.e2e.mjs`. */
async function typeSlash(query) {
  const body = await editorBody();
  await body.click();
  await browser.keys(["/", ...query.split("")]);
}

async function chooseSlashItem(title) {
  const item = await $(`//*[contains(@class,"ed-root") or ancestor::*]//*[normalize-space(text())="${title}"]`);
  await item.waitForDisplayed({ timeout: 5000 });
  await item.click();
}

async function createSubPage(title) {
  await typeSlash("page");
  await chooseSlashItem("Sub-página");
  const titleInput = await $('input[aria-label^="Título de"]');
  await titleInput.waitForDisplayed({ timeout: 5000 });
  await titleInput.setValue(title);
  await browser.keys("Enter");
  await treeItemByTitle(title).waitForDisplayed({ timeout: 5000 });
}

/** EDT-044: digita "@" + `query` no corpo do editor e confirma a primeira sugestão com Enter. */
async function mentionPage(query) {
  const body = await editorBody();
  await body.click();
  await browser.keys(["@", ...query.split("")]);
  const option = await $(`//*[@role="listbox"][@aria-label="Páginas"]//*[@role="option"][contains(., "${query}")]`);
  await option.waitForDisplayed({ timeout: 5000 });
  await browser.keys("Enter");
}

function mentionChip(pageTitle) {
  return $(`.ed-mention-page[aria-label="Ir para a página ${pageTitle}"]`);
}

describe("FUN-044/FUN-045 — backlinks no rodapé e propagação de renomeação", () => {
  before(async () => {
    // Sem assistente de primeira execução (apagado — App.tsx chama
    // openWorkspace() direto ao subir, que abre/cria o arquivo do banco e
    // roda as migrações). O primeiro elemento real do app é a `<nav
    // aria-label="Páginas">` de `AppShell.tsx` — ela existe mesmo antes de a
    // árvore carregar (mostra o `EmptyState` até lá), então é o sinal certo
    // de "o app abriu de verdade" em vez de esperar a árvore em si. Timeout
    // generoso porque a primeira execução ainda cria o arquivo e migra.
    await $('[aria-label="Páginas"]').waitForDisplayed({ timeout: 30000 });

    await createRootPage(AULA4_TITLE);
    await createRootPage(AULA7_TITLE);
    await createRootPage(GLOSSARIO_TITLE);
  });

  // Sem `after` de limpeza: `db.mjs` abre o SQLite em modo somente leitura de
  // propósito (ver `lib/db.mjs`), e o banco inteiro é descartado entre
  // sessões de qualquer forma. Os títulos já carregam `STAMP` (Date.now())
  // como prefixo único, então não há colisão com outra spec para limpar.

  it("prepara o cenário do checklist: 'Glossário' com filha 'Termos', mencionado em 'Aula 4' e 'Aula 7'", async () => {
    await openPage(GLOSSARIO_TITLE);
    await createSubPage(TERMOS_TITLE);

    await openPage(AULA4_TITLE);
    await mentionPage(GLOSSARIO_TITLE);
    await mentionChip(GLOSSARIO_TITLE).then((el) => el.waitForDisplayed({ timeout: 5000 }));

    await openPage(AULA7_TITLE);
    await mentionPage(GLOSSARIO_TITLE);
    await mentionChip(GLOSSARIO_TITLE).then((el) => el.waitForDisplayed({ timeout: 5000 }));
  });

  it("FUN-044: abrir 'Glossário' mostra a seção Backlinks com '2 backlinks' navegáveis", async () => {
    await openPage(GLOSSARIO_TITLE);

    const heading = await $("h2=Backlinks");
    await heading.waitForDisplayed({ timeout: 10000 });

    // A contagem é conferida pelo texto da SEÇÃO, não por um seletor
    // `*=2 backlinks`: aquele seletor, ao falhar, só diz "not displayed" e
    // esconde o número que a página realmente mostrou — a diferença entre
    // "1 backlink" (uma das duas menções não persistiu) e "seção vazia".
    // `toHaveText` também espera (faz polling), então cobre o `list_backlinks`
    // assíncrono do rodapé.
    const section = await $('section[aria-label="Backlinks"]');
    await expect(section).toHaveText(expect.stringContaining("2 backlinks"));

    const linkToAula4 = await $(`//section[@aria-label="Backlinks"]//button[contains(., "${AULA4_TITLE}")]`);
    await expect(linkToAula4).toBeDisplayed();
    const linkToAula7 = await $(`//section[@aria-label="Backlinks"]//button[contains(., "${AULA7_TITLE}")]`);
    await expect(linkToAula7).toBeDisplayed();

    await linkToAula4.click();
    // `toHaveValue`, não `waitForValue`: o segundo não existe no WebdriverIO
    // (só `waitForDisplayed`/`Exist`/`Enabled`/`Clickable`/`Stable`), e uma
    // chamada a método inexistente vira `TypeError`, não falha de asserção.
    await expect(titleField()).toHaveValue(AULA4_TITLE);
  });

  it("FUN-045: renomear 'Glossário' para 'Dicionário' propaga na sidebar, na @-menção de 'Aula 4' e na breadcrumb de 'Termos'", async () => {
    await openPage(GLOSSARIO_TITLE);

    const field = await titleField();
    await field.setValue(DICIONARIO_TITLE);
    await browser.keys("Tab"); // sai do campo (blur) — é isso que confirma o rename (ver TitleField em PageWorkspace.tsx)

    // Sidebar: reativa via `usePageTreeStore`, sem recarregar a página.
    await treeItemByTitle(DICIONARIO_TITLE).waitForDisplayed({ timeout: 5000 });

    // @-menção em "Aula 4": o chip lê o título atual pelo id
    // (mention-page-node-view.ts), nunca a cópia congelada no attr.
    await openPage(AULA4_TITLE);
    await mentionChip(DICIONARIO_TITLE).then((el) => el.waitForDisplayed({ timeout: 5000 }));

    // Breadcrumb de "Termos" (filha de "Glossário"): `get_page_breadcrumb`
    // é consultado do zero ao abrir "Termos" — já vem correto, sem cache
    // para invalidar (ver o comentário em `Breadcrumb.tsx` sobre este
    // caminho, e `fun-045-breadcrumb.test.tsx` desta pasta para o teste de
    // componente equivalente).
    await openPage(TERMOS_TITLE);
    const nav = await $('nav[aria-label="Trilha de navegação"]');
    // `toHaveText`, não `toHaveTextContent`: o segundo é matcher do
    // `@testing-library/jest-dom` (usado pelos testes de componente em
    // vitest), não do `expect-webdriverio` — aqui virava `TypeError` em vez
    // de asserção. Ver `node_modules/expect-webdriverio/lib/matchers/element`.
    await expect(nav).toHaveText(new RegExp(`${DICIONARIO_TITLE}[\\s\\S]*${TERMOS_TITLE}`));
  });

  it("FUN-045 (SQLite): o título persistido de 'Glossário' agora é 'Dicionário'", async () => {
    // waitFor, não scalar direto: a asserção anterior já confirmou o rename
    // na UI, mas a gravação em disco é assíncrona em relação ao clique/blur
    // (ver comentário de `waitFor` em `lib/db.mjs`) — ler o banco no instante
    // seguinte pode ainda achar o título antigo.
    const persisted = await waitFor(
      () => scalar("select title from pages where title = ?", [DICIONARIO_TITLE]),
      (valor) => valor === DICIONARIO_TITLE,
      { mensagem: "título de 'Glossário' renomeado para 'Dicionário' no banco" },
    );
    expect(persisted).toBe(DICIONARIO_TITLE);
  });
});
