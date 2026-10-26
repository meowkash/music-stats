# Music podium

Design exploration for Music Stats, generated with the built-in image generation tool. Existing production icons are unchanged.

## Direction

One connected podium silhouette holds one enclosed eighth-note counter. Three ranked heights communicate listening charts; rounded shoulders soften the statistical motif. The note counter carries forward the existing icon's music idea while removing the floating cards and neon gradient.

Preferred palette: pastel cornflower blue (`#779BEA` target) on warm ivory (`#F7F5EF` target). These are design targets; generated raster pixels may vary. Dark treatment uses pale blue on deep ink. Clear and tinted studies test whether the same silhouette survives without its original color.

## Deliverables

- `concept-master.png`: generated square concept master, an opaque raster design exploration.
- `appearance-studies.png`: light, dark, clear, and tinted design studies. These are illustrative simulations, not captures from an iPhone.

## Production considerations

The concept still needs precise vector construction and small-size optical review before replacing the production SVG and generating deployment assets. Keep the cutout transparent in the foreground source, the foreground connected, and the exported PWA icon background opaque and full bleed. Do not bake rounded outer icon corners or glass highlights into the PWA PNG. Let the platform mask the outer square.

The existing application consumes `public/favicon.svg`, `public/logo-mark.svg`, and `scripts/generate-pwa-icons.js`. This exploration does not modify those files or the manifest.

Apple's layered app icon workflow provides system-rendered Liquid Glass effects. A PWA's static PNG/SVG assets should not be presented as equivalent to a native Icon Composer package. Validate the installed PWA on the target iPhone in every Home Screen appearance before calling the result verified.

References:

- https://developer.apple.com/design/human-interface-guidelines/app-icons
- https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer
- https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/

## Generation brief

Use case: logo-brand. One refined minimalist icon for a music listening statistics PWA. A single contiguous pastel cornflower-blue silhouette combines a winners podium with a musical eighth note cut out as negative space. Three softly rounded vertical lobes join into one continuous rounded base: left medium, center highest, right shortest. The note counter is enclosed, generously spaced, and readable. Warm ivory background. Flat vector-like artwork, optical balance, soft corners, clear hierarchy, no words, floating pieces, gradients, outlines, textures, shadows, or glass rendering. Reference: the existing `public/icons/icon-512.png`, used only for inspiration from its music counter; replace its stack of cards.

Appearance sheet brief: preserve the master silhouette and scale across four equally sized tiles, in one spacious row: Light (blue on ivory), Dark (pale blue on ink), Clear study (frosted white on pale neutral glass), Tinted study (icy blue on slate). Label the studies as simulations; restrict glass material to the clear study.
