import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpcoesDeDeckJson } from "../../lib/ipc";
import {
  PESOS_PADRAO_FSRS6,
  QUANTIDADE_DE_PESOS_FSRS,
  formatarPesos,
  opcoesDoRascunho,
  rascunhoDeOpcoes,
  type RascunhoDeOpcoes,
} from "./opcoes-de-baralho";

const PADRAO: OpcoesDeDeckJson = {
  learning_steps_min: [1, 10],
  relearning_steps_min: [10],
  graduating_interval_dias: 1,
  easy_interval_dias: 4,
  easy_bonus_pct: 130,
  hard_interval_pct: 120,
  lapse_new_interval_percent: 0,
  minimum_interval_dias: 1,
  maximum_interval_dias: 36_500,
  leech_threshold: 8,
  fuzz_habilitado: true,
  agendador: "sm2",
  fsrs_retencao_desejada: 0.9,
  fsrs_pesos: [...PESOS_PADRAO_FSRS6],
};

function rascunho(overrides: Partial<RascunhoDeOpcoes> = {}): RascunhoDeOpcoes {
  return { ...rascunhoDeOpcoes(PADRAO), ...overrides };
}

describe("PESOS_PADRAO_FSRS6", () => {
  it("é cópia fiel de PESOS_PADRAO em src-tauri/src/srs/fsrs.rs", () => {
    // A constante é duplicada em TypeScript para o botão "Usar padrões"
    // funcionar sem ida ao backend; este teste é o que impede a cópia de
    // envelhecer em silêncio quando o Rust mudar de versão do modelo.
    const fonte = fs.readFileSync(path.resolve(__dirname, "../../../src-tauri/src/srs/fsrs.rs"), "utf-8");
    const bloco = /pub const PESOS_PADRAO: \[f64; 21\] = \[([^\]]+)\];/.exec(fonte);
    expect(bloco, "não achei PESOS_PADRAO em fsrs.rs; o teste precisa acompanhar a mudança").not.toBeNull();
    if (!bloco) return;

    const noRust = bloco[1]
      .split(",")
      .map((pedaco) => pedaco.trim())
      .filter((pedaco) => pedaco !== "")
      .map(Number);

    expect(noRust).toHaveLength(QUANTIDADE_DE_PESOS_FSRS);
    expect([...PESOS_PADRAO_FSRS6]).toEqual(noRust);
  });
});

describe("rascunhoDeOpcoes ↔ opcoesDoRascunho", () => {
  it("faz a viagem de ida e volta sem perder nada", () => {
    const resultado = opcoesDoRascunho(rascunhoDeOpcoes(PADRAO));

    expect(resultado).toEqual({ ok: true, opcoes: PADRAO });
  });

  it("mostra retenção e multiplicadores como o usuário pensa neles: percentual inteiro", () => {
    const r = rascunhoDeOpcoes(PADRAO);

    expect(r.fsrsRetencaoPct).toBe("90");
    expect(r.easyBonusPct).toBe("130");
    expect(r.learningSteps).toBe("1 10");
  });

  it("aceita passos separados por vírgula e pesos colados do Anki, e normaliza", () => {
    const resultado = opcoesDoRascunho(
      rascunho({
        learningSteps: "1, 10, 60",
        relearningSteps: "",
        fsrsPesos: PESOS_PADRAO_FSRS6.map((peso) => peso.toFixed(4)).join(", "),
        agendador: "fsrs",
        fsrsRetencaoPct: "85",
      }),
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.opcoes.learning_steps_min).toEqual([1, 10, 60]);
    // Lista vazia é válida: gradua na primeira resposta (doc de `OpcoesDeDeck`).
    expect(resultado.opcoes.relearning_steps_min).toEqual([]);
    expect(resultado.opcoes.agendador).toBe("fsrs");
    expect(resultado.opcoes.fsrs_retencao_desejada).toBeCloseTo(0.85);
    expect(resultado.opcoes.fsrs_pesos).toHaveLength(21);
    expect(resultado.opcoes.fsrs_pesos[0]).toBeCloseTo(0.212);
  });

  it("recusa 20 pesos: o serde do Rust exige exatamente 21, e o erro precisa aparecer antes do fio", () => {
    const resultado = opcoesDoRascunho(rascunho({ fsrsPesos: formatarPesos(PESOS_PADRAO_FSRS6.slice(0, 20)) }));

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.erros.fsrsPesos).toMatch(/exatamente 21/);
  });

  it("aponta todos os campos inválidos de uma vez, cada um com a própria mensagem", () => {
    const resultado = opcoesDoRascunho(
      rascunho({
        learningSteps: "1 dez",
        graduatingInterval: "0",
        fsrsRetencaoPct: "150",
        lapseNewIntervalPct: "abc",
      }),
    );

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(Object.keys(resultado.erros).sort()).toEqual(
      ["fsrsRetencaoPct", "graduatingInterval", "lapseNewIntervalPct", "learningSteps"].sort(),
    );
    expect(resultado.erros.learningSteps).toMatch(/inteiro/);
    expect(resultado.erros.fsrsRetencaoPct).toMatch(/entre 70 e 99/);
  });

  it("intervalo mínimo maior que o máximo é erro no mínimo, não um agendamento impossível", () => {
    const resultado = opcoesDoRascunho(rascunho({ minimumInterval: "30", maximumInterval: "10" }));

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.erros.minimumInterval).toMatch(/intervalo máximo/);
    expect(resultado.erros.maximumInterval).toBeUndefined();
  });
});
