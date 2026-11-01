# 41 — Content Moderation and Fraud Detection with ML

*Real-system parts from Facebook's Immune System paper (2011), Stripe's post on how Radar is built (2023) and its rules documentation, and Meta AI's post on Few-Shot Learner, plus a reference design for an integrity platform. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** Moderation and fraud detection score actions (a post, a message, a payment, a signup) and decide: allow, block, challenge, send to a human, or demote. Unlike most ML, the other side adapts: attackers change whatever the model keys on. So the design favours **speed of response** over a perfect model: features, rules and models must update online without restarts; a **policy layer** turns scores into actions and holds out traffic to measure; **human review** handles the uncertain middle and produces labels; and **feedback loops** (user reports, chargebacks, appeals) feed the next model. Synchronous checks sit on the request path with a tight latency budget; heavier analysis runs asynchronously and acts after the fact.

**Key numbers** (as published, with dates)
- Facebook Immune System (2011): 25 billion checks per day, 650,000 per second at peak; synchronous classification kept under 50 ms; about 20% of actions are writes `[CONFIRMED]`.
- Stripe Radar (March 2023 post): more than 1,000 characteristics per transaction, a decision in under 100 ms, 0.1% of legitimate payments blocked; fraud is about 1 in 1,000 payments; training time cut by over 85% (to under two hours) after moving to a DNN-only model `[CONFIRMED]`.
- Meta Few-Shot Learner (undated post, 2021 period): adapts to new kinds of harmful content within weeks instead of months, in more than 100 languages `[CONFIRMED]`.
- Cost figures here are illustrative.

**Decisions and trade-offs**

| Option | Strength | Weakness |
|---|---|---|
| Hand-written rules | Immediate, explainable, owned by analysts | Brittle; attackers learn them; rule sprawl |
| Supervised classifiers | Generalise across variants | Need labels; lag behind new attacks |
| Few-shot or general models | New policies in weeks, little labelled data | Costly to serve; harder to explain |
| Synchronous check on the request | Stops harm before it happens | Latency budget limits model size |
| Asynchronous review after the fact | Heavier models, more context | Harm may already have spread |
| Block | Stops the action | False positives hurt real users |
| Challenge (3DS, CAPTCHA, re-auth) or human review | Lets the good user through | Friction and reviewer cost |

**Common mistakes**
- Optimising a single model's accuracy instead of time to respond across all attacks.
- Choosing features that are cheap for the attacker to change (text patterns) over ones that are expensive (infrastructure, account history).
- No holdout, so nobody can tell whether a rule or model still helps.
- Treating appeals and chargebacks as support tickets rather than as labels.

---

## 🧒 Non-technical explanation

A shop has a door guard. Most shoppers walk straight in. The guard has a short list of rules (no masks after dark) and a good sense for trouble learned from many past cases. If someone seems odd, she can ask for ID instead of turning them away, or call the manager. Every evening the staff tell her who stole and who was wrongly stopped, and she adjusts. Thieves change their coats, so she watches what is hard to change: how they arrived, who they came with.

---

## TL;DR for engineers

- **Facebook Immune System (2011):** realtime checks on every read and write; classifier services that are never restarted; a feature language (FXL) whose features and rules load online; a policy engine that maps classifications to responses and keeps holdouts; feature loops that aggregate classification data and user feedback `[CONFIRMED]`.
- **Stripe Radar (2023):** one network-wide model scoring every payment in under 100 ms; architecture moved from logistic regression to an XGBoost-plus-DNN ensemble to a DNN-only model; feature engineering from investigations of past attacks; risk insights explain decisions; users add allow, block, review and 3DS rules on top `[CONFIRMED]`.
- **Meta Few-Shot Learner:** a large multimodal, multilingual model that takes policy text and few examples, measured by A/B tests on prevalence `[CONFIRMED]`.
- **Review queues, label pipelines, shadow mode, cost tiers:** reference design `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** score actions in real time · act (allow, block, challenge, review, demote, disable account) · let analysts write rules · route uncertain cases to people · collect feedback and labels · explain and appeal decisions.

**Non-functional:** **latency** on the request path (tens of milliseconds) · **throughput** (every action) · **agility** (respond to a new attack in hours) · **precision on good users** (false positives are costly) · **auditability** · **cost** (models and reviewers).

**Clarifying questions:** which surface (payments, posts, signups)? Is it synchronous? What actions are allowed? What false positive rate is acceptable? Are there legal reporting duties? Languages and media types?

---

## 2. Facebook's Immune System (2011) `[CONFIRMED]`

The paper treats protection as **adversarial learning**: "the attacker creating the pattern does not want the pattern to be learned". Attacks cycle through phases (attack, detect, defend, mutate), and the system aims to shorten the phases the attacker controls. It has two advantages: user feedback (explicit, such as marking spam; implicit, such as deleting a post or rejecting a friend request) and global knowledge of what is normal.

Accuracy is not the main goal: "response and detection latencies can be more important than precision and recall". The paper's example: a 2% false positive rate today on an attack hitting 1,000 users beats a 1% rate tomorrow on the same attack hitting 100,000. "Done is often better than perfect." Features should be the ones expensive for the attacker to change, such as IP-related signals rather than text patterns.

Components: **classifier services** behind one interface (random forests, SVMs, logistic regression, boosting), "designed never to be restarted"; **FXL**, a statically typed functional language for features and rules, loaded online; **dynamic model loading**; a **policy engine** where policies are boolean FXL expressions over classifications that trigger responses (block an action, require an authentication challenge, disable an account) and that also define holdouts to evaluate classifiers; and **feature loops** that aggregate classification data, user feedback, crawler results and warehouse queries back into features. Scale in early 2011: 25 billion read and write actions a day, synchronous classification under 50 ms.

## 3. Stripe Radar (2023) `[CONFIRMED]`

Radar scores each payment in under 100 ms using over 1,000 characteristics, blocks risky ones or sends them to extra checks, and blocks 0.1% of legitimate payments. Fraud is rare, about 1 in 1,000 payments, and the key asset is the breadth of the Stripe network. The model went from logistic regression to a "Wide & Deep" ensemble of XGBoost and a DNN, then in mid-2022 to a DNN-only, multi-branch architecture inspired by ResNeXt; simply dropping XGBoost would have cost 1.5% recall, so the new DNN had to recover its memorisation. Training time fell by over 85% to under two hours, and a 10× increase in training data still improved the model.

Features come from investigating past attacks in detail and searching the network for correlated signals; some promising features add little because the model already captures the pattern. Because a DNN is hard to explain, Stripe built **risk insights** showing which features drove a decline. Fraud has shifted from stolen cards toward high-velocity **card testing**.

**Rules on top.** Users write rules of the form `{action} if {attribute} {operator} {value}`; default rules review payments at elevated risk, and the highest-risk block rule (enabled by default, now marked deprecated) is giving way to risk controls that block the highest-risk payments with dynamic thresholds. Request-3DS rules are evaluated before review, block and allow rules; allow rules override Stripe's defaults and should be used minimally; and the docs warn a badly set rule can allow many risky payments or block many legitimate ones.

## 4. Adapting to new harms: Few-Shot Learner (Meta AI) `[CONFIRMED]`

Training a classifier for a new kind of harmful content "typically takes several months to collect and label thousands, if not millions, of examples". Meta's Few-Shot Learner starts from a large general model trained on billions of language examples, then on labelled policy-violating and borderline content, then on text describing a new policy, and works with zero examples, fewer than 50 examples, or light fine-tuning. Inputs combine the whole post (text, image, URL), the policy text and any examples. It was evaluated with offline tests and online A/B tests on **prevalence** (the share of views of violating content) on Facebook and Instagram. The post is explicit about limits: AI cannot yet read dozens of pages of policy and enforce them.

---

## 5. Reference design for an integrity platform `[INDUSTRY PATTERN]`

- **Synchronous path:** the product calls a risk service with the action; it fetches precomputed features (account age, velocity counters, device and network reputation), runs fast rules and a small model, and returns a decision within the budget. On timeout, fail open or closed per surface (payments may challenge; posting may allow and re-check).
- **Asynchronous path:** every action is logged to a stream; heavier models (multimodal, graph, few-shot) and clustering run there and act after the fact (remove, demote, disable linked accounts).
- **Policy layer:** versioned rules over scores, with per-rule holdouts and a **shadow mode** that logs what a new rule or model would do before it acts.
- **Human review:** queues ordered by severity and reach, reviewer tooling with context, decisions logged as labels; appeals reopen cases and also become labels.
- **Feedback and labels:** reports, chargebacks, appeals and reviewer decisions feed training sets; watch for label delay (chargebacks arrive weeks later).
- **Evaluation:** offline precision and recall at the operating threshold, online prevalence or fraud loss, false positive rate on good users, and time from new attack to response.
- **Safety limits:** humans in the loop for severe or irreversible actions, an appeal path, audit logs, rate limits on automated account actions, and care with sensitive attributes.
- **Cost control:** a tiered cascade (rules, then a small model, then a large model or a person only for the uncertain band), cached features, and review capacity planned against queue length.

---

## 6. Failure scenarios

- **New attack the model has not seen.** Analysts ship a rule online within hours, as the Immune System's FXL allows, while a model is retrained `[CONFIRMED]` for online rules / `[INDUSTRY PATTERN]` for the workflow.
- **A rule blocks good users en masse.** Stripe warns rules can block many legitimate payments; ship rules in shadow mode with a holdout, alert on block-rate jumps, and roll back `[CONFIRMED]` for the risk / `[INDUSTRY PATTERN]` for the controls.
- **Risk service slow or down.** Per-surface fallback: allow with asynchronous re-check, or challenge `[INDUSTRY PATTERN]`.
- **Label delay hides a drift.** Chargebacks arrive late; track leading signals (disputes opened, reports) and recent-window metrics `[INDUSTRY PATTERN]`.
- **Review queue backs up during an incident.** Prioritise by severity and reach, raise automatic thresholds temporarily, and log the change `[INDUSTRY PATTERN]`.
- **Attackers probe the threshold.** Card testing is many small attempts; velocity features and per-account limits catch it `[CONFIRMED]` for the trend / `[INDUSTRY PATTERN]` for the response.

---

## 7. Capacity and cost reasoning (illustrative)

- At 650,000 checks per second and a 50 ms budget, each check gets well under one CPU-millisecond of model time per core in a large fleet only if features are precomputed; the expensive part is feature fetching, not the model (our reasoning).
- If 1 in 1,000 actions is bad and a model flags 1% of traffic for review, reviewers see ten times more good cases than bad ones; precision at the review threshold sets reviewer cost.
- A cascade where a large model sees only the 2% of items the small model is unsure about cuts large-model cost by about 50 times compared with scoring everything.

---

## ⚠️ Reviewer notes

1. **Dates matter here.** The Immune System paper is from 2011, Stripe's post from March 2023, and the Few-Shot Learner post is undated on the page (its examples concern COVID-19 vaccine content). None describes the systems as they are today.
2. **Stripe's 0.1% and 100 ms are Stripe's own figures** in a product post; no method for measuring the 0.1% is given.
3. **Meta reports prevalence reductions without numbers** in the post; the 55% and 12% figures it gives are about few-shot learning benchmarks, not production.
4. **Popular articles often present moderation as one classifier.** Every source here describes a system of rules, models, people and feedback.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the sources. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **agility** (time to respond), **performance** (request-path latency), **accuracy**, **auditability**, **cost**.
- **Style (Ch 13–17):** a synchronous **microkernel-like** risk service with plug-in rules and models, plus an **event-driven** asynchronous path.
- **Quanta (Ch 7):** the request-path scorer, the stream analysis and the review tooling are separate quanta.
- **Trade-off (First Law, Ch 1):** **false positives vs false negatives, and speed vs certainty.** The sources favour responding fast with an imperfect model over waiting for a better one.
- **ADR sketch (Ch 19):** *"We will score every action synchronously with rules and a small model under 50 ms, run heavy models asynchronously, and launch every new rule in shadow mode with a 1% holdout. We accept after-the-fact removal for some harms in exchange for a fast request path."*
- Plain English: watch what is hard for the thief to change.

---

## Interview questions to practice

1. Design a fraud detection system for payments.
2. Design content moderation for a social network with billions of posts.
3. A new scam appears today. How fast can your system respond, and how?
4. How do you measure whether moderation is working?
5. How do you keep false positives on good users low?
6. Where do humans fit, and how do you control their cost?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the sources.

**A 45-minute walkthrough**

1. Clarify: surface, synchronous or not, actions, acceptable false positives, legal duties.
2. Estimate: actions per second, latency budget, review volume at a threshold ([P01](../toolkit/P01-estimation.md)).
3. API: `assess(action, context) → {decision, score, reasons}`, `report(item)`, `appeal(decision)`.
4. Design: feature store and counters, rules and models, policy layer, async stream analysis, review queues, label pipeline.
5. Deep dive: adversarial adaptation, features expensive to change, holdouts and shadow mode, explanations.
6. Failure and scale: new attack, bad rule, service outage, label delay, 10× traffic.

**If it grows 10×**
- Push more decisions to cheap tiers; keep large models for the uncertain band.
- Shard feature counters by entity; precompute aggregates.
- Scale review by better routing and tooling, not only by headcount.

**Answer outlines** (try the questions above first)

<details><summary>A new scam today</summary>

Analysts find a distinguishing feature, ideally one hard to change (infrastructure, account links, payment patterns), and ship a rule online in shadow mode, then enforce after checking its hit rate on good users. In parallel, label examples (or use a few-shot model) and retrain. Measure time from first report to enforcement.

</details>

<details><summary>Is moderation working?</summary>

Prevalence (share of views that are violating), estimated by sampling and human labels, not only the count of removals; precision of automated actions from appeal outcomes; time to action; and false positive rate on good users. For fraud: losses, dispute rate and the share of good payments blocked.

</details>

<details><summary>Where humans fit</summary>

On the uncertain band and on severe or irreversible actions, and to create labels. Control cost with a tiered cascade, queue priority by severity and reach, and tooling that shows context. Appeals give a second check and feed training.

</details>

## 📚 Further reading

- The sources listed under Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [17 Payments](17-payment-system.md), [02 Rate limiter](02-rate-limiter.md), [26 Recommendations](26-recommendation-system.md), [28 Fine-tuning and evaluation](28-llm-finetuning-evaluation.md), [31 Stream aggregation](31-ad-click-aggregation.md), [P06 Security](../toolkit/P06-security-threat-modeling.md).

## Sources and provenance

> **Kind:** real-system parts (Facebook Immune System, Stripe Radar, Meta Few-Shot Learner) with a reference design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-11-01:** Tao Stein, Erdong Chen and Karan Mangla, [*Facebook Immune System*](https://css.csail.mit.edu/6.858/2012/readings/facebook-immune.pdf) (EuroSys Social Network Systems workshop, April 2011) · Stripe, [*How we built it: Stripe Radar*](https://stripe.com/blog/how-we-built-it-stripe-radar) (29 March 2023) · Stripe, [Radar rules](https://docs.stripe.com/radar/rules) (current docs) · Meta AI, [*Harmful content can evolve quickly. Our new AI system adapts to tackle it*](https://ai.meta.com/blog/harmful-content-can-evolve-quickly-our-new-ai-system-adapts-to-tackle-it/) (undated on the page).
> **Dated material:** 2011, 2023 and an undated 2021-era post; models, figures and products have changed since.
> **Not read:** Meta's Transparency Center pages (rendered by script, not fetched), the Few-Shot Learner research paper, Stripe's later Radar posts, YouTube or TikTok moderation material, academic adversarial-ML work.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-11-01, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Immune System paper: adversarial learning framing, attack phases, user feedback and global knowledge, latency over precision and recall, the 2% versus 1% example, features expensive for attackers, classifier services, FXL, dynamic model loading, the policy engine with responses and holdouts, feature loops, 25 billion checks a day, 650,000 per second, 20% writes and the 50 ms budget.
- Verified in Stripe's post: 1,000+ characteristics, under 100 ms, 0.1% of legitimate payments blocked, 1 in 1,000 fraud rate, the model history, the 1.5% recall cost, 85% faster training, the 10× data result, feature investigations, risk insights and card testing.
- Verified in Stripe's rules docs: rule syntax, default rules, evaluation order for 3DS rules, the allow-rule warning and the misconfiguration warning.
- Verified in Meta AI's post: months to label, weeks to adapt, 100+ languages, the training stages, zero and few-shot modes, inputs, prevalence-based A/B tests and the stated limits.
- Not sourced (our reasoning): the integrity platform design, shadow mode, label-delay handling, cascades, safety limits and cost figures.
- Not claimed: how Meta, Facebook or Stripe run these systems today.
