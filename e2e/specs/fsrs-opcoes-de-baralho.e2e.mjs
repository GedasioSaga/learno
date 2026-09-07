// FSRS-6 ao lado do SM-2, por baralho: escolher, criar cartão nos dois
// agendadores, estudar sob FSRS, e reabrir para confirmar que a escolha foi
// lida de volta — de ponta a ponta.
//
// POR QUE ESTA SPEC EXISTE: este repositório já quebrou SETE costuras de IPC
// em silêncio — o Rust serializando uma forma e o TypeScript declarando
// outra, sem erro, sem log e sem nenhum teste vermelho (a mais cara delas,
// documentada no cabeçalho de `cartoes.e2e.mjs`, viveu na sessão de estudo).
// Nenhuma das duas suítes estáticas pode pegar esse tipo de defeito, por
// construção: o vitest mocka `src/lib/ipc.ts` e nunca atravessa o fio; os
// testes Rust chamam `_inner` direto, com structs Rust construídos em Rust,
// então o `serde_json` do meio nunca entra em cena. O e2e é a única camada
// que atravessa o fio de verdade — e aqui o fio é particularmente longo:
// `set_deck_scheduling_options` grava um JSON (`decks.options`) que
// `db::notes::insert_card` lê para decidir `cards.scheduler`, cuja leitura
// por sua vez decide qual dos dois braços de `answer_card` roda.
//
// O QUE ESTA SPEC PROVA, e cada passo confere na TELA **e** no BANCO —
// "apareceu na tela" e "gravou no banco" são afirmações diferentes, e
// confundir as duas é como o autosave que nunca gravou bloco passou
// despercebido neste projeto:
//
//   1. Um cartão criado ANTES de qualquer troca de agendador nasce 'sm2'.
//   2. Escolher FSRS e salvar grava o agendador em `decks.options` — e a
//      tela avisa que salvou.
//   3. Um cartão criado DEPOIS da troca nasce 'fsrs'; o cartão antigo NÃO
//      migra e continua 'sm2' para sempre (decisão documentada em
//      `src-tauri/src/db/cards.rs`, braço "fsrs" de `answer_card` — é a
//      coisa mais fácil de quebrar sem ninguém notar, porque nenhuma tela
//      mostra "este cartão é SM-2" ou "este é FSRS").
//   4. Responder o cartão FSRS grava `fsrs_stability`, `fsrs_difficulty` e
//      `fsrs_last_review_at` (coluna nova, migração
//      `0039_cards_fsrs_last_review_at.sql`) — os três saindo de NULL para
//      preenchidos na MESMA resposta, e `due` definido.
//   5. Reabrir "Opções do baralho" lê de volta FSRS — fecha o round-trip de
//      `get_deck_scheduling_options`, onde uma divergência `snake_case`/
//      `camelCase` entre os dois lados apareceria.

import { query, scalar, waitFor } from "../lib/db.mjs";

const BARALHO = "FSRS Opções E2E";
const FRENTE_SM2 = "Capital da França";
const VERSO_SM2 = "Paris";
const FRENTE_FSRS = "Capital da Itália";
const VERSO_FSRS = "Roma";

async function irParaCartoes() {
  await $('[aria-label="Seções"]').waitForDisplayed({ timeout: 30000 });
  // Ver o comentário equivalente em `cartoes.e2e.mjs`: um seletor CSS não
  // pode ser combinado com `tag*=texto` na mesma string.
  await $('[aria-label="Seções"]').$('button*=Cartões').click();
  await $('[aria-label="Baralhos"]').waitForDisplayed({ timeout: 20000 });
}

/** Clica numa aba da barra de Cartões pelo texto visível (Baralhos/Adicionar/Painel/Estatísticas). */
async function abrirAba(nome) {
  await $('[aria-label="Abas de Cartões"]').$(`button*=${nome}`).click();
}

/**
 * Digita `nomeNovo` no campo de renomear de um baralho recém-criado.
 *
 * Mesmo contorno documentado em `cartoes.e2e.mjs`: `setValue`/`clearValue`
 * soltam um blur nativo, e `onBlur` de `DeckTreeRow` interpreta qualquer
 * blur como "terminou de editar" — fecharia o modo de renomear antes de
 * qualquer tecla nova chegar. `addValue` digita por cima do texto já
 * selecionado (`inputRef.current.select()` no mount), sem apagar antes.
 */
async function renomearBaralhoRecemCriado(nomeNovo) {
  const campo = await $('input[aria-label^="Nome do baralho"]');
  await campo.waitForDisplayed({ timeout: 5000 });
  await campo.addValue(nomeNovo);
  await browser.keys("Enter");
}

/** Cria um cartão "Básico" no baralho já selecionado, pela aba Adicionar. */
async function criarCartao(frente, verso) {
  await abrirAba("Adicionar");
  await $("h2*=Criar cartão").waitForDisplayed({ timeout: 20000 });
  await $('textarea[aria-label="Frente"]').setValue(frente);
  await $('textarea[aria-label="Verso"]').setValue(verso);
  await $('button*=Criar').click();
  await $('[role="status"]').waitForDisplayed({ timeout: 20000 });
}

/**
 * A linha de `cards` (mais o que importa de `notes`) para o cartão cuja
 * Frente é `frente` — a única forma estável de mirar um cartão específico
 * daqui, já que o `id` nasce no backend e a tela nunca o expõe.
 */
function cartaoPorFrente(frente) {
  return query(
    "SELECT c.scheduler, c.fsrs_stability, c.fsrs_difficulty, c.fsrs_last_review_at, c.due \
     FROM cards c JOIN notes n ON n.id = c.note_id \
     WHERE json_extract(n.field_values, '$.Frente') = ?",
    [frente],
  )[0];
}

/** O agendador gravado em `decks.options` para o baralho de nome `nome` (ou `undefined` se ainda não configurado). */
function agendadorSalvo(nome) {
  return scalar("SELECT json_extract(options, '$.agendador') FROM decks WHERE name = ?", [nome]);
}

describe("FSRS por baralho — escolher, criar cartão nos dois agendadores e estudar", () => {
  before(async () => {
    await irParaCartoes();

    await $('[aria-label="Baralhos"]').$('button*=Novo baralho').click();
    await renomearBaralhoRecemCriado(BARALHO);
    await $(`button*=${BARALHO}`).waitForDisplayed({ timeout: 20000 });
    await waitFor(
      () => scalar("SELECT COUNT(*) FROM decks WHERE name = ? AND deleted_at IS NULL", [BARALHO]),
      (n) => n === 1,
      { mensagem: `o baralho "${BARALHO}" precisava existir no banco` },
    );

    // Seleciona o baralho recém-criado — fica selecionado pelo resto da
    // spec, mesmo trocando de aba (só `irPara` muda a aba; `selectDeck` é
    // quem muda o baralho, e não é chamado de novo depois disto).
    await $(`button*=${BARALHO}`).click();
  });

  it("um cartão criado ANTES de qualquer configuração nasce no SM-2", async () => {
    await criarCartao(FRENTE_SM2, VERSO_SM2);

    await waitFor(
      () => cartaoPorFrente(FRENTE_SM2)?.scheduler,
      (scheduler) => scheduler === "sm2",
      { mensagem: `o cartão "${FRENTE_SM2}" precisava nascer com scheduler = 'sm2'` },
    );
  });

  it("escolher FSRS em Opções do baralho e salvar avisa sucesso na tela e grava no banco", async () => {
    await abrirAba("Baralhos");
    await $('button*=Opções do baralho').click();
    await $("h2*=" + BARALHO).waitForDisplayed({ timeout: 20000 });

    // Antes de mexer: o baralho não tem agendador configurado ainda —
    // `decks.options` nasce `'{}'` (0010_decks_note_types.sql), então
    // `json_extract` devolve NULL (a linha existe; só a chave não), e o
    // backend cai no default 'sm2' só na LEITURA — nada foi gravado até aqui.
    expect(agendadorSalvo(BARALHO)).toBeNull();

    // O rádio é `sr-only` (focável, mas visualmente escondido) — o clique
    // vai no `<label>` que o embrulha, mesmo contorno de `tema.e2e.mjs`.
    await $('input[value="fsrs"]').parentElement().click();
    expect(await $('input[value="fsrs"]').isSelected()).toBe(true);

    await $('button*=Salvar opções').click();
    const statusSalvo = await $('[role="status"]');
    await statusSalvo.waitForDisplayed({ timeout: 20000 });
    expect(await statusSalvo.getText()).toBe("Opções salvas.");

    await waitFor(() => agendadorSalvo(BARALHO), (agendador) => agendador === "fsrs", {
      mensagem: `"decks.options" precisava gravar o agendador FSRS para "${BARALHO}"`,
    });
  });

  it("um cartão criado DEPOIS da troca nasce no FSRS — o cartão antigo não migra", async () => {
    await criarCartao(FRENTE_FSRS, VERSO_FSRS);

    await waitFor(
      () => cartaoPorFrente(FRENTE_FSRS)?.scheduler,
      (scheduler) => scheduler === "fsrs",
      { mensagem: `o cartão "${FRENTE_FSRS}" precisava nascer com scheduler = 'fsrs'` },
    );

    // A decisão de não-migração é a coisa mais fácil de quebrar sem
    // ninguém notar: nenhuma tela mostra o agendador de um cartão já
    // existente, então um regressão aqui só apareceria numa consulta como
    // esta.
    expect(cartaoPorFrente(FRENTE_SM2)?.scheduler).toBe("sm2");

    // E as três colunas FSRS nascem NULL, exatamente como um cartão SM-2 —
    // a assinatura de estado que o próximo teste prova sair de NULL.
    const antes = cartaoPorFrente(FRENTE_FSRS);
    expect(antes.fsrs_stability).toBeNull();
    expect(antes.fsrs_difficulty).toBeNull();
    expect(antes.fsrs_last_review_at).toBeNull();
  });

  it("estudar o cartão FSRS grava estabilidade, dificuldade, última revisão e reagenda", async () => {
    await abrirAba("Baralhos");
    await $('button*=Estudar').click();

    // A fila serve o cartão mais antigo primeiro (`ORDER BY created_at ASC`
    // em `buscar_novo`) — o cartão SM-2 vem antes do FSRS. Respondê-lo aqui
    // não é incidental: é o que garante que a PRÓXIMA carta da mesma
    // sessão, sem nenhuma ação extra, é o cartão FSRS que este teste
    // precisa estudar.
    await $(`p*=${FRENTE_SM2}`).waitForDisplayed({ timeout: 20000 });
    await $('button*=Mostrar resposta').click();
    await $(`p*=${VERSO_SM2}`).waitForDisplayed({ timeout: 20000 });
    await $('button*=Bom').click();

    // Agora o cartão FSRS — a mesma sessão de estudo, sem reabrir nada.
    await $(`p*=${FRENTE_FSRS}`).waitForDisplayed({ timeout: 20000 });
    await $('button*=Mostrar resposta').click();
    await $(`p*=${VERSO_FSRS}`).waitForDisplayed({ timeout: 20000 });
    await $('button*=Bom').click();

    await waitFor(
      () => cartaoPorFrente(FRENTE_FSRS),
      (linha) =>
        linha !== undefined &&
        linha.fsrs_stability !== null &&
        linha.fsrs_difficulty !== null &&
        linha.fsrs_last_review_at !== null &&
        linha.due !== null,
      { mensagem: "responder o cartão FSRS precisava preencher estabilidade, dificuldade, última revisão e due" },
    );

    // O cartão SM-2 respondido no mesmo passo continua sem nenhuma das três
    // colunas FSRS — `answer_card` nunca toca `fsrs_*` no braço "sm2" com um
    // valor novo (só repassa o antigo, que aqui é `NULL`).
    const sm2 = cartaoPorFrente(FRENTE_SM2);
    expect(sm2.fsrs_stability).toBeNull();
    expect(sm2.fsrs_difficulty).toBeNull();
    expect(sm2.fsrs_last_review_at).toBeNull();
  });

  it("reabrir Opções do baralho lê FSRS de volta — fecha o round-trip de get_deck_scheduling_options", async () => {
    // A sessão de estudo, sem mais nada para servir, mostra "Voltar".
    await $('button*=Voltar').waitForDisplayed({ timeout: 20000 });
    await $('button*=Voltar').click();

    await abrirAba("Baralhos");
    await $('button*=Opções do baralho').click();
    await $("h2*=" + BARALHO).waitForDisplayed({ timeout: 20000 });

    const fsrs = await $('input[value="fsrs"]');
    await fsrs.waitForExist({ timeout: 20000 });
    expect(await fsrs.isSelected()).toBe(true);
    expect(await $('input[value="sm2"]').isSelected()).toBe(false);

    expect(await $('[role="alert"]').isExisting()).toBe(false);
  });
});
