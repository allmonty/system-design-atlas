# 39 — Maps, Routing and ETA

*Real-system parts from the Contraction Hierarchies paper (2008), Google's ETA paper on graph neural networks in Google Maps (CIKM 2021), the OpenStreetMap tile scheme and the OSRM routing engine, plus a reference design. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** A maps product is three systems sharing one road graph. **Tiles** draw the map: the world is cut into square images (or vector tiles) per zoom level, addressed by `z/x/y`, so they cache like static files. **Routing** finds the best path: plain Dijkstra on a continental graph is too slow per request, so the graph is preprocessed (Contraction Hierarchies, multi-level partitions) and a query then touches a few hundred nodes. **ETA** predicts how long the chosen route will take, using live and historical speeds; Google describes a graph neural network over "supersegments" of road. Traffic updates arrive continuously, so the design question is which parts are precomputed, which are recomputed when speeds change, and how fresh the ETA must be.

**Key numbers** (as published)
- Contraction Hierarchies, Western Europe road network (18,029,721 nodes, 42,199,587 directed edges): queries in about 160 to 220 µs on a 2008 Opteron core, with negative space overhead; a 10,000 × 10,000 distance table in 10.2 s `[CONFIRMED]`.
- Google Maps ETA GNN: negative ETA outcomes reduced by over 40% in cities like Sydney versus the previous production model; road segments average 50 to 100 m and supersegments about 20 segments; horizons of 0, 10, 20, 30 and 60 minutes `[CONFIRMED]`.
- OSM tiles: 256 × 256 pixels; zoom n has 2^n × 2^n tiles, about 4.3 billion at zoom 16 `[CONFIRMED]`.

**Decisions and trade-offs**

| Option | Strength | Weakness |
|---|---|---|
| Dijkstra or A* on the raw graph | No preprocessing, any weights | Far too slow for long routes at request rate |
| Contraction Hierarchies | Microsecond queries, fast distance tables | Preprocessing to redo when weights change |
| Multi-level partition (OSRM's MLD) | Cheaper weight updates ("customise") | Somewhat slower queries than CH |
| Raster tiles | Simple to serve and cache | Restyling means re-rendering; large at high zoom |
| Vector tiles | Styled on the device, smaller | Client rendering work |
| Sum of segment speeds for ETA | Simple baseline | Ignores interactions between segments and future traffic |
| Learned ETA over the road graph (Google) | Captures spatial and temporal effects | Training stability and serving cost |

**Common mistakes**
- Running a shortest-path search over the whole continent per request.
- Using live speeds only, so an ETA at 5 pm ignores that rush hour is about to start.
- Treating routing and ETA as one step: Google's paper estimates the time for a route suggested by a prior system.
- Rendering every tile up front at every zoom (billions of mostly ocean tiles) instead of on demand with caching.

---

## 🧒 Non-technical explanation

A city has a paper map cut into squares of every size, stacked by zoom, so you only fetch the squares you look at. To find a way across the country, a navigator does not check every street; she has marked in advance which roads matter for long trips, so she only looks at small streets near the start and the end. To say when you will arrive, she remembers how busy each road usually is at this hour and how busy it is now, and adds up the pieces along your path.

---

## TL;DR for engineers

- **Contraction Hierarchies:** order nodes by importance, contract the least important first and add shortcut edges that preserve shortest paths; a query is a bidirectional search that only goes "up" the hierarchy from both ends `[CONFIRMED]`.
- **OSRM:** an open-source engine on OpenStreetMap data with Route, Table, Match (map-matching GPS traces), Nearest, Trip and Tile services; supports CH and Multi-Level Dijkstra, recommending MLD by default `[CONFIRMED]`.
- **Google ETA:** supersegments of connected road segments, real-time and historical (time-of-day, day-of-week) speed features, per-horizon GNN models, queried along the route with interpolated horizons `[CONFIRMED]`.
- **Tiles:** `z/x/y` addressing on Web Mercator, 256-pixel tiles `[CONFIRMED]`.
- **Traffic ingestion from GPS probes, re-customising weights, tile caching layers, rerouting:** reference design `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** show the map at any zoom · search places (see [36 Typeahead](36-typeahead-autocomplete.md)) · compute a route between points, with alternatives · predict arrival time · update ETA and reroute during a trip.

**Non-functional:** **latency** (a route in well under a second; tiles load as you pan) · **freshness** (traffic changes minute by minute) · **accuracy** (ETA error users notice) · **scale** (tiles are by far the highest request volume) · **availability** (navigation mid-trip must keep working, even offline).

**Clarifying questions:** driving only, or walking, cycling and transit? Live traffic? Global or one country? Offline support? Many-to-many tables (for dispatch, see [15 Uber](15-uber-proximity-dispatch.md))?

---

## 2. Tiles `[CONFIRMED]`

The OpenStreetMap tile scheme serves 256 × 256 pixel images at URLs of the form `/zoom/x/y.png`, one directory per zoom level and per column, on the Web Mercator projection. Zoom 0 is one tile for the whole world; zoom n has 2^n × 2^n tiles, so zoom 12 has 16,777,216 tiles and zoom 16 about 4.3 billion. Zoom normally goes up to 18. Because a tile is addressed by three integers and changes rarely, it caches well at every layer, from the browser to a CDN (see [38 CDN](38-cdn.md)). OSRM can also generate vector tiles carrying routing metadata.

## 3. Routing with Contraction Hierarchies (2008) `[CONFIRMED]`

The paper's idea: number the nodes by "importance" and contract them in that order. Contracting a node v removes it while preserving shortest paths among the rest, by adding a shortcut edge ⟨u, w⟩ whenever ⟨u, v, w⟩ was the only shortest path. A query is a modified bidirectional Dijkstra: the forward search only follows edges to more important nodes and the backward search only edges from more important nodes; they meet near the top of the hierarchy. On the Western Europe network the authors report five times "lower query times than the best previous hierarchical" Dijkstra-based speedup techniques and a negative space overhead (the search structure needs less space than the input graph). Unpacking a shortcut path back to real roads takes about 0.3 ms; a 10,000 × 10,000 many-to-many table takes 10.2 s. Edge weights were travel times derived from road length and one of 13 road categories.

Preprocessing (node ordering plus contraction) took about 10 to 30 minutes on that hardware, depending on the variant; when weights change, at least the contraction must be redone, which is why OSRM offers a second algorithm.

## 4. OSRM `[CONFIRMED]`

OSRM is a C++ engine for OpenStreetMap data exposing Nearest (snap to the road network), Route, Table (all-pairs durations or distances), Match (snap noisy GPS traces to the most plausible road path), Trip (a greedy travelling salesman) and Tile. It supports Contraction Hierarchies and Multi-Level Dijkstra and recommends MLD by default, except for cases such as very large distance matrices where CH is still the better fit. The MLD pipeline splits preprocessing into partition and customise steps; CH uses a single contract step.

## 5. ETA in Google Maps (2021) `[CONFIRMED]`

The paper frames ETA as "providing an estimated travel time given a user-provided starting location and a route suggested by a prior system". The road network is modelled as **supersegments**, sequences of connected road segments that follow typical traffic routes (segments average 50 to 100 m; a supersegment about 20 segments). For each supersegment a GNN predicts travel time at fixed horizons (0, 600, 1200, 1800 and 3600 seconds). At serving time the route's supersegments are queried in order, using the predicted arrival at one supersegment to pick and interpolate the horizon for the next. Features combine real-time speeds and times (17 two-minute windows before the prediction) with historical ones for that time of day and day of week (averaged over the past 17 weeks), segment length and road priority. The world is divided into regions with region-specific models. The previous production models were segment-level linear regressions; the GNN cut negative ETA outcomes (error above a threshold) by over 40% in cities like Sydney. Training needed stabilisation (MetaGradients) to be production-ready.

---

## 6. Reference design `[INDUSTRY PATTERN]`

- **Map data pipeline:** ingest road and place data, build the routable graph and the tile sources; publish versioned graph files to routing servers.
- **Tile service:** pre-render popular zooms and regions, render the rest on demand, and cache everything behind a CDN; vector tiles for client styling.
- **Traffic pipeline:** anonymised GPS probes from phones and fleets are map-matched to segments (OSRM's Match does this kind of snapping), aggregated into current speeds per segment every minute or two, and stored with historical profiles.
- **Routing service:** in-memory preprocessed graph, sharded by region; when live speeds change, re-run the cheap customise step (MLD) on a schedule and swap the weights atomically.
- **ETA service:** given a route, query the learned model or a speed-sum baseline; return arrival time and a confidence.
- **Navigation:** the client re-requests ETA every few minutes and reroutes when the driver leaves the route or a faster route appears; it keeps the route and nearby tiles cached for offline use.

---

## 7. Failure scenarios

- **Traffic feed stops.** Fall back to historical speeds for that time and day, which the ETA model already uses as features `[CONFIRMED]` for the features / `[INDUSTRY PATTERN]` for the fallback.
- **Road closure not yet in the data.** Probes show zero flow; mark the segment closed and re-customise; until then, users are routed into it `[INDUSTRY PATTERN]`.
- **Weight update takes too long.** With CH, contraction must be redone; MLD's customise step is cheaper, which is why OSRM recommends it by default `[CONFIRMED]` for the recommendation / `[INDUSTRY PATTERN]` for the reasoning.
- **Routing server for a region down.** Route from a replica; cross-region routes need a stitching step at region borders `[INDUSTRY PATTERN]`.
- **Model regression after a retrain.** Gate releases on offline ETA error and roll out per region with a fallback to the previous model ([28 Evaluation](28-llm-finetuning-evaluation.md) uses the same gate idea) `[INDUSTRY PATTERN]`.
- **Tile storm after a new style.** Every tile is a cache miss at once; roll out styles gradually or pre-render the popular areas `[INDUSTRY PATTERN]`.

---

## 8. Capacity reasoning (illustrative)

- Zoom 0 to 16 together hold about 5.7 billion tiles (the sum of 4^z), most of them ocean or empty land; rendering on demand and caching what is viewed is far cheaper than pre-rendering all of them (our arithmetic).
- With CH queries around 0.2 ms of CPU on 2008 hardware, one core answers thousands of point-to-point routes per second; path unpacking and response building often cost more than the search.
- If 10 million drivers navigate at peak and each client asks for an ETA update every 2 minutes, that is about 83,000 ETA requests per second.

---

## ⚠️ Reviewer notes

1. **The CH numbers are from 2008 hardware and a 2008 data set.** They show the scale of the speedup, not a current benchmark.
2. **Google's paper covers ETA, not routing or tiles.** It does not say how Google computes routes or serves maps; those parts of this note are our reference design.
3. **Interview articles often present A* as the answer to routing at scale.** A* helps a single search; the published production-grade speedups come from preprocessing the graph.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the sources. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **performance**, **scalability** (tiles), **accuracy** (ETA), **availability**, **freshness**.
- **Style (Ch 13–17):** **pipelines** that build artefacts (graph, tiles, models) feeding **stateless in-memory services**, plus a streaming traffic pipeline.
- **Quanta (Ch 7):** tiles, routing, traffic and ETA can be deployed and scaled separately; they share data, not runtime.
- **Trade-off (First Law, Ch 1):** **preprocessing vs freshness.** More preprocessing makes queries fast and weight updates slow.
- **ADR sketch (Ch 19):** *"We will use a multi-level partition with live-speed customisation every 2 minutes, and a learned ETA over the chosen route with historical fallback. We accept slightly slower route queries than CH in exchange for fast traffic updates."*
- Plain English: mark the main roads once, then only look at small streets near the ends.

---

## Interview questions to practice

1. Design Google Maps.
2. How do you compute a driving route across a continent in milliseconds?
3. How do you include live traffic in routes and arrival times?
4. How are map tiles stored and served? How many are there?
5. How would you update ETA during a trip, and when do you reroute?
6. How would you evaluate whether a new ETA model is better?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the sources.

**A 45-minute walkthrough**

1. Clarify: travel modes, live traffic, scope, offline, scale.
2. Estimate: tiles per zoom, tile request rate, routes and ETA requests per second, probe ingest rate ([P01](../toolkit/P01-estimation.md)).
3. API: `GET /tiles/{z}/{x}/{y}`, `POST /route {from, to, mode}`, `POST /eta {route}`.
4. Design: map data pipeline, tile service and CDN, routing service with a preprocessed graph, traffic pipeline, ETA model.
5. Deep dive: CH or MLD and weight updates; ETA with historical and live features.
6. Failure and scale: traffic feed down, closures, region outage, model regressions, 10× users.

**If it grows 10×**
- More CDN capacity and on-demand rendering for tiles.
- Shard routing by region and replicate hot regions.
- Batch ETA updates for active trips and lower their frequency on stable routes.

**Answer outlines** (try the questions above first)

<details><summary>Fast routes across a continent</summary>

Preprocess the road graph once (Contraction Hierarchies or a multi-level partition) so that a query only explores a small part of it: with CH, both searches only climb toward more important nodes and meet near the top. Keep the result in memory, and unpack shortcuts to real road segments at the end.

</details>

<details><summary>Live traffic in routes</summary>

Map-match GPS probes to segments, aggregate speeds per segment every minute or two, and blend them with historical speeds for the time of day. Use them as edge weights in a routing structure whose weights can be updated cheaply (MLD customisation), and predict ETA along the chosen route with future horizons, not only current speeds.

</details>

<details><summary>Is the new ETA model better?</summary>

Measure error against actual trip durations offline on held-out trips, by region and time of day, including the share of trips with error above a threshold (Google's negative ETA outcome). Then canary per region with automatic rollback.

</details>

## 📚 Further reading

- The sources listed under Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [15 Uber proximity and dispatch](15-uber-proximity-dispatch.md), [38 CDN](38-cdn.md), [36 Typeahead](36-typeahead-autocomplete.md), [26 Recommendations](26-recommendation-system.md), [P01 Estimation](../toolkit/P01-estimation.md).

## Sources and provenance

> **Kind:** real-system parts (Google Maps ETA, OSRM, OpenStreetMap tiles) and a research algorithm (Contraction Hierarchies), with a reference design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-31:** Robert Geisberger, Peter Sanders, Dominik Schultes and Daniel Delling, [*Contraction Hierarchies: Faster and Simpler Hierarchical Routing in Road Networks*](https://ae.iti.kit.edu/download/contract.pdf) (WEA 2008) · Austin Derrow-Pinion et al., [*ETA Prediction with Graph Neural Networks in Google Maps*](https://arxiv.org/pdf/2108.11482) (CIKM 2021; arXiv, 25 August 2021) · OpenStreetMap Wiki, [Slippy map tilenames](https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames) · Project OSRM, [osrm-backend README](https://raw.githubusercontent.com/Project-OSRM/osrm-backend/master/README.md).
> **Dated material:** CH figures are from 2008 hardware; the ETA paper is from 2021.
> **Not read:** the CH journal version, Customizable Route Planning (Microsoft), OSRM's MLD documentation in detail, Google's traffic or routing internals, transit routing (RAPTOR), map-matching papers.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-31, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the CH paper: node contraction with shortcuts, the upward bidirectional query, the Western Europe graph size, the five-times claim, negative space overhead, query times in Table 1, path unpacking around 0.3 ms, the 10.2 s many-to-many table, and edge weights from length and 13 road categories.
- Verified in the ETA paper: the problem framing, supersegments and their sizes, the horizons, sequential querying with interpolation, real-time and 17-week historical features, region-specific models, segment-level linear regression as the prior model, MetaGradients, and the over 40% reduction in Sydney.
- Verified on the OSM wiki: 256-pixel tiles, `/zoom/x/y.png`, tile counts per zoom and the usual maximum zoom of 18.
- Verified in the OSRM README: the services, CH and MLD, and the MLD default recommendation.
- Not sourced (our reasoning): the traffic pipeline, routing shards and weight swaps, navigation behaviour, fallbacks, and the capacity arithmetic.
- Not claimed: how Google Maps computes routes or serves tiles.
