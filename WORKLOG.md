# Work log: review follow-ups (temporary, delete when done)

Started 2026-11-04. Source: the content and design reviews of 2026-11-03 (two subagent reports).
Each step is one small commit with `npm run validate`, `npm test` and, for site changes, `npm run build`
plus a screenshot check; the full browser sweep runs once at the end.

Status: `[ ]` to do · `[x]` done (ticked in the commit that does it) · `[-]` dropped (reason)

## A. Wording errors (content review)
- [x] A1 Note 03: Cassandra "Strong when W + R > RF" contradicts P16 (quorum overlap is not linearizable). Fix note and pt-BR mirror.
- [x] A2 P16: "consensus-based or single-leader design" for linearizable reads; single leader needs leadership confirmation (lease or read-index).
- [x] A3 tracks.json: W05 reason calls 22 to 31 "AI systems"; 29 to 31 are streaming and observability. Fix English and pt-BR overlay.

## B. Design fixes (design review items 1-4 and 8-10)
- [x] B1 Item 1: mobile text view clips sideways (`.split.mode-text .notes` auto margins on a grid item).
- [x] B2 Item 4: toolkit tables wrap one letter per line (`overflow-wrap: anywhere` on `main.toolkit`).
- [x] B3 Item 2: text mode scrolls an inner box plus the page; scroll-spy offset disagrees with `scroll-margin-top`.
- [x] B4 Item 3: note typography (heading scale, hr, mono font token for code, tables).
- [x] B5 Item 8: one global focus ring; remove `outline: none` overrides.
- [x] B6 Item 9: `<details>` answer outlines (chevron, open state, prose width), shared with the trust card.
- [x] B7 Item 10: top bar polish (lucide settings icon, alignment with centred pages).

## C. Design system document
- [x] C1 Write `DESIGN.md` (palette per theme, diagram palette, spacing, radii, type scale and fonts, headings, layout and positions, layers, components, motion, accessibility, how to add a component). Point `design.css` header and CLAUDE.md to it.

## D. Roadmap
- [x] D1 Clean and restructure ROADMAP.md (open items first, done items condensed).
- [x] D2 Add the missing content topics (ranked by the content review).
- [x] D3 Add design items 5-7 (split-view diagram and stepper, chrome above the note, home cards) plus the reviewers' quick wins and bigger ideas.

## E. Final check
- [x] E1 Full browser sweep (`npm run sweep`), English and pt-BR, all themes: 808 checks, 0 console errors, 0 failing (after the tint fix below).
- [ ] E2 Delete this file (left for the user, who said it will be deleted later).

## Notes
- Found during B2: the trust card says "1 days ago" (plural for one day). Add to the quick wins in D3.
- E1 first run: 144 failures, all light-theme contrast on inline code from B4 (7% tint: links 4.31:1, muted text 4.42:1) plus one link on a table header (5% tint, 4.49:1). Fixed by using a 4% tint for both (worst case 4.58:1), documented in DESIGN.md.
- After the plan: the user saw sideways scroll in note 02. Cause: hidden confidence-tag tooltips (visibility: hidden) widened the note column, by up to 257px in split view. Fixed with display: none, and the sweep now checks reading columns.

## F. Quick wins (roadmap "Design: quick wins", started 2026-11-04)
- [x] F1 "1 days ago" on the trust card (English and pt-BR).
- [x] F2 Confidence tag before a full stop leaves a gap ("S3 [c] .").
- [x] F3 Contents list and "Jump to" select show raw "[c]" / "[ip]" in heading labels.
- [x] F4 Wrapped flow-step lines put the number marker beside the last line.
- [x] F5 "16 px" readout touches the settings menu border.
- [ ] F6 Concept filter input touches the first card at 500px.
- [ ] F7 Track page: a step with no reading time shows a stray "practice".
- [ ] F8 Unknown route silently shows the home page.
- [ ] F9 Diagram edges faint in dark; edge labels collide.
- [ ] F10 Dark cards barely stand out from the page.
- [ ] F11 Toolkit top bar not aligned with the 860px column.
- [ ] F12 Full sweep, then move the quick wins to Done in ROADMAP.md.
