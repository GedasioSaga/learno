/**
 * Fractional-index string ordering for the local stub backend
 * (`blocks-api.ts`) - `Block.position` (contract.ts) is opaque to everyone
 * but whoever assigns it, compared only with `<`/`>` (see `PageRow.position`
 * and `tree-utils.ts`'s `comparePosition` for the same convention on
 * pages). The real backend will assign its own values once
 * `list_page_blocks`/`create_block` exist; this only has to be internally
 * consistent, not match whatever scheme `src-tauri/src/db/position.rs` uses.
 */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * A position string that sorts strictly between `before` and `after`
 * (either may be omitted for "start of the list" / "end of the list").
 * Throws if `before` does not already sort earlier than `after` - that's a
 * caller bug (stale sibling order), not a case to paper over.
 */
export function midpointPosition(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) {
    throw new Error(`midpointPosition: "${before}" must sort before "${after}"`);
  }

  let result = "";
  for (let i = 0; ; i += 1) {
    const lowDigit = before !== null && i < before.length ? ALPHABET.indexOf(before[i]) : 0;
    const highDigit = after !== null && i < after.length ? ALPHABET.indexOf(after[i]) : ALPHABET.length;

    if (highDigit - lowDigit > 1) {
      const midDigit = lowDigit + Math.floor((highDigit - lowDigit) / 2);
      return result + ALPHABET[midDigit];
    }

    // Digits tie or are adjacent at this depth: carry it forward and go one
    // digit deeper to find room. `before`/`after` are finite strings and
    // ALPHABET always leaves room within a few extra digits, so this
    // terminates in practice; the cap only guards a caller bug upstream.
    result += ALPHABET[lowDigit];
    if (i > 500) return result + ALPHABET[Math.floor(ALPHABET.length / 2)];
  }
}
