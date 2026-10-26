// Liquid-glass optics for the lifted lens on the nav bar and segmented
// controls. Real backdrop refraction (`backdrop-filter: url()`) is ignored by
// WebKit and SVG feImage maps are unreliable there, so the lens carries its own
// copy of the buttons it slides over and refracts that with transforms only.
// Concentric bands step the magnification from strongly minified at the rim
// (the edge pulls in what lies well past the glass) up to strongly magnified
// at the centre, approximating one continuous convex surface. The real
// buttons get a lens-shaped hole while the lens covers them, so nothing is
// seen twice. At rest none of this exists in the render tree.

import type { PillPose } from './slidingHighlight';

export interface LensBand {
  /** Band width, as a fraction of the lens's unscaled height. */
  width: number;
  /** Magnification through this band; below 1 compresses the surroundings. */
  magnify: number;
}

export interface LensProfile {
  /** Magnification through the core of the lens. */
  magnify: number;
  /** Rings from the rim inward, each refracting more gently than the last. */
  bands: LensBand[];
  /** Main-axis stretch per px/ms of lens speed, and its ceiling. */
  stretchPerSpeed: number;
  maxStretch: number;
}

// iOS 26 magnifies what sits under a lifted lens by ~1.18 (measured) and
// pulls the lens into a wide capsule while it travels.
export const NAV_LENS: LensProfile = {
  magnify: 1.18,
  stretchPerSpeed: 0.3,
  maxStretch: 0.45,
  bands: [
    { width: 0.04, magnify: 0.4 },
    { width: 0.045, magnify: 0.68 },
    { width: 0.05, magnify: 0.96 },
    { width: 0.05, magnify: 1.16 },
  ],
};
// A lifted segment barely enlarges its label (Health app): the effect is in
// the rim, not the core.
export const SEGMENT_LENS: LensProfile = {
  magnify: 1.08,
  stretchPerSpeed: 0.26,
  maxStretch: 0.4,
  bands: [
    { width: 0.05, magnify: 0.5 },
    { width: 0.05, magnify: 0.76 },
    { width: 0.06, magnify: 1.04 },
  ],
};

/** Specular glint travel per px/ms, as a % of lens width. */
const GLINT_PER_SPEED = 14;

// Enough to rebuild a button's look without its classes, so the copies can't
// be picked up by `.range-btn.active`-style queries elsewhere in the app.
const COPIED = [
  'display', 'flex-direction', 'align-items', 'justify-content', 'gap', 'box-sizing',
  'width', 'height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'background-color', 'background-image', 'box-shadow', 'color', 'opacity',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant-numeric',
  'font-variant-ligatures', 'font-feature-settings', 'font-variation-settings', 'font-kerning',
  'font-optical-sizing', 'text-rendering', '-webkit-font-smoothing', 'word-spacing', 'line-height',
  'letter-spacing', 'text-transform', 'text-align', 'text-shadow', 'white-space', 'overflow',
  'text-overflow', 'flex-shrink', 'fill', 'stroke', 'stroke-width',
] as const;

function copyLook(source: Element, target: HTMLElement | SVGElement, rootColor?: string) {
  const computed = getComputedStyle(source);
  for (const prop of COPIED) {
    const value = computed.getPropertyValue(prop);
    // Whatever took the button's own colour keeps following it, so one
    // colour on the copy recolours its icon and label together.
    if (rootColor && (prop === 'color' || prop === 'fill' || prop === 'stroke') && value === rootColor) {
      target.style.setProperty(prop, prop === 'color' ? 'inherit' : 'currentColor');
      continue;
    }
    target.style.setProperty(prop, value);
  }
  target.style.margin = '0';
  target.removeAttribute('id');
  target.removeAttribute('class');
  for (const attr of [...target.attributes]) {
    if (attr.name.startsWith('data-') || attr.name.startsWith('aria-')) target.removeAttribute(attr.name);
  }
}

function snapshot(button: HTMLElement, rect: PillPose['rect']): HTMLElement {
  const copy = button.cloneNode(true) as HTMLElement;
  const sources = [button, ...button.querySelectorAll('*')];
  const targets = [copy, ...copy.querySelectorAll('*')] as (HTMLElement | SVGElement)[];
  const rootColor = getComputedStyle(button).color;
  sources.forEach((source, i) => copyLook(source, targets[i], i === 0 ? undefined : rootColor));
  copy.removeAttribute('type');
  copy.tabIndex = -1;
  Object.assign(copy.style, {
    position: 'absolute',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    transform: 'none',
    transition: 'none',
    pointerEvents: 'none',
    // Labels are one line; sub-pixel metric drift must not wrap the copy.
    whiteSpace: 'nowrap',
  });
  return copy;
}

/** A stadium (or rounded rect) as path data, with independent x/y radii so a
 *  jelly-stretched lens keeps its exact outline. */
function roundedRect(l: number, t: number, w: number, h: number, rx: number, ry: number): string {
  const r = l + w;
  const b = t + h;
  const f = (n: number) => n.toFixed(1);
  return (
    `M${f(l + rx)} ${f(t)}H${f(r - rx)}A${f(rx)} ${f(ry)} 0 0 1 ${f(r)} ${f(t + ry)}` +
    `V${f(b - ry)}A${f(rx)} ${f(ry)} 0 0 1 ${f(r - rx)} ${f(b)}` +
    `H${f(l + rx)}A${f(rx)} ${f(ry)} 0 0 1 ${f(l)} ${f(b - ry)}` +
    `V${f(t + ry)}A${f(rx)} ${f(ry)} 0 0 1 ${f(l + rx)} ${f(t)}Z`
  );
}

const EVERYTHING = 'M-9999 -9999H9999V9999H-9999Z';

export interface LiquidLensOptions {
  /** The pill element; the optics are mounted inside it and scale with it. */
  host: HTMLElement;
  buttons: HTMLElement[];
  /** Button rect in the pill's offset-parent coordinates. */
  rectAt: (index: number) => PillPose['rect'] | null;
  profile: LensProfile;
  /** Colour each refracted copy is drawn in: iOS shows everything under the
   *  lens in its selected state. */
  copyColor?: (index: number) => string;
}

export interface LiquidLens {
  /** Feeds the lens's unstretched main-axis centre; returns the jelly stretch
   *  for this frame, from how fast the lens is travelling. */
  stretchFor: (center: number) => number;
  /** Refracts whatever the painted pose covers. `strength` (0..1) is how
   *  much glass shows — rim refraction, and the selected look underneath;
   *  `magnify` (0..1, default `strength`) is how far the core enlarges, which
   *  iOS reserves for a lifted lens: a tapped pill bends only at its edges. */
  paint: (pose: PillPose, strength: number, magnify?: number) => void;
  /** Mirrors a colour painted on a real button into its refracted copies. */
  setColor: (index: number, color: string) => void;
  clear: () => void;
}

export function createLiquidLens(options: LiquidLensOptions): LiquidLens {
  const { host, buttons, rectAt, profile, copyColor } = options;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  const root = document.createElement('div');
  root.className = 'lens-optics';
  root.setAttribute('aria-hidden', 'true');
  root.inert = true;
  // One clipped layer per band plus the core, each with its own copy.
  const layers = [...profile.bands.map((band) => band.magnify), profile.magnify].map((magnify, i) => {
    const el = document.createElement('div');
    el.className = i === profile.bands.length ? 'lens-optics-core' : 'lens-optics-band';
    const content = document.createElement('div');
    content.className = 'lens-optics-content';
    el.appendChild(content);
    root.appendChild(el);
    return { el, content, magnify };
  });

  let mounted = false;
  let copies: HTMLElement[][] = [];
  let shapeKey = '';
  let glint = '';
  let strengthCss = '';
  const holes = buttons.map(() => '');

  let lastCenter = Number.NaN;
  let lastTime = 0;
  let speed = 0;

  function mount() {
    // Snapshot on every lift: the active button's look may have changed.
    const made = buttons.map((btn, i) => {
      const copy = snapshot(btn, rectAt(i) ?? { left: 0, top: 0, width: 0, height: 0 });
      if (copyColor) copy.style.color = copyColor(i);
      return copy;
    });
    copies = layers.map(({ content }, i) => {
      const set = i === 0 ? made : made.map((copy) => copy.cloneNode(true) as HTMLElement);
      content.replaceChildren(...set);
      return set;
    });
    host.appendChild(root);
    mounted = true;
  }

  function stretchFor(center: number): number {
    const now = performance.now();
    const dt = now - lastTime;
    if (!Number.isNaN(lastCenter) && dt > 0 && dt < 100) {
      speed = speed * 0.6 + ((center - lastCenter) / dt) * 0.4;
    } else {
      speed = 0;
    }
    lastCenter = center;
    lastTime = now;
    if (reduced.matches) return 0;
    return Math.min(Math.abs(speed) * profile.stretchPerSpeed, profile.maxStretch);
  }

  function paintGlint(strength: number) {
    // Light catches the leading shoulder and slides back as the lens moves.
    const offset = Math.max(-1, Math.min(1, speed)) * GLINT_PER_SPEED * strength;
    const next = `${(50 - offset).toFixed(1)}%`;
    if (next === glint) return;
    glint = next;
    host.style.setProperty('--lens-glint-x', next);
    host.style.setProperty('--lens-glint-angle', `${(200 + offset * 2).toFixed(1)}deg`);
  }

  function paintShape(w: number, h: number) {
    const key = `${w.toFixed(1)} ${h.toFixed(1)}`;
    if (key === shapeKey) return;
    shapeKey = key;
    const radius = Math.min(w, h) / 2;
    const ring = (inset: number) =>
      roundedRect(inset, inset, w - inset * 2, h - inset * 2, radius - inset, radius - inset);
    let inset = 0;
    layers.forEach(({ el }, i) => {
      const outer = ring(inset);
      if (i === profile.bands.length) {
        el.style.clipPath = `path('${outer}')`;
        return;
      }
      inset = Math.min(inset + profile.bands[i].width * h, radius - 1);
      el.style.clipPath = `path(evenodd, '${outer}${ring(inset)}')`;
    });
  }

  // Content coordinates are the pill's offset parent; the host's own scale is
  // divided back out so the copy lands magnified about the lens centre.
  function place(content: HTMLElement, magnify: number, pose: PillPose, cx: number, cy: number) {
    const kx = magnify / pose.scaleX;
    const ky = magnify / pose.scaleY;
    const tx = (cx * (1 - magnify) - pose.x) / pose.scaleX;
    const ty = (cy * (1 - magnify) - pose.y) / pose.scaleY;
    content.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${kx.toFixed(4)}, ${ky.toFixed(4)})`;
  }

  function cutHoles(left: number, top: number, width: number, height: number, rx: number, ry: number) {
    for (let i = 0; i < buttons.length; i++) {
      const rect = rectAt(i);
      const covered =
        rect &&
        left < rect.left + rect.width &&
        left + width > rect.left &&
        top < rect.top + rect.height &&
        top + height > rect.top;
      const hole = covered
        ? `path(evenodd, '${EVERYTHING}${roundedRect(left - rect.left, top - rect.top, width, height, rx, ry)}')`
        : '';
      if (hole === holes[i]) continue;
      holes[i] = hole;
      if (hole) buttons[i].style.clipPath = hole;
      else buttons[i].style.removeProperty('clip-path');
    }
  }

  function paint(pose: PillPose, strength: number, magnifyStrength = strength) {
    if (reduced.matches || strength <= 0.01 || pose.rect.height <= 0) {
      clear();
      return;
    }
    if (!mounted) mount();
    paintGlint(strength);
    // Lets CSS clear a pill's fill and sharpen its rim as the lens lifts.
    const lift = strength.toFixed(2);
    if (lift !== strengthCss) {
      strengthCss = lift;
      host.style.setProperty('--lens', lift);
    }

    const { width: w, height: h } = pose.rect;
    paintShape(w, h);
    const width = w * pose.scaleX;
    const height = h * pose.scaleY;
    const cx = pose.x + width / 2;
    const cy = pose.y + height / 2;
    layers.forEach(({ content, magnify }, i) => {
      const k = i === layers.length - 1 ? magnifyStrength : strength;
      place(content, 1 + (magnify - 1) * k, pose, cx, cy);
    });
    const radius = Math.min(w, h) / 2;
    cutHoles(pose.x, pose.y, width, height, radius * pose.scaleX, radius * pose.scaleY);
  }

  function setColor(index: number, color: string) {
    if (!mounted) return;
    for (const set of copies) {
      const copy = set[index];
      if (copy) copy.style.color = color;
    }
  }

  function clear() {
    for (let i = 0; i < buttons.length; i++) {
      if (!holes[i]) continue;
      holes[i] = '';
      buttons[i].style.removeProperty('clip-path');
    }
    if (mounted) {
      root.remove();
      for (const { content } of layers) content.replaceChildren();
      copies = [];
      mounted = false;
    }
    lastCenter = Number.NaN;
    speed = 0;
    if (strengthCss) {
      strengthCss = '';
      host.style.removeProperty('--lens');
    }
    if (glint) {
      glint = '';
      host.style.removeProperty('--lens-glint-x');
      host.style.removeProperty('--lens-glint-angle');
    }
  }

  return { stretchFor, paint, setColor, clear };
}
