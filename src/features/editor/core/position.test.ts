import { describe, expect, it } from "vitest";
import { midpointPosition } from "./position";

describe("midpointPosition", () => {
  it("orders a run of appended positions increasingly", () => {
    let position: string | null = null;
    const sequence: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      position = midpointPosition(position, null);
      sequence.push(position);
    }
    for (let i = 1; i < sequence.length; i += 1) {
      expect(sequence[i] > sequence[i - 1]).toBe(true);
    }
  });

  it("inserts strictly between two existing positions", () => {
    const first = midpointPosition(null, null);
    const last = midpointPosition(first, null);
    const middle = midpointPosition(first, last);
    expect(middle > first).toBe(true);
    expect(middle < last).toBe(true);
  });

  it("keeps producing a distinct value even between adjacent-looking positions", () => {
    // Repeatedly halving the same gap must never collide - this is the case
    // that breaks a naive "average the two strings" implementation.
    let low = midpointPosition(null, null);
    let high = midpointPosition(low, null);
    for (let i = 0; i < 30; i += 1) {
      const mid = midpointPosition(low, high);
      expect(mid > low).toBe(true);
      expect(mid < high).toBe(true);
      high = mid;
    }
  });

  it("rejects a range where `before` does not sort earlier than `after`", () => {
    const a = midpointPosition(null, null);
    expect(() => midpointPosition(a, a)).toThrow();
  });
});
