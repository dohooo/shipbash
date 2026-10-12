# ShipBash brand assets

This directory is the canonical, reviewable home for ShipBash brand files.
Every export is generated from `source/shipbash-eye.svg`, except the repository
social preview, which is finished artwork kept as
`source/shipbash-social-preview-1280x640.png` and copied as-is, by:

```bash
bun run brand:assets
```

Do not edit files in `exports/`, `public/shipbash-brand/`, or
`apps/marketing/public/shipbash-brand/` by hand. Update the deterministic source
or generator, regenerate, and review the private `/brand` page instead.

## Which file to use

- Product UI on light surfaces: `shipbash-mark-black.svg`
- Product UI on dark surfaces: `shipbash-mark-white.svg`
- Browser, PWA, Apple touch, and social avatars:
  `shipbash-icon-white-on-black-1024.png`
- GitHub App and OAuth App: upload
  `shipbash-github-app-logo-white-1024.png`, then set the GitHub badge background
  to `#000000`
- GitHub repository social preview: `shipbash-social-preview-1280x640.png`
- Open Graph: `shipbash-open-graph-1200x630.png`
- Launch directories and demo listings: `shipbash-launch-cover-1600x900.png`
- README: use both horizontal lockups through a color-scheme-aware `<picture>`

## Color rule

ShipBash product surfaces use Ink `#141414` and Paper `#f7f5f2`. Technical
icons placed on third-party surfaces use pure black `#000000` and pure white
`#ffffff` for predictable contrast.

## Clear space and misuse

Keep clear space equal to the pupil diameter around the full outer contour.
Never crop, stretch, rotate, add effects, change stroke weights, or place the
transparent mark on low-contrast imagery. Motion is reserved for the product;
external assets use the generated static resting frame.
