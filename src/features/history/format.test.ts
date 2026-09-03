import { describe, expect, it } from "vitest";
import { formatSnapshotTimestamp, snapshotReasonLabel } from "./format";

describe("snapshotReasonLabel", () => {
  it("traduz os três motivos possíveis de um snapshot", () => {
    expect(snapshotReasonLabel("autosave")).toBe("Salvo automaticamente");
    expect(snapshotReasonLabel("manual")).toBe("Salvo manualmente");
    expect(snapshotReasonLabel("restore")).toBe("Restauração de versão anterior");
  });
});

describe("formatSnapshotTimestamp", () => {
  it("formata um ISO 8601 válido como data e hora legíveis", () => {
    const formatted = formatSnapshotTimestamp("2026-08-20T14:05:30Z");
    expect(formatted).toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(formatted).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("devolve o texto original em vez de 'Invalid Date' para uma entrada não parseável", () => {
    expect(formatSnapshotTimestamp("não é uma data")).toBe("não é uma data");
  });
});
