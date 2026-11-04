# Design system

How the System Design Atlas site looks, and the rules that keep every page consistent. The values live in code; this document explains them and how to use them. If the two disagree, the code is right and this file needs updating.

| File | Role |
|---|---|
| `site/src/design.css` | The tokens (colour, space, radius, type, shadow, layers), the themes, the page frame, the one card look, the focus ring and the top bar. Its header comment is a one-screen summary of this document. |
| `site/src/styles.css` | Page and component rules. Uses the tokens, never raw spacing or radius values. |
| `test/design.test.ts` | Fails the build on raw px in `padding`, `margin`, `gap` or `border-radius` in `styles.css`, on rem font sizes outside the type scale, and on a `var(--s-*|--r-*|--t-*)` that `design.css` does not define. A line ending in `/* raw: reason */` is exempt. |
| `scripts/browser-sweep.mjs` | Opens every page in three themes at 1280px and 500px, then in pt-BR, and checks console errors, sideways scroll, clipped cards, the sticky top bar and WCAG AA text contrast. |

## 1. Principles

1. **Reading first.** Readers spend most of their time in long notes. Comfort (measure, line height, contrast, calm colour) beats decoration.
2. **One of each.** One border, one card look, one hover, one focus ring, one disclosure style. A new component reuses these before it invents anything.
3. **Tokens, not values.** Spacing, radius, type size, colour, shadow and layer come from `design.css`. If no token fits, add or change a token, not a one-off value.
4. **The reader decides.** Theme, font and text size are reader settings, so components must work in all four themes, all four fonts and text sizes from 13 to 24 px.
5. **The diagram is the exception.** Diagram nodes have fixed sizes computed from their text, so diagram text is in px and the diagram keeps the system font (section 9).

## 2. Colour

### 2.1 Theme tokens

Themes are set on `<html data-theme="light|warm|dark">`. With no attribute (the System setting), the light values apply and the OS dark preference switches to the dark values. Print forces black on white.

| Token | Use | Light | Warm | Dark |
|---|---|---|---|---|
| `--bg` | page background | `#fafafa` | `#f4ecd8` | `#111114` |
| `--fg` | body text, headings | `#1c1c1e` | `#3b3226` | `#ececf0` |
| `--muted` | secondary text, captions, inactive items | `#6b6b70` | `#6b5f4f` | `#9a9aa3` |
| `--card` | solid surfaces: menus, inputs, buttons, disclosures | `#fff` | `#fbf6e9` | `#1d1d23` |
| `--line` | every border and divider | `#d8d8de` | `#dccfb4` | `#383842` |
| `--accent` | links, primary actions, current item, focus ring | `#2563eb` | `#1f5f8b` | `#60a5fa` |
| `--on-accent` | text on an accent background | `#fff` | `#fff` | `#0b1220` |
| `--c-confirmed` | `[CONFIRMED]`, "real system", fresh sources, progress | `#15803d` | `#3d6b27` | `#4ade80` |
| `--c-pattern` | `[INDUSTRY PATTERN]`, "reference design" | `#b45309` | `#94560a` | `#fbbf24` |
| `--c-spec` | `[SPECULATIVE]`, failure flows, stale or warning states | `#b91c1c` | `#a32d2d` | `#f87171` |

Derived surface: `--surface` is `--card` at 80% over a blur, used by the card look (section 6.1).

Rules:
- **Accent means "you can act here" or "you are here".** Do not use it for decoration.
- **The three status colours carry meaning** (confidence, freshness, failure). Do not reuse them for unrelated emphasis.
- **Tints are mixed, not new hex values.** For a faint background behind text use `color-mix(in srgb, var(--fg) 4%, transparent)` (table headers, inline code, code blocks). Do not go above 4%: on the light theme, muted text and links then drop below 4.5:1 (5% gives 4.49 for links, 7% gives 4.31). Stronger accent mixes (`color-mix(in srgb, var(--accent) 18–35%, transparent)`) are for highlights and rings, not for backgrounds of muted or link text.
- **A theme change touches only `design.css`.** `styles.css` must not contain theme hex values. The existing exceptions are white or near-black text on the fixed diagram palette (which is the same in every theme), the theme swatches in the settings menu, and the print block.

### 2.2 Kind tints (legend chips)

`--k-client`, `--k-edge`, `--k-service`, `--k-datastore`, `--k-queue` and `--k-external` are soft per-theme backgrounds for the older kind legend chips. They change with the theme (pastel in light and warm, deep in dark).

### 2.3 Diagram palette

The diagram uses one fixed palette in every theme: **hue = kind of element, shade = C4 level** (saturated for a container, a light tint for a component inside it). White text on the saturated fills and dark text (`#0f172a`) on the tints both meet 4.5:1.

| Kind | Container (`--p-*`) | Component tint (`--p-*-t`) |
|---|---|---|
| Service | `--p-service` `#1d4ed8` | `--p-service-t` `#bfdbfe` |
| Data store | `--p-data` `#b45309` | `--p-data-t` `#fde68a` |
| Queue or stream | `--p-queue` `#be185d` | `--p-queue-t` `#fbcfe8` |
| Edge (CDN, gateway, load balancer) | `--p-edge` `#0f766e` | `--p-edge-t` `#99f6e4` |
| Client | `--p-client` `#7c3aed` | `--p-client-t` `#ddd6fe` |
| External system | `--p-external` `#475569` | `--p-external-t` `#e2e8f0` |

Plus `--p-person` `#4c1d95` (people), `--p-system` `#0f172a` (the system as one box in the Context view, with a white 3px border) and `--p-note` `#6b7280` (annotations). The home page's icon tiles (`.tile.tone-*`) reuse the same hues, so a colour means the same thing on the home page and in a diagram.

Confidence shows in the **node border style**, not its colour: solid for confirmed, dashed for industry pattern, dotted for speculative. The current flow step uses `--accent`, or `--c-spec` in a failure flow.

## 3. Typography

### 3.1 Fonts

| Token | Value | Use |
|---|---|---|
| `--font-body` | the reader's choice: system (`system-ui`), Atkinson Hyperlegible, Lexend or Literata (self-hosted through Fontsource) | all text outside diagrams |
| `--font-mono` | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | inline code, code blocks, ASCII diagrams in notes |
| (fixed) | `system-ui, sans-serif` | diagram nodes and edge labels |

Never set a font family in a component except through these tokens. A component that must stay legible at any reading setting (the settings menu) fixes its size in px, with a comment saying why.

### 3.2 Size and the type scale

The root size is the reader's setting: `html { font-size: var(--fs, 15px) }`, from 13 to 24 px. Every size below is in rem, so it follows the setting.

| Token | Size | Use |
|---|---|---|
| `--t-xs` | .75rem | pills, badges, confidence tags, chips |
| `--t-sm` | .85rem | secondary text, captions, tables, the trust card, the contents list |
| `--t-md` | 1rem | body text, `h4` in notes, card titles |
| `--t-lg` | 1.15rem | `h3` in notes, home section titles |
| `--t-xl` | 1.5rem | page titles (`.bar h1`, the note title), `h2` in notes, the home headline on phones |
| `--t-2xl` | 2.3rem | the home headline |

Inside notes, `code` is `.875em` (relative to its context), and confidence tags and anchors use `em` so they follow their heading.

### 3.3 Headings, line height and measure

| Element | Size | Line height | Other |
|---|---|---|---|
| Home headline (`.hero h1`) | `--t-2xl` (`--t-xl` under 560px) | 1.2 | letter-spacing -.02em; second line uses the accent-to-green gradient |
| Note `h2` | `--t-xl` | 1.25 | letter-spacing -.01em; 1.8em top margin |
| Note `h3` | `--t-lg` | 1.3 | 1.4em top margin |
| Note `h4` | `--t-md` | inherits | |
| Body (`body`) | `--t-md` | 1.5 | |
| Note prose (`.notes`) | `--t-md` | 1.65 | paragraphs, list items and quotes capped at `--prose-max` (76ch) |
| Code blocks | `.875em` | 1.55 | horizontal scroll, never wrap |

Rules: the page has exactly one `h1` (the sweep checks it); a system note's own Markdown title renders as `h2.note-title`. Do not skip heading levels for size; change the size with the scale instead.

## 4. Space

All spacing sits on a 4px grid.

| Token | px | Typical use |
|---|---|---|
| `--s-1` | 4 | inside a control, between a label and its value |
| `--s-2` | 8 | inside a control, between chips or buttons in a row |
| `--s-3` | 12 | padding of compact cards, gap between related blocks |
| `--s-4` | 16 | padding inside a card, gap between cards |
| `--s-5` | 24 | page top padding, list indentation |
| `--s-6` | 32 | between sections, around a horizontal rule |
| `--s-7` | 48 | page bottom padding, large layout gaps |

`--page-pad` is the page gutter, `clamp(--s-3, 3vw, --s-5)`: 12 px on phones, up to 24 px on desktop. Negative offsets and `calc()` are allowed for layout tricks (the test skips them).

## 5. Shape and depth

| Token | Value | Use |
|---|---|---|
| `--r-sm` | 6px | buttons, inputs, inline code, segmented controls |
| `--r-md` | 10px | small panels, popovers, disclosures, code blocks, the diagram canvas, diagram nodes |
| `--r-lg` | 14px | cards |
| `--r-pill` | 999px | pills, chips, the coffee link, progress bars |
| `--shadow-1` | soft two-layer | a card at rest |
| `--shadow-2` | deeper | a hovered card |
| `--shadow-pop` | wide | menus, popovers, tooltips |

Borders are always `1px solid var(--line)`. A thicker left border (3 to 4px) marks a block's role: the trust card (`--c-confirmed`), the at-a-glance box (`--accent`), a failure stepper (`--c-spec`), a quote (`--line`).

## 6. Components

### 6.1 Card (the one card look)

Every card-like element is in the surface selector list in `design.css`: `--surface` background with blur, 1px `--line` border, `--r-lg`, `--shadow-1`, `--s-4` padding (`--s-3 --s-4` for compact cards). Clickable cards share one hover: border to `--accent`, lift 2px, `--shadow-2`; no lift under reduced motion. **A new card-like element is added to that selector list**, not given its own border, radius and shadow.

### 6.2 Buttons and links

| Class | Look | Use |
|---|---|---|
| `button` (default) | `--card` background, `--line` border, `--r-sm`, `--s-1 --s-3` padding | tool buttons, view modes, flow buttons |
| `button[aria-pressed="true"]` | accent background, `--on-accent` text | the selected item in a group |
| `.button` | link styled as a button, `--r-md`, `--s-3 --s-4` | page-level actions on the home page |
| `.button.primary` | accent background | the one main action in a view |
| `button.linkish` | looks like a link | inline actions in text |
| `.icon-btn` | square, at least `--hit` (36px) | icon-only buttons; always with an `aria-label` |
| `a` | `--accent`, underlined in prose | navigation |

Failure-flow buttons use a `--c-spec` border, and a `--c-spec` fill when pressed.

### 6.3 Pills, badges, chips and tags

- **Pill** (`.pill`): `--t-xs`, `--r-pill`, `--line` border, `--muted` text. Colour variants follow meaning: `type-system` green, `type-primer` accent, `type-incident` red, `type-exercise` amber; `up-next` is filled accent.
- **Kind badge** (`.kind`): "Real system" in `--c-confirmed`, "Reference design" in `--c-pattern`.
- **Confidence tag** (`.conf-tag`): the notes' `[CONFIRMED]`, `[INDUSTRY PATTERN]`, `[SPECULATIVE]` and `[EARLIER PASS]` render as `[c]`, `[ip]`, `[s]`, `[ep]` in `--t-xs` bold at 70% opacity, with a tooltip (`--card`, `--shadow-pop`, max 18rem). The tooltip is `display: none` until hover or focus: a box hidden with `visibility` still widens its scroll container, which made note columns scroll sideways. A new tag needs an entry in `site/src/tags.tsx` and its text in `i18n.tsx`.
- **Chip** (`.chip`, `.chips a`): legend swatches and concept links; `--r-pill` for links, `--r-sm` for legend swatches.

### 6.4 Disclosure (`<details>`)

Every `<details>` on the site (answer outlines, the trust card, the home page's reading guide, the diagram panel) shares one marker. The browser marker is replaced by a chevron drawn with `::before` that turns from right to down and takes `--accent` when open. Note disclosures have a `--card` background, `--line` border, `--r-md`, are capped at the prose width, and get an accent-tinted border when open. Keep `summary` as a block (not flex): some browsers break toggling on a flex `summary`.

### 6.5 Tables and code in notes

- **Tables:** `--t-sm`, left-aligned; headers on a 4% `--fg` tint with a stronger bottom rule; hairlines between rows only, no vertical lines. Wide tables scroll inside `.tablewrap`.
- **Inline code:** `--font-mono`, `.875em`, a faint pill (`--r-sm`, 4% `--fg` tint).
- **Code blocks:** `--font-mono`, a 4% `--fg` tint over `--bg`, 1px `--line` border, `--r-md`, `--s-3 --s-4` padding, line height 1.55, horizontal scroll.
- **Horizontal rule:** one `--line` hairline with `--s-6` above and below.

### 6.6 Top bar

Sticky at the top of every page (the sweep fails a page without it): the brand with its `--p-service` tile on the left; the coffee link and the settings button on the right, each at least `--hit` tall. It uses a 92% `--bg` background with blur and a `--line` bottom border. On the centred pages (home, tracks, concepts) its contents line up with the page column; on system and toolkit pages it spans the window.

### 6.7 Trust card

A card with a 4px `--c-confirmed` left border and `--t-sm` text: freshness (green when fresh, red and bold when stale), tallies, then disclosures for tag meanings, what was not checked, change history and quotation evidence.

### 6.8 Focus

One ring for every focusable element: `outline: 2px solid var(--accent); outline-offset: 2px`, on `:focus-visible` only (keyboard focus, not mouse clicks). It is defined once in `design.css`. Do not set `outline: none` on a focusable element; if a component needs a different focus look, add it and keep the ring.

## 7. Layout and positions

### 7.1 Widths

| Token or rule | Value | What |
|---|---|---|
| `--page-max` | 1100px | home, track and concept pages |
| `main.toolkit` | 860px | toolkit reading pages |
| `.system` | 1800px | system pages (diagram and note side by side) |
| `.split.mode-text .notes` | 960px | the note column in text view |
| `--prose-max` | 76ch | paragraphs, list items, quotes and disclosures in notes |
| `.lede` | 60ch | the home introduction |
| `.side-outline` | 240px | the contents list beside a note (1250px and wider) |

Every page uses the same frame: `--s-5` top, `--page-pad` sides, `--s-7` bottom.

### 7.2 System page views

- **Split** (default): diagram column (1.2fr) and note column (1fr) in a grid as tall as the window minus the header; each column scrolls on its own.
- **Graph**: the diagram alone (canvas 62vh).
- **Text**: the note alone, scrolling with the page, with the contents list in the right margin at 1250px and wider, or a "Jump to" select above the note on narrower screens.

### 7.3 Breakpoints

| Width | What changes |
|---|---|
| ≤ 520px | the coffee link shows its icon only (the label stays for screen readers) |
| ≤ 560px | the home headline drops to `--t-xl`, the hero art is hidden, home cards get a smaller minimum width |
| ≤ 760px | the home hero becomes one column |
| ≤ 860px | system pages stack (diagram above the note), everything scrolls with the page, the flow panel becomes one column |
| ≥ 1250px | text view shows the contents list in the margin |

Test new layouts at 1280px and 500px at least, which is what the sweep does.

### 7.4 Sticky elements and layers

- The top bar is `position: sticky; top: 0`. Anything that sticks below it uses `top: var(--top-h)`. `--top-h` is the bar's height: the tallest control (`max(2.3rem, --hit)`) plus padding and the border.
- `html` and `body` use `overflow-x: clip`, never `hidden`: `hidden` makes the body a scroll container and stops sticky positioning.
- Headings that are jump targets have `scroll-margin-top: calc(var(--top-h) + 56px)` so they land below the bar and the sticky "Jump to" select; the contents highlight reads the same value.
- Layers: `--z-sticky` (4) sticky page controls, `--z-tools` (5) controls floating over the diagram, `--z-top` (10) the top bar, `--z-pop` (20) menus and tooltips. Use these, never a raw `z-index`.

## 8. Motion

One timing, `--ease` (.15s ease), for hover and state changes: card lift, border colour, the disclosure chevron. Nothing moves on its own. Under `prefers-reduced-motion: reduce`, transitions and lifts are turned off; a new transition must be added to those rules.

## 9. Diagrams

- Node and edge text are in px (node title 13.5px, kind and technology 11px, edge labels 12px, boundary labels 12px), because each node is sized to its text by `site/src/nodeSize.ts`. The padding, gap, font sizes and line height in `.c4-body` are mirrored there: change both together.
- Node colours come from the diagram palette (section 2.3); the border style shows confidence; `--accent` (or `--c-spec` in a failure flow) marks the current step's nodes and edge; other edges dim to 20% opacity during a flow.
- Controls that float over the canvas (level select, reset, export) use `--card`, `--line` and `--z-tools`.

## 10. Accessibility

- **Contrast:** text meets WCAG AA (4.5:1, or 3:1 for large text) in every theme; the sweep measures it on every page. The one known false positive is the dark-theme "lighter = component" legend chip, whose gradient background the check cannot read.
- **Focus:** the one ring (section 6.8), never removed.
- **Targets:** icon-only and top-bar controls are at least `--hit` (36px) square.
- **Motion:** honour reduced motion (section 8).
- **Language:** the language setting sets `<html lang>`; new UI text goes into both the English and the pt-BR objects in `site/src/i18n.tsx`.
- **Icons:** decorative icons get `aria-hidden="true"`; an icon-only button gets an `aria-label`.

## 11. Changing the design

1. Look for an existing token or component first (this document, then `design.css`).
2. If something new is needed, add a token to `design.css` and a line to its header comment, then document it here.
3. Write page rules in `styles.css` with tokens only. A raw value needs a trailing `/* raw: reason */`.
4. Run `npm test` (design rules), `npm run build`, and check the change in light, warm and dark at 1280px and 500px. Run `npm run sweep` before finishing a visual change.
5. Update this document in the same commit when a token, component rule or breakpoint changes.
