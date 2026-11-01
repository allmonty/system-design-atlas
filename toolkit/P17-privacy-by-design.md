# P17 — Privacy by design for system architects

*A primer on turning privacy requirements into architecture: what the EU's data protection by design and by default obligation asks for (as interpreted by the European Data Protection Board), how NIST frames privacy risk, and how Meta enforces purpose limitation in code. Statements from those documents are tagged; the design patterns and interview advice are our reasoning and are labelled.*

## At a glance

- Privacy is a property of the **data flows**, not of one database. A design is private when you can say, for every piece of personal data, why it is collected, where it goes, who can use it for what, and when it is deleted.
- The GDPR's Article 25 makes this an obligation: build data protection principles into the design "at the time of determination of the means for processing", and by default process only what each purpose needs.
- Four principles become architecture: **data minimisation** (collect and keep less), **purpose limitation** (use data only for the stated purpose), **storage limitation** (delete on schedule, including backups and logs) and **security** (protect what remains).
- Point checks (an `if` in code, an ACL on a table) do not follow data once it is copied. Meta moved to **information flow control**: label data, and let the infrastructure block flows to disallowed purposes at runtime.
- In an interview, privacy shows up as concrete design choices: what you do not collect, what you aggregate or pseudonymise, where deletion propagates, and how you prove it.

---

## 1. What the law asks of the design `[CONFIRMED]` (EDPB Guidelines 4/2019 on Article 25)

The EDPB describes the "core obligation" as "the implementation of appropriate measures and necessary safeguards that provide effective implementation of the data protection principles" and the data subjects' rights, by design and by default.

- **When:** at the time the means of processing are decided, which the EDPB says ranges from the general to the detailed design elements, "including the architecture, procedures, protocols, layout and appearance". It also applies during processing (measures must be reviewed regularly) and "also applies to existing systems that are processing personal data".
- **By default:** only personal data necessary for each specific purpose are processed, and personal data must not be made accessible "to an indefinite number of natural persons" without the individual's intervention. A sharing setting that defaults to public fails this.
- **Data minimisation:** controllers should first decide whether they need personal data at all, and whether "less detailed or aggregated personal data" would do; when identification is no longer needed (for example after aggregation into statistics), delete or anonymise.
- **Storage limitation** elements the EDPB lists: clear procedures for deletion and anonymisation, testing that anonymised data cannot be re-identified and deleted data cannot be recovered, **automated** deletion, a justified retention period per purpose, enforcement of retention policies, and retention decisions for **backups and logs**; controllers should limit "temporary" copies along data flows.

## 2. How NIST frames privacy risk `[CONFIRMED]` (NIST Privacy Framework 1.0, 2020)

NIST treats privacy events as potential problems individuals could experience from a system's operations on data, across the whole life cycle from collection through disposal. Its Core has five Functions: **Identify-P** (inventory and map data processing), **Govern-P**, **Control-P** (manage data with enough granularity to handle risk), **Communicate-P** and **Protect-P**; Protect-P covers cybersecurity-related privacy events such as breaches. The point for architects: security protects data from outsiders, but privacy risk also comes from authorised processing, so it needs its own controls.

## 3. Purpose limitation in infrastructure: Meta's Policy Zones `[CONFIRMED]` (Meta Engineering, August 2024)

Meta describes **purpose limitation** as ensuring "data is only processed for explicitly stated purposes". Point checks (if statements in code, access controls on datasets) are fragile: they need "frequent and exhaustive code audits", and when a job reads from a source and writes to a sink, the restriction must be propagated by hand. Adding **data lineage** (tracking source-to-sink flows by static analysis, logging and query processing) helps at small scale but still relies on audits and is not real-time.

Meta's answer is **information flow control** through **Policy Zones**, part of its Privacy Aware Infrastructure:

- Data assets are **annotated** with a label (at table, column, row or potentially cell level), and the label carries flow rules listing allowed purposes.
- When annotated data is processed, a **zone** is created around the request, function call stack or batch job, and the runtime checks every flow; writing labelled data to a sink outside the zone is a violation.
- A zone first runs in **logging mode**; once violations are fixed (annotate the sink, or remove the flow), it moves to **enforcement**, after which a new disallowed write is blocked automatically.
- Policy Zones is integrated in function-based systems (web, middle tier, backends) and batch systems (SQL in the warehouse), so labels follow data across systems; systems without it still use point checks.
- Adoption across hundreds of systems needed tooling (Policy Zone Manager) to find source assets, discover downstream flows and remediate.

---

## 4. Patterns that turn principles into architecture `[INDUSTRY PATTERN]`

| Principle | Pattern | Example |
|---|---|---|
| Minimisation | Collect the coarsest data that works; aggregate early | Store city instead of GPS trace for analytics; drop raw events after aggregation ([31](../systems/31-ad-click-aggregation.md)) |
| Minimisation | Pseudonymise identifiers at ingestion | Replace user id with a keyed hash in the analytics pipeline; keep the key elsewhere |
| Purpose limitation | Label data by purpose and enforce at the platform | Column tags plus a query engine that refuses joins across purposes |
| Storage limitation | Retention as configuration, with automatic deletion | TTL on tables and topics; per-dataset retention reviewed with the data owner |
| Erasure | A deletion service that fans out to every store | Deletion request id, a registry of stores holding user data, per-store acknowledgements, verification |
| Erasure in backups | Crypto-shredding | Encrypt each user's data with a per-user key; delete the key to make backups unreadable |
| Access | Least privilege and audited access | Fine-grained permissions ([42](../systems/42-authorization-identity.md)); access logs reviewed |
| Defaults | Private by default | New posts visible to friends, not public; opt-in, not opt-out, for extra uses |
| Transparency | Data inventory and lineage | Every dataset has an owner, a purpose and a retention, discoverable in a catalogue |

**Deletion is the hardest part.** User data spreads to caches ([32](../systems/32-distributed-cache.md)), search indexes, logs, warehouses, ML features, backups and third parties. Design the registry of where data lives before you need to delete, give every store a deletion handler, make deletion idempotent and retried, and measure completion time.

**Logs are personal data too.** Request logs with IPs, user ids and payloads are often the largest uncontrolled copy. Redact at the source, keep logs short, and separate security logs (longer, restricted) from debug logs (short).

---

## 5. Using this in a design discussion `[INDUSTRY PATTERN]`

1. Name the personal data the system touches and the purpose of each.
2. Say what you will not collect, and where you aggregate or pseudonymise.
3. Draw the data flows and mark where each purpose ends.
4. State retention for each store, including logs and backups, and how deletion propagates.
5. Say how access is limited and audited, and what the defaults are.
6. Say how you would prove it: inventory, lineage, deletion verification, audits.

---

## Questions to practise

1. A product manager wants to keep raw location history forever, just in case a future feature needs it. What do you propose instead?
2. Design account deletion for a social network with caches, search, a warehouse, ML features and nightly backups.
3. Why are point checks not enough for purpose limitation, and what replaces them?
4. What does "by default" change in the design of a sharing feature?
5. Your request logs contain email addresses. What do you change?

**Related:** [P06 Security and threat modeling](P06-security-threat-modeling.md), [P14 Multi-tenancy](P14-multi-tenancy.md), [08 Chat (end-to-end encryption)](../systems/08-chat-whatsapp.md), [42 Authorization and identity](../systems/42-authorization-identity.md), [31 Stream aggregation](../systems/31-ad-click-aggregation.md), [41 Moderation and fraud](../systems/41-moderation-fraud-ml.md).

## Sources and provenance

> **Sources read on 2026-11-01:** European Data Protection Board, [Guidelines 4/2019 on Article 25 Data Protection by Design and by Default, version 2.0](https://www.edpb.europa.eu/sites/default/files/files/file1/edpb_guidelines_201904_dataprotection_by_design_and_by_default_v2.0_en.pdf) (adopted 20 October 2020) · NIST, [Privacy Framework: A Tool for Improving Privacy through Enterprise Risk Management, Version 1.0](https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.01162020.pdf) (16 January 2020) · Meta Engineering, [How Meta enforces purpose limitation via Privacy Aware Infrastructure at scale](https://engineering.fb.com/2024/08/27/security/privacy-aware-infrastructure-purpose-limitation-meta/) (27 August 2024).
> **Dated material:** The EDPB guidelines are from 2020 and interpret the GDPR as it then stood; NIST has since worked on a revised framework not read here.
> **Not read:** The GDPR text itself on EUR-Lex (the page could not be fetched by our tools, so Article 25 is cited as quoted and interpreted by the EDPB), Brazil's LGPD, California's CCPA/CPRA, Cavoukian's seven principles, and Meta's other Privacy Aware Infrastructure posts.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning. This primer is not legal advice.

---
## ✅ Verification log

*Fact-check, 2026-11-01, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the EDPB guidelines: the core obligation, the time of determination of the means and what means include, application to existing systems, processing by default only what each purpose needs, the indefinite-number rule, the minimisation steps including aggregated data and deletion after identification is no longer needed, and the storage limitation elements (deletion, testing, automation, justification, enforcement, backups and logs, temporary copies).
- Verified in the NIST Privacy Framework: privacy events across the data life cycle, the five Functions and Protect-P's focus on cybersecurity-related events.
- Verified in Meta's post: the definition of purpose limitation, the weaknesses of point checks and lineage, information flow control, annotations and their granularity, zones, logging then enforcement, integration in function-based and batch systems, and Policy Zone Manager.
- Not verified: the GDPR article text directly; quotations of Article 25 come through the EDPB guidelines.
- Not sourced (our reasoning): the pattern table, deletion service, crypto-shredding, log advice and the design-discussion checklist.
