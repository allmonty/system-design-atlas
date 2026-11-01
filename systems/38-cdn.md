# 38 — Content Delivery Network (CDN)

*Real-system note from Akamai engineers' account of their CDN's algorithms (Maggs and Sitaraman, 2015), Cloudflare's cache documentation and RFC 9111 (HTTP caching), plus a reference design. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** A CDN puts shared caches near users and answers from them, so that most bytes never cross the long path to the origin. A request goes through three decisions: **which cluster** (DNS, by the location of the user's resolver, balancing performance, load and cost), **which server in the cluster** (consistent hashing of the content, so each object lives on few servers), and, on a miss, **where to fetch from** (peers in the cluster, a parent tier, then the origin). Caching rules come from HTTP (freshness, validation, the cache key); the CDN adds tiering to protect the origin, filters what is worth caching, serves stale content while it revalidates, and purges on demand. Content that cannot be cached still benefits: the CDN relays it over chosen overlay paths.

**Key numbers** (as published)
- Akamai: over 170,000 edge servers in over 1,300 networks in 102 countries, serving 15 to 30% of all web traffic (at the time of the 2015 paper) `[CONFIRMED]`.
- In one cluster, 74% of about 400 million objects were accessed only once in two days; caching only on the second hit raised the byte hit rate from about 74% to 83% and cut disk writes by 44% `[CONFIRMED]`.
- Everything else here (hit ratios, purge times, tier counts) is illustrative.

**Decisions and trade-offs**

| Option | Strength | Weakness |
|---|---|---|
| DNS-based cluster selection | Works for any client, fine-grained control | Sees the resolver, not the user; DNS TTLs slow reaction |
| Anycast routing to the nearest site | Simple, fast failover by routing | Less control over which site serves whom |
| Consistent hashing within a cluster | Each object on few servers, high hit ratio | Hot objects need more than one server |
| Tiered cache (lower and upper tiers) | Fewer origin fetches and connections | Extra hop on a miss |
| Cache on second hit | More room for popular objects, fewer disk writes | First requests always miss |
| Long TTLs with purge | High hit ratio | Purge must be reliable and fast |

**Common mistakes**
- Leaving cookies or tracking parameters in the cache key, so nothing is ever a hit.
- Caching personalised responses in a shared cache (a privacy incident, not a performance bug).
- Forgetting that every edge miss for a new object can reach the origin at once without tiering or request collapsing.
- Treating the CDN as only static files: it also terminates TLS and relays dynamic traffic.

---

## 🧒 Non-technical explanation

A popular bakery opens small shops all over town. Each shop keeps the breads most people buy. If a shop runs out, it asks the other counters in the same shop, then a bigger regional shop, and only as a last resort the main bakery. A shop does not stock a bread the first time someone asks, because most breads asked for once are never asked for again. When the bakery changes a recipe, it phones every shop to throw out the old loaves.

---

## TL;DR for engineers

- **Request path (Akamai):** the CDN's authoritative DNS picks a cluster from the resolver's address (or EDNS client subnet) with a stable-allocation algorithm; a second level of DNS picks servers in the cluster by consistent hashing of the customer's serial number; misses go to cluster peers, then a parent cluster, then the origin `[CONFIRMED]`.
- **What to cache (Akamai):** most objects are one-hit wonders; a cache-on-second-hit rule with two rotating Bloom filters saves disk and raises hit rate `[CONFIRMED]`.
- **Tiering and staleness (Cloudflare):** lower tiers ask upper tiers, and only upper tiers ask the origin; with `stale-while-revalidate` the edge serves stale content and revalidates in the background; purge by URL, tag, prefix or host, rate-limited by token bucket `[CONFIRMED]`.
- **HTTP rules (RFC 9111):** shared versus private caches, the cache key (method and target URI, plus `Vary` headers), freshness and validation `[CONFIRMED]`.
- **Cache-key design, request collapsing, origin shield sizing, purge strategy:** reference design `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** serve cacheable content from the edge · fetch misses from the origin · honour HTTP caching rules · purge or invalidate on demand · relay uncacheable traffic · terminate TLS.

**Non-functional:** **latency** (nearby edge) · **availability** (survive server, cluster and network failures) · **origin protection** (few origin requests and connections) · **hit ratio** · **cost** (bandwidth and storage) · **isolation between customers**.

**Clarifying questions:** static files, video segments or dynamic pages? How fresh must content be? How fast must a purge take effect? Is any content personalised? Where are the users?

---

## 2. How a request finds a server (Akamai) `[CONFIRMED]`

The client's resolver asks the CDN's authoritative name server, which looks at the resolver's address (or the EDNS client subnet it forwards) and picks a cluster. That choice is **global load balancing**: map units (groups of clients) have preferences over clusters, clusters have capacities, and a variant of the stable marriage algorithm assigns them, balancing performance, load across clusters and cost. Demand changes quickly; the paper names "flash crowds" as a normal event.

Inside the chosen cluster, **local load balancing** uses consistent hashing. Objects are not hashed one by one: each customer gets serial numbers, and all objects with one serial number hash to the same server, or the same set of servers when popular, so a browser can fetch a page's objects over one persistent connection. The customer points a hostname at a CDN name with a CNAME; for each serial number the name server keeps a random ordering of the cluster's servers and returns the first k that are up, k depending on current popularity, in random order to spread load.

On a request, the edge server checks its cache; on a miss it asks other servers in its cluster, then may ask a "parent" cluster, and only then the origin.

Every decision-making component (the global and local load balancers among them) runs replicated on many servers in several data centers; each computes its answer independently, and a **leader election** picks whose output the rest of the system uses, because failures of servers and whole data centers are common.

## 3. What is worth caching (Akamai) `[CONFIRMED]`

In logs from a 45-server cluster over two days, about three-quarters of some 400 million objects were requested once and 90% fewer than four times. Caching such "one-hit-wonders" wastes disk and writes. The **cache-on-second-hit** rule records requested objects in a Bloom filter and caches an object only if it was seen before; two filters (a primary and a secondary, rotated when the primary fills) keep false positives bounded and let old objects be forgotten. In a field test on about 47 servers, the byte hit rate rose from around 74% to 83% and disk writes fell from about 10,209 to 5,738 per second, 44% fewer.

Bloom filters also serve **cache summarisation**: servers exchange compact summaries so one can find which peer holds an object (Squid calls these digests), which needs counting Bloom filters to support deletion.

## 4. Uncacheable content and overlay routing (Akamai) `[CONFIRMED]`

Dynamic sites, applications and live video cannot be served from cache, yet the edge still acts as their front end. Relaying through CDN servers as an overlay network can "reduce download time and increase availability": the CDN explores several paths between the edge and the origin, picks the faster ones, and has spares when a path fails.

## 5. Tiers, staleness and purging (Cloudflare) `[CONFIRMED]`

**Tiered cache** divides data centers into lower tiers (near users) and upper tiers; on a miss a lower tier asks an upper tier, and "only the upper-tier can ask the origin for content", which raises hit ratios and concentrates origin connections in a few locations. Cloudflare picks the upper tier per origin by measured latency (Smart Tiered Cache) or by a consistent hash of the cache key within a regional pool (Generic Global); changing origin IPs can move the upper tier and cause a burst of misses while the new tier fills.

**Revalidation.** When a cached asset expires and the origin sent `stale-while-revalidate`, the first request triggers background revalidation and it and later requests get the stale copy until the origin answers; conditional requests with `If-Modified-Since` and ETags avoid re-downloading unchanged content. Without the directive, users wait for the origin. `must-revalidate`, `proxy-revalidate` and `s-maxage` prevent serving stale content.

**Purge.** Content can be purged by URL (recommended), or by tag, prefix, hostname or everything, or marked stale (invalidated) so it is revalidated on next use. A successful purge response means the request was received, not that an object was evicted. Purge requests are rate-limited with a token bucket per plan.

## 6. HTTP caching rules (RFC 9111) `[CONFIRMED]`

A **shared cache** stores responses for reuse by more than one user (a CDN); a **private cache** is for one user (the browser). The **cache key** is composed at minimum of the request method and target URI; many caches store only GET and so key by URI alone, and content negotiation adds the request headers named in `Vary`. Freshness and validation decide whether a stored response can be reused without asking the origin.

---

## 7. Reference design `[INDUSTRY PATTERN]`

- **Edge PoPs** with TLS termination, an HTTP cache (memory for hot objects, disk for the rest) and request collapsing, so concurrent misses for one object make one upstream fetch.
- **Routing** by DNS (control) or anycast (simplicity), with health checks that withdraw a PoP.
- **Within a PoP**, consistent hashing of the cache key across servers; replicate hot keys.
- **Shield tier** (an upper tier per origin) in front of the origin.
- **Cache-key policy per customer:** strip tracking parameters, ignore cookies unless the response varies on them, normalise case and query order.
- **Invalidation:** versioned URLs for static assets (`app.3f9a.js`) so no purge is needed; tag-based purge for content; a purge bus that fans out to every PoP and acknowledges.
- **Config and logs:** a control plane distributes customer configuration; logs stream back for billing and analytics.

---

## 8. Failure scenarios

- **An edge server dies.** DNS stops returning it (it is skipped in the server list); consistent hashing moves only its objects `[CONFIRMED]` (Akamai) / `[INDUSTRY PATTERN]`.
- **A whole data center fails.** Decision components are replicated across data centers, and a leader election picks the surviving output `[CONFIRMED]` (Akamai).
- **Flash crowd for one object.** Popular serial numbers get more servers; request collapsing and tiering keep the origin from seeing the spike `[CONFIRMED]` for Akamai's popularity-based k / `[INDUSTRY PATTERN]` for collapsing.
- **Origin slow or down.** Serve stale where the origin allowed it (`stale-while-revalidate`, and `stale-if-error` from RFC 5861, not read here) `[CONFIRMED]` / `[SPECULATIVE]`.
- **A bad deploy on the origin is cached everywhere.** Purge by tag, or roll back the versioned URL `[INDUSTRY PATTERN]`.
- **A personalised page cached in a shared cache.** Users see each other's data; mark such responses `private` or `no-store` and keep cookies out of cacheable paths `[INDUSTRY PATTERN]`.

---

## 9. Capacity reasoning (illustrative)

- A site serving 10 Gbit/s at a 95% byte hit ratio sends 0.5 Gbit/s to the origin; at 80%, 2 Gbit/s, four times more. Hit ratio is the lever on origin cost (our arithmetic).
- With 300 PoPs and no tiering, a new object can cause up to 300 origin fetches; with one upper tier per origin, one (plus misses during fills).
- A PoP with 20 servers and 10 TB of disk each holds 200 TB if objects are hashed to one server, but only 100 TB of distinct content if each object is stored twice.

---

## ⚠️ Reviewer notes

1. **The Akamai figures are from the 2015 paper** (an editorial note, not peer reviewed, by authors who built the system); the network has changed since.
2. **Cloudflare's docs describe current product behaviour**, which changes; the Smart Tiered Cache and Smart Shield names are product names.
3. **Popular articles often equate a CDN with static file hosting.** Both sources describe relaying uncacheable traffic as a core function.
4. **Not read:** Akamai's 2010 overview paper (*The Akamai Network*), Cloudflare's anycast architecture posts, RFC 5861 (`stale-while-revalidate`, `stale-if-error`), and Netflix Open Connect (see [13 Netflix](13-netflix.md)).

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the sources. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **performance** (latency), **availability**, **scalability**, **cost** (bandwidth), **elasticity** for flash crowds.
- **Style (Ch 13–17):** a **space-based**-like edge of caches in front of origins, with a separate **control plane** for routing and configuration.
- **Quanta (Ch 7):** each PoP serves on its own; the control plane and the origins are separate quanta.
- **Trade-off (First Law, Ch 1):** **freshness vs hit ratio.** Longer TTLs mean fewer origin requests and older content; purge and revalidation buy back freshness at a cost.
- **ADR sketch (Ch 19):** *"We will version static asset URLs and cache them for a year, cache HTML for 60 seconds with stale-while-revalidate, and purge by tag on publish. We accept up to a minute of staleness for HTML in exchange for a high hit ratio."*
- Plain English: keep the popular bread in the local shop.

---

## Interview questions to practice

1. Design a CDN.
2. How does a user's request reach a nearby server, and what are the options?
3. How do you keep a new popular object from overloading the origin?
4. What goes into the cache key, and what goes wrong if you get it wrong?
5. How do you purge content worldwide, and how fast can it be?
6. How does a CDN help with content that cannot be cached?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the sources.

**A 45-minute walkthrough**

1. Clarify: content types, freshness, purge speed, personalisation, geography.
2. Estimate: peak bandwidth, hit ratio, origin egress, storage per PoP ([P01](../toolkit/P01-estimation.md)).
3. API: customer config (origin, cache rules), purge API, logs.
4. Design: routing (DNS or anycast), PoP internals (consistent hashing, memory and disk), tiering, origin shield.
5. Deep dive: cache key and Vary, admission (second hit), revalidation, purge fan-out.
6. Failure and scale: server, PoP and origin failures, flash crowds, 10× traffic.

**If it grows 10×**
- Add PoPs and capacity per PoP; raise k for hot content.
- Add regional tiers so upper-tier misses do not cross continents.
- Push more decisions to the edge (compute at the edge) for dynamic content.

**Answer outlines** (try the questions above first)

<details><summary>A new popular object and the origin</summary>

Without protection, every PoP misses at once and each sends a fetch. Collapse concurrent misses in each PoP into one fetch, route misses through one upper tier per origin, and pre-warm if the launch is known. Serve stale on expiry while revalidating.

</details>

<details><summary>Cache key mistakes</summary>

Too broad (cookies, tracking parameters, header variations) and nothing hits; too narrow (ignoring a header the response depends on, such as language or authorisation) and users get the wrong or someone else's content. Start from method and URI, add only what the response varies on, and normalise.

</details>

<details><summary>Global purge</summary>

Prefer versioned URLs so most changes need no purge. For the rest, publish purge requests (by URL or tag) on a bus every PoP subscribes to, have each PoP acknowledge, and measure time to the last acknowledgement. Rate-limit purges so one customer cannot flood the system.

</details>

## 📚 Further reading

- The sources listed under Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [13 Netflix](13-netflix.md) (Open Connect), [12 YouTube](12-youtube.md), [29 Live streaming](29-live-streaming-twitch.md), [32 Distributed cache](32-distributed-cache.md), [P04 Load balancing](../toolkit/P04-load-balancing.md), [C02 Cloudflare 2019](../toolkit/C02-cloudflare-2019.md).

## Sources and provenance

> **Kind:** real-system parts (Akamai, Cloudflare) and a standard (RFC 9111), with a reference design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-31:** Bruce M. Maggs and Ramesh K. Sitaraman, [*Algorithmic Nuggets in Content Delivery*](https://people.cs.umass.edu/~ramesh/Site/HOME_files/CCRpaper_1.pdf) (ACM SIGCOMM Computer Communication Review, editorial note, 2015) · Cloudflare, [Tiered Cache](https://developers.cloudflare.com/cache/how-to/tiered-cache/), [Revalidation](https://developers.cloudflare.com/cache/concepts/revalidation/) and [Purge cache](https://developers.cloudflare.com/cache/how-to/purge-cache/) (current docs) · IETF, [RFC 9111, HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.txt) (2022).
> **Dated material:** the Akamai figures are from 2015; Cloudflare's docs describe current behaviour.
> **Not read:** *The Akamai Network* (2010; the PDF returned 403), RFC 5861, Cloudflare's anycast and network posts, other CDNs' documentation.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-31, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Akamai paper: the DNS request path, stable-allocation global load balancing, flash crowds, serial numbers and consistent hashing with popularity-dependent k, the peer, parent and origin order, overlay routing for uncacheable content, replicated components with leader election, the 170,000 servers, 1,300 networks, 102 countries and 15 to 30% of web traffic, the one-hit-wonder analysis, the two-filter cache-on-second-hit rule and the 74% to 83% and 44% results.
- Verified in Cloudflare's docs: lower and upper tiers, only upper tiers contacting the origin, Smart and Generic Global selection, the miss burst after origin changes, background revalidation with stale-while-revalidate, the directives that disable it, purge methods, the meaning of a successful purge, and token-bucket purge limits.
- Verified in RFC 9111: shared and private caches, and the cache key.
- Not sourced (our reasoning): the reference design, request collapsing, cache-key policy, versioned URLs, the purge bus, and the capacity arithmetic.
- Not verified: `stale-if-error` (RFC 5861 not read), so its line is tagged speculative.
