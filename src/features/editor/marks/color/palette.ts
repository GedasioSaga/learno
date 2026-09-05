/**
 * The small named palette `ColorMenuButton` renders (EDT-040/041): the app's
 * own brand colors plus red/yellow/blue/green, exactly what the task asks
 * for - not a full color wheel, which would stop being "pequena e legível".
 *
 * Text-color `value`s use each color's "-ink" variant (theme.css) where one
 * exists - those are the ones theme.css itself documents as contrast-safe
 * for text, unlike the plain `--amber`/`--terracotta` swatches meant for
 * icons/borders. The four extra hues (red/yellow/blue/green) aren't in the
 * theme, so they're picked at a darkened, ~4.5:1-on-paper shade by hand.
 *
 * Highlight `value`s are the same hues at partial alpha (8-digit hex) so the
 * swatch (and the mark it produces) blends with whatever surface color the
 * current theme renders - light or dark - instead of a hardcoded light-mode
 * pastel that would go muddy against a dark background.
 */
export interface NamedColor {
  /** Stable id for the swatch's React key - not persisted anywhere. */
  id: string;
  /** Shown nowhere but the swatch's `aria-label` - a swatch alone is color-only information. */
  label: string;
  /** Passed straight to `setColor`/`setHighlight` and stored as the mark's `color` attr. */
  value: string;
}

export const TEXT_COLORS: NamedColor[] = [
  { id: "red", label: "Vermelho", value: "#b3261e" },
  { id: "yellow", label: "Amarelo", value: "#8a6d1a" },
  { id: "blue", label: "Azul", value: "#1d4ed8" },
  { id: "green", label: "Verde", value: "#15803d" },
  { id: "amber", label: "Âmbar", value: "var(--amber-ink)" },
  { id: "mint", label: "Menta", value: "var(--mint-ink)" },
  { id: "emerald", label: "Esmeralda", value: "var(--emerald)" },
  { id: "terracotta", label: "Terracota", value: "var(--terracotta-ink)" },
];

export const HIGHLIGHT_COLORS: NamedColor[] = [
  { id: "red", label: "Vermelho", value: "#dc262666" },
  { id: "yellow", label: "Amarelo", value: "#eab30866" },
  { id: "blue", label: "Azul", value: "#3b82f666" },
  { id: "green", label: "Verde", value: "#22c55e66" },
  { id: "amber", label: "Âmbar", value: "#d6943666" },
  { id: "mint", label: "Menta", value: "#59d68a66" },
  { id: "emerald", label: "Esmeralda", value: "#0d564d66" },
  { id: "terracotta", label: "Terracota", value: "#9f582e66" },
];
