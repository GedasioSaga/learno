/**
 * `invoke` is mocked the way `src/features/pages/PageWorkspace.test.tsx`
 * mocks `../../lib/ipc` - `importOriginal` plus a `vi.fn()` override, so
 * every other export of `@tauri-apps/api/core` stays real.
 */
import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SyncedBlockError,
  countSyncedCopies,
  createSyncedBlockCopy,
  deleteSyncedOriginal,
  unsyncAllSyncedCopies,
  unsyncBlock,
} from "./synced-blocks-api";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: vi.fn() };
});

const invokeMock = vi.mocked(invoke);

afterEach(() => {
  invokeMock.mockReset();
});

describe("EDT-073: createSyncedBlockCopy", () => {
  it("chama create_synced_block_copy com sourceId e placement em camelCase", async () => {
    invokeMock.mockResolvedValue({ id: "copy-1", syncedSourceId: "origin-1" });

    const result = await createSyncedBlockCopy("origin-1", { pageId: "page-1", parentBlockId: null, afterBlockId: "a" });

    expect(invokeMock).toHaveBeenCalledWith("create_synced_block_copy", {
      sourceId: "origin-1",
      placement: { pageId: "page-1", parentBlockId: null, afterBlockId: "a" },
    });
    expect(result).toEqual({ id: "copy-1", syncedSourceId: "origin-1" });
  });
});

describe("EDT-073/078: countSyncedCopies", () => {
  it("chama count_synced_copies com o id e devolve o número", async () => {
    invokeMock.mockResolvedValue(3);

    const count = await countSyncedCopies("origin-1");

    expect(invokeMock).toHaveBeenCalledWith("count_synced_copies", { id: "origin-1" });
    expect(count).toBe(3);
  });
});

describe("EDT-076: unsyncBlock", () => {
  it("chama unsync_block com o id da cópia", async () => {
    invokeMock.mockResolvedValue({ id: "copy-1", syncedSourceId: null });

    await unsyncBlock("copy-1");

    expect(invokeMock).toHaveBeenCalledWith("unsync_block", { id: "copy-1" });
  });
});

describe("EDT-077: unsyncAllSyncedCopies", () => {
  it("chama unsync_all_synced_copies com o id do original", async () => {
    invokeMock.mockResolvedValue([{ id: "copy-1" }, { id: "copy-2" }]);

    const result = await unsyncAllSyncedCopies("origin-1");

    expect(invokeMock).toHaveBeenCalledWith("unsync_all_synced_copies", { id: "origin-1" });
    expect(result).toHaveLength(2);
  });
});

describe("EDT-078: deleteSyncedOriginal", () => {
  it("chama delete_synced_original com id e confirmed", async () => {
    invokeMock.mockResolvedValue(undefined);

    await deleteSyncedOriginal("origin-1", true);

    expect(invokeMock).toHaveBeenCalledWith("delete_synced_original", { id: "origin-1", confirmed: true });
  });

  it("um erro do backend (kind/message) vira SyncedBlockError com a mesma mensagem e kind", async () => {
    invokeMock.mockRejectedValue({
      kind: "invalid",
      message: "o bloco original tem 11 cópias vinculadas; confirme a exclusão para apagar todas junto com o original",
    });

    await expect(deleteSyncedOriginal("origin-1", false)).rejects.toMatchObject({
      name: "SyncedBlockError",
      kind: "invalid",
      message: expect.stringContaining("11 cópias"),
    });
    await expect(deleteSyncedOriginal("origin-1", false)).rejects.toBeInstanceOf(SyncedBlockError);
  });

  it("um erro que não tem a forma kind/message atravessa sem ser embrulhado", async () => {
    const raw = new Error("falha de rede genérica");
    invokeMock.mockRejectedValue(raw);

    await expect(deleteSyncedOriginal("origin-1", false)).rejects.toBe(raw);
  });
});
