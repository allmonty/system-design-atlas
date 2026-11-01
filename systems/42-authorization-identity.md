# 42 — Authorization at Scale (Zanzibar) and Identity

*Real-system note from Google's Zanzibar paper (USENIX ATC 2019) and the standards for identity and delegated access (OAuth 2.0, OpenID Connect, JWT), plus a reference design for a permissions service. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** Two questions sit in front of almost every request: **who is this?** (authentication, identity) and **may they do this to that object?** (authorization). Identity is mostly solved by standards: an identity provider signs users in and issues tokens (OpenID Connect's ID Token, OAuth access and refresh tokens, often JWTs) that services verify without a round trip. Authorization is the harder system problem when permissions are fine-grained and shared: documents in folders shared with groups that contain groups. Google's **Zanzibar** stores every permission as a **relation tuple** (`doc:readme#viewer@group:eng#member`), derives indirect permissions from per-namespace rewrite rules, answers checks in milliseconds from replicated data, and uses consistency tokens (**zookies**) so a check never uses permissions older than the content it protects.

**Key numbers** (as published, 2019)
- Zanzibar: more than two trillion ACLs, more than 1,500 namespaces, millions of checks per second; 95th-percentile latency under 10 ms and availability above 99.999% over 3 years `[CONFIRMED]`.
- Peak load: about 4.2 million Check, 8.2 million Read, 760,000 Expand and 25,000 Write requests per second, on more than 10,000 servers in several dozen clusters `[CONFIRMED]`.
- Check Safe latency at the 50th, 95th, 99th and 99.9th percentiles peaks at about 3, 11, 20 and 93 ms `[CONFIRMED]`.

**Decisions and trade-offs**

| Option | Strength | Weakness |
|---|---|---|
| Permissions inside each service | Simple to start | Inconsistent semantics, hard to share across apps |
| Central relationship-based service (Zanzibar-style) | One model, cross-app sharing, consistent checks | A critical dependency on the request path; hot spots |
| Role-based access (RBAC) | Easy to reason about | Coarse; poor for per-object sharing |
| Attribute or policy rules (ABAC) | Expressive conditions | Harder to index and to answer "who can see X" |
| Self-contained tokens (JWT) | Verified locally, no lookup | Hard to revoke before expiry |
| Opaque tokens with introspection | Revocable at once | A lookup per request |

**Common mistakes**
- Putting permissions in a token: they go stale until it expires.
- Checking authorization against a cache with no bound on staleness (the "new enemy" problem).
- Building a search or list view that checks each result one by one at query time.
- Confusing authentication (ID Token) with authorization (access token, permission check).

---

## 🧒 Non-technical explanation

A big office building has a reception desk that checks your ID and gives you a visitor badge (identity). Each room has a guest list instead of a lock that knows everybody: *the design team may enter*, and somewhere else *Alice is in the design team*. To know if you may enter, the guard follows those lists. And if someone was removed from the design team a minute ago, the guard must not use an old copy of the list for a room that was refurnished after that.

---

## TL;DR for engineers

- **Zanzibar data model:** relation tuples `object#relation@user`, where the user may be a userset (`group:eng#member`); groups are just ACLs with membership semantics `[CONFIRMED]`.
- **Namespace configs:** per-object-type relations and **userset rewrite** rules (for example, editors are viewers; viewers of the parent folder are viewers) `[CONFIRMED]`.
- **API:** Check, Read, Write (with optimistic concurrency), Watch (stream of tuple changes) and Expand (the effective userset tree) `[CONFIRMED]`.
- **Consistency:** external consistency and snapshot reads with bounded staleness on Spanner; zookies make checks at least as fresh as the content version; most checks run on locally replicated data `[CONFIRMED]`.
- **Performance:** a distributed cache sharded by consistent hashing, request deduplication, hedging, timestamp quantisation, and the Leopard index for deep nested groups `[CONFIRMED]`.
- **Identity:** OAuth 2.0 for delegated access, OpenID Connect's ID Token for authentication, JWT as the token format `[CONFIRMED]`.
- **Token lifetimes, gateway enforcement, list filtering, multi-tenant isolation:** reference design `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** sign users in · issue and verify tokens · store permissions (owners, editors, viewers, groups, nested folders) · answer *may U do R on O?* · list what a user can see, or who can see an object · audit changes.

**Non-functional:** **latency** (checks are on the critical path; single-digit milliseconds) · **availability** (if authorization is down, everything is down) · **correctness** (no access after revocation; no stale ACL applied to new content) · **scale** (billions of objects, millions of checks per second) · **auditability**.

**Clarifying questions:** per-object sharing or roles only? Nested groups? Cross-application sharing? How fast must revocation take effect? Do we need *list everything U can see*? Multi-tenant?

---

## 2. Identity: OAuth 2.0, OpenID Connect and JWT `[CONFIRMED]`

**OAuth 2.0** (RFC 6749) "enables a third-party application to obtain limited access to an HTTP service", on behalf of a resource owner or on its own behalf. The authorization server issues an **access token** and optionally a **refresh token**, used to get a new access token when the current one expires, possibly with narrower scope; access tokens may have a shorter lifetime and fewer permissions than the resource owner granted.

**OpenID Connect** is "a simple identity layer on top of the OAuth 2.0" protocol. Its main addition is the **ID Token**, "a security token that contains Claims about the Authentication of an End-User", represented as a JWT.

**JWT** (RFC 7519) is a compact, URL-safe way to carry claims as a JSON object that is signed (JWS) or encrypted (JWE). A service can verify a signed token with the issuer's public key and no network call, which is why short lifetimes matter: the token stays valid until it expires.

## 3. Zanzibar's model (2019) `[CONFIRMED]`

Zanzibar is "a global system for storing and evaluating access control lists" used by hundreds of Google services, including Calendar, Cloud, Drive, Maps, Photos and YouTube. A unified system gives consistent semantics, lets applications interoperate (an object from one embedded in another), supports shared infrastructure such as an access-aware search index, and solves consistency and scale once.

**Relation tuples.** ACLs are collections of relation tuples `⟨object⟩#⟨relation⟩@⟨user⟩`, where the user is a user id or a userset `⟨object⟩#⟨relation⟩`. Examples from the paper: `doc:readme#owner@10` (user 10 owns the doc), `group:eng#member@11`, `doc:readme#viewer@group:eng#member` (members of eng can view), `doc:readme#parent@folder:A#...` (the doc is in folder A). Groups are ACLs with membership semantics, so groups can nest.

**Namespace configuration.** Each namespace (object type) declares relations and **userset rewrite** rules combined by union, intersection and exclusion: `_this` (direct tuples), `computed_userset` (another relation on the same object: every owner is an editor, every editor a viewer) and `tuple_to_userset` (follow a relation to another object: viewers of the parent folder are viewers of the doc). Tuples hold the facts; the config holds the policy.

**API.** **Check** evaluates a userset expression at a snapshot; **Read** returns tuples; **Write** changes tuples, with read-modify-write using optimistic concurrency via a lock tuple; **Watch** streams tuple changes from a zookie so clients can maintain secondary indexes; **Expand** returns the effective userset tree.

## 4. Consistency: the "new enemy" problem and zookies `[CONFIRMED]`

Two failure examples drive the design: Alice removes Bob from a document and then adds new content, and Bob sees it because the check used an ACL from before his removal; or ACL changes are applied out of order. Zanzibar must respect causal ordering between ACL and content updates, so it provides **external consistency** and **snapshot reads with bounded staleness**, storing ACLs in **Spanner**, whose TrueTime timestamps reflect causal order.

To avoid global round trips, clients cooperate: when content is about to be saved, the client asks for a **zookie**, an opaque token encoding a global timestamp later than all prior ACL writes, and stores it atomically with the content. Later checks on that content send the zookie, and Zanzibar evaluates at a snapshot at least that fresh, which is usually already replicated locally. Freedom to pick any fresh-enough timestamp also lets it quantise timestamps to share cache entries.

## 5. Architecture and performance `[CONFIRMED]`

**aclservers** in clusters answer Check, Read, Expand and Write; a request lands on any server, which fans out to others (for example to walk nested groups). **watchservers** serve Watch from a changelog. Spanner holds one database of relation tuples per client namespace, one for all namespace configs, and one changelog shared by all namespaces; watchservers tail the changelog, and an offline pipeline dumps namespace snapshots.

Hot spots were "the most critical frontier" for latency and availability. Servers in a cluster form a **distributed cache** for reads and check results, including intermediate results, placed by **consistent hashing**; simultaneous identical requests are **deduplicated**; timestamps are quantised so requests share cache entries. Calls to Spanner and Leopard use **request hedging**: send to several servers, use the first answer, cancel the rest. Aggressive caching and pooling keep Spanner reads at about 20 million RPCs per second; 1% of them (200,000 per second) benefit from hedging. **Leopard** is an indexing system for large, deeply nested sets: it reads periodic snapshots, watches changes, and denormalises group membership to answer set queries quickly.

---

## 6. Reference design `[INDUSTRY PATTERN]`

- **Identity provider:** sign-in (passwords, passkeys, federation), MFA, sessions; issues short-lived access tokens and longer-lived refresh tokens; publishes signing keys for local verification and rotates them.
- **Gateway:** verifies the token signature, audience and expiry, rejects early, and passes the user id downstream; never trusts permissions inside the token for object access.
- **Permissions service (Zanzibar-style):** tuples in a strongly consistent, replicated store; namespace configs as reviewed code; Check with a consistency hint (a zookie-like token stored with each object, or "latest" for sensitive writes); a cache sharded by consistent hashing.
- **List and search filtering:** a Watch-fed index (like Leopard) or per-user materialised views for "what can U see"; post-filter search results with batched checks.
- **Revocation:** delete tuples (effective on the next check at a fresh snapshot); for tokens, short lifetimes plus a deny list for urgent cases.
- **Audit:** every tuple change logged with who and why.
- **Multi-tenancy:** tenant id in every object id and namespace, so a missing check cannot cross tenants (see [P14 Multi-tenancy](../toolkit/P14-multi-tenancy.md)).

---

## 7. Failure scenarios

- **New enemy.** A check uses an ACL older than the content; prevented by evaluating at a snapshot at least as fresh as the content's zookie `[CONFIRMED]`.
- **Hot group or object.** A popular group overloads storage; caching intermediate results, deduplication and timestamp quantisation spread it `[CONFIRMED]`.
- **Slow backend replica.** Hedged requests cut the tail `[CONFIRMED]` (see the tail-latency section of [P07](../toolkit/P07-slos-and-incidents.md)).
- **Permissions service unavailable.** Fail closed for writes and sensitive reads; consider a short-lived cached allow for low-risk reads, logged `[INDUSTRY PATTERN]`.
- **Signing key leaked.** Rotate the key and revoke tokens signed with it; services must fetch keys by id, not hard-code them `[INDUSTRY PATTERN]`.
- **Clients see worse latency than the service reports.** Zanzibar measures latency on the server side, partly because client jobs are outside its control and sometimes overloaded; measure on both sides before blaming either `[CONFIRMED]` for the measurement choice / `[INDUSTRY PATTERN]` for the advice.

---

## 8. Capacity reasoning (illustrative)

- Zanzibar's peak reads (Check plus Read about 12.4 million per second) against 25,000 writes is about 500 reads per write, which is why it optimises for reads and caching (our arithmetic on the paper's numbers).
- A document app with 100 million users, each opening 50 objects a day with 3 checks per open, makes 15 billion checks a day, about 174,000 per second on average.
- Two trillion tuples at an assumed 50 bytes each is about 100 TB before replication; the paper does not give tuple sizes.

---

## ⚠️ Reviewer notes

1. **The Zanzibar numbers are from 2019 (December 2018 measurements)** and describe Google's system then.
2. **Open-source systems inspired by Zanzibar** (SpiceDB, OpenFGA and others) exist; we did not read their docs and make no claims about them.
3. **Interview articles often reduce authorization to RBAC.** Zanzibar shows that shared, nested, per-object permissions need a relationship model and explicit consistency.
4. **We did not read the OAuth 2.0 Security Best Current Practice or OAuth 2.1 drafts**, which change recommended flows (for example, PKCE for all clients).

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the sources. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **security**, **availability**, **performance** (critical path), **consistency**, **auditability**.
- **Style (Ch 13–17):** a shared **platform service** behind every product; identity at the edge (gateway), authorization as a central service.
- **Quanta (Ch 7):** the identity provider and the permissions service are separate quanta that almost every other quantum depends on, so they need the strictest availability targets.
- **Trade-off (First Law, Ch 1):** **freshness vs latency.** Checking at the latest snapshot is always correct and slow; zookies let most checks use a slightly older snapshot that is still provably fresh enough.
- **ADR sketch (Ch 19):** *"We will store permissions as relation tuples in one service, evaluate checks at a snapshot no older than the object's stored consistency token, and keep JWT access tokens to 10 minutes with no object permissions inside. We accept a central dependency in exchange for consistent, revocable, shareable permissions."*
- Plain English: the guest list on the door, kept up to date, beats a badge that lists every room.

---

## Interview questions to practice

1. Design the permissions system for Google Drive.
2. How do you make a revocation take effect immediately?
3. How would you show a user only the documents they can see in search results?
4. JWT or opaque tokens? How do you revoke a JWT?
5. Authentication versus authorization: where does each happen in your design?
6. The permissions service is down. What happens to the product?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the sources.

**A 45-minute walkthrough**

1. Clarify: sharing model, nesting, cross-app, revocation speed, listing needs, tenants.
2. Estimate: checks per second, tuples, read to write ratio ([P01](../toolkit/P01-estimation.md)).
3. API: `check(object, relation, user, consistency)`, `write(tuples)`, `read(filter)`, `watch(namespace, from)`, `expand(object, relation)`.
4. Design: identity provider and tokens, gateway verification, tuple store, namespace configs, check evaluation with cache, watch-fed indexes.
5. Deep dive: new enemy and consistency tokens; nested groups and hot spots.
6. Failure and scale: service down, hot groups, key rotation, 10× checks.

**If it grows 10×**
- More cache capacity per cluster and more clusters near load.
- Denormalised indexes for deep groups (Leopard-style).
- Batch checks for list views; push filtering into indexes.

**Answer outlines** (try the questions above first)

<details><summary>Immediate revocation</summary>

Delete the tuple, and make the next check on that object evaluate at a snapshot at least as new as the deletion. Zanzibar does this by storing a consistency token with each content version and by allowing callers to ask for a fresh evaluation. Do not rely on long-lived tokens that carry permissions; keep access tokens short and check object permissions server-side.

</details>

<details><summary>Search results a user may see</summary>

Checking each hit at query time is slow for large result sets. Keep an access-aware index fed by the permission change stream (Zanzibar's Watch API exists for this), filter in the index, then confirm the top results with batched checks.

</details>

<details><summary>JWT revocation</summary>

A signed JWT is valid until it expires, by design. Keep lifetimes short, refresh with a refresh token that the server can revoke, keep a small deny list for emergencies, and never put object permissions in the token.

</details>

## 📚 Further reading

- The sources listed under Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [33 Coordination](33-distributed-coordination-locks.md), [32 Distributed cache](32-distributed-cache.md), [06 File sync (Dropbox)](06-file-sync-dropbox.md), [P06 Security](../toolkit/P06-security-threat-modeling.md), [P14 Multi-tenancy](../toolkit/P14-multi-tenancy.md), [P16 Consistency](../toolkit/P16-consistency-and-cache-failures.md).

## Sources and provenance

> **Kind:** real system (Google Zanzibar) and standards (OAuth 2.0, OpenID Connect, JWT), with a reference design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-11-01:** Ruoming Pang et al., [*Zanzibar: Google's Consistent, Global Authorization System*](https://www.usenix.org/system/files/atc19-pang.pdf) (USENIX ATC, July 2019) · IETF, [RFC 6749, The OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749.txt) (2012) · OpenID Foundation, [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) · IETF, [RFC 7519, JSON Web Token](https://www.rfc-editor.org/rfc/rfc7519.txt) (2015).
> **Dated material:** Zanzibar measurements are from December 2018; RFC 6749 is from 2012 and has later best-practice updates not read here.
> **Not read:** OAuth 2.0 Security BCP, OAuth 2.1, PKCE (RFC 7636), WebAuthn and passkeys, SpiceDB and OpenFGA docs, Google's Leopard internals beyond the paper.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-11-01, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Zanzibar paper: the client services, the reasons for a unified system, relation tuples and the Table 1 examples, groups as ACLs, namespace configs and userset rewrites (`_this`, `computed_userset`, `tuple_to_userset`), the Check, Read, Write, Watch and Expand APIs, optimistic concurrency with a lock tuple, the new enemy examples, external consistency and bounded-staleness snapshots on Spanner, zookies, aclservers and watchservers, the distributed cache with consistent hashing, deduplication, quantised timestamps, hedging, Leopard, and the numbers (two trillion ACLs, 1,500 namespaces, peak QPS by API, 10,000 servers, latency percentiles, 99.999%, 20 million Spanner RPCs, 1% hedged).
- Verified in RFC 6749: the abstract, refresh tokens and narrower-scope access tokens; in OpenID Connect Core: the identity layer and the ID Token as a JWT; in RFC 7519: the JWT definition.
- Not sourced (our reasoning): the reference design, token lifetimes, gateway behaviour, deny lists, fail-closed policy, list filtering, multi-tenant ids and the capacity arithmetic.
- Not claimed: how Google's Zanzibar runs today, or how any open-source Zanzibar-inspired system works.
