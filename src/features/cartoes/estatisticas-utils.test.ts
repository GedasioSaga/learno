import { describe, expect, it } from "vitest";
import type { RevisaoDoDia } from "../../lib/ipc";
import {
  construirMapaDeCalor,
  descricaoDoDia,
  formatarDataLocal,
  maximoDeRevisoes,
  nivelDeIntensidade,
} from "./estatisticas-utils";

describe("formatarDataLocal", () => {
  it("usa os componentes locais, não toISOString (que é UTC)", () => {
    // 23h59 do dia 5 em horário local: toISOString() jogaria isto pro dia 6
    // se a implementação usasse UTC por engano.
    expect(formatarDataLocal(new Date(2026, 2, 5, 23, 59))).toBe("2026-03-05");
    expect(formatarDataLocal(new Date(2026, 0, 1))).toBe("2026-01-01");
  });
});

describe("construirMapaDeCalor", () => {
  const hoje = new Date(2026, 8, 5); // sábado, 5 de setembro de 2026

  it("cobre exatamente a janela pedida, com a última linha terminando na semana de hoje", () => {
    const semanas = construirMapaDeCalor([], 7, hoje);

    const todasAsCelulas = semanas.flat();
    expect(todasAsCelulas.at(-1)?.dia).toBe("2026-09-05"); // sábado: fecha a semana de hoje
    expect(todasAsCelulas.every((celula) => celula.data <= hoje)).toBe(true);
  });

  it("preenche a grade até um múltiplo de 7, sem quebrar retângulo", () => {
    const semanas = construirMapaDeCalor([], 10, hoje);

    expect(semanas.every((semana) => semana.length === 7)).toBe(true);
  });

  it("dia dentro da janela mas sem revisão vira célula 'naJanela: true' com 0 — apagada, não buraco", () => {
    const semanas = construirMapaDeCalor([], 7, hoje);

    const domingoDaSemana = semanas.at(-1)?.[0]; // 2026-08-30, dentro da janela de 7 dias? não — checa abaixo
    // O domingo que abre a última semana (30/08) fica FORA da janela de 7 dias
    // (que vai de 30/08... na verdade início = hoje - 6 = 30/08, então cai dentro).
    expect(domingoDaSemana?.dia).toBe("2026-08-30");
    expect(domingoDaSemana?.naJanela).toBe(true);
    expect(domingoDaSemana?.revisoes).toBe(0);
  });

  it("dia de preenchimento antes do início da janela pedida vem marcado 'naJanela: false'", () => {
    // Janela de 1 dia = só hoje (sábado). A grade ainda cobre a semana
    // inteira (domingo a sábado); todo o resto da semana é preenchimento.
    const semanas = construirMapaDeCalor([], 1, hoje);

    const semanaUnica = semanas[0];
    expect(semanaUnica).toHaveLength(7);
    expect(semanaUnica.slice(0, 6).every((celula) => celula.naJanela === false)).toBe(true);
    expect(semanaUnica[6].naJanela).toBe(true); // sábado = hoje
    expect(semanaUnica[6].dia).toBe("2026-09-05");
  });

  it("junta as revisões de porDia pela chave YYYY-MM-DD", () => {
    const porDia: RevisaoDoDia[] = [{ dia: "2026-09-05", revisoes: 12, segundos: 300 }];

    const semanas = construirMapaDeCalor(porDia, 7, hoje);

    const celulaDeHoje = semanas.flat().find((celula) => celula.dia === "2026-09-05");
    expect(celulaDeHoje?.revisoes).toBe(12);
  });
});

describe("maximoDeRevisoes", () => {
  it("ignora células fora da janela ao achar o pico", () => {
    const semanas = construirMapaDeCalor(
      [
        { dia: "2026-09-05", revisoes: 3, segundos: 0 },
        { dia: "2026-08-29", revisoes: 999, segundos: 0 }, // antes da janela de 1 dia — não conta
      ],
      1,
      new Date(2026, 8, 5),
    );

    expect(maximoDeRevisoes(semanas)).toBe(3);
  });

  it("grade totalmente vazia dá máximo 0", () => {
    const semanas = construirMapaDeCalor([], 7, new Date(2026, 8, 5));
    expect(maximoDeRevisoes(semanas)).toBe(0);
  });
});

describe("nivelDeIntensidade", () => {
  it("bucketiza em 5 níveis (0 a 4) pela fração sobre o máximo", () => {
    expect(nivelDeIntensidade(0, 100)).toBe(0);
    expect(nivelDeIntensidade(10, 100)).toBe(1);
    expect(nivelDeIntensidade(50, 100)).toBe(2);
    expect(nivelDeIntensidade(75, 100)).toBe(3);
    expect(nivelDeIntensidade(100, 100)).toBe(4);
  });

  it("máximo 0 (nunca estudou) nunca divide por zero — tudo vira nível 0", () => {
    expect(nivelDeIntensidade(0, 0)).toBe(0);
  });
});

describe("descricaoDoDia", () => {
  it("formata singular e plural, com o dia da semana e a data por extenso", () => {
    // Quinta-feira, 23 de março de 2026.
    const quinta = new Date(2026, 2, 19);
    expect(descricaoDoDia({ data: quinta, revisoes: 51 })).toBe("51 revisões em quinta-feira, 19 de março");
    expect(descricaoDoDia({ data: quinta, revisoes: 1 })).toBe("1 revisão em quinta-feira, 19 de março");
    expect(descricaoDoDia({ data: quinta, revisoes: 0 })).toBe("0 revisões em quinta-feira, 19 de março");
  });
});
