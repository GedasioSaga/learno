// DBS-FORMULA — a propriedade Fórmula da database, de ponta a ponta: abrir
// "+ Propriedade" → "Fórmula", validar ao vivo contra o Rust, criar a
// propriedade, ver o valor calculado por linha e recalcular quando a
// origem muda.
//
// POR QUE ESTA SPEC EXISTE: o e2e é a ÚNICA camada deste projeto que
// atravessa o fio de verdade. O vitest mocka `src/lib/ipc.ts` e nunca sai
// do jsdom; os testes Rust chamam as funções `_inner` direto, com structs
// Rust construídos EM Rust, então o `serde_json` do meio nunca entra em
// cena. Este repositório já quebrou SETE costuras de IPC em silêncio nesse
// buraco exato (cabeçalho de `cartoes.e2e.mjs`).
//
// O PONTO CEGO ESPECÍFICO que só esta spec fecha: a propriedade Fórmula
// consome um motor de 40 funções (`src-tauri/src/formula/`) por TRÊS
// comandos — `list_formula_functions`, `validate_formula` e
// `evaluate_formula_column` — e, antes desta spec, nenhum pixel jamais
// tinha chamado nenhum dos três. Um vitest de componente não alcança isto:
// `FormulaConfigForm.test.tsx` passa uma paleta e um resultado de validação
// já prontos por prop; nunca é o Rust quem os produziu. Se `validate_formula`
// devolvesse posições de diagnóstico erradas (bytes UTF-8 vs UTF-16 — o
// comentário de `DiagnosticDto` em `src/lib/ipc.ts` documenta exatamente
// essa conversão), ou se `evaluate_formula_column` devolvesse os valores na
// ordem errada, ou se o nome de uma função na paleta não batesse com o que
// `functions::lookup` aceita, nenhum teste deste repositório perceberia —
// só um `invoke` de verdade.
//
// Ela também lê o banco direto: "apareceu na tela" e "gravou no banco" são
// afirmações diferentes. Para Fórmula a afirmação mais importante é a
// NEGATIVA — `database_record_values` nunca tem linha para uma propriedade
// de fórmula (o valor é sempre calculado, nunca gravado, `FormulaCell.tsx`)
// — e é fácil de mentir sem querer se algum caminho de escrita otimista
// tratasse a coluna calculada como qualquer outra.
//
// Peças lidas antes de escrever esta spec (para não adivinhar seletor):
// `src/features/databases/properties/formula/FormulaConfigForm.tsx` (o
// diálogo: caixa de expressão, paleta, validação ao vivo, prévia),
// `FormulaCell.tsx` (célula somente leitura, sem `renderEditor`),
// `formula-value.ts` (I1 aplicada a Fórmula, formatação de número),
// `src/features/databases/container/NewPropertyDialog.tsx` (o único
// momento em que `config` pode ser escrita — por isso o diálogo tem campo
// de nome), `loader/use-database.ts` (`evaluateFormulaColumns`,
// `refreshFormulaColumns` — o recálculo é uma chamada de IPC por COLUNA,
// depois de toda escrita, nunca uma por linha), e o catálogo de funções em
// `src-tauri/src/formula/functions/matematica/mod.rs` (`round`) e o
// diagnóstico de `src-tauri/src/formula/core/typecheck.rs::check_call`
// ("função desconhecida: …") — a mensagem exata que a validação inválida
// desta spec confere, para provar que ela vem do Rust e não de um texto
// hardcoded no formulário.
//
// DESVIO DO ENUNCIADO, documentado: a propriedade de Número nasce com o
// nome do TIPO como padrão ("Número", `numberPropertySpec.label`), não
// "Preço" — `AddPropertyMenu.tsx` diz explicitamente que renomear uma
// propriedade "ainda não tem tela" (dívida declarada em
// `comandos-alcancaveis.test.ts`). Esta spec usa "Número" pelo nome real,
// em vez de fingir uma tela de renomeio que não existe.
//
// Duas armadilhas de `docs/e2e.md` que valem nomear aqui (as outras — pasta
// de trabalho por spec, `+ Propriedade` só no hover, `afterSession`
// encerrando o app — são as mesmas de `database-tabela.e2e.mjs`, cujos
// helpers esta spec reaproveita):
//   - o editor de NÚMERO commita no Enter, mas Escape SÓ fecha, sem
//     commitar (`NumberCellEditor` em `number-cell.tsx`) — diferente da
//     célula de Texto de `database-tabela.e2e.mjs`, onde Escape confirma.
//     Usar Escape aqui gravaria nada e a spec mentiria sozinha.
//   - `setValue()` no input de Número grava a propriedade `.value` do DOM
//     sem disparar o `input` nativo que o React escuta — o componente
//     controlado (`draft`) nunca vê a tecla, e o Enter commita `draft`
//     ainda vazio. Confirmado por instrumentação (removida depois de achar
//     a causa): `input.getValue()` mostrava o número certo, mas a célula
//     sempre ficava em branco. `addValue` (teclas de verdade) resolve —
//     mesma classe de armadilha de `renomearBaralhoRecemCriado` em
//     `cartoes.e2e.mjs`.
//   - o recálculo da coluna de fórmula, depois de editar o Número, é
//     assíncrono (uma chamada de IPC a mais depois da escrita da célula) —
//     por isso o último teste espera a coluna estabilizar com `waitFor`
//     (polling), nunca com uma pausa fixa.
//
// DEFEITO DO APP ENCONTRADO (não corrigido aqui, de propósito — ver o `it`
// "1b" abaixo para a causa raiz completa): uma propriedade Número criada
// pelo fluxo normal nasce com `config: "{}"` em vez de
// `{"format":"plain"}`, e `formatNumberValue` não tem `default:` no
// `switch` — a célula fica em branco pra sempre, mesmo com o valor certo
// gravado no banco. Não afeta a Fórmula (que lê o valor bruto pelo Rust),
// e por isso os passos 2-7 seguem intactos; o `it` "1b" isola o defeito
// como uma falha PRÓPRIA, para não ser confundido com um problema desta
// spec ou da Fórmula.

import { scalar, waitFor } from "../lib/db.mjs";

const STAMP = Date.now();
const PAGINA_TITLE = `E2E Formula ${STAMP}`;
const NOME_NUMERO = "Número";
const NOME_FORMULA = `Dobro ${STAMP}`;
const EXPRESSAO = `round(prop("${NOME_NUMERO}") * 2, 2)`;

const PRECO_1 = 3.333;
const PRECO_2 = 10;
const PRECO_1_NOVO = 7;

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

/** Abre `title` e espera o corpo do editor e o cabeçalho concordarem — mesmo padrão de `database-tabela.e2e.mjs`. */
async function abrirPagina(title) {
  await treeItemByTitle(title).click();
  await editorBody().then((el) => el.waitForDisplayed({ timeout: 10000 }));
  await $(`input[aria-label="Título da página"][value="${title}"]`).waitForDisplayed({ timeout: 5000 });
}

/** Digita "/" mais `query` no corpo do editor, abrindo o menu de blocos — mesmo helper de `database-tabela.e2e.mjs`. */
async function typeSlash(query) {
  const body = await editorBody();
  await body.click();
  await browser.keys(["/", ...query.split("")]);
}

/** Clica o item do menu "/" cujo texto acessível é `title` — mesmo helper de `database-tabela.e2e.mjs`. */
async function chooseSlashItem(title) {
  const item = await $(`//*[contains(@class,"ed-root") or ancestor::*]//*[normalize-space(text())="${title}"]`);
  await item.waitForDisplayed({ timeout: 5000 });
  await item.click();
}

/** A grade da view Tabela — `role="grid"`, nome acessível o `view.name` ("Tabela"). */
function grid() {
  return $('[role="grid"][aria-label="Tabela"]');
}

/**
 * Abre o menu "+ Propriedade" do cabeçalho da database — DBS-001: os botões
 * de ação só MONTAM no hover em modo inline, daí `moveTo()` (um
 * `pointermove` real). Mesmo helper de `database-tabela.e2e.mjs`.
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

/**
 * O diálogo "Nova propriedade: Fórmula" — `role="dialog"`, título em `<h2>`
 * (`NewPropertyDialog.tsx`).
 *
 * `contains(., "texto")`, nunca `contains(text(), "texto")`: o `<h2>` do
 * componente é `Nova propriedade: {spec.label}` — DOIS nós de texto no DOM
 * ("Nova propriedade: " e "Fórmula", por causa da interpolação JSX), não
 * um só. `text()` devolve um conjunto de nós, e `contains()` some com
 * TODOS menos o primeiro ao converter para string — comparava só "Nova
 * propriedade: " contra a frase inteira e nunca batia, mesmo com o diálogo
 * de pé (confirmado: o dump de tela da falha mostrava o diálogo aberto). O
 * mesmo motivo por que `treeItemByTitle`, nesta e em `database-tabela.e2e.mjs`,
 * usa `contains(., title)` — o `.` pega o VALOR-STRING do elemento inteiro,
 * concatenando todos os nós de texto descendentes.
 */
function dialogFormula() {
  return $('//div[@role="dialog"][.//h2[contains(., "Nova propriedade: Fórmula")]]');
}

/** A `databases.id` cuja `container_page_id` é a página desta spec — mesmo padrão de `database-tabela.e2e.mjs`. */
function databaseIdDoBanco() {
  return scalar(
    "SELECT d.id FROM databases d JOIN pages p ON p.id = d.container_page_id WHERE p.title = ?",
    [PAGINA_TITLE],
  );
}

/** A i-ésima linha da grade, na mesma ordem de `position` que `TableView` desenha. */
async function linha(indice) {
  const linhas = await $$('.db-table__row');
  return linhas[indice];
}

/**
 * A célula de VALOR da coluna `indiceColuna` na linha `indiceLinha`.
 *
 * `TitleCell` e `ValueCell` são as duas únicas coisas que desenham um
 * `<td role="gridcell">` — a ordem no DOM é sempre título (0), depois as
 * propriedades na ordem em que foram criadas: Número (1), Fórmula (2). A
 * célula é reconsultada a cada chamada (não guardada numa variável) porque
 * a grade se re-renderiza a cada edição.
 */
async function celula(indiceLinha, indiceColuna) {
  const linhaEl = await linha(indiceLinha);
  const celulas = await linhaEl.$$('td[role="gridcell"]');
  return celulas[indiceColuna];
}

function celulaNumero(indiceLinha) {
  return celula(indiceLinha, 1);
}

function celulaFormula(indiceLinha) {
  return celula(indiceLinha, 2);
}

/**
 * Escreve `valor` na célula de Número da linha `indiceLinha`, pelo
 * formulário — nunca pelo banco direto (`db.mjs` abre só leitura).
 *
 * Armadilha (`docs/e2e.md` + `number-cell.tsx`): o editor de Número commita
 * no ENTER; Escape só fecha, SEM commitar — o oposto da célula de Texto de
 * `database-tabela.e2e.mjs`, onde Escape confirma. Usar Escape aqui gravaria
 * nada e a spec mentiria sozinha sobre o que testou.
 */
async function digitarNumero(indiceLinha, valor) {
  const alvo = await celulaNumero(indiceLinha);
  await alvo.click();
  const input = await $(`input[aria-label="Editar ${NOME_NUMERO}"]`);
  await input.waitForDisplayed({ timeout: 5000 });
  // `setValue()`/`clearValue()` neste input NÃO servem: confirmado por
  // instrumentação — eles gravam a propriedade `.value` do DOM sem disparar
  // o `input` nativo que o React escuta para atualizar `draft`
  // (`NumberCellEditor`, estado controlado). O DOM mostrava "3.333"/"10"
  // certinho (`input.getValue()`), mas o Enter commitava `draft` ainda vazio
  // (ou, na reedição, o `draft` ANTIGO intocado) — mesma classe de
  // armadilha documentada em `renomearBaralhoRecemCriado` de
  // `cartoes.e2e.mjs`. `addValue` sozinho (teclas de verdade) resolve a
  // escrita na célula VAZIA (passo 1), mas na REEDIÇÃO (passo 7, célula já
  // com "3.333") ele APARECE por cima do texto existente em vez de
  // substituir — o cursor de um `<input>` recém-focado fica no fim do
  // valor, não com tudo selecionado (diferente do `DeckTreeRow`, que chama
  // `.select()` no mount) — dando "3.3337" em vez de "7". Ctrl+A seleciona
  // tudo primeiro (equivalente ao que um usuário faria antes de substituir),
  // e é inofensivo quando o campo já está vazio.
  await browser.keys(["Control", "a"]);
  await input.addValue(String(valor));
  await browser.keys("Enter");
}

describe("DBS-FORMULA — propriedade Fórmula: paleta do Rust, validação ao vivo, cálculo por linha e recálculo", () => {
  // IDs descobertos no banco à medida que cada passo os cria — a tela nunca
  // os expõe, e são a única forma estável de mirar exatamente esta
  // database/propriedade/registro nas consultas seguintes.
  let databaseId;
  let numeroPropertyId;
  let formulaPropertyId;
  let recordId1;
  let recordId2;

  before(async () => {
    await $('[aria-label="Páginas"]').waitForDisplayed({ timeout: 30000 });
    await createRootPage(PAGINA_TITLE);
    await abrirPagina(PAGINA_TITLE);

    await typeSlash("database");
    await chooseSlashItem("Database");
    await grid().waitForDisplayed({ timeout: 20000 });

    databaseId = await waitFor(databaseIdDoBanco, (id) => id !== undefined, {
      mensagem: "a database precisava existir no banco antes de qualquer passo desta spec",
    });
  });

  // Sem `after` de limpeza: a pasta de trabalho desta sessão é descartada
  // inteira quando a suíte termina (docs/e2e.md), e o título da página já
  // carrega `STAMP` como prefixo único.

  it("1. cria a propriedade Número e dois registros com valores diferentes — no banco", async () => {
    const menu = await abrirMenuDePropriedade();
    await menu.$('button*=Número').click();
    await $(`th*=${NOME_NUMERO}`).waitForDisplayed({ timeout: 20000 });

    numeroPropertyId = await waitFor(
      () =>
        scalar(
          "SELECT id FROM database_properties WHERE database_id = ? AND name = ? AND property_type = 'number'",
          [databaseId, NOME_NUMERO],
        ),
      (id) => id !== undefined,
      { mensagem: "a propriedade 'Número' precisava existir no banco com property_type = 'number'" },
    );

    await $('button*=Nova linha').click();
    await browser.keys("Escape"); // título vazio é aceitável — a spec não precisa dele.
    await digitarNumero(0, PRECO_1);

    await $('button*=Nova linha').click();
    await browser.keys("Escape");
    await digitarNumero(1, PRECO_2);

    // Os IDs e as conferências de BANCO vêm ANTES da conferência de TELA
    // (abaixo, fora deste `it`) de propósito: são independentes uma da
    // outra, e os passos 4-7 precisam de `recordId1`/`recordId2` mesmo que
    // a tela do Número tenha um defeito à parte (tem — ver o próximo `it`).
    // Se a captura ficasse depois de uma asserção de tela frágil, uma
    // falha ali derrubaria os passos seguintes por uma causa que não é a
    // deles (foi exatamente o que aconteceu na primeira versão desta spec:
    // o passo 7 quebrava com `ERR_INVALID_ARG_TYPE` porque `recordId1`
    // nunca tinha sido atribuído).
    recordId1 = await waitFor(
      () => scalar("SELECT id FROM pages WHERE database_id = ? ORDER BY position ASC LIMIT 1", [databaseId]),
      (id) => id !== undefined,
      { mensagem: "o primeiro registro precisava existir no banco" },
    );
    recordId2 = await waitFor(
      () => scalar("SELECT id FROM pages WHERE database_id = ? ORDER BY position ASC LIMIT 1 OFFSET 1", [databaseId]),
      (id) => id !== undefined,
      { mensagem: "o segundo registro precisava existir no banco" },
    );

    // Banco: os dois valores gravados, cada um no seu registro — a prova
    // de que a ESCRITA funcionou, independente do que a tela mostra dela.
    await waitFor(
      () =>
        scalar(
          "SELECT json_extract(value, '$') FROM database_record_values WHERE record_id = ? AND property_id = ?",
          [recordId1, numeroPropertyId],
        ),
      (valor) => valor === PRECO_1,
      { mensagem: "o primeiro registro precisava gravar o Número digitado" },
    );
    await waitFor(
      () =>
        scalar(
          "SELECT json_extract(value, '$') FROM database_record_values WHERE record_id = ? AND property_id = ?",
          [recordId2, numeroPropertyId],
        ),
      (valor) => valor === PRECO_2,
      { mensagem: "o segundo registro precisava gravar o Número digitado" },
    );
  });

  it("1b. DEFEITO DO APP (não da fórmula): a célula de Número recém-criada nunca mostra o valor, embora ele esteja gravado certo", async () => {
    // Instrumentado com `browser.execute`/`getHTML` numa sessão de debug
    // (removida): o clique abre o editor certo, `addValue` grava a tecla a
    // tecla certas (confirmado por `input.getValue()`), o Enter fecha o
    // editor e o valor VAI para `database_record_values` correto (passo 1
    // acima prova isso lendo o banco). O que falha é só o RENDER da célula
    // em repouso.
    //
    // Causa raiz, também confirmada por instrumentação (`SELECT config FROM
    // database_properties WHERE id = ?` devolveu `{}`, não
    // `{"format":"plain"}`):
    //   1. `numberPropertySpec.defaultConfig = { format: "plain" }`
    //      (`number-spec.ts`) só é usado por quem MONTA o formulário de uma
    //      propriedade com `renderConfigForm` — Número não tem um
    //      (`AddPropertyMenu.tsx`).
    //   2. Para um tipo sem diálogo, `DatabaseContainer.tsx` (`onAddProperty`
    //      dentro do `headerActions`) chama `onAddProperty(type, name)` SEM
    //      config nenhuma quando `config === undefined` — nunca passa
    //      `spec.defaultConfig`.
    //   3. `useDatabase.addProperty` então chama a forma de 3 argumentos de
    //      `createProperty` (sem config), e o Rust
    //      (`src-tauri/src/db/databases.rs::create_property`, comentário na
    //      linha 288) documenta que "`config` ausente vira `{}`" — por
    //      desenho, não é bug do Rust.
    //   4. De volta no front, `property.config.format` fica `undefined`
    //      para essa propriedade, e `formatNumberValue`
    //      (`number-spec.ts`) tem um `switch (format)` com só os três casos
    //      conhecidos e NENHUM `default:` — para um `format` desconhecido a
    //      função sai do fim sem `return`, ou seja, devolve `undefined`.
    //      React renderiza `undefined` como nada, e a célula fica em
    //      branco pra sempre (não é um atraso: nem depois de recarregar a
    //      página o valor aparece, porque o `config` gravado no banco
    //      continua `{}`).
    //
    // Efeito prático fora desta spec: qualquer propriedade Número criada
    // pelo fluxo normal ("+ Propriedade" → "Número") nasce muda — o dado é
    // gravado certo, mas nenhuma célula daquela coluna jamais mostra nada,
    // em nenhuma linha, para sempre. Não é um defeito da Fórmula (que lê o
    // valor bruto pelo Rust, não por `formatNumberValue` — por isso os
    // passos 4-7 abaixo calculam certo mesmo com a coluna de origem muda) —
    // é um defeito do tipo Número em si, e esta spec só o encontrou porque
    // foi a primeira a olhar a TELA de uma propriedade Número recém-criada
    // logo depois de escrever nela.
    await waitFor(() => celulaNumero(0).then((el) => el.getText()), (texto) => texto === "3,333", {
      mensagem: `a primeira linha precisava mostrar "3,333" (o Número gravado, formatado); mostrou uma célula sempre vazia — config da propriedade ficou "{}" em vez de {"format":"plain"}`,
    });
    await waitFor(() => celulaNumero(1).then((el) => el.getText()), (texto) => texto === "10", {
      mensagem: `a segunda linha precisava mostrar "10"; mesma causa raiz do primeiro registro`,
    });
  });

  it("2. '+ Propriedade' → 'Fórmula' abre o diálogo, e a paleta lista funções vindas de list_formula_functions", async () => {
    const menu = await abrirMenuDePropriedade();
    await menu.$('button*=Fórmula').click();

    await dialogFormula().waitForDisplayed({ timeout: 5000 });

    // `round` só aparece aqui se `listFormulaFunctions()` de fato atravessou
    // o `invoke` e voltou com a entrada que o Rust registrou em
    // `matematica/mod.rs` — não é uma lista escrita neste repositório em
    // TypeScript (`FormulaConfigForm.tsx` não conhece nome de função nenhum).
    await $('//span[@class="formula-palette__name" and text()="round"]').waitForDisplayed({ timeout: 20000 });
  });

  it("3. validação ao vivo: expressão inválida mostra o erro que o Rust devolveu e desabilita 'Criar propriedade'; expressão válida libera", async () => {
    const nomeInput = await $('//div[@role="dialog"]//input[@type="text"]');
    await nomeInput.setValue(NOME_FORMULA);

    const textarea = await $('.formula-editor__textarea');
    const status = await $('.formula-editor__status');
    const botaoCriar = () => $('button*=Criar propriedade');

    await textarea.setValue("naoexiste(1)");
    // "função desconhecida: …" é a mensagem exata de
    // `typecheck.rs::check_call` — se aparecesse aqui sem o `invoke`, seria
    // porque alguém hardcodou o texto no formulário, o ponto cego que esta
    // spec existe para fechar.
    await browser.waitUntil(
      async () => (await status.getText()).includes('função desconhecida: "naoexiste"'),
      {
        timeout: 5000,
        timeoutMsg: "a validação precisava mostrar o diagnóstico que o Rust devolveu para uma função inexistente",
      },
    );
    expect(await botaoCriar().isEnabled()).toBe(false);

    await textarea.setValue(EXPRESSAO);
    await browser.waitUntil(async () => (await status.getText()).includes("Válida"), {
      timeout: 5000,
      timeoutMsg: "a expressão válida precisava liberar a validação",
    });
    expect(await botaoCriar().isEnabled()).toBe(true);
  });

  it("4. cria a propriedade com uma expressão real sobre a coluna de Número — na tela e no banco", async () => {
    await $('button*=Criar propriedade').click();

    // Sucesso: o próprio diálogo se desmonta (comentário de `create()` em
    // `NewPropertyDialog.tsx` — só erro deixa o diálogo aberto).
    await dialogFormula().waitForExist({ reverse: true, timeout: 10000 });
    await $(`th*=${NOME_FORMULA}`).waitForDisplayed({ timeout: 20000 });

    formulaPropertyId = await waitFor(
      () =>
        scalar(
          "SELECT id FROM database_properties WHERE database_id = ? AND name = ? AND property_type = 'formula'",
          [databaseId, NOME_FORMULA],
        ),
      (id) => id !== undefined,
      { mensagem: "a propriedade de fórmula precisava existir no banco com property_type = 'formula'" },
    );
    expect(
      scalar("SELECT json_extract(config, '$.expression') FROM database_properties WHERE id = ?", [formulaPropertyId]),
    ).toBe(EXPRESSAO);
  });

  it("5. o valor calculado aparece por linha e bate com a conta — diferente entre os dois registros (evaluate_formula_column)", async () => {
    // round(3,333 * 2, 2) = round(6,666, 2) = 6,67 — arredondamento de
    // verdade, não um passe adiante disfarçado de fórmula.
    await waitFor(() => celulaFormula(0).then((el) => el.getText()), (texto) => texto === "6,67", {
      mensagem: `a primeira linha precisava mostrar ${EXPRESSAO} = 6,67 para Número = ${PRECO_1}`,
    });
    // round(10 * 2, 2) = 20 — diferente da primeira linha, prova que o
    // cálculo é por REGISTRO, não um valor único repetido na coluna.
    await waitFor(() => celulaFormula(1).then((el) => el.getText()), (texto) => texto === "20", {
      mensagem: `a segunda linha precisava mostrar ${EXPRESSAO} = 20 para Número = ${PRECO_2}`,
    });
  });

  it("6. a célula de fórmula é somente leitura: clicar não abre editor, e database_record_values nunca grava linha para ela", async () => {
    const alvo = await celulaFormula(0);
    expect(await alvo.getAttribute("class")).toContain("db-table__cell--readonly");

    await alvo.click();

    // Sem editor: `ValueCell.open()` só monta um `EditorFlyout` quando
    // `spec.renderEditor` existe, e `formulaPropertySpec` não declara um, de
    // propósito (`formula-spec.tsx`) — diferente do que aconteceria clicando
    // a célula de Número, que abriria `input[aria-label="Editar Número"]`.
    expect(await $(`[aria-label="Editar ${NOME_FORMULA}"]`).isExisting()).toBe(false);

    // O valor calculado NUNCA é gravado — nem para este registro, nem para
    // nenhum outro. A ausência da linha é o contrato, não um "" nem um
    // null gravado por cima (I1, mesma invariante de `database-tabela.e2e.mjs`).
    expect(
      scalar("SELECT COUNT(*) FROM database_record_values WHERE property_id = ?", [formulaPropertyId]),
    ).toBe(0);
  });

  it("7. editar o Número recalcula a coluna de fórmula — o recálculo é assíncrono, uma chamada de IPC por coluna depois da escrita", async () => {
    await digitarNumero(0, PRECO_1_NOVO);

    await waitFor(
      () =>
        scalar(
          "SELECT json_extract(value, '$') FROM database_record_values WHERE record_id = ? AND property_id = ?",
          [recordId1, numeroPropertyId],
        ),
      (valor) => valor === PRECO_1_NOVO,
      { mensagem: "o Número editado precisava gravar o valor novo" },
    );

    // A tela: `refreshFormulaColumns` dispara DEPOIS de `applyValueChanges`
    // resolver (`loader/use-database.ts`) — não é instantâneo, por isso
    // `waitFor` (polling), nunca uma pausa fixa.
    await waitFor(() => celulaFormula(0).then((el) => el.getText()), (texto) => texto === "14", {
      mensagem: `a fórmula da primeira linha precisava recalcular para round(${PRECO_1_NOVO} * 2, 2) = 14`,
    });
    // A segunda linha não mudou — prova que o recálculo aconteceu por
    // COLUNA (todas as fórmulas da database), sem vazar para a fórmula de
    // um registro que ninguém editou.
    expect(await celulaFormula(1).then((el) => el.getText())).toBe("20");
  });
});
