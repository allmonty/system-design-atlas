# 36 — Typeahead and Autocomplete

*Real-system parts from Facebook's typeahead (2010), LinkedIn's Cleo (2012), Google's description of Autocomplete (2020) and the Elasticsearch completion suggester docs, plus a reference design for query completion. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** Typeahead returns a short ranked list while the user is still typing, so every keystroke is a query and the latency budget is tens of milliseconds. There are two products under one name: **entity typeahead** (find a person, page or company; the results are records, often personalised by the social graph) and **query completion** (finish the search the user is typing; the suggestions come from past queries). Both precompute heavily: prefix indexes held in memory, global results cached, per-user data shipped to the browser in advance. The design questions are where the prefix index lives, how it is ranked and refreshed, how personalisation is merged with global results, and which suggestions must never be shown.

**Key numbers** (as published)
- Facebook: more than 100 ms to retrieve a result makes the typeahead "stutter"; the system served 400 million users in 2010 `[CONFIRMED]`.
- LinkedIn Cleo: network typeahead over more than 150 million members in about 20 ms on average; query prefixes of at most 4 characters index the inverted lists `[CONFIRMED]`.
- Everything else here (keystroke rates, cache hit ratios, index sizes) is illustrative.

**Decisions and trade-offs**

| Option | Strength | Weakness |
|---|---|---|
| Precomputed top-k per prefix (trie or FST) | One lookup per keystroke | Costly to rebuild; freshness lags |
| Prefix inverted index scanned at query time | Fresh, flexible ranking | More work per query; needs partitioning |
| Preload per-user data in the browser | Zero round trips for the common case | Only fits small per-user sets (friends, recent items) |
| Global results cached by query string | High hit ratio for popular prefixes | Useless for personalised results |
| Personal and global services merged by an aggregator | Each leaf ranks on its own signals | Fan-out latency is set by the slowest leaf |

**Common mistakes**
- Sending a request on every keystroke with no client cache, debounce or cancellation.
- Treating completion as a list of the most frequent queries only, ignoring freshness, locale and policy filtering.
- Personalising results that could be cached globally, or caching results that are personal.
- Forgetting the privacy check on entity results before they are rendered.

---

## 🧒 Non-technical explanation

Think of a librarian who starts walking to the right shelf as soon as you say the first letters of a title. She keeps the most asked-for titles for each opening on a card at her desk, so she rarely walks at all. For things only you ask about (your friends' names), she gave you your own card when you came in. And there are a few phrases she will never suggest out loud, even if many people ask for them.

---

## TL;DR for engineers

- **Facebook (2010):** the browser preloads the user's friends, pages, groups and events on focus; an aggregator fans out to leaf services (a global one with a memcached query cache, a graph one for the user's neighbourhood), merges and ranks; the web tier fetches data and checks privacy `[CONFIRMED]`.
- **LinkedIn Cleo:** in-memory prefix inverted index, per-document Bloom filter and forward index, partitioned and merged; generic (global) versus network (personalised) typeahead; new members searchable in real time `[CONFIRMED]`.
- **Google Autocomplete:** predictions come from real searches, adjusted for language, location and freshness, and filtered by policy, with human enforcement for what the systems miss `[CONFIRMED]`.
- **Query-log pipeline, top-k per prefix, debounce, versioned index swaps:** reference design `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** return up to k suggestions for a prefix · rank by popularity, personal relevance and freshness · support entity results (people, items) and query completions · hide policy-violating suggestions.

**Non-functional:** **latency** (a result in well under 100 ms end to end, so the list keeps up with typing) · **throughput** (one request per keystroke, far more than full searches) · **freshness** (new entities and trending queries appear quickly) · **availability** (typeahead failing must not block search).

**Clarifying questions:** entities, queries or both? Personalised? How fresh must new items be? Which languages and locales? What must never be suggested?

---

## 2. Facebook's typeahead (2010) `[CONFIRMED]`

The post follows one query through seven steps. **Bootstrapping:** when the user focuses the search box, the browser requests all of the user's friends, pages, groups, applications and upcoming events and keeps them in the browser cache, so those results appear "without sending another request". **AJAX request:** if the cache does not have enough results, the browser sends the query string plus the results already displayed. **Aggregator:** a PHP endpoint wraps a Thrift service, the aggregator, which is "stateless and have no index of their own"; it delegates to several lower-level services in parallel. **Leaf services:** each retrieves and ranks on a few features. The global service indexes all pages and applications with no personalisation, so "we can save latency by storing recent results in a memcached-based query cache"; the graph service searches the user's neighbourhood of the graph. **Merging:** the aggregator ranks the merged results with a model and returns ids. **Fetching and validating:** the web tier fetches names and pictures from memcache and MySQL and does privacy checking "to make sure that the searcher is allowed to see each result". **Display:** results are added to the browser cache so similar later queries skip the backend.

Before launch they dark-tested by making the old typeahead send a query on every keystroke, which exposed network limits and changed the topology. The post frames search as a trilemma of performance, recall and relevance, and puts performance first: "late answers are wrong answers". Long-tail queries still go to the full results page.

## 3. LinkedIn's Cleo (2012) `[CONFIRMED]`

Cleo powers LinkedIn's typeahead for members, companies, groups, questions and skills, in two categories: **generic** typeahead (the same query gives everyone the same results, ranked globally, for example by popularity) and **network** typeahead (results filtered by the member's first- and second-degree connections and ranked with People You May Know scores). It does "out-of-order prefix matching over a very large number of elements by means of in-memory scanning", using three structures per partition: an **inverted index** from prefixes to documents (or an **adjacency list** from members to members for network typeahead), a per-document **Bloom filter** to discard documents that cannot match, and a **forward index** to confirm each query term prefix-matches an indexed term. A query for `linked` uses the prefix `link`, since prefixes are at most 4 characters. Partitions return hits that are merged. Updates are real time: new members, companies and groups become searchable at once.

## 4. Query completion: where predictions come from `[CONFIRMED]`

Google says its "predictions reflect searches that have been done on Google": the systems start from common and trending queries that match what has been typed, then adjust for the searcher's language and location, predict only the end of very long queries, and boost predictions when they detect rising interest. Predictions are filtered: systems block terms that may be violent, sexually explicit, hateful, disparaging or dangerous, suppress predictions unlikely to lead to reliable content (for example rumours after breaking news), apply a cautious policy to names, and enforcement teams remove what gets through, including close variants. The filter applies only to predictions; it "does not impact the ability for someone to finish typing a query".

The Elasticsearch docs describe the trade-off of a completion index: the completion suggester "is optimized for speed" and uses data structures "that enable fast lookups, but are costly to build and are stored in-memory".

---

## 5. Reference design for query completion `[INDUSTRY PATTERN]`

- **Offline pipeline:** collect query logs, normalise (case, whitespace), drop rare queries (privacy and noise), count over a decayed window, apply the policy filter, and build per-prefix top-k lists (a trie or finite-state structure). Ship the built index as an immutable versioned file and swap it atomically on each serving node.
- **Freshness path:** a streaming job counts recent queries per prefix and serves a small "trending" overlay merged with the batch index (see [34 Top-K](34-top-k-leaderboard.md) and [31 Stream aggregation](31-ad-click-aggregation.md)).
- **Serving:** stateless suggestion servers hold the index in memory, sharded by prefix range if it does not fit one node; a CDN or edge cache serves the most popular short prefixes.
- **Client:** debounce keystrokes (tens of milliseconds), cancel in-flight requests when the prefix changes, cache responses per prefix, and filter a cached longer list locally when the user types one more character.
- **Personalisation:** merge global suggestions with the user's own recent queries or entities, as Facebook does by preloading.

---

## 6. Failure scenarios

- **Suggestion service slow or down.** The client shows cached or no suggestions; the search box itself must keep working `[INDUSTRY PATTERN]`.
- **A leaf service is slow.** The aggregator waits on its slowest leaf; set a deadline and return what has arrived (see the tail-latency section of [P07](../toolkit/P07-slos-and-incidents.md)) `[INDUSTRY PATTERN]`.
- **A harmful prediction surfaces.** Block it at serving time with a deny list that is faster to update than the index, then remove it in the next build; Google describes both automated filters and enforcement teams `[CONFIRMED]` for the policy, `[INDUSTRY PATTERN]` for the deny-list mechanism.
- **A bad index build ships.** Keep the previous version on disk and roll back by switching the pointer `[INDUSTRY PATTERN]`.
- **Keystroke storm after a launch.** Facebook found network limits by dark-testing per-keystroke queries before launch `[CONFIRMED]`.

---

## 7. Capacity reasoning (illustrative)

- If 10 million searches a day each take 8 keystrokes and the client debounces half of them, that is about 40 million suggestion requests a day, roughly 460 per second on average and a few thousand at peak (our arithmetic).
- An index of 10 million distinct queries with top-10 lists for every prefix of up to 20 characters is at most 200 million prefix entries before sharing; tries share common prefixes, so the real count is far lower. Measure before sharding.
- Most requests are short prefixes, which are few and hot: a small cache in front of the servers absorbs most of the load.

---

## ⚠️ Reviewer notes

1. **The Facebook and LinkedIn posts are from 2010 and 2012.** Both describe systems that have since changed; this note does not claim either company's current design.
2. **Google's post describes behaviour and policy, not architecture.** The pipeline in section 5 is our reference design.
3. **Interview articles often present a trie with top-k at each node as "the" design.** The sources show two different products (entity and query typeahead) and in-memory prefix indexes built in more than one way; the trie is one option.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the sources. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **performance** (latency is the feature), **scalability**, **availability**, and a **safety** constraint on what may be shown.
- **Style (Ch 13–17):** a **scatter-gather** service tree (aggregator and leaves) over **precomputed** data built by a batch pipeline.
- **Quanta (Ch 7):** the serving tier and the index build are separate quanta joined only by a versioned file.
- **Trade-off (First Law, Ch 1):** **freshness vs latency and cost.** Precomputing per-prefix lists makes reads cheap and makes updates slow.
- **ADR sketch (Ch 19):** *"We will serve completions from an immutable in-memory index rebuilt hourly, with a streaming trending overlay and a serving-time deny list. We accept up to an hour of lag for non-trending queries in exchange for one lookup per keystroke."*
- Plain English: keep the answer cards at the desk.

---

## Interview questions to practice

1. Design search autocomplete for a large search engine.
2. Design typeahead for finding friends and pages in a social network.
3. How do you keep suggestions fresh when something starts trending?
4. How do you stop offensive or dangerous suggestions?
5. What does the client do to keep the request rate down?
6. How would you personalise suggestions without losing cacheability?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the sources.

**A 45-minute walkthrough**

1. Clarify: entities or queries, personalisation, freshness, locales, policy.
2. Estimate: keystrokes per second at peak, index size, cache hit ratio ([P01](../toolkit/P01-estimation.md)).
3. API: `GET /suggest?q=prefix&locale=...&limit=10`.
4. Design: client debounce and cache, edge cache, suggestion servers with an in-memory index, batch build, trending overlay, deny list.
5. Deep dive: building top-k per prefix, merging personal and global, ranking signals.
6. Failure and scale: slow leaf, bad index build, harmful prediction, 10× traffic.

**If it grows 10×**
- Shard the index by prefix range and cache the hottest prefixes at the edge.
- Push more filtering to the client (download a longer list, filter locally).
- Split personal and global serving so the global part stays cacheable.

**Answer outlines** (try the questions above first)

<details><summary>How do you keep suggestions fresh?</summary>

Keep the heavy index as a periodic batch build, and add a small streaming overlay that counts recent queries per prefix over a short window. At serving time merge the two, giving the overlay a boost when its rate rises sharply. Google describes boosting predictions when it detects rising interest.

</details>

<details><summary>How do you stop harmful suggestions?</summary>

Filter at build time by policy classifiers and term lists, filter again at serving time with a deny list that can be updated in minutes, and have a reporting path with people who review and remove, including close variants. Never let the filter block the user's own search.

</details>

<details><summary>Personalised and cacheable at once?</summary>

Split the answer: the global part is keyed only by prefix and locale, so it caches well; the personal part is small and either preloaded to the client (as Facebook did with friends) or served by a separate service. Merge on the client or in a thin aggregator.

</details>

## 📚 Further reading

- The sources listed under Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [20 Web crawler and search](20-web-crawler-search.md), [34 Top-K and leaderboards](34-top-k-leaderboard.md), [32 Distributed cache](32-distributed-cache.md), [P07 Reliability](../toolkit/P07-slos-and-incidents.md).

## Sources and provenance

> **Kind:** real-system parts (Facebook, LinkedIn, Google, Elasticsearch) with a reference design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-31:** Keith Adams, [*The Life of a Typeahead Query*](https://engineering.fb.com/2010/05/17/web/the-life-of-a-typeahead-query/) (Facebook Engineering, 17 May 2010) · LinkedIn Engineering, [*Cleo: the open source technology behind LinkedIn's typeahead search*](https://web.archive.org/web/20150227001852/https://engineering.linkedin.com/open-source/cleo-open-source-technology-behind-linkedins-typeahead-search) (2012; Internet Archive copy, the live page returns 404) · Google, [*How Google autocomplete predictions are generated*](https://blog.google/products/search/how-google-autocomplete-predictions-work/) (8 October 2020) · Elastic, [Suggesters: completion suggester](https://www.elastic.co/guide/en/elasticsearch/reference/current/search-suggesters.html) (current docs).
> **Dated material:** the Facebook and LinkedIn posts are over a decade old; the Google post is from 2020.
> **Not read:** Google's published Autocomplete policies page, Lucene's FST implementation, LinkedIn's later typeahead posts, academic work on query auto-completion.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-31, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Facebook post: the seven steps (bootstrap, AJAX, aggregator, leaves, merge, fetch and privacy check, display), the memcached query cache for the global service, dark testing, the 100 ms stutter remark, "late answers are wrong answers" and the 400 million users.
- Verified in the Cleo post: generic versus network typeahead, inverted index or adjacency list, Bloom filter, forward index, the 4-character prefix example, real-time updates, and about 20 ms over more than 150 million members.
- Verified in Google's post: predictions from real searches, language, location and freshness adjustments, policy filtering and enforcement, the names policy, and that filtering does not stop the search.
- Verified in the Elasticsearch docs: the completion suggester is optimised for speed with in-memory structures that are costly to build.
- Not sourced (our reasoning): the query-log pipeline, versioned index swaps, the trending overlay, client debounce and caching, the deny-list mechanism, and the capacity arithmetic.
- Not claimed: how Facebook, LinkedIn or Google build typeahead today.
