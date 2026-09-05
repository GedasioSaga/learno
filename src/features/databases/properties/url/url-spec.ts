/**
 * DBS-018 — URL: texto validado como link, clicável para abrir no navegador
 * padrão em vez de entrar em edição. `parseSafeUrl`/`openBookmarkUrl` são os
 * MESMOS do bloco de bookmark (`editor/blocks/bookmark/`) — arquitetura §6
 * nomeia esse arquivo como quem já resolveu "por que não âncora nativa
 * dentro do Tauri" (o repo tinha dois padrões divergentes, EDT-027; esta
 * fase escolhe o do bookmark). Reusar em vez de reescrever evita um
 * TERCEIRO padrão de "abrir link" no mesmo repositório.
 *
 * A recusa de esquema (só http:/https:) acontece no CLIQUE
 * (`parseSafeUrl`/`openBookmarkUrl`, já testados em
 * `editor/blocks/bookmark/*.test.ts`), não na gravação: uma URL digitada
 * pela metade ("http") ainda não é um esquema hostil, só incompleta — barrar
 * na escrita apagaria o que o usuário está no meio de digitar.
 */
import type { PropertySpec } from "../../core/property-spec";
import { UrlCellEditor, UrlCellValue } from "./url-cell";

/** Sem opções nesta fase — DBS-018 não pede configuração de exibição. */
export type UrlConfig = Record<string, never>;

/** `TValue = string | null`: o texto cru digitado, nunca um `URL` já parseado — a validação de esquema é só do lado de abrir (ver o cabeçalho). */
export type UrlValue = string | null;

export const urlPropertySpec: PropertySpec<UrlValue, UrlConfig> = {
  type: "url",
  label: "URL",
  icon: "🔗",
  valueShape: "text",
  defaultConfig: {},

  isEmpty: (value) => typeof value !== "string" || value.length === 0,
  // I1: string vazia (ou não-string) apaga a linha — texto só de espaços
  // também, para não gravar um valor que renderiza como célula em branco.
  normalize: (value) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  },
  // TOTAL: qualquer coisa que não seja string vira vazio — nunca lança.
  parse: (raw) => (typeof raw === "string" && raw.length > 0 ? raw : null),
  serialize: (value) => value,

  renderValue: (ctx) => UrlCellValue(ctx),
  renderEditor: (ctx) => UrlCellEditor(ctx),

  filterOperators: ["is", "isNot", "contains", "doesNotContain", "startsWith", "endsWith", "isEmpty", "isNotEmpty"],
  sort: "text",
  aggregations: ["count_all", "count_values", "count_unique", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty"],

  toPlainText: (value) => value ?? "",
  parsePlainText: (text) => {
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  },
};
