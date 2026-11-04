# Roadmap

What is left to do, and why it is not done yet. Open work comes first, grouped by kind; finished work is summarised at the end with its date. Status as of 2026-11-04.

## Open

### Content: missing interview topics

Found by the 2026-11-03 content review, ranked by value in a senior system-design interview. Each was checked against the atlas with a search before being called missing. The candidate sources are leads that have **not been read yet**; the usual sourcing rules apply when one is written.

| # | Topic | What is missing today | Where it would fit | Candidate primary sources (unverified) |
|---|---|---|---|---|
| 1 | Batch vs stream, backfills and CDC | Only note 31 touches the warehouse and OLAP side, and backfills appear only in note 21. No lambda vs kappa, reprocessing, change data capture into a lake or warehouse, or columnar storage. | A new primer, or a section in 31 | Kreps, *Questioning the Lambda Architecture* (O'Reilly, 2014); Akidau et al., *The Dataflow Model* (VLDB 2015); Melnik et al., *Dremel* (VLDB 2010) |
| 2 | Multi-region writes, geo-partitioning and data residency | P13 covers disaster-recovery strategies, but not active-active conflict resolution, home-region or geo-partitioned data, or residency rules. | A section in P13 or a new primer | Corbett et al., *Spanner* (OSDI 2012); DynamoDB global tables documentation (last-writer-wins); Shapiro et al., *CRDTs* (2011); CockroachDB multi-region documentation |
| 3 | Schema evolution for stored data and online migrations | Only the schema registry in note 04 and API evolution in P05. No Avro or Protobuf compatibility rules, expand and contract migrations, or online schema changes. | A section in P10 | Confluent Schema Registry compatibility documentation; Protocol Buffers guide, "Updating a message type"; GitHub's gh-ost post |
| 4 | LLM guardrails and the safety layer | Spread across notes 23, 25, 41 and P06. No input and output classifiers, jailbreak defence, PII redaction or refusal evaluation in one place. | A section in 25 or a new AI primer | Meta, *Llama Guard* (arXiv 2312.06674); Anthropic, *Constitutional Classifiers* (arXiv 2501.18837); OWASP Top 10 for LLM Applications |
| 5 | Prompt caching and semantic caching | Note 22 covers prefix sharing inside the serving engine; API-level prompt caching (cost, TTL) and semantic caching are absent. | A cost-control section in 22 or 23 | Anthropic prompt caching documentation; vendor docs of other model APIs |
| 6 | Resilience patterns and distributed tracing | Circuit breakers appear only in notes 09 and 14, tracing only in 30; P07 covers retries. | A section in P07 | Sigelman et al., *Dapper* (Google, 2010); the Google SRE book chapter "Handling Overload" |

Already covered, so not on this list: queues vs logs (note 04's comparison table), data retention and deletion (P17), search ranking (notes 20 and 36).

### Design: larger changes

From the 2026-11-03 design review (screenshots of notes 01 and 07, a toolkit page, a track page, the concept index and the settings menu, light, warm and dark, 1280px and 500px). Its items 1 to 4 and 8 to 10 and its quick wins are done (see Done). Rules for any of these: [`DESIGN.md`](DESIGN.md).

| # | Change | What the review saw | Proposed change | Effort |
|---|---|---|---|---|
| 1 | Split view: a readable diagram and a visible stepper | At 1280px, fitting the whole diagram into a 46vh canvas renders node text at about 5px; the current step's edge is a faint dashed line; the step caption and Back and Next sit below the fold; six flow buttons take about 250px. | When a flow is active, zoom to the current step's nodes (`fitView` on those nodes, padding .3, max zoom 1) in `DiagramView.tsx`; let the canvas take the free height (`flex: 1`) instead of `46vh`; pin the step caption and Back and Next as an overlay at the bottom of the canvas (`--z-tools`); show the flows as one horizontally scrolling chip row. | M |
| 2 | Less chrome above the note | On system pages the breadcrumbs, title, eight legend chips and the legend sentence take about 230px, then the trust card pushes the note's first line to about y=850. | Move the legend into a "Legend" disclosure inside the canvas; put "Mark as studied" on the breadcrumb row; collapse the trust card into a one-line bar (freshness, tag tallies, quotes found, "Details") with its four sections behind it; hide the note's repeated title (`h2.note-title`) on system pages but keep it for print. | M |
| 3 | Home cards: less empty space, even rows | System cards are 170px tall with about 40% empty (a number and a title), so the page is about 6000px tall; five track columns at 1100px wrap titles onto three lines; "Continue" falls onto its own row; stage subtitles are indented while cards are flush left. | Lower the card `min-height` to about 112px or add a one-line description; track cards `minmax(min(200px, 100%), 1fr)` with title line height 1.3; a separate "Resume" strip; align stage subtitles with the cards. | S |

**Diagram export:** the SVG and PNG export (`site/src/export.ts`) draws straight lines between box edges, so two lines between the same pair of elements, or a line pointing backwards, can overlap there, and their labels with them. The on-screen diagram routes and spaces them since 2026-11-04; the export would need the same treatment.

**Bigger ideas** (not planned; each changes how the site feels, so decide first):
1. **Docs-style three-column system page:** stage or system navigation on the left, the note in the centre, the contents and a compact trust summary on the right, the diagram as a sticky panel you can toggle (the Stripe and Tailwind docs pattern). Much easier to keep your place; a large `SystemPage` refactor that gives the diagram less room in Split.
2. **Reading-first default:** open notes in Text view with a small diagram thumbnail that opens Graph, and use Literata for note text only while the interface stays sans. Calmer for long sessions; hides the diagram, which is the site's distinctive feature.
3. **Denser home index:** keep cards for the five tracks, but show the 42 systems and the toolkit as a compact table per stage (number, title, kind, minutes, progress tick). Much faster to scan; loses some visual charm.

### Translations (pt-BR)

UI text (`site/src/i18n.tsx`), track and stage overlays (`site/src/locales/pt-BR/{tracks,stages}.json`), 39 of the 42 systems (01 to 30 and 34 to 42) and 6 toolkit pages (P02, P11, P14, P17, P18, W04) are translated under `locales/pt-BR/`, checked against `schema/glossary.json` by `scripts/validate.ts` and `test/i18n.test.ts`. Still in English:

- **Systems (3):** 31 Ad click aggregation, 32 Distributed cache (Memcache at Facebook), 33 Coordination, locks and leader election.
- **Primers (13):** P01 Estimation, P03 Distributed transactions, P04 Load balancing, P05 API design, P06 Security for architects, P07 SLOs and incidents, P08 Cost as a design input, P09 Decisions and design docs, P10 Changing systems safely, P12 Event sourcing and CQRS, P13 Disaster recovery and multi-region, P15 Effective review, P16 Consistency and cache failures.
- **Casebook (6):** C01 Amazon S3 2017, C02 Cloudflare 2019, C03 GitHub 2018, C04 Facebook 2021, C05 Knight Capital 2012, C06 AWS Kinesis 2020.
- **Workbook (5):** W01 Mock interview protocol, W02 Find the flaw, W03 Estimation drills, W05 Flashcards, W06 Review an API.
- **Diagram JSON (42):** node labels, descriptions and flow captions. Needs schema support or localised JSON files first.

### Review findings not yet verified

Each of these needs its source re-read before the note changes; none changes a headline number.

- **From the 2026-10-27 review, diagrams:** note 31's batch reconciliation reads the joined log, not the raw log, so a click lost before the joined log cannot be found (add a raw-log edge); note 21 omits the Open Match backend (FetchMatches and the evaluator return route through it); note 11's read flow ranks before hydrating while the note hydrates first, and the 2017 timeline service and 2023 Home Mixer are one node; several edge labels do not match their flow captions (notes 25, 28, 33, 34, 08 server-crash, 18 gw-bob); note 13's `c-ix` edge and note 21's `no-server` wording; the failure flags on `chat-rejected`, `duplicate` and `late` are debatable.
- **From the 2026-10-27 review, notes:** 01 (Squid collapsed forwarding, the RFC 9110 section cited for 302, an unsourced "1 unused" bit and the 100:1 read ratio); 02 (the Envoy recommendation wording, the Redis pattern blend, the IETF draft status); 04 (edge direction, KIP-848 source); 05 (a table figure read from an image); 09 (the Semaphore node, an unlabelled order of publish and store); 10 (APNs 30-day storage, queue edges); 12 (YouTube resumable upload documented for the Data API); 15 (O(1) parent lookup attribution); 17 (cancel in the processing state for some payment methods); 19 ("exactly-once" wording, snapshot fallback in gap recovery); 20 (RFC 9309 30-day and cached-copy rules); 21 (the 1.7M figure reference); 22 (binary units in one calculation); 23 (permission pre-filter trade-off); 24 (the effect of ef on memory); 26 (Table 3 unit wording); 29 (IVS latency wording, the 6 s draft attribution); 30 (Gorilla and Prometheus blend); 33 (an inference tagged CONFIRMED, an unsourced etcd/Consul line).
- **From the 2026-10-27 review, toolkit and site:** P11 to P14 small attribution items (the P14 stamps pattern page was not read); C01 "approved playbook" (the post says established); C05 two details not in the SEC order; casebook logs have no "Not ..." bullets, so the trust card shows only the "Not read" line; tracks (the W02 step omits C06, the W05 step says primers but has no P11 to P14 cards, the architect track summary order); README wording on what `npm test` covers.
- **From the 2026-10-29 re-read of notes 16 and 07:** how a concurrent insert behaves while the first transaction is uncommitted (note 16; not stated in the pages read), and Facebook's current photo architecture (note 07).
- **Not covered by the 2026-11-03 content review:** it sampled about 9 of 66 pages. Not checked: notes 15 (H3 figures) and 19 (LMAX and Disruptor figures), DistServe's 7.4x and 12.6x in note 22, the concept matrix row by row, the `stages.json` reasons, and every diagram except note 25's. Wording slips like the one fixed in note 03 may exist in pages it did not open.

### Sources that could not be fetched

The Count-Min Sketch paper (note 34), the Instagram engineering post on IDs (note 35, read from an Internet Archive copy only where noted), *The Akamai Network* (2010, note 38; the 2015 Akamai algorithms paper is used instead), Meta's Transparency Center pages (note 41; rendered by script) and the GDPR text on EUR-Lex (P17; Article 25 is cited through the EDPB guidelines).

### Testing gaps

`npm run sweep` (`scripts/browser-sweep.mjs`, start instructions in its header) drives headless Chrome over its DevTools protocol. For the home page, every system, toolkit page and track, and the concept index, it checks console errors, sideways scroll of the page or of a reading column, overlapping diagram line labels, clipped cards, empty pages, a missing trust card or diagram, one h1 per page, the sticky top bar and text contrast (WCAG AA) in light, warm and dark at 1280px and 500px. A pt-BR pass repeats the layout checks and checks `<html lang>` and the not-translated notice. The dark-theme "lighter = component" legend chip is a known contrast false positive (gradient background) and is excluded.

Still untested: a real phone, a screen reader and a real print dialog. Print was checked only with print-media emulation; the PNG export, study checkboxes and progress saved across reloads were checked by hand in headless Chrome.

### Deferred by decision

- **Confidence tags on diagram edges.** Needs a schema change and hand-tagging a few hundred edges.
- **Per-element alias for clickable names in the note.** Names are matched by text, so an ambiguous name can occasionally link to the wrong element.
- **More agent access.** Static pre-rendering (routes are hash-based, so pages have no URL of their own), an MCP server, a `SKILL.md` and a PR-review rules layer. They came from an external review (2026-10-29, AI-written without access to the site) and were judged out of scope for now.

## Done

| When | What |
|---|---|
| 2026-11-04 | The design review's quick wins: "1 day ago" and "today" on the trust card; no gap between a tag and its full stop; contents labels without raw tags; flow step numbers beside the first line; the size readout inside the settings menu; space below the concept filter; no stray "practice" on exercise steps; "Page not found" for unknown addresses; diagram lines visible in dark, backward lines looped around their boxes and labels that never overlap (checked on all 42 diagrams); clearer dark cards and borders; the toolkit top bar aligned with its column; one disclosure style for every `<details>`. The sweep now also fails on overlapping diagram labels and on reading columns that scroll sideways (the cause of a sideways scroll in note 02, from hidden tag tooltips, fixed the same day). |
| 2026-11-04 | Follow-ups from the 2026-11-03 reviews: wording fixes in notes 03, 23 and 25, P16, P18 and the tracks; design fixes (mobile text view, toolkit tables, page scroll in text view, note typography, focus ring, disclosures, top bar); [`DESIGN.md`](DESIGN.md) documents the design system. |
| 2026-11-03 | Primer P18 (evaluating LLM and agent systems) and additions to notes 23 (Ragas) and 25 (multi-agent coordination failures), with pt-BR mirrors. Two read-only reviews (content, design) found the items above. |
| 2026-11-01 | Systems 36 to 42 (typeahead, job scheduler, CDN, maps and ETA, video conferencing, moderation and fraud ML, authorization and identity) and primers P11 to P17, each in English and pt-BR. |
| 2026-11-01 | Whole site checked in the new design: `npm run sweep`, 800 checks (every page in 3 themes at 2 widths, then in pt-BR at 2 widths, text and graph views at 1280px only), 0 console errors and 0 failures. It had found and the commits fixed two h1 headings on every system page and a favicon 404. |
| 2026-10-31 | Pages deployed by GitHub Actions; the stale `docs/` build deleted. |
| 2026-10-31 | Agent and crawler access: `llms.txt`, `llms-full.txt` and raw Markdown copies generated at build (`scripts/build-llms.ts`), meta tags, `robots.txt`, the MIT and CC BY 4.0 licenses. The external review behind it was checked claim by claim: most of its content gaps were already covered (P16, P03, P05, notes 04, 11, 22 to 28); the two real ones were fixed (tail latency under fan-out in P07, idle consumers beyond the partition count in note 04). |
| 2026-10-29 | Notes 16 and 07 re-read against fresh copies of their sources. Note 16: the `CREATE TABLE ... EXCLUDE` page read (partial constraint syntax and constraint timing quoted), PostgreSQL 18's `UNIQUE ... WITHOUT OVERLAPS` added, the parking example names its `btree_gist` prerequisite, Stripe rules scoped to API v1, Redis `SET NX PX` quoted. Note 07: a non-verbatim quotation now quotes the f4 paper, the presigned-URL expiry follows the current AWS page, the abandoned multipart upload advice cites S3's lifecycle rule, and every number was re-checked. |
| 2026-10-27 | Fresh source review of all content by four read-only reviewers (notes 01-12, 13-23, 24-35, and the toolkit with workbook and site data). About 25 findings fixed: Twitch Create Clip timeout (29); Llama 3 table and GPU share (27); S-LoRA 4x condition (28); Dropbox streaming sync (06); Stripe 429/503 (02); Argos (12); S3 shards and zones (05); Dynamo example (03); peak rate (08); Spotify loudness and codec lines (14); expired holds vs the exclusion constraint (16); crawler connections (20), TP2 (18), multipart URLs (07), WhatsApp group limit tag (08); 26 diagram nodes retagged INDUSTRY PATTERN; composite diagrams 26 and 27 name each part's source; toolkit wording (P11 to P14, C02, W02, W03, a matrix row). The rest are under "Review findings not yet verified". |
| — | One source for the learning order: `site/src/stages.json`, checked by a test against the atlas track and the README. |
| — | Note 15's "dispatch optimization": no primary source gives the expansion (Uber's InfoQ page and slides use the name DISCO only), so the note attributes it to HighScalability's summary. |
