# 40 — Video Conferencing

*Real-system note from Discord's voice and video architecture (2018), the Jitsi "Last N" paper (NOSSDAV 2015) and the IETF documents on RTP topologies, ICE and TURN, plus a reference design for a meeting service. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** A video call moves real-time media between participants, so latency beats completeness: a late packet is useless. Two people can talk peer to peer; groups need a server. A **mixer (MCU)** decodes everyone, composes one stream and re-encodes it (heavy CPU, simple clients); a **selective forwarding unit (SFU)** forwards packets without decoding and chooses which streams each participant receives (cheap CPU, more client work). SFUs dominate today, and the key decision is the **selection policy**: forward only the last N active speakers, and pick a resolution each receiver can take. Around the SFU sit signaling (who is in the call, which server), NAT traversal (ICE with STUN and TURN relays) and a control plane that places calls on servers and moves them when a server fails.

**Key numbers** (as published)
- Jitsi Last N: an SFU forwarding 10 of 30 participants used 45% less CPU and 63% less bandwidth than forwarding everyone to everyone `[CONFIRMED]`.
- Discord (2018): more than 850 voice servers in 13 regions (over 30 data centers), more than 2.6 million concurrent voice users, egress above 220 Gbps and 120 million packets per second `[CONFIRMED]`.
- Discord's native clients exchange about 1,000 bytes to join a voice channel instead of SDP that can be close to 10 KB round trip `[CONFIRMED]`.

**Decisions and trade-offs**

| Option | Strength | Weakness |
|---|---|---|
| Peer-to-peer mesh | No media servers | Upload grows with participants; exposes IPs |
| Mixer (MCU) | One stream per client, easy for weak clients | Decode and re-encode for everyone: CPU-heavy, adds latency |
| Selective forwarding (SFU) | No transcoding, low latency, cheap CPU | Clients decode several streams; needs a selection policy |
| Forward all streams | Simple | Server traffic grows quadratically |
| Forward last N speakers | Bounded traffic, matches what people watch | Needs good dominant-speaker detection |
| Direct UDP | Lowest latency | Fails behind some NATs and firewalls |
| TURN relay fallback | Works almost everywhere | Extra hop and relay bandwidth cost |

**Common mistakes**
- Designing a group call as a mesh of peer connections.
- Sending media over TCP-like reliable delivery and waiting for retransmissions.
- Forwarding every video stream to every participant in large meetings.
- Forgetting signaling and media are different paths: a signaling outage need not drop the media, and a media server failure needs reassignment through signaling.

---

## 🧒 Non-technical explanation

Imagine a meeting by walkie-talkie through a switchboard operator. She does not repeat what people say; she just flips switches so that each listener hears the people currently talking, at most a few at a time. If one person's radio is weak, she sends them a lower-quality copy. If her switchboard breaks, everyone is told to tune to another operator, who already knows who was in the room.

---

## TL;DR for engineers

- **Topologies (RFC 7667):** mesh, media-mixing mixer, media-switching mixer and the **Selective Forwarding Middlebox**, which projects each source to every endpoint and selects which active sources each one receives `[CONFIRMED]`.
- **Last N (Jitsi):** an SFU orders endpoints by audio activity, forwards video only from the last N dominant speakers, and keeps CPU and bandwidth bounded `[CONFIRMED]`.
- **Discord:** client-server (not peer to peer) for large channels, IP privacy and moderation; Elixir signaling plus a C++ SFU per voice server; load-aware placement through etcd; fast reassignment on failure or DDoS `[CONFIRMED]`.
- **ICE and TURN:** gather candidate addresses and test connectivity; fall back to a relay when direct paths fail `[CONFIRMED]`.
- **Simulcast layers, bandwidth estimation per receiver, cascading SFUs across regions, recording:** reference design `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** create and join meetings · audio, video and screen share · see who is speaking · mute and moderate · chat · (optionally) record.

**Non-functional:** **latency** (mouth to ear well under a few hundred milliseconds) · **quality under loss and jitter** · **scale** (2 to hundreds of participants, millions of concurrent users) · **availability** (survive a media server failure mid-call) · **privacy and security** (encryption, no IP leaks).

**Clarifying questions:** maximum meeting size? Video for everyone or mostly audio? Browser support? Recording? End-to-end encryption required (it constrains what servers can do)?

---

## 2. Topologies and why SFUs won `[CONFIRMED]`

RFC 7667 catalogues RTP topologies. In a **mesh**, each endpoint sends its streams to every other endpoint over separate flows. A **media-mixing mixer** produces new media from the inputs (the classic audio bridge). A **Selective Forwarding Middlebox** makes all potential sources available to each endpoint and selects which of the actively transmitting sources are sent to each, and the RFC links these architectures to scalable video coding and simulcast.

The Last N paper states the trade-off: in a mesh "the endpoints quickly exhaust their available upstream bandwidth"; MCUs that mix audio and combine video need substantial computation; SFUs "forward RTP packets, optionally changing their headers, but without processing the payload", so they are more CPU-efficient, and they become bandwidth-efficient by selecting what to forward. Forwarding everything to everyone grows quadratically with participants at the server, and clients cannot display or decode that many streams.

## 3. Last N: selecting what to forward (Jitsi, 2015) `[CONFIRMED]`

Last N orders endpoints by audio activity using a dominant-speaker algorithm on audio levels, and forwards video from only the N most recent speakers (plus any participant a user pins). In the evaluation, forwarding for 10 endpoints in a 30-participant conference used 45% less CPU and 63% less bandwidth than a full-star forwarder. The dominant-speaker detection must avoid switching on short noises and must not let a loud participant dominate unfairly.

## 4. Discord's voice and video (2018) `[CONFIRMED]`

Every Discord call is multiparty, with channels of up to 1,000 people taking turns, so it uses client-server networking: "peer-to-peer networking becomes prohibitively expensive as the number of participants increases". Routing through Discord's servers also hides users' IP addresses (protecting them from DDoS) and allows moderation, such as muting a participant at the server.

**Clients.** Browsers use the browser's WebRTC; desktop and mobile apps use one C++ media engine built on the WebRTC native library. Native clients skip SDP (exchanging about 1,000 bytes of setup instead), skip ICE because every client connects to a known relay server, use Salsa20 instead of DTLS/SRTP, and send nothing during silence to save bandwidth and CPU. The voice backend bridges browser and native clients.

**Backend.** Signaling services are in Elixir. Clients keep a WebSocket to the Gateway; joining a voice channel causes the Guilds service to pick a voice server: voice servers report health and load into etcd, and Guilds "assigns the least utilized voice server in the given region to the guild". The client opens a second WebSocket to that voice server for media setup. Each voice server has a signaling component and a homegrown C++ SFU, which forwards audio and video, drops packets from server-muted users, translates between browser and native transports, and handles RTCP for video quality.

**Failure handling.** If the SFU process crashes, the signaling component restarts it and rebuilds its state without involving clients (the same mechanism gives zero-downtime SFU updates). If a voice server dies, it fails its ping and leaves service discovery; clients notice the broken WebSocket; Guilds assigns a new server, pushes the voice state to it, and clients reconnect. A DDoS on a voice server gets the same treatment; changing a guild's region does too.

## 5. NAT traversal: ICE and TURN `[CONFIRMED]`

ICE is a protocol for NAT traversal for UDP-based communication that uses STUN and TURN. Behind a NAT, a host "can be impossible for that host to communicate directly with other hosts", so TURN lets it exchange packets with peers through a relay, and lets one client reach several peers through a single relay address. Browsers gather candidates (local, server-reflexive via STUN, relayed via TURN) and test pairs to pick a path. With an SFU, the SFU itself is the far end; Discord's native apps skip ICE because the server address is known.

---

## 6. Reference design `[INDUSTRY PATTERN]`

- **Signaling service:** meeting membership, permissions, and assignment of the meeting to an SFU (by region and load); WebSocket to clients; state kept outside the SFU so a replacement can be built quickly.
- **SFU fleet:** stateless-ish media forwarders in many regions; one meeting on one SFU, or SFUs **cascaded** across regions for global meetings, each forwarding one copy of a stream to the other.
- **Simulcast:** each sender encodes two or three resolutions; the SFU forwards the layer each receiver's bandwidth estimate allows, and only for visible tiles.
- **Selection:** last N speakers plus pinned and screen-share streams; audio from the top few speakers.
- **TURN servers** for clients that cannot reach the SFU over UDP (TURN over TCP or TLS on 443).
- **Recording:** a bot participant receives the streams from the SFU and mixes them offline, so recording does not load the live path.
- **Telemetry:** clients report quality metrics (loss, jitter, freeze time), as Discord does, for alerting and placement.

---

## 7. Failure scenarios

- **SFU process crash.** Restart and rebuild from signaling state with a few dropped packets `[CONFIRMED]` (Discord).
- **Voice server or host dies.** Removed from discovery, meeting reassigned, clients reconnect `[CONFIRMED]` (Discord).
- **DDoS on a media server.** Same reassignment; the attacked server returns when the attack ends `[CONFIRMED]` (Discord).
- **A participant's network degrades.** Receive a lower simulcast layer or audio only; send fewer layers `[INDUSTRY PATTERN]`.
- **UDP blocked by a corporate firewall.** Fall back to TURN over TCP or TLS; quality suffers from head-of-line blocking `[CONFIRMED]` for TURN / `[INDUSTRY PATTERN]` for the fallback.
- **Signaling outage.** Ongoing media can continue, but joins and reassignments stop; make signaling highly available and separate from media `[INDUSTRY PATTERN]`.

---

## 8. Capacity reasoning (illustrative)

- A 720p stream at about 1.5 Mbit/s forwarded to 9 receivers is 13.5 Mbit/s of egress for one sender; with all 10 participants sending, about 135 Mbit/s for one meeting. Last N with N = 4 and smaller thumbnails cuts this several times (our arithmetic).
- Audio at about 40 kbit/s is cheap; silence suppression matters more for packet rate than for bytes (Discord's 120 million packets per second shows packet rate is a real limit).
- At Discord's 2018 scale, 220 Gbps over 2.6 million users is about 85 kbit/s per user on average, consistent with mostly audio.

---

## ⚠️ Reviewer notes

1. **Discord's post is from 2018** and describes voice-heavy usage; video in large channels came later and is not covered here. Note [09 Discord](09-discord.md) uses the same post.
2. **The Last N figures come from a 2015 test setup**, not a production fleet.
3. **Popular articles often describe Zoom's architecture in detail.** We did not read a Zoom primary source; nothing here describes Zoom.
4. **End-to-end encryption** conflicts with server-side mixing and some SFU features; this note does not cover E2EE designs (see [08 Chat](08-chat-whatsapp.md) for E2EE in messaging).

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the sources. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **latency**, **availability**, **scalability**, **cost** (egress), **security** (IP privacy, encryption).
- **Style (Ch 13–17):** a **control plane** (signaling, placement) separate from a **data plane** (SFUs, TURN), as in [13 Netflix](13-netflix.md) and [29 Live streaming](29-live-streaming-twitch.md).
- **Quanta (Ch 7):** each SFU is its own quantum; meetings are sharded across them.
- **Trade-off (First Law, Ch 1):** **server CPU vs client work and bandwidth.** Mixers spend server CPU to simplify clients; SFUs push decoding to clients and spend bandwidth.
- **ADR sketch (Ch 19):** *"We will use regional SFUs with simulcast and last-N selection, signaling in a separate service that can rebuild an SFU's state, and TURN over TLS as fallback. We accept client-side decoding of up to N streams in exchange for no server transcoding."*
- Plain English: flip switches, don't repeat the words.

---

## Interview questions to practice

1. Design Zoom or Google Meet.
2. Mesh, MCU or SFU: when would you use each?
3. How do you support a 300-person meeting?
4. A participant is on a poor mobile connection. What changes for them?
5. The media server hosting a meeting dies. What happens next?
6. How do clients behind strict firewalls connect?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the sources.

**A 45-minute walkthrough**

1. Clarify: meeting size, video share, browsers, recording, encryption.
2. Estimate: streams per meeting, egress per SFU, concurrent meetings per server ([P01](../toolkit/P01-estimation.md)).
3. API: create meeting, join (returns SFU address and credentials), signaling messages over WebSocket.
4. Design: signaling, placement, SFU fleet, TURN, simulcast and selection, recording bot.
5. Deep dive: last-N selection and dominant speaker; bandwidth estimation and layer switching.
6. Failure and scale: SFU crash, server death, DDoS, firewalls, 10× meetings, 300-person meetings.

**If it grows 10×**
- More SFUs per region and tighter placement by load.
- Cascade SFUs for large or global meetings.
- Webinar mode: a few senders, many receivers, possibly switching to a broadcast path ([29 Live streaming](29-live-streaming-twitch.md)).

**Answer outlines** (try the questions above first)

<details><summary>Mesh, MCU or SFU</summary>

Mesh for two or three people when you want no media servers. MCU when clients are very weak or need one composed stream (legacy room systems, phone dial-in), accepting server CPU and added latency. SFU for almost everything else: no transcoding, and a selection policy keeps bandwidth bounded.

</details>

<details><summary>The media server dies</summary>

Signaling notices (missed health checks or dropped client connections), picks a new SFU in the region, pushes the meeting state to it, and tells clients to reconnect; media resumes after a short gap. Keep meeting state in signaling, not only in the SFU, so a replacement starts warm, as Discord does.

</details>

<details><summary>300 participants</summary>

Most people do not send video; forward audio from the top few speakers and video from last N plus pinned and screen share, as thumbnails at the low simulcast layer. Cascade SFUs if the audience spans regions, and consider a broadcast mode for passive viewers.

</details>

## 📚 Further reading

- The sources listed under Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [09 Discord](09-discord.md), [08 Chat](08-chat-whatsapp.md), [29 Live streaming](29-live-streaming-twitch.md), [21 Game matchmaking](21-game-matchmaking-lobby-chat.md), [P04 Load balancing](../toolkit/P04-load-balancing.md).

## Sources and provenance

> **Kind:** real system (Discord voice and video) with research (Jitsi Last N), standards (RFC 7667, RFC 8445, RFC 8656) and a reference design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-31:** Jozsef Vass, [*How Discord Handles Two and Half Million Concurrent Voice Users using WebRTC*](https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc) (Discord, 10 September 2018) · Boris Grozev, Lyubomir Marinov, Varun Singh and Emil Ivov, [*Last N: Relevance-Based Selectivity for Forwarding Video in Multimedia Conferences*](https://jitsi.org/wp-content/uploads/2016/12/nossdav2015lastn.pdf) (NOSSDAV 2015) · IETF, [RFC 7667, RTP Topologies](https://www.rfc-editor.org/rfc/rfc7667.txt) (2015), [RFC 8445, ICE](https://www.rfc-editor.org/rfc/rfc8445.txt) (2018) and [RFC 8656, TURN](https://www.rfc-editor.org/rfc/rfc8656.txt) (2020).
> **Dated material:** Discord 2018, Jitsi 2015; the RFCs are current standards.
> **Not read:** Zoom, Google Meet or Microsoft Teams engineering material, simulcast RFC 8853, WebRTC congestion control (GCC) papers, SVC specifications.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-31, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Discord post: multiparty client-server design and its reasons, the native media engine, SDP and ICE skipped by native clients with about 1,000 bytes of setup, Salsa20, silence suppression, Elixir signaling, Gateway and voice WebSockets, etcd-based least-utilized placement, the C++ SFU and its duties, SFU restart, server failover, DDoS and region change handling, and the 850 servers, 13 regions, 2.6 million users, 220 Gbps and 120 Mpps.
- Verified in the Last N paper: the mesh, MCU and SFU comparison, the dominant-speaker ordering, the quadratic growth, and the 45% CPU and 63% bandwidth result.
- Verified in RFC 7667: mesh, mixer and Selective Forwarding Middlebox topologies and the link to simulcast and SVC; in RFC 8445 and RFC 8656: ICE's purpose and TURN's relay role.
- Not sourced (our reasoning): the reference design, simulcast layer choice, cascading, recording bot, firewall fallback, and the capacity arithmetic.
- Not claimed: how Zoom, Google Meet or Teams are built.
