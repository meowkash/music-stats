// Consecutive years step 47° around the wheel: coprime enough that no hue nears
// a repeat for eight years and no two adjacent years share a band.

const HUE_STEP = 47;
const HUE_ANCHOR = 20;

export interface RecapTheme {
  /** Bare number (no unit) so CSS can do `hsl(calc(var(--year-hue) + 40) …)`. */
  hue: number;
  base: string;
  accent: string;
  deep: string;
  glow: string;
}

// Yellows read far lighter than blues at equal HSL lightness, so each band gets
// a correction; without it the yellow years looked washed out.
function lightnessFor(hue: number): number {
  if (hue >= 40 && hue < 75) return 47; // yellow / gold
  if (hue >= 75 && hue < 160) return 45; // green
  if (hue >= 160 && hue < 200) return 48; // cyan
  if (hue >= 200 && hue < 265) return 58; // blue / indigo
  return 55; // red, magenta, violet
}

export function recapHue(year: number): number {
  // JS `%` keeps the sign of the dividend; years are positive, but the extra
  // normalisation keeps this honest if that ever changes.
  return (((year * HUE_STEP + HUE_ANCHOR) % 360) + 360) % 360;
}

export function recapTheme(year: number): RecapTheme {
  const hue = recapHue(year);
  const light = lightnessFor(hue);
  // The accent sits a third of the way toward the next year's hue: close
  // enough to harmonise, far enough to read as a second colour in gradients.
  const accentHue = (hue + 32) % 360;

  return {
    hue,
    base: `hsl(${hue} 88% ${light}%)`,
    accent: `hsl(${accentHue} 92% ${Math.min(light + 6, 66)}%)`,
    deep: `hsl(${hue} 62% 11%)`,
    glow: `hsl(${hue} 90% ${light}% / 0.45)`,
  };
}

/** Inline `style` payload that exposes the palette to CSS. */
export function recapThemeVars(year: number): string {
  const theme = recapTheme(year);
  return [
    `--year-hue:${theme.hue}`,
    `--year-base:${theme.base}`,
    `--year-accent:${theme.accent}`,
    `--year-deep:${theme.deep}`,
    `--year-glow:${theme.glow}`,
  ].join(';');
}

/** Applies the palette to an element (the story stage, the picker card…). */
export function applyRecapTheme(el: HTMLElement, year: number): void {
  const theme = recapTheme(year);
  el.style.setProperty('--year-hue', String(theme.hue));
  el.style.setProperty('--year-base', theme.base);
  el.style.setProperty('--year-accent', theme.accent);
  el.style.setProperty('--year-deep', theme.deep);
  el.style.setProperty('--year-glow', theme.glow);
}
