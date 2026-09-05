/**
 * EDT-073's persistence contract for the indicator: a role declared for a
 * block id survives being read back (this is what stands in for a page
 * reload, since `localStorage` is exactly what would still be there after
 * one - see `synced-decorations.ts`'s doc comment for why this cache exists
 * at all).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  allKnownSyncedIds,
  getCachedCopyCount,
  groupIdOf,
  isSynced,
  markSynced,
  resetSyncedStoreForTests,
  roleOf,
  setCachedCopyCount,
  siblingsInGroup,
  unmarkGroup,
  unmarkSynced,
} from "./synced-store";

beforeEach(() => {
  resetSyncedStoreForTests();
});

describe("EDT-073: marcar um bloco como sincronizado", () => {
  it("um bloco recém marcado é reconhecido como sincronizado, com o papel certo", () => {
    markSynced("origin-1", "origin", "origin-1");

    expect(isSynced("origin-1")).toBe(true);
    expect(roleOf("origin-1")).toBe("origin");
    expect(groupIdOf("origin-1")).toBe("origin-1");
    expect(allKnownSyncedIds().has("origin-1")).toBe(true);
  });

  it("um bloco nunca marcado não é sincronizado", () => {
    expect(isSynced("nunca-visto")).toBe(false);
    expect(roleOf("nunca-visto")).toBeNull();
  });
});

describe("EDT-076: desvincular uma cópia isolada", () => {
  it("remove só o id desvinculado, mantendo o grupo intacto para os demais", () => {
    markSynced("origin-1", "origin", "origin-1");
    markSynced("copy-a", "copy", "origin-1");
    markSynced("copy-b", "copy", "origin-1");

    unmarkSynced("copy-a");

    expect(isSynced("copy-a")).toBe(false);
    expect(isSynced("copy-b")).toBe(true);
    expect(isSynced("origin-1")).toBe(true);
  });
});

describe("EDT-077: desvincular todas as cópias de um original", () => {
  it("unmarkGroup apaga o original e toda cópia que compartilha o groupId", () => {
    markSynced("origin-1", "origin", "origin-1");
    markSynced("copy-a", "copy", "origin-1");
    markSynced("copy-b", "copy", "origin-1");
    markSynced("outro-origem", "origin", "outro-origem"); // grupo diferente, não deve ser afetado

    unmarkGroup("origin-1");

    expect(isSynced("origin-1")).toBe(false);
    expect(isSynced("copy-a")).toBe(false);
    expect(isSynced("copy-b")).toBe(false);
    expect(isSynced("outro-origem")).toBe(true);
  });
});

describe("siblingsInGroup", () => {
  it("lista todo outro id do mesmo grupo, o próprio id excluído", () => {
    markSynced("origin-1", "origin", "origin-1");
    markSynced("copy-a", "copy", "origin-1");
    markSynced("copy-b", "copy", "origin-1");

    expect(siblingsInGroup("copy-a").sort()).toEqual(["copy-b", "origin-1"]);
  });

  it("um id sem grupo (nunca marcado) não tem irmãos", () => {
    expect(siblingsInGroup("solto")).toEqual([]);
  });
});

describe("EDT-078: cache de count_synced_copies", () => {
  it("guarda e devolve a última contagem conhecida, null antes de qualquer consulta", () => {
    expect(getCachedCopyCount("origin-1")).toBeNull();

    setCachedCopyCount("origin-1", 11);

    expect(getCachedCopyCount("origin-1")).toBe(11);
  });
});
