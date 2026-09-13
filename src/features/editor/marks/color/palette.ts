/**
 * The small named palette `ColorMenuButton` renders (EDT-040/041): the app's
 * own brand colors plus red/yellow/blue/green, exactly what the task asks
 * for - not a full color wheel, which would stop being "pequena e legível".
 *
 * Every `value` below is `color-mix()` against a theme token, not a literal
 * hex - see the "Matizes" block in `theme.css` for why. Brand hues (amber,
 * mint, emerald, terracotta) mix the brand token itself (`var(--amber)`
 * etc. - already documented in theme.css as contrast-safe); the four extra
 * hues that have no brand token (red/yellow/blue/green) mix the matching
 * `--matiz-*` token instead. Either way the mix is what makes this
 * theme-aware automatically: five themes, zero hardcoded hex per theme.
 *
 * Text `value`s mix mostly hue with a little `--ink` (70/30) so the result
 * self-adjusts toward the active theme's text color - dark ink pulls a hue
 * darker on Papel, light ink pulls it lighter on the four dark themes.
 * Highlight `value`s mix a lighter dose of hue with `--surface` (30/70) so
 * the wash blends with whatever surface color the current theme renders
 * instead of a hardcoded light-mode pastel that would go muddy in the dark.
 *
 * IMPORTANT - persisted data: `value` is stored verbatim as the mark's
 * `color` attr inside the user's document (ColorMenuButton passes it
 * straight to `setColor`/`setHighlight`). Changing a `value` here does NOT
 * change text/highlights already saved with the old literal hex - those
 * marks still carry that exact string and still render it exactly as
 * before (a CSS color string doesn't stop being valid because the palette
 * moved on). That's intentional and covered by `register.test.ts`: new
 * marks pick up the new theme-aware value, old marks keep rendering their
 * old literal color. Neither is a bug; don't "fix" old documents to match.
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
  { id: "red", label: "Vermelho", value: "color-mix(in srgb, var(--matiz-vermelho) 70%, var(--ink))" },
  { id: "yellow", label: "Amarelo", value: "color-mix(in srgb, var(--matiz-amarelo) 70%, var(--ink))" },
  { id: "blue", label: "Azul", value: "color-mix(in srgb, var(--matiz-azul) 70%, var(--ink))" },
  { id: "green", label: "Verde", value: "color-mix(in srgb, var(--matiz-verde) 70%, var(--ink))" },
  { id: "amber", label: "Âmbar", value: "var(--amber-ink)" },
  { id: "mint", label: "Menta", value: "var(--mint-ink)" },
  { id: "emerald", label: "Esmeralda", value: "var(--emerald)" },
  { id: "terracotta", label: "Terracota", value: "var(--terracotta-ink)" },
];

export const HIGHLIGHT_COLORS: NamedColor[] = [
  { id: "red", label: "Vermelho", value: "color-mix(in srgb, var(--matiz-vermelho) 30%, var(--surface))" },
  { id: "yellow", label: "Amarelo", value: "color-mix(in srgb, var(--matiz-amarelo) 30%, var(--surface))" },
  { id: "blue", label: "Azul", value: "color-mix(in srgb, var(--matiz-azul) 30%, var(--surface))" },
  { id: "green", label: "Verde", value: "color-mix(in srgb, var(--matiz-verde) 30%, var(--surface))" },
  { id: "amber", label: "Âmbar", value: "color-mix(in srgb, var(--amber) 30%, var(--surface))" },
  { id: "mint", label: "Menta", value: "color-mix(in srgb, var(--mint) 30%, var(--surface))" },
  { id: "emerald", label: "Esmeralda", value: "color-mix(in srgb, var(--emerald) 30%, var(--surface))" },
  { id: "terracotta", label: "Terracota", value: "color-mix(in srgb, var(--terracotta) 30%, var(--surface))" },
];
