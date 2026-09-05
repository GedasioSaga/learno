/**
 * `parseInstantToLocalDateValue`/`formatTimestampPlainText` isoladas de
 * `PropertySpec`/React — a metade pura de DBS-024/026. O teste de
 * round-trip (construir com campos LOCAIS, converter para o instante RFC3339
 * que `pages.created_at` mandaria, reconverter) deixa a asserção
 * independente do fuso horário da máquina que roda o teste: os campos
 * locais de saída têm que bater com os de entrada não importa o offset.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMESTAMP_CONFIG,
  formatTimestampPlainText,
  isCorruptedTimestampValue,
  parseInstantToLocalDateValue,
} from "./format";

describe("parseInstantToLocalDateValue", () => {
  it("converte um instante RFC3339 para a hora local de parede, largura fixa de I5 (round-trip independente de fuso)", () => {
    const wallClock = new Date(2026, 2, 15, 10, 30); // 15/03/2026 10:30 na hora local desta máquina
    const instant = wallClock.toISOString(); // o formato que chrono::DateTime<Utc> manda pela borda
    expect(parseInstantToLocalDateValue(instant)).toEqual({ start: "2026-03-15T10:30" });
  });

  it("faz zero-padding de mês/dia/hora/minuto de um dígito só", () => {
    const wallClock = new Date(2026, 0, 5, 9, 5); // 05/01/2026 09:05
    expect(parseInstantToLocalDateValue(wallClock.toISOString())).toEqual({ start: "2026-01-05T09:05" });
  });

  it("instante corrompido/ausente vira o sentinela vazio, nunca lança (PropertySpec.parse é TOTAL)", () => {
    expect(parseInstantToLocalDateValue("não é uma data")).toEqual({ start: "" });
    expect(parseInstantToLocalDateValue(undefined)).toEqual({ start: "" });
    expect(parseInstantToLocalDateValue(null)).toEqual({ start: "" });
    expect(parseInstantToLocalDateValue("")).toEqual({ start: "" });
  });
});

describe("isCorruptedTimestampValue", () => {
  it("só o sentinela `start: \"\"` conta como corrompido", () => {
    expect(isCorruptedTimestampValue({ start: "" })).toBe(true);
    expect(isCorruptedTimestampValue({ start: "2026-03-15T10:30" })).toBe(false);
  });
});

describe("formatTimestampPlainText", () => {
  const value = { start: "2026-03-15T10:30" };

  it("com includeTime, mostra data e hora em DD/MM/AAAA HH:mm", () => {
    expect(formatTimestampPlainText(value, { includeTime: true })).toBe("15/03/2026 10:30");
  });

  it("sem includeTime, mostra só a data", () => {
    expect(formatTimestampPlainText(value, { includeTime: false })).toBe("15/03/2026");
  });

  it("respeita a config padrão (includeTime: true)", () => {
    expect(formatTimestampPlainText(value, DEFAULT_TIMESTAMP_CONFIG)).toBe("15/03/2026 10:30");
  });

  it("valor corrompido formata como string vazia, nunca lança", () => {
    expect(formatTimestampPlainText({ start: "" }, DEFAULT_TIMESTAMP_CONFIG)).toBe("");
  });
});
