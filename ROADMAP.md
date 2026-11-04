# Roadmap

What is left to do, and why it is not done yet. Open work comes first, grouped by kind; finished work is summarised at the end with its date. Status as of 2026-11-04.

## Open

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

`npm run sweep` (`scripts/browser-sweep.mjs`, start instructions in its header) drives headless Chrome over its DevTools protocol. For the home page, every system, toolkit page and track, and the concept index, it checks console errors, sideways scroll, clipped cards, empty pages, a missing trust card or diagram, one h1 per page, the sticky top bar and text contrast (WCAG AA) in light, warm and dark at 1280px and 500px. A pt-BR pass repeats the layout checks and checks `<html lang>` and the not-translated notice. The dark-theme "lighter = component" legend chip is a known contrast false positive (gradient background) and is excluded.

Still untested: a real phone, a screen reader and a real print dialog. Print was checked only with print-media emulation; the PNG export, study checkboxes and progress saved across reloads were checked by hand in headless Chrome.

### Deferred by decision

- **Confidence tags on diagram edges.** Needs a schema change and hand-tagging a few hundred edges.
- **Per-element alias for clickable names in the note.** Names are matched by text, so an ambiguous name can occasionally link to the wrong element.
- **More agent access.** Static pre-rendering (routes are hash-based, so pages have no URL of their own), an MCP server, a `SKILL.md` and a PR-review rules layer. They came from an external review (2026-10-29, AI-written without access to the site) and were judged out of scope for now.

## Done

| When | What |
|---|---|
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
