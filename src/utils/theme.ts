// Absolute colours (not `var()`) so animations can interpolate them.
// Keep in sync with the --accent-cat-* tokens in Layout.astro.
export function getCategoryAccent(category: string): { color: string; glow: string } {
  switch (category) {
    case 'artists':
    case 'albums':
    case 'tracks':
    case 'songs':
      return { color: '#14a3b4', glow: 'rgba(20, 163, 180, 0.45)' };
    default:
      return { color: 'rgba(255, 255, 255, 0.25)', glow: 'rgba(0, 0, 0, 0.4)' };
  }
}

export function getGlowStyle(
  rgb: { r: number; g: number; b: number },
  options?: { blur?: number; alpha?: number; weight?: number },
): string {
  const blur = options?.blur ?? 10;
  const alpha = options?.alpha ?? 0.5;
  const weight = options?.weight ?? 700;
  return `color: rgb(${rgb.r}, ${rgb.g}, ${rgb.b}); text-shadow: 0 0 ${blur}px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha}); font-weight: ${weight};`;
}
