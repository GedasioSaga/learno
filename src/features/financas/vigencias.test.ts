import { describe, expect, it } from "vitest";
import type { VigenciaRow } from "./ipc";
import { descreverVigencia, ultimaVigencia, vigenciaNoMes } from "./vigencias";

function vigencia(inicioMes: string, fimMes: string | null, valorCentavos: number): VigenciaRow {
  return { id: inicioMes, recorrenteId: "r1", valorCentavos, inicioMes, fimMes, createdAt: "2026-09-01T00:00:00Z" };
}

const salario = [vigencia("2026-09", "2026-12", 410000), vigencia("2027-01", null, 438700)];

describe("vigenciaNoMes", () => {
  it("fim é inclusivo e a virada de ano troca de vigência", () => {
    expect(vigenciaNoMes(salario, "2026-12")?.valorCentavos).toBe(410000);
    expect(vigenciaNoMes(salario, "2027-01")?.valorCentavos).toBe(438700);
  });

  it("antes do início não há vigência", () => {
    expect(vigenciaNoMes(salario, "2026-08")).toBeNull();
  });

  it("vigência aberta vale para qualquer mês depois do início", () => {
    expect(vigenciaNoMes(salario, "2030-06")?.valorCentavos).toBe(438700);
  });

  it("depois de encerrado não há vigência", () => {
    const encerrado = [vigencia("2026-09", "2026-10", 9000)];
    expect(vigenciaNoMes(encerrado, "2026-11")).toBeNull();
  });
});

describe("ultimaVigencia e descreverVigencia", () => {
  it("lista vazia não inventa vigência", () => {
    expect(ultimaVigencia([])).toBeNull();
  });

  it("descreve período fechado e aberto", () => {
    const texto = (v: VigenciaRow) => descreverVigencia(v).replace(/ /g, " ");
    expect(texto(salario[0])).toBe("R$ 4.100,00 · set. de 26 → dez. de 26");
    expect(texto(salario[1])).toBe("R$ 4.387,00 · jan. de 27 em diante");
  });
});
