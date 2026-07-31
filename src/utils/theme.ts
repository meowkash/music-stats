import type { CategoryTab } from '../types/music';

export function getCategoryAccent(category: string): { color: string; glow: string } {
  switch (category) {
    case 'artists':
      return { color: 'var(--accent-cat-artists)', glow: 'var(--accent-cat-artists-glow)' };
    case 'albums':
      return { color: 'var(--accent-cat-albums)', glow: 'var(--accent-cat-albums-glow)' };
    case 'tracks':
    case 'songs':
      return { color: 'var(--accent-cat-songs)', glow: 'var(--accent-cat-songs-glow)' };
    default:
      return { color: 'rgba(255,255,255,0.25)', glow: 'rgba(0,0,0,0.4)' };
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
