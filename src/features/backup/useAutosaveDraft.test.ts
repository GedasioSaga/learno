import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAutosaveDraft } from "./useAutosaveDraft";
import { autosaveClearPending, autosaveWritePending } from "../../lib/ipc";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    autosaveWritePending: vi.fn(),
    autosaveClearPending: vi.fn(),
  };
});

const writeMock = vi.mocked(autosaveWritePending);
const clearMock = vi.mocked(autosaveClearPending);

beforeEach(() => {
  vi.useFakeTimers();
  writeMock.mockReset();
  clearMock.mockReset();
  writeMock.mockResolvedValue(undefined);
  clearMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAutosaveDraft", () => {
  it("grava o rascunho só depois do intervalo de debounce, não a cada chamada", () => {
    const { result } = renderHook(() => useAutosaveDraft("page-1"));

    result.current.saveDraft("Título", { text: "a" });
    expect(writeMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2999);
    expect(writeMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(writeMock).toHaveBeenCalledWith("page-1", "Título", { text: "a" });
    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it("uma chamada nova reinicia o debounce em vez de acumular escritas", () => {
    const { result } = renderHook(() => useAutosaveDraft("page-1"));

    result.current.saveDraft("Título", { text: "a" });
    vi.advanceTimersByTime(1500);
    result.current.saveDraft("Título", { text: "ab" });
    vi.advanceTimersByTime(1500);
    expect(writeMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1500);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith("page-1", "Título", { text: "ab" });
  });

  it("clearDraft cancela uma escrita pendente e chama autosaveClearPending", async () => {
    const { result } = renderHook(() => useAutosaveDraft("page-1"));

    result.current.saveDraft("Título", { text: "a" });
    await result.current.clearDraft();

    vi.advanceTimersByTime(5000);
    expect(writeMock).not.toHaveBeenCalled();
    expect(clearMock).toHaveBeenCalledWith("page-1");
  });

  it("sem página ativa (pageId null), nada é gravado", () => {
    const { result } = renderHook(() => useAutosaveDraft(null));

    result.current.saveDraft("Título", { text: "a" });
    vi.advanceTimersByTime(5000);

    expect(writeMock).not.toHaveBeenCalled();
  });
});
