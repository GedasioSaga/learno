// A seção Cartões, de ponta a ponta: criar baralho, criar cartão, estudar.
//
// POR QUE ESTA SPEC EXISTE, e por que ela é a mais importante do projeto:
//
// Este repositório já quebrou SETE costuras de IPC em silêncio — o Rust
// serializando uma forma e o TypeScript declarando outra, sem erro, sem log e
// sem nenhum teste vermelho. A mais cara delas viveu exatamente neste fluxo:
// `CardToStudy.fields` viajava como LISTA e o TypeScript declarava mapa, então
// `fields["Frente"]` devolvia `undefined` e a sessão de estudo mostrava
// "(sem conteúdo)" com o cartão íntegro no banco.
//
// Nenhuma das duas suítes podia pegar isso, por construção:
//   - o vitest mocka `src/lib/ipc.ts` e nunca atravessa o fio;
//   - os testes Rust chamam as funções `_inner` direto, com structs Rust
//     construídos em Rust, então o `serde_json` do meio nunca entra em cena.
//
// O e2e é a única camada deste projeto que atravessa o fio de verdade. As duas
// travas estáticas (`src/lib/contrato-ipc.test.ts` e
// `src/lib/comandos-alcancaveis.test.ts`) cobrem a FORMA do contrato; esta
// spec cobre o COMPORTAMENTO — que o conteúdo digitado chega de volta à tela.
//
// Ela também lê o banco direto, e não só a tela: "apareceu na tela" e "gravou
// no banco" são afirmações diferentes, e confundir as duas é como o autosave
// que nunca gravou bloco passou despercebido.

import { scalar, waitFor } from "../lib/db.mjs";

const BARALHO = "Geografia E2E";
const FRENTE = "Capital do Japão";
const VERSO = "Tóquio";

async function irParaCartoes() {
  await $('[aria-label="Seções"]').waitForDisplayed({ timeout: 30000 });
  // Um seletor CSS não pode ser combinado com `tag*=texto` na mesma string —
  // o WebdriverIO só aceita a forma de texto (`*=`) sozinha. Encadear com
  // `.$()` resolve o rail primeiro e busca o botão dentro dele, do jeito que
  // `page-link.e2e.mjs` já faz para o mesmo problema.
  await $('[aria-label="Seções"]').$('button*=Cartões').click();
  await $('[aria-label="Baralhos"]').waitForDisplayed({ timeout: 20000 });
}

/** Clica numa aba da barra de Cartões pelo texto visível. */
async function abrirAba(nome) {
  await $('[aria-label="Abas de Cartões"]').$(`button*=${nome}`).click();
}

/**
 * Digita `nomeNovo` no campo de renomear de um baralho recém-criado.
 *
 * O baralho nasce em modo de renomear automático (`pendingFocusId` em
 * `DeckTreeRow`), com o valor atual JÁ SELECIONADO inteiro
 * (`inputRef.current.select()` no mount) — o desenho existe para digitar por
 * cima, sem precisar apagar antes.
 *
 * `setValue()`/`clearValue()` do WebdriverIO, por baixo, mandam o driver
 * ESVAZIAR o campo antes de digitar. Instrumentando com `browser.execute`
 * (ler `document.activeElement` e o `value` do input antes/depois de cada
 * comando, sem nada mais no meio) ficou claro que isso NÃO é inofensivo
 * aqui: apagar um valor NÃO VAZIO faz o msedgedriver soltar um blur nativo
 * do elemento, e o `onBlur` de `DeckTreeRow` lê qualquer blur como "o
 * usuário terminou" e fecha o modo de renomear — antes de qualquer tecla
 * nova chegar. O mesmo teste contra o título de uma página nova em Notas
 * (`page-link.e2e.mjs` e companhia) não sofre disso porque esse campo já
 * nasce VAZIO: apagar o vazio é *no-op* para o driver, sem blur — daí essas
 * specs nunca terem batido nisto. Não é erro do app (nenhum usuário de
 * verdade aciona a rotina de "clear" de um driver), então a correção mora
 * só aqui: `addValue` não apaga antes de digitar — as teclas caem em cima da
 * seleção existente e a substituem, exatamente como o componente foi
 * desenhado para funcionar.
 */
async function renomearBaralhoRecemCriado(nomeNovo) {
  const campo = await $('input[aria-label^="Nome do baralho"]');
  await campo.waitForDisplayed({ timeout: 5000 });
  await campo.addValue(nomeNovo);
  await browser.keys("Enter");
}

describe("Cartões — criar baralho, criar cartão e estudar", () => {
  before(async () => {
    await irParaCartoes();
  });

  it("cria um baralho e ele aparece na árvore e no banco", async () => {
    await $('[aria-label="Baralhos"]').$('button*=Novo baralho').click();

    // O input de renomeio (`DeckTreeRow`) não declara `type="text"` — é o
    // padrão do elemento, mas um seletor de atributo CSS só casa com o que
    // está de fato escrito no HTML, então `input[type="text"]` nunca acharia
    // este campo. O `aria-label` que o componente já grava
    // ("Nome do baralho …") é o que sobra de estável.
    await renomearBaralhoRecemCriado(BARALHO);

    // A tela e o banco são duas afirmações diferentes — as duas precisam valer.
    // Seletor de texto com tag CURINGA (`*=texto`, sem tag antes do `*=`) tem
    // um defeito no `findStrategy` desta versão do WebdriverIO (9.31.5): o
    // XPath que ele monta para casar só o nó-folha (`contains(., "...") and
    // not(.//*)`) devolve zero resultado quando a tag é `*`, mas o MESMO
    // texto com uma tag explícita (`button*=...`) ou o XPath equivalente
    // escrito à mão funcionam — confirmado isolando os três num teste à
    // parte. `button` é a tag real da linha na árvore (`DeckTreeRow`).
    await $(`button*=${BARALHO}`).waitForDisplayed({ timeout: 20000 });
    await waitFor(
      () => scalar("SELECT COUNT(*) FROM decks WHERE name = ? AND deleted_at IS NULL", [BARALHO]),
      (n) => n === 1,
      { mensagem: `o baralho "${BARALHO}" precisava existir no banco` },
    );
  });

  it("cria um cartão pelo formulário e a nota chega ao banco com os dois campos", async () => {
    await $(`button*=${BARALHO}`).click();
    await abrirAba("Adicionar");
    await $("h2*=Criar cartão").waitForDisplayed({ timeout: 20000 });

    // Os campos são gerados a partir do tipo de nota ("Básico": Frente, Verso),
    // então são buscados pelo `aria-label` (acrescentado em `CriarCartao.tsx`
    // pelo nome do campo), não por posição — mudar a ordem dos campos no tipo
    // de nota não pode quebrar esta spec por acidente. A união XPath com `|`
    // não é uma forma que o WebdriverIO aceita; um seletor de atributo simples
    // resolve o mesmo sem precisar de XPath nenhum.
    await $('textarea[aria-label="Frente"]').setValue(FRENTE);
    await $('textarea[aria-label="Verso"]').setValue(VERSO);
    await $('button*=Criar').click();

    await $('[role="status"]').waitForDisplayed({ timeout: 20000 });
    await waitFor(
      () =>
        scalar("SELECT COUNT(*) FROM notes WHERE json_extract(field_values, '$.Frente') = ?", [FRENTE]),
      (n) => n === 1,
      { mensagem: "a nota precisava existir no banco com o campo Frente preenchido" },
    );
  });

  it("a sessão de estudo mostra o conteúdo do cartão, não '(sem conteúdo)'", async () => {
    await abrirAba("Baralhos");
    await $('button*=Estudar').click();

    // ESTE é o assert que justifica a spec inteira. Enquanto `fields` viajava
    // como lista, a tela mostrava "(sem conteúdo)" aqui, com a nota íntegra no
    // banco e as duas suítes verdes.
    //
    // `p*=` e não `*=` — mesmo defeito de `findStrategy` do parágrafo acima:
    // tag curinga (`*=`) não acha nó-folha nenhum nesta versão do
    // WebdriverIO, só com uma tag explícita. `<p>` é a tag real da frente e
    // do verso em `EstudoSessao.tsx`.
    const frente = await $(`p*=${FRENTE}`);
    await frente.waitForDisplayed({ timeout: 20000 });

    expect(await $("p*=(sem conteúdo)").isExisting()).toBe(false);

    await $('button*=Mostrar resposta').click();
    await $(`p*=${VERSO}`).waitForDisplayed({ timeout: 20000 });
  });

  it("responder o cartão grava uma linha em review_log e reagenda", async () => {
    const antes = scalar("SELECT COUNT(*) FROM review_log");

    await $('button*=Bom').click();

    // `answer_card` grava `cards` e `review_log` na MESMA transação — se só
    // uma das duas escritas acontecesse, toda estatística mentiria depois.
    await waitFor(() => scalar("SELECT COUNT(*) FROM review_log"), (n) => n === antes + 1, {
      mensagem: "responder precisava gravar exatamente uma linha de histórico",
    });
    await waitFor(
      () =>
        scalar("SELECT COUNT(*) FROM cards WHERE state <> 'new' AND due IS NOT NULL"),
      (n) => n >= 1,
      { mensagem: "o cartão respondido precisava sair de 'new' com uma data de revisão" },
    );
  });

  it("a aba Estatísticas conta a revisão que acabou de acontecer", async () => {
    // O baralho só tinha um cartão, e o teste anterior acabou de respondê-lo
    // — a sessão de estudo (que toma a tela inteira, sem a barra de abas,
    // por desenho de `ConteudoDeCartoes`) foi para o estado "nada para
    // estudar agora", com um botão "Voltar" que leva de volta a "resumo".
    // Sem isto, `abrirAba` não acha `[aria-label="Abas de Cartões"]" porque
    // essa barra não existe enquanto a sessão de estudo está na tela.
    await $('button*=Voltar').click();
    await abrirAba("Estatísticas");

    // `study_stats` é um comando que existiu semanas sem estar registrado no
    // `generate_handler!` — o repositório estava pronto e nenhuma chamada
    // chegava nele. Aqui ele atravessa o fio de verdade. `p*=`, não `*=` —
    // mesmo defeito de `findStrategy` citado acima; o rótulo é um `<p>` em
    // `Estatisticas.tsx` (`CartaoDeNumero`).
    await $('p*=Dias estudados').waitForDisplayed({ timeout: 20000 });
    expect(await $('[role="alert"]').isExisting()).toBe(false);
  });
});
