import type { CategoryTab } from '../types/music';

/**
 * Absolute colours (not `var()`) so animations can interpolate them.
 * Keep in sync with the --accent-cat-* tokens in Layout.astro.
 */
export function getCategoryAccent(category: string): { color: string; glow: string } {
  switch (category) {
    case 'artists':
      return { color: '#f97316', glow: 'rgba(249, 115, 22, 0.4)' };
    case 'albums':
      return { color: '#10b981', glow: 'rgba(16, 185, 129, 0.4)' };
    case 'tracks':
    case 'songs':
      return { color: '#3b82f6', glow: 'rgba(59, 130, 246, 0.4)' };
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
