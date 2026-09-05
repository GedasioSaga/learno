import { describe, expect, it } from "vitest";
import { formatFixedWidthIso, ISO_DATE_VALUE_PATTERN, parseFixedWidthIso } from "./date-iso";

describe("ISO_DATE_VALUE_PATTERN — espelho de chk_drv_iso_date_shape", () => {
  it("aceita dia solto e dia+hora", () => {
    expect(ISO_DATE_VALUE_PATTERN.test("2026-03-15")).toBe(true);
    expect(ISO_DATE_VALUE_PATTERN.test("2026-03-15T14:30")).toBe(true);
  });

  it("rejeita segundos, fuso e formato brasileiro (I5: sem fuso, sem segundos)", () => {
    expect(ISO_DATE_VALUE_PATTERN.test("2026-03-15T14:30:00")).toBe(false);
    expect(ISO_DATE_VALUE_PATTERN.test("2026-03-15T14:30Z")).toBe(false);
    expect(ISO_DATE_VALUE_PATTERN.test("2026-03-15T14:30-03:00")).toBe(false);
    expect(ISO_DATE_VALUE_PATTERN.test("15/03/2026")).toBe(false);
  });
});

describe("parseFixedWidthIso", () => {
  it("dia solto vira meia-noite local, hasTime false", () => {
    const parsed = parseFixedWidthIso("2026-03-15");
    expect(parsed).not.toBeNull();
    expect(parsed?.hasTime).toBe(false);
    expect(parsed?.date.getFullYear()).toBe(2026);
    expect(parsed?.date.getMonth()).toBe(2);
    expect(parsed?.date.getDate()).toBe(15);
    expect(parsed?.date.getHours()).toBe(0);
  });

  it("dia+hora preserva a hora local de parede — o Calendário (DBS-012) depende disto para posicionar o registro", () => {
    const parsed = parseFixedWidthIso("2026-03-15T14:30");
    expect(parsed?.hasTime).toBe(true);
    expect(parsed?.date.getHours()).toBe(14);
    expect(parsed?.date.getMinutes()).toBe(30);
  });

  it("TOTAL: texto fora da forma nunca lança, devolve null", () => {
    expect(parseFixedWidthIso("não é uma data")).toBeNull();
    expect(parseFixedWidthIso("")).toBeNull();
    expect(parseFixedWidthIso("2026-03-15T14:30:00Z")).toBeNull();
  });

  it("TOTAL: uma data de calendário que não existe não vira outra data por engano (Date normalizaria 2026-02-30 para 2 de março)", () => {
    expect(parseFixedWidthIso("2026-02-30")).toBeNull();
    expect(parseFixedWidthIso("2026-13-01")).toBeNull();
  });
});

describe("formatFixedWidthIso — o inverso, para a Trilha/Calendário escreverem de volta", () => {
  it("zero-padding e largura fixa (I5), dia solto", () => {
    expect(formatFixedWidthIso(new Date(2026, 2, 5, 9, 7), false)).toBe("2026-03-05");
  });

  it("dia+hora", () => {
    expect(formatFixedWidthIso(new Date(2026, 2, 5, 9, 7), true)).toBe("2026-03-05T09:07");
  });

  it("é o inverso exato de parseFixedWidthIso para os dois casos", () => {
    for (const iso of ["2026-01-01", "2026-12-31T23:59"]) {
      const parsed = parseFixedWidthIso(iso);
      expect(parsed).not.toBeNull();
      if (parsed) expect(formatFixedWidthIso(parsed.date, parsed.hasTime)).toBe(iso);
    }
  });
});
