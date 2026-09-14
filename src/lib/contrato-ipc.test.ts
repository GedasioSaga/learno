import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A trava contra o defeito que este projeto já cometeu SEIS vezes: o tipo
 * TypeScript de um comando IPC declarar campos que o Rust nunca serializa.
 *
 * O histórico, todo em silêncio absoluto — nenhum erro, nenhum log, nenhum
 * teste vermelho:
 *
 * - `create_note` mandava `Vec<String>` onde o TS esperava um registro;
 * - `AnswerOutcome`, `DeckForecastDay` e `MindmapChange` divergiam em nome
 *   ou em aninhamento;
 * - `CardToStudy.fields` viajava como LISTA e o TS declarava
 *   `Record<string, string>` — indexar uma lista por nome devolve `undefined`,
 *   e a sessão de estudo mostrava "(sem conteúdo)" com o cartão íntegro no
 *   banco;
 * - `BlocoPlanejado` declarava sete campos em português contra sete nomes em
 *   inglês do Rust, e todo cartão do Cronograma renderizava `undefined`.
 *
 * Por que nada pegou: **o vitest mocka `ipc.ts` e nunca atravessa o fio**, e
 * do lado Rust os testes chamam as funções `_inner` diretamente, com structs
 * Rust construídos em Rust — o `serde_json` do meio nunca entra em cena. As
 * duas suítes ficam verdes provando cada metade contra uma fixture que elas
 * mesmas fabricaram, e a fixture é justamente onde o erro mora.
 *
 * Este teste não olha nenhuma das duas metades: olha só a COSTURA. Lê o texto
 * dos dois lados e compara nome por nome, aplicando o `rename_all` do serde.
 * Uma struct nova entra na conta no instante em que o arquivo aparece, sem
 * ninguém precisar lembrar de vir aqui.
 *
 * Ele lê texto em vez de importar módulo de propósito: o que se quer provar é
 * o que está ESCRITO, e não há como importar um tipo TypeScript em tempo de
 * execução — tipo some na compilação, que é precisamente por que o `tsc`
 * também nunca pegou nada disto.
 */

const RAIZ = path.resolve(__dirname, "../..");
const IPC_TS = path.join(RAIZ, "src/lib/ipc.ts");
const PASTAS_RUST = [
  path.join(RAIZ, "src-tauri/src/db"),
  path.join(RAIZ, "src-tauri/src/ipc"),
  // `import_apkg` devolve `anki::importar::RelatorioDeImportacao`.
  path.join(RAIZ, "src-tauri/src/anki"),
];

/**
 * Pares em que o tipo TypeScript e a struct Rust descrevem a mesma coisa com
 * nomes diferentes.
 *
 * O casamento normal é por nome igual, e sem esta tabela um tipo renomeado
 * some da comparação SEM alarme nenhum — o que faria deste arquivo mais um
 * teste verde que não olha nada, exatamente o que ele existe para impedir.
 * Aconteceu na Trilha: `Raia`, `Etapa` e `Flecha` ganharam sufixo em TS para
 * não ocupar nomes genéricos no módulo compartilhado, e as três passaram a
 * ser puladas em silêncio.
 *
 * Renomeou um tipo? Ou volte ao nome do Rust, ou registre aqui.
 */
const APELIDOS: Record<string, string> = {
  RaiaDaTrilha: "Raia",
  EtapaDaTrilha: "Etapa",
  FlechaDaTrilha: "Flecha",
  Livro: "LivroRow",
  Anotacao: "AnotacaoRow",
  DeckForecastDay: "DiaPrevisto",
  EstatisticasDeEstudo: "StudyStats",
  PageVersion: "PageVersionRow",
  SearchResult: "SearchResultRow",
  PomodoroSessionRow: "PomodoroRow",
  PomodoroToday: "PomodoroResumo",
};

/**
 * Structs Rust que atravessam o fio e que a comparacao NAO consegue conferir,
 * com o motivo de cada uma.
 *
 * Ponto cego declarado e divida; ponto cego calado e a proxima costura
 * quebrada. Sair desta lista e o objetivo — escrever a interface TypeScript
 * correspondente resolve a maioria dos casos.
 */
const PONTOS_CEGOS: Record<string, string> = {
  // ---- db::effects — motor de efeitos de registro (arquitetura §7) --------
  // `EffectRepository` (src-tauri/src/db/effects.rs) e os tipos abaixo
  // existem, mas nenhum comando os expõe: procurado em
  // `src-tauri/src/ipc/*_commands.rs` por `run_record_effect` e
  // `validate_record_effect_references` (os dois únicos métodos que os
  // produzem) e nenhum `#[tauri::command]` os chama. Só os testes do próprio
  // `effects.rs` constroem esses tipos hoje.
  PropertyWrite:
    "db::effects::PropertyWrite só é construída/lida por EffectRepository::run_record_effect e ::validate_record_effect_references; procurado em src-tauri/src/ipc/*_commands.rs por essas chamadas e nenhum #[tauri::command] as faz.",
  RecordEffect:
    "mesma ausência de comando de PropertyWrite acima — RecordEffect só aparece dentro de src-tauri/src/db/effects.rs e nos testes dele.",
  BrokenReference:
    "mesma ausência de comando — devolvida só por EffectRepository::validate_record_effect_references, que nenhum comando em src-tauri/src/ipc/ chama.",
  EffectOutcome:
    "mesma ausência de comando — devolvida só por EffectRepository::run_record_effect, que nenhum comando em src-tauri/src/ipc/ chama.",
  // (`AppliedRecordValue`/`AppliedChanges` saíram daqui: `apply_record_value_changes`
  // ganhou comando em `ipc/database_commands.rs` e as duas interfaces
  // correspondentes vivem em `ipc.ts`, comparadas campo a campo como as demais.)
  // ---- db::relations — grafo de relações (arquitetura §5/§9) -------------
  // RelationRepository (src-tauri/src/db/relations/) tem create_relation,
  // list_relation_targets e list_relation_targets_bulk, mas
  // ipc/relation_commands.rs — procurado e ausente em src-tauri/src/ipc/ —
  // nunca foi escrito.
  RelationDefinitionRow:
    "db::relations::RelationDefinitionRow só é produzida por RelationRepository; ipc/relation_commands.rs (o arquivo previsto para o comando create_relation) não existe em src-tauri/src/ipc/.",
  CreateRelationResult:
    "mesmo motivo de RelationDefinitionRow acima — devolvida só por RelationRepository::create_relation/::set_relation_two_way, sem ipc/relation_commands.rs que os exponha.",
  RelationTargetRow:
    "mesmo motivo — devolvida só por RelationRepository::list_relation_targets(_bulk), sem comando que os exponha.",
  RelationTargetPage:
    "mesmo motivo — devolvida só por RelationRepository::list_relation_targets, sem comando que a exponha.",
  RecordTargets:
    "mesmo motivo — devolvida só por RelationRepository::list_relation_targets_bulk, sem comando que a exponha.",
  // ---- Editor: contrato próprio, fora de ipc.ts ---------------------------
  BlockRow:
    "atravessa o fio de verdade (list_page_blocks/create_block/update_block/delete_blocks/move_block/apply_block_changes, src-tauri/src/ipc/block_commands.rs), mas por um contrato paralelo: src/features/editor/contract.ts declara `Block` campo a campo e src/features/editor/core/blocks-api.ts chama invoke() diretamente, com uma arquitetura própria de stub localStorage/real (`BlockCommands`) que várias peças do editor importam. Consolidar em ipc.ts, como foi feito nesta mesma rodada para BacklinkRow/OutgoingLinkRow (achado desta tarefa), exigiria refatorar esse mecanismo de stub/real inteiro — grande demais para esta tarefa, fica como dívida.",
};

interface Campo {
  nome: string;
  /** `true` quando o campo aceita ausência: `Option<T>` no Rust, `| null` ou `?` no TypeScript. */
  aceitaNulo: boolean;
}

/** Campos de uma interface TypeScript, na ordem em que aparecem. */
type CamposPorTipo = Map<string, Campo[]>;

/**
 * As `export interface` de `ipc.ts` e seus campos.
 *
 * Parser de linha, deliberadamente simples: o arquivo tem um campo por linha
 * e nenhum tipo objeto embutido. Se isso mudar, este teste passa a ver campos
 * a mais — e é melhor ele reclamar de leve do que calar sobre um descasamento.
 */
function interfacesDoTypeScript(fonte: string): CamposPorTipo {
  const encontradas: CamposPorTipo = new Map();
  const linhas = fonte.split(/\r?\n/);

  for (let i = 0; i < linhas.length; i += 1) {
    // `(?:\s+extends\s+\w+)?` cobre `PrazoComContagem extends PrazoRow` — a
    // única interface do arquivo que usa `extends` (para espelhar o
    // `#[serde(flatten)]` do lado Rust). Sem isso a linha inteira falhava o
    // casamento e a interface inteira desaparecia da comparação, campo
    // próprio (`diasRestantes`) incluído.
    const abertura = /^export interface (\w+)(?:\s+extends\s+\w+)?\s*\{/.exec(linhas[i]);
    if (!abertura) continue;

    const campos: Campo[] = [];
    for (let j = i + 1; j < linhas.length; j += 1) {
      const linha = linhas[j].trim();
      if (linha === "}") break;
      if (linha === "" || linha.startsWith("//") || linha.startsWith("/*") || linha.startsWith("*")) continue;
      const campo = /^(\w+)(\??)\s*:\s*(.+?);?$/.exec(linha);
      if (!campo) continue;
      const opcional = campo[2] === "?";
      const tipo = campo[3];
      campos.push({
        nome: campo[1],
        aceitaNulo: opcional || /\bnull\b/.test(tipo) || /\bundefined\b/.test(tipo),
      });
    }
    encontradas.set(abertura[1], campos);
  }

  return encontradas;
}

interface StructRust {
  campos: Campo[];
  /** Struct com `#[serde(flatten)]` não dá para comparar por nome — some da conta, mas é reportada. */
  temFlatten: boolean;
}

/**
 * As structs Rust marcadas com `Serialize` e os nomes de campo COMO SAEM NO
 * JSON — ou seja, já com `rename_all` e `rename` aplicados.
 *
 * Só entram structs serializáveis: uma struct interna sem `Serialize` nunca
 * atravessa o fio, e comparar com ela produziria alarme falso.
 */
function structsDoRust(fonte: string): Map<string, StructRust> {
  const encontradas = new Map<string, StructRust>();
  const linhas = fonte.split(/\r?\n/);

  let atributos: string[] = [];

  for (let i = 0; i < linhas.length; i += 1) {
    const linha = linhas[i].trim();

    if (linha.startsWith("#[")) {
      atributos.push(linha);
      continue;
    }

    const abertura = /^pub struct (\w+)\s*\{/.exec(linha);
    if (!abertura) {
      // Comentário e linha em branco não quebram a sequência de atributos:
      // o estilo do projeto intercala doc comment entre `#[derive]` e
      // `#[serde]`.
      if (!linha.startsWith("//") && linha !== "") atributos = [];
      continue;
    }

    const atributosDaStruct = atributos;
    atributos = [];

    const serializavel = atributosDaStruct.some((a) => a.includes("derive") && a.includes("Serialize"));
    if (!serializavel) continue;
    const emCamelCase = atributosDaStruct.some((a) => a.includes('rename_all = "camelCase"'));

    const campos: Campo[] = [];
    let temFlatten = false;
    let atributosDoCampo: string[] = [];

    for (let j = i + 1; j < linhas.length; j += 1) {
      const corpo = linhas[j].trim();
      if (corpo === "}") break;
      if (corpo.startsWith("#[")) {
        atributosDoCampo.push(corpo);
        continue;
      }
      if (corpo === "" || corpo.startsWith("//")) continue;

      const campo = /^pub (\w+)\s*:\s*(.+?),?$/.exec(corpo);
      if (!campo) {
        atributosDoCampo = [];
        continue;
      }

      const serdeDoCampo = atributosDoCampo.filter((a) => a.startsWith("#[serde("));
      atributosDoCampo = [];

      if (serdeDoCampo.some((a) => a.includes("flatten"))) {
        temFlatten = true;
        continue;
      }
      if (serdeDoCampo.some((a) => a.includes("skip"))) continue;

      const renomeado = serdeDoCampo.map((a) => /rename = "([^"]+)"/.exec(a)).find(Boolean);
      const nomeCru = campo[1];
      const nome = renomeado ? renomeado[1] : emCamelCase ? paraCamelCase(nomeCru) : nomeCru;

      campos.push({ nome, aceitaNulo: campo[2].startsWith("Option<") });
    }

    encontradas.set(abertura[1], { campos, temFlatten });
  }

  return encontradas;
}

function paraCamelCase(snake: string): string {
  return snake.replace(/_(\w)/g, (_, letra: string) => letra.toUpperCase());
}

function arquivosRust(): string[] {
  const achados: string[] = [];
  for (const pasta of PASTAS_RUST) {
    if (!fs.existsSync(pasta)) continue;
    for (const entrada of fs.readdirSync(pasta, { withFileTypes: true, recursive: true })) {
      if (!entrada.isFile() || !entrada.name.endsWith(".rs")) continue;
      achados.push(path.join(entrada.parentPath ?? pasta, entrada.name));
    }
  }
  return achados;
}

function structsSerializaveis(): Map<string, StructRust> {
  const todas = new Map<string, StructRust>();
  for (const arquivo of arquivosRust()) {
    for (const [nome, struct] of structsDoRust(fs.readFileSync(arquivo, "utf-8"))) {
      todas.set(nome, struct);
    }
  }
  return todas;
}

describe("o contrato de IPC bate dos dois lados do fio", () => {
  it("acha os dois lados (se este teste ficar vazio, ele não está provando nada)", () => {
    const interfaces = interfacesDoTypeScript(fs.readFileSync(IPC_TS, "utf-8"));
    const structs = structsSerializaveis();

    expect(interfaces.size).toBeGreaterThan(10);
    expect(structs.size).toBeGreaterThan(10);

    // Se os parsers deixassem de reconhecer nulabilidade, o teste principal
    // continuaria verde sem checar metade do que promete checar.
    expect(
      [...structs.values()].some((struct) => struct.campos.some((campo) => campo.aceitaNulo)),
      "nenhum Option<T> reconhecido no Rust; o parser de tipo quebrou",
    ).toBe(true);
    expect(
      [...interfaces.values()].some((campos) => campos.some((campo) => campo.aceitaNulo)),
      "nenhum campo anulável reconhecido no TypeScript; o parser de tipo quebrou",
    ).toBe(true);

    // Apelido que aponta para struct inexistente é pior que apelido nenhum:
    // ele faz o tipo ser pulado, e a tabela dá a impressão de que ele está
    // coberto.
    const apelidosOrfaos = Object.entries(APELIDOS)
      .filter(([tipoTs, structRust]) => !interfaces.has(tipoTs) || !structs.has(structRust))
      .map(([tipoTs, structRust]) => `${tipoTs} -> ${structRust}`);
    expect(apelidosOrfaos, "apelido apontando para tipo ou struct que não existe mais").toEqual([]);
  });

  it("toda interface com struct Rust de mesmo nome tem exatamente os mesmos campos", () => {
    const interfaces = interfacesDoTypeScript(fs.readFileSync(IPC_TS, "utf-8"));
    const structs = structsSerializaveis();

    const divergencias: string[] = [];
    let comparadas = 0;

    for (const [nome, camposTs] of interfaces) {
      const struct = structs.get(APELIDOS[nome] ?? nome);
      if (!struct) continue;
      comparadas += 1;
      // (structs sem par são auditadas pelo teste de pontos cegos, adiante)
      //
      // `struct.temFlatten` NÃO exclui mais a struct daqui: `struct.campos`
      // já vem sem o campo achatado (structsDoRust pula só ELE, não a
      // struct inteira), então comparar contra `camposTs` — que também só
      // tem os campos próprios da interface TS, nunca os herdados de um
      // `extends` — confere exatamente a parte que não é achatada. É o caso
      // de `PrazoComContagem`: só `diasRestantes` entra nesta comparação, e
      // é exatamente o campo que antes nunca era conferido por ninguém.

      const noRust = new Map(struct.campos.map((campo) => [campo.nome, campo]));
      const noTs = new Map(camposTs.map((campo) => [campo.nome, campo]));

      const soNoTs = camposTs.filter((campo) => !noRust.has(campo.nome)).map((campo) => campo.nome);
      const soNoRust = struct.campos.filter((campo) => !noTs.has(campo.nome)).map((campo) => campo.nome);

      // A outra metade do mesmo defeito, e a mais traiçoeira: o nome bate, o
      // campo chega — e chega `null` num lugar onde o TypeScript prometeu que
      // sempre haveria valor. O `tsc` fica quieto (ele acredita na declaração)
      // e a tela quebra só quando o dado real aparece. Aconteceu em
      // `ProgressoDeLeitura.currentLocator` e em `BlocoPlanejado.startLocalTime`.
      //
      // O contrário — Rust sempre manda valor e o TS aceita `null` — é só
      // excesso de cautela e não entra na conta.
      const nuloNaoDeclarado = struct.campos
        .filter((campo) => campo.aceitaNulo && noTs.get(campo.nome)?.aceitaNulo === false)
        .map((campo) => campo.nome);

      if (soNoTs.length === 0 && soNoRust.length === 0 && nuloNaoDeclarado.length === 0) continue;

      divergencias.push(
        [
          `${nome}:`,
          soNoTs.length ? `  declarados em ipc.ts e NUNCA enviados pelo Rust: ${soNoTs.join(", ")}` : "",
          soNoRust.length ? `  enviados pelo Rust e ausentes de ipc.ts: ${soNoRust.join(", ")}` : "",
          nuloNaoDeclarado.length
            ? `  Option<T> no Rust e sem "| null" em ipc.ts: ${nuloNaoDeclarado.join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    // Sem pares comparados o teste passaria alegremente sem olhar nada — que
    // é justamente o modo de falha que ele existe para impedir.
    expect(comparadas, "nenhuma interface casou com struct Rust; o parser provavelmente quebrou").toBeGreaterThan(5);

    expect(
      divergencias,
      [
        "Costura de IPC quebrada. Um campo que o Rust não envia chega como `undefined`",
        "no TypeScript — sem erro, sem log, sem teste vermelho, e a tela mostra vazio.",
        "Alinhe os dois lados (em geral o Rust manda, porque os nomes dele vêm das",
        "colunas da tabela) e conserte também as fixtures dos testes: fixture no formato",
        "errado é o que escondeu todos os casos anteriores.",
        "",
      ].join(" "),
    ).toEqual([]);
  });
  /**
   * O teste que audita a PRÓPRIA COBERTURA deste arquivo.
   *
   * Um revisor rastreou tipo por tipo e mostrou que a comparação acima tem
   * três pontos cegos — e que nenhum teste os reportava como buraco. Cada um
   * fazia um tipo ser pulado EM SILÊNCIO, que é o modo de falha que este
   * arquivo inteiro existe para impedir:
   *
   * 1. struct Rust `Serialize` sem NENHUMA interface TypeScript de mesmo nome:
   *    o laço itera sobre as interfaces do TS, então uma struct sem par nunca
   *    é sequer tentada. Foi o caso de `ResumoDeSessao`, que tem comando
   *    registrado e atravessa o fio;
   * 2. struct com `#[serde(flatten)]`: era pulada INTEIRA, inclusive os
   *    campos que NÃO são achatados — `PrazoComContagem` é a única do
   *    projeto com flatten, e o único campo próprio dela (`diasRestantes`)
   *    nunca era conferido. CORRIGIDO: `structsDoRust` já excluía só o campo
   *    achatado dos `campos` da struct (nunca a struct inteira); o buraco
   *    era a comparação acima pular a struct toda ao ver `temFlatten`, e o
   *    parser de interface TS não reconhecer `interface X extends Y {` (por
   *    isso `PrazoComContagem`, que usa `extends PrazoRow` para expressar o
   *    mesmo achatamento do lado TypeScript, nem aparecia como interface).
   *    Consertados os dois, uma struct com flatten casa por nome como
   *    qualquer outra e só os campos não achatados entram na conta — deixa
   *    de ser uma categoria de ponto cego à parte;
   * 3. tipo de ENTRADA (`Deserialize` sem `Serialize`): nunca indexado, então
   *    o que o TypeScript MANDA para o Rust não é conferido por ninguém —
   *    só o que ele recebe.
   *
   * A correção não é fingir que dá para comparar os três: é fazer o buraco
   * aparecer. Ponto cego declarado é dívida; ponto cego calado é a próxima
   * costura quebrada.
   */
  it("os pontos cegos da comparação estão todos declarados", () => {
    const interfaces = interfacesDoTypeScript(fs.readFileSync(IPC_TS, "utf-8"));
    const structs = structsSerializaveis();

    const nomesTsResolvidos = new Set([...interfaces.keys()].map((nome) => APELIDOS[nome] ?? nome));

    // Struct sem NENHUMA interface TS de mesmo nome (direto ou via APELIDOS)
    // — flatten incluído: uma struct com `#[serde(flatten)]` que tem par por
    // nome já é comparada de verdade (ver o comentário do teste anterior),
    // então não é mais uma categoria à parte. `Set` deduplica: antes desta
    // correção `PrazoComContagem` entrava aqui E na lista (hoje removida) de
    // `comFlatten`, contando o mesmo ponto cego duas vezes.
    const cegos = [...new Set([...structs.keys()].filter((nome) => !nomesTsResolvidos.has(nome)))].sort();
    const declarados = Object.keys(PONTOS_CEGOS).sort();

    expect(
      cegos.filter((nome) => !(nome in PONTOS_CEGOS)),
      [
        "Estas structs Rust atravessam o fio e NÃO estão sendo comparadas com o",
        "TypeScript — nenhuma interface de mesmo nome (direto ou via APELIDOS).",
        "Escreva a interface TS correspondente (o melhor desfecho), registre um",
        "apelido, ou declare-as em PONTOS_CEGOS com o motivo. O que não pode é",
        "elas sumirem da conta sem ninguém saber.",
      ].join(" "),
    ).toEqual([]);

    expect(
      declarados.filter((nome) => !cegos.includes(nome)),
      "declarados como ponto cego e hoje já comparados (ou já não existem); remova de PONTOS_CEGOS",
    ).toEqual([]);
  });
});
