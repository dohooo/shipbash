# ShipBash UI Design Rules

Read this before writing or changing any UI. Desktop is designed first, but
every screen also has to work at 390px, so the desktop markup is written to stay
mobile-ready. The single source of truth for every design value is
**`apps/console/app/theme.css`** (Tailwind v4 `@theme` tokens).
`apps/console/app/globals.css` holds the component styles and must only reference tokens.

## Hard rules

1. **Never hardcode a design value.** No hex colors (except `#fff`/`#000`),
   no `px` font sizes, no `px` radii. Use `var(--color-*)`, `var(--text-*)`,
   `var(--radius-*)` from `apps/console/app/theme.css`. If no token fits, propose a new
   token first — do not invent a one-off value.
2. **Type scale** (`--text-*`): `xs 10` mono labels/meta · `sm 11` secondary
   copy · `md 12` dense copy/chips · `base 14` body · `lg 16` h2 ·
   `xl 18` / `2xl 20` prominent headings · `3xl 30` hero/metrics ·
   `4xl 42` display. Font weights: **500 / 600 / 700 only.**
3. **Fonts**: `--font-sans` for prose, `--font-mono` for status labels,
   badges, counters, timestamps, and buttons. The standard micro-label is
   `font: 600 var(--text-xs)/1 var(--mono)`.
4. **Radii**: `sm 4` controls/chips/inputs · `md 8` cards/windows ·
   `lg 12` large surfaces · `full` pills. Nothing else.
5. **Color roles**: `ink/muted/faint` text ramp · `line/line-strong` borders ·
   `bg/panel/panel-muted/soft` surfaces · `green|amber|red|blue` semantic sets,
   each with `-soft` (surface), `-line` (border on soft), and accent/ink
   variants. `--color-chrome-*` and `--color-mac-*` are reserved for the mock
   browser window only — it mimics a real browser's own colors.
6. **Page structure**: the sidebar and breadcrumb already name the page.
   Top-level pages pass `titleHidden` to `PageTitle` (h1 stays for screen
   readers), pass primary actions to the topbar as `<Topbar actions>`, carry
   no marketing description (explanatory copy belongs in the `Empty` state),
   and start content directly with the first section. Only detail pages show
   a visible h1 with specific content (a run, a server).
7. **Composite patterns**: use the existing component instead of re-composing:
   - `Status` — any status/verdict label.
   - `RelativeTime` — any timestamp (never a bare `<time>` or raw date string).
8. A bare element must never rely on inherited browser defaults for size or
   color; if a wrapper class doesn't style it, that's a bug (see rule 1).

## Breakpoints
- `≤760px`: mobile layout for app screens. All mobile rules live inside `@media (max-width: 760px)`, in `apps/console/app/mobile.css`, which loads after `globals.css`.
- `≤700px`: sign-in chassis only (login, waitlist, gate, CLI); this is the existing `login.module.css` breakpoint.
- Never change desktop rules to fix mobile. Mobile is an override layer on top.

## Rules for desktop work (so mobile doesn't break)
1. **Lay out with flex or grid and `gap`.** No spacing from source whitespace, and no fixed widths on boxes that hold text. Use `minmax(0, 1fr)`, `min-width: 0`, `max-width`.
2. **Group actions in one container** (`.page-actions`, `.workbench-actions`, `.signin-actions`, `.connection-action`), so mobile can move them right or into the header without restructuring.
3. **Keep the title and its action as siblings in one head** (`.settings-card-head`, `.section-head`, `.page-title`). Mobile keeps them on one row: title left, action right.
4. **Keep status next to its name, metadata in its own element.** Mobile renders two lines: name + chips / meta · dots · time. Don't merge them into one text node.
5. **Data tables get a mobile shape on purpose.** Name each table's mobile form (card, two-line row, label-over-value) when you add it. A `<table>` with no plan for mobile is a bug.
6. **Never truncate the only copy of important text.** Failure reasons, emails and repo names wrap at mobile widths rather than ellipsize.
7. **Media and workbenches must be able to go full-bleed.** No meaning carried by side borders or radius; mobile removes them.
8. **Viewport-filling screens** (stage + conversation) must be flex columns with `min-height: 0` all the way down, so the conversation can fill the remaining height and scroll inside itself.
9. **Don't add a page-level horizontal scroller.** Horizontal strips (case rail, filters) scroll inside themselves with a hidden scrollbar.
10. **Hover is never the only affordance.** Every hover state needs a visible resting state too. Check specificity against `.button.primary:hover:not(:disabled)`.

## Mobile conventions (what the mobile layer does)
- **Header:** one 52px bar with menu (44px), page title (last crumb only), up to 2 icon actions, and avatar. No project switcher in the header.
- **Navigation:** the rail becomes a left drawer, min(304px, 86vw), with a scrim; Escape, scrim tap or nav tap closes it.
- **Settings nav:** a 44px picker that opens a bottom sheet (max 78dvh, grab handle, close button).
- **Rhythm:** page padding `12px 16px 40px`; card padding 14px; 12px between cards; h1 `--text-2xl`.
- **Actions:** right-aligned and compact (34px for secondary actions). Row actions never stretch full width; only a primary footer CTA may.
- **Lists inside cards:** bleed to the card edge (no nested padding).
- **Footers with actions:** a sticky bar on `var(--soft)` with a 1px top line, safe-area padding, facts on one line, buttons on the right.
- **Tap targets:** ≥44px for navigation and primary actions, ≥34px for secondary row actions.
- **Scrollbars:** thin (4px), transparent track, thumb `rgba(23,23,20,.2)`.
- **Modals:** become bottom sheets (full width, max 88dvh, `--radius-lg` top corners).

## Before merging any UI change
- [ ] Desktop is unchanged, unless desktop was the point of the change.
- [ ] Checked at 390×844: no horizontal page scroll, no clipped text, no overlap.
- [ ] Actions are right-aligned and reachable; tap targets meet the minimums.
- [ ] Any new table or list has its mobile shape defined.
- [ ] Hover, focus and disabled states are all visible.
