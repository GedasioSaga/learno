/**
 * `crypto.randomUUID()` is what the real backend also uses for `BlockId`
 * (contract.ts: "Server-generated UUID"). The editor mints ids client-side
 * the instant a node is created (typing, input rule, Enter, Tab) rather than
 * waiting on a round trip - `apply_block_changes` treats an id it has never
 * seen as a create, so the id only needs to be unique, not server-issued.
 */
export function newBlockId(): string {
  return crypto.randomUUID();
}
