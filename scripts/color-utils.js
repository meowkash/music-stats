/** Shared surface-tint defaults — keep in sync with src/utils/colorSurface.ts */
export const OVERLAY_SCRIM = { r: 10, g: 10, b: 15 };
export const OVERLAY_SCRIM_ALPHA = 0.95;
export const BOTTOM_COLOR_VERSION = 2;

export const SURFACE_TINT_DEFAULTS = {
  targetLightness: 0.07,
  maxSaturation: 0.8,
  tintWeight: 1,
};

export function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return { h: h * 360, s, l };
}

export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  h /= 360;

  let r;
  let g;
  let b;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

export function compositeScrim(src, alpha = OVERLAY_SCRIM_ALPHA) {
  const inv = 1 - alpha;
  return {
    r: Math.round(src.r * inv + OVERLAY_SCRIM.r * alpha),
    g: Math.round(src.g * inv + OVERLAY_SCRIM.g * alpha),
    b: Math.round(src.b * inv + OVERLAY_SCRIM.b * alpha),
  };
}

export function toDarkSurfaceTint(sourceRgb, opts = {}) {
  const {
    targetLightness = SURFACE_TINT_DEFAULTS.targetLightness,
    maxSaturation = SURFACE_TINT_DEFAULTS.maxSaturation,
    tintWeight = SURFACE_TINT_DEFAULTS.tintWeight,
  } = opts;

  const hsl = rgbToHsl(sourceRgb.r, sourceRgb.g, sourceRgb.b);
  const tinted = hslToRgb(hsl.h, Math.min(hsl.s, maxSaturation), targetLightness);
  const scrimComposite = compositeScrim(sourceRgb);

  const keep = 1 - tintWeight;
  return {
    r: Math.round(scrimComposite.r * keep + tinted.r * tintWeight),
    g: Math.round(scrimComposite.g * keep + tinted.g * tintWeight),
    b: Math.round(scrimComposite.b * keep + tinted.b * tintWeight),
  };
}

export function extractBottomSurfaceColor(sourceRgb) {
  if (!sourceRgb) return { ...OVERLAY_SCRIM };
  return toDarkSurfaceTint(sourceRgb);
}
