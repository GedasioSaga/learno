import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A trava contra o defeito mais repetido deste projeto: código pronto,
 * testado, revisado — e que nenhum caminho do usuário alcança.
 *
 * Já aconteceu OITO vezes, sempre com a suíte verde:
 *
 * - o autosave que nunca gravou bloco;
 * - a @-menção que nunca gerou backlink;
 * - o registro de extensões que ninguém chamava;
 * - `saveDataDir` sem chamador;
 * - o motor de fórmula inteiro fora do `lib.rs` — existia, tinha testes
 *   próprios, e nenhum byte dele era compilado;
 * - a seção Cartões inteira mostrando "Em construção" porque `montarSecoes`
 *   não a listava;
 * - `deckForecast`, exposto no `ipc.ts` e nunca chamado por tela nenhuma;
 * - `study_stats`, com o `ReviewLogRepository` completo e nenhum
 *   `#[tauri::command]` que chegasse nele.
 *
 * `src/features/navegacao/toda-tela-e-alcancavel.test.ts` fecha a ponta da
 * interface: uma tela que existe precisa estar montada. Este arquivo fecha a
 * ponta do IPC, nas duas direções — porque as duas quebram de formas opostas
 * e igualmente invisíveis:
 *
 * - **comando não registrado**: o Rust compila, os testes do repositório
 *   passam, e a chamada do frontend falha em tempo de execução com um erro
 *   que só aparece no console da WebView;
 * - **comando registrado e nunca chamado**: nada falha nunca — a capacidade
 *   simplesmente não existe para o usuário, e a única pista é ninguém nunca
 *   ter visto aquela tela funcionar.
 *
 * Lê texto em vez de importar módulo pelo mesmo motivo de
 * `contrato-ipc.test.ts`: o que se quer provar é o que está ESCRITO na
 * fiação, e o `generate_handler!` é uma macro que só existe depois do
 * `cargo build`.
 */

const RAIZ = path.resolve(__dirname, "../..");
const LIB_RS = path.join(RAIZ, "src-tauri/src/lib.rs");
const PASTA_IPC = path.join(RAIZ, "src-tauri/src/ipc");

/** Os nomes dentro de `tauri::generate_handler![ ... ]`, só o último segmento. */
function comandosRegistrados(): Set<string> {
  const fonte = fs.readFileSync(LIB_RS, "utf-8");
  const inicio = fonte.indexOf("generate_handler![");
  expect(inicio, "não achei o generate_handler! em src-tauri/src/lib.rs").toBeGreaterThan(-1);

  const fim = fonte.indexOf("]", inicio);
  const bloco = fonte.slice(inicio, fim);

  const nomes = new Set<string>();
  for (const achado of bloco.matchAll(/ipc::\w+::(\w+)/g)) nomes.add(achado[1]);
  return nomes;
}

/** Toda função marcada com `#[tauri::command]` sob `src-tauri/src/ipc/`. */
function comandosDeclarados(): Map<string, string> {
  const declarados = new Map<string, string>();

  for (const entrada of fs.readdirSync(PASTA_IPC, { withFileTypes: true })) {
    if (!entrada.isFile() || !entrada.name.endsWith(".rs")) continue;

    const linhas = fs.readFileSync(path.join(PASTA_IPC, entrada.name), "utf-8").split(/\r?\n/);
    for (let i = 0; i < linhas.length; i += 1) {
      if (linhas[i].trim() !== "#[tauri::command]") continue;

      // A assinatura costuma vir na linha seguinte, mas pode haver outro
      // atributo no meio — procura em uma janelinha curta em vez de assumir.
      for (let j = i + 1; j < Math.min(i + 5, linhas.length); j += 1) {
        const assinatura = /^\s*pub (?:async )?fn (\w+)/.exec(linhas[j]);
        if (assinatura) {
          declarados.set(assinatura[1], entrada.name);
          break;
        }
      }
    }
  }

  return declarados;
}

const TRANSPORTE = path.join(RAIZ, "src/lib/ipc.ts");

/** Percorre os `.ts`/`.tsx` de produção sob `src/`, com os arquivos a pular. */
function paraCadaFonte(visitar: (caminho: string, fonte: string) => void, pular: Set<string> = new Set()) {
  (function varrer(diretorio: string) {
    for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
      const caminho = path.join(diretorio, entrada.name);
      if (entrada.isDirectory()) {
        varrer(caminho);
        continue;
      }
      if (!/\.tsx?$/.test(entrada.name) || /\.test\.tsx?$/.test(entrada.name)) continue;
      if (pular.has(caminho)) continue;
      visitar(caminho, fs.readFileSync(caminho, "utf-8"));
    }
  })(path.join(RAIZ, "src"));
}

/**
 * Todo comando que o frontend invoca — o nome literal que vai no fio.
 *
 * Varre `src/` inteiro, não só `ipc.ts`: o editor de blocos tem camada própria
 * de `invoke` (`src/features/editor/core/blocks-api.ts`), porque ela troca a
 * implementação real por uma de memória nos testes. Olhar só o `ipc.ts`
 * apontaria os quatorze comandos de bloco como órfãos — falso positivo que
 * treinaria qualquer um a ignorar este teste.
 */
function comandosChamadosPeloFrontend(): Set<string> {
  const nomes = new Set<string>();
  paraCadaFonte((_caminho, fonte) => {
    // `[^(]*` impede o genérico de atravessar o parêntese e casar com o
    // literal de outra chamada mais adiante no arquivo.
    for (const achado of fonte.matchAll(/\b(?:call|invoke)\s*(?:<[^(]*>)?\(\s*"([a-z0-9_]+)"/g)) {
      nomes.add(achado[1]);
    }
  });
  return nomes;
}

/**
 * Os comandos que alguma TELA de fato alcança.
 *
 * A pergunta é diferente da anterior, e a diferença é o ponto: quase todo
 * comando é invocado dentro de `src/lib/ipc.ts`, que é o TRANSPORTE. O que as
 * telas chamam é o WRAPPER — `deckForecast(...)`, não `call("deck_forecast")`.
 * Um wrapper exportado, tipado, e que nenhum componente importa é exatamente o
 * defeito do `deckForecast`: a previsão de revisões existia no `ipc.ts` desde
 * a Fase 4 e nenhuma tela do app a chamava.
 *
 * Então: mapeia `nome do wrapper -> comando` lendo o `ipc.ts`, e considera o
 * comando alcançado quando o NOME do wrapper aparece em algum arquivo fora do
 * transporte — ou quando alguém invoca o comando cru por conta própria, como
 * o editor faz.
 */
function comandosAlcancadosPorTela(): Set<string> {
  const transporte = fs.readFileSync(TRANSPORTE, "utf-8");

  const comandoDoWrapper = new Map<string, string>();
  for (const achado of transporte.matchAll(
    /export function (\w+)[\s\S]{0,400}?\b(?:call|invoke)\s*(?:<[^(]*>)?\(\s*"([a-z0-9_]+)"/g,
  )) {
    comandoDoWrapper.set(achado[1], achado[2]);
  }

  const alcancados = new Set<string>();
  paraCadaFonte(
    (_caminho, fonte) => {
      for (const [wrapper, comando] of comandoDoWrapper) {
        // `(?<![\w.$])` e não `\b`: `\b` casa depois de um ponto (ponto não é
        // caractere de palavra), então `Reflect.deleteProperty` num fixture de
        // teste contava como "alguma tela chama o wrapper `deleteProperty`" —
        // e o comando `delete_property`, que de fato não tem tela, saía da
        // lista de dívida sozinho. Acesso a membro de OUTRO objeto nunca é uma
        // chamada ao wrapper importado deste módulo de transporte.
        if (new RegExp(`(?<![\\w.$])${wrapper}\\b`).test(fonte)) alcancados.add(comando);
      }
      for (const achado of fonte.matchAll(/\b(?:call|invoke)\s*(?:<[^(]*>)?\(\s*"([a-z0-9_]+)"/g)) {
        alcancados.add(achado[1]);
      }
    },
    new Set([TRANSPORTE]),
  );

  return alcancados;
}

/**
 * Comandos registrados que NENHUMA tela chama ainda, com o motivo.
 *
 * Esta lista é dívida declarada, não exceção conveniente. A terceira direção
 * deste arquivo — "todo comando registrado é de fato chamado" — é a que pega o
 * caso mais silencioso de todos: um comando registrado e nunca chamado não
 * falha nunca, em lugar nenhum. A capacidade simplesmente não existe para o
 * usuário, e a única pista é ninguém nunca ter visto aquela tela funcionar.
 *
 * Entrar aqui precisa ser uma decisão consciente com data para sair. Sair
 * daqui é o objetivo.
 */
const REGISTRADOS_SEM_TELA: Record<string, string> = {
  // (validate_formula, preview_formula, list_formula_functions e
  // evaluate_formula_column saíram daqui: a propriedade Fórmula ganhou
  // editor — `properties/formula/FormulaConfigForm.tsx` — e a coluna é
  // calculada pelo carregador, `loader/use-database.ts`.)

  // --- Biblioteca: o leitor ligou abrir_livro, registrar_progresso, listar_anotacoes e criar_anotacao ---
  excluir_livro_definitivamente: "a exclusao definitiva existe no backend; a estante hoje so manda para a lixeira, e o caminho permanente ainda nao tem botao",

  // --- Resumo por capitulo: a feature foi SUBSTITUIDA a pedido do usuario ---
  //
  // O painel do leitor listava todos os capitulos do sumario do livro, cada um
  // com "escrever resumo". O usuario pediu o contrario: paginas que ELE cria e
  // nomeia (`library_book_pages`, migracao 0038). O painel novo nao le
  // `library_chapter_notes`, entao estes tres comandos ficaram sem tela.
  //
  // NAO foram apagados de proposito, e o motivo e desconfortavel e precisa
  // ficar escrito: a tabela antiga continua no banco com os resumos que
  // alguem ja tenha escrito, e NENHUMA tela os mostra hoje. Apagar os
  // comandos tiraria tambem o unico caminho de leitura desse texto. Quem for
  // resolver isso tem duas saidas honestas — importar os resumos antigos para
  // paginas na primeira abertura, ou apagar tabela e comandos juntos depois
  // de confirmar que nao ha nada escrito. Deixar como esta indefinidamente
  // nao e uma delas.
  salvar_resumo_de_capitulo: "o painel de resumo por capitulo foi substituido por paginas criadas pelo usuario (0038); a tabela antiga fica so para nao abandonar texto ja escrito",
  listar_resumos_do_livro: "o painel de resumo por capitulo foi substituido por paginas criadas pelo usuario (0038); a tabela antiga fica so para nao abandonar texto ja escrito",
  remover_resumo_de_capitulo: "o painel de resumo por capitulo foi substituido por paginas criadas pelo usuario (0038); a tabela antiga fica so para nao abandonar texto ja escrito",
  // A tela JA precisa da arvore inteira de categorias em memoria para
  // desenhar a lista aninhada, entao expandir os descendentes de um filtro e
  // uma varredura local instantanea (`filtrarPorCategoria`, filtro.ts) — uma
  // ida ao backend a cada clique de filtro seria mais lenta e sem ganho.
  // CUSTO ACEITO E DECLARADO: a travessia existe nos DOIS lados (aqui em
  // TypeScript, e em `WITH RECURSIVE` no Rust) e nada trava as duas juntas.
  // Quem ligar este comando a uma tela um dia (uma estante grande demais para
  // carregar de uma vez) deve APAGAR a versao em TypeScript no mesmo commit,
  // em vez de deixar as duas convivendo.
  listar_livros_da_categoria: "o filtro da estante expande os descendentes na propria tela, com a arvore que ela ja tem em memoria; este comando e a mesma resposta vinda do banco, para quando a estante nao couber inteira em memoria",

  // --- Databases: a view Tabela ligou o núcleo (get_database, list_properties,
  //     list_views, list_records, create_record, apply_record_value_changes,
  //     create_property via "+ Propriedade", create_database/create_view via
  //     "/database"). O menu do cabeçalho de coluna
  //     (`views/table/ColumnHeaderMenu.tsx`) ligou rename_property,
  //     change_property_type, reorder_property ("mover para a esquerda/
  //     direita"), delete_property e set_property_config ("Editar fórmula").
  //     O que sobra: ---
  list_databases_in_page: "nenhuma tela lista as databases de uma pagina — o bloco inline ja carrega o databaseId dele proprio; uma tela de 'databases desta pagina' (ou de page inteira, DBS-002) e que precisaria disto",
  set_view_config: "o ViewConfig (filtro/ordenacao/agrupamento/visibilidade) tem UI pura em view-config/, mas aplicar filtro e ordenacao depende do pipeline de consulta em Rust (open_view_query, arquitetura §8) que nao existe — persistir um config que a tela nao consegue honrar seria controle morto",
  reorder_view: "a database nasce com uma view so; nao ha abas de view na tela, entao nem reordenar nem apagar view tem onde morar",
  delete_view: "mesmo motivo de reorder_view — sem abas de view, nao ha onde apagar uma",

  // --- Trilha: painel (varias trilhas, trocar, renomear, apagar) mais
  //     raia/material ligados nesta rodada. criar_trilha continua sem tela
  //     de propósito (criarTrilhaCompleta cobre o caminho real de criação;
  //     configurar/trocar groupPropertyId DEPOIS passa por
  //     definir_propriedade_de_agrupamento_da_trilha, esse sim com tela —
  //     "Ativar raias" em TrilhaCanvas.tsx) — e etapa_esta_desbloqueada
  //     porque obter_trilha já devolve isUnlocked por etapa. ---
  criar_trilha: "sem tela dedicada — criarTrilhaCompleta cobre o caminho real de criacao (database + view + configuracao num passo so); quem precisa mudar o agrupamento depois usa definir_propriedade_de_agrupamento_da_trilha (Ativar raias), nao este comando",
  etapa_esta_desbloqueada: "obter_trilha ja devolve isUnlocked por etapa; nenhuma tela precisou perguntar isso avulso",

  // --- Cartoes: sem tela de editar/navegar notas ---
  update_note: "nao ha tela de editar cartao nem navegador de notas; so criar e estudar existem",
  delete_note: "nao ha tela de editar cartao nem navegador de notas; so criar e estudar existem",
  list_notes: "nao ha tela de editar cartao nem navegador de notas; so criar e estudar existem",

  // --- Gamificacao: o XP de revisao, de foco e de bloco cumprido sai SOZINHO,
  //     na mesma transacao do evento (answer_card, e finish do pomodoro com
  //     plan_block_id). Nenhuma tela deve chamar os tres abaixo no fluxo
  //     normal: ficam como reprocessamento do historico gravado antes do
  //     credito automatico existir (decisao do usuario, 13/09/2026; ver o
  //     comentario de modulo de ipc/gamificacao_commands.rs) ---
  registrar_xp_revisao_cartao: "reprocessamento: revisoes gravadas antes do credito automatico em answer_card nunca geraram XP, e so este comando idempotente as credita",
  registrar_xp_pomodoro_concluido: "reprocessamento: focos concluidos antes do credito automatico em finish nunca geraram XP, e so este comando idempotente os credita",
  registrar_xp_bloco_cronograma: "reprocessamento: o credito normal sai em finish do foco ligado ao bloco; este comando confere o limiar e credita blocos antigos",
  resumo_de_sessao: "a camada de motivacao existe no Rust; nenhuma tela ainda fecha uma sessao de estudo com inicio/fim para resumir",

  // --- Tags: o indice (0041_tags.sql, db/tags.rs) e alimentado em toda
  //     escrita de bloco, mas a marca # no editor e o painel de navegacao por
  //     tag ainda nao existem. As interfaces TagSummaryRow/TagPageRow ja estao
  //     no ipc.ts; o wrapper entra junto com a tela. ---
  list_all_tags: "o indice de #tags existe no backend; falta o painel que lista as tags e leva as paginas de cada uma",
  list_pages_for_tag: "o indice de #tags existe no backend; falta o painel que lista as tags e leva as paginas de cada uma",

  // --- Cronograma: rotina diaria (o MOLDE de um dia, 0024) tem backend e
  //     testes completos, e nenhuma tela. aplicar_rotina ainda aplica um dia
  //     so — o intervalo de datas e a fatia 2 do plano. As interfaces
  //     Rotina/ItemDeRotina/AplicacaoDeRotina ja estao no ipc.ts. ---
  criar_rotina: "a rotina diaria nao tem tela no Cronograma ainda",
  listar_rotinas: "a rotina diaria nao tem tela no Cronograma ainda",
  atualizar_rotina: "a rotina diaria nao tem tela no Cronograma ainda",
  remover_rotina: "a rotina diaria nao tem tela no Cronograma ainda",
  criar_item_de_rotina: "a rotina diaria nao tem tela no Cronograma ainda",
  listar_itens_de_rotina: "a rotina diaria nao tem tela no Cronograma ainda",
  atualizar_item_de_rotina: "a rotina diaria nao tem tela no Cronograma ainda",
  remover_item_de_rotina: "a rotina diaria nao tem tela no Cronograma ainda",
  aplicar_rotina: "a rotina diaria nao tem tela no Cronograma ainda; aplicar a um intervalo de datas tambem falta no Rust",

  // --- Avulsos ---
  get_page_breadcrumb: "o Breadcrumb deriva a trilha da store da arvore de paginas em vez de ir ao backend, entao este comando nunca e chamado; decidir se ele fica como API ou sai",
  trigger_backup_for_risky_operation: "o backup antes de operacao arriscada e disparado pelo proprio Rust; nenhuma tela precisa aciona-lo",
};


describe("todo comando de IPC é alcançável", () => {
  it("acha os três lados (se estiver vazio, este arquivo não prova nada)", () => {
    expect(comandosRegistrados().size).toBeGreaterThan(20);
    expect(comandosDeclarados().size).toBeGreaterThan(20);
    expect(comandosChamadosPeloFrontend().size).toBeGreaterThan(20);
  });

  it("todo #[tauri::command] está no generate_handler! do lib.rs", () => {
    const registrados = comandosRegistrados();
    const orfaos = [...comandosDeclarados()]
      .filter(([nome]) => !registrados.has(nome))
      .map(([nome, arquivo]) => `${nome} (src-tauri/src/ipc/${arquivo})`);

    expect(
      orfaos,
      [
        "Estes comandos existem, compilam e não estão registrados no",
        "`generate_handler!` de src-tauri/src/lib.rs — ou seja: o frontend não",
        "consegue chamá-los, e nada nunca falha para avisar. É a família de",
        "defeito mais repetida deste projeto. Acrescente-os à lista.",
      ].join(" "),
    ).toEqual([]);
  });

  it("todo comando registrado é de fato chamado por alguma tela", () => {
    const chamados = comandosAlcancadosPorTela();
    const orfaos = [...comandosRegistrados()]
      .filter((nome) => !chamados.has(nome))
      .filter((nome) => !(nome in REGISTRADOS_SEM_TELA));

    expect(
      orfaos,
      [
        "Estes comandos estão registrados e nenhuma tela os chama. Nada falha —",
        "a capacidade simplesmente não existe para o usuário, e é o caso mais",
        "silencioso desta família de defeito. Ou ligue-os a uma tela, ou",
        "declare-os em REGISTRADOS_SEM_TELA com o motivo, para a dívida ficar",
        "visível em vez de invisível.",
      ].join(" "),
    ).toEqual([]);
  });

  it("a lista de dívida não guarda comando que já sumiu ou que já tem tela", () => {
    // Entrada obsoleta é pior que entrada nenhuma: ela silencia um comando que
    // voltaria a ser órfão sem ninguém ver.
    const registrados = comandosRegistrados();
    const chamados = comandosAlcancadosPorTela();

    const inexistentes = Object.keys(REGISTRADOS_SEM_TELA).filter((nome) => !registrados.has(nome));
    const jaLigados = Object.keys(REGISTRADOS_SEM_TELA).filter((nome) => chamados.has(nome));

    expect(inexistentes, "declarados como dívida e não existem mais; remova de REGISTRADOS_SEM_TELA").toEqual([]);
    expect(jaLigados, "declarados como dívida e JÁ têm tela; remova de REGISTRADOS_SEM_TELA").toEqual([]);
  });

  it("todo comando chamado pelo frontend existe e está registrado", () => {
    const registrados = comandosRegistrados();
    const inexistentes = [...comandosChamadosPeloFrontend()].filter((nome) => !registrados.has(nome));

    expect(
      inexistentes,
      [
        "O frontend invoca estes comandos e o Rust não os registra. A chamada",
        "rejeita em tempo de execução com um erro que só aparece no console da",
        "WebView — a tela simplesmente não funciona, sem nenhum teste vermelho.",
        "Ou o nome está escrito diferente dos dois lados, ou o comando nunca foi",
        "acrescentado ao `generate_handler!`.",
      ].join(" "),
    ).toEqual([]);
  });
});
