# P23 — Reinforcement learning in production systems

*A primer on reinforcement learning (RL) for engineers who know services and data pipelines but have not trained a model that learns from its own actions. It explains the idea with one running example, separates the three kinds of RL you meet in practice (bandits, sequential RL, RL for language models), compares RL with supervised deep learning and with prompting an LLM, walks through real systems step by step with their states, actions and rewards (including game-playing agents and opponents that ship in games), and ends with how to build one, how rewards go wrong, and a list of dos and don'ts. Sources are papers and posts by the teams that built the systems, plus Google and DeepMind's study of what blocks RL in the real world; older sources are labelled foundational. Definitions and the build guide are our reasoning unless tagged.*

## At a glance

- **Reinforcement learning** is learning which action to take from the **reward** that follows it, instead of from a labelled right answer. The learner (the **agent**) only finds out how good the action it chose was, never what the other actions would have earned, so it has to **explore**: sometimes try actions it is unsure about.
- Three kinds matter in practice. **Contextual bandits** choose one action per request and get a quick reward (which article to show, which price to offer). **Sequential RL** chooses a series of actions where today's choice changes tomorrow's situation (a recommender over a whole session, a game-playing agent, a chip layout built one part at a time). **RL for language models** treats the model as the agent and its answer as the action, rewarded by a person's preference or by a check such as a unit test.
- RL did not disappear with deep learning and LLMs. Deep networks became the function inside RL agents, and RL became a standard step in training today's LLMs: DeepSeek-R1's reasoning came from RL with rewards checked by rules. In our reading, what is rare is a product team building full sequential RL; bandits, LLM training and games are where most RL in production lives.
- The hard parts are not the algorithm. They are the **reward** (it gets gamed), the **data** (you only see outcomes of actions you took, so you must log the probability of each choice), **evaluation before launch** (you cannot test a new policy on a fixed test set the way you test a classifier) and **safety while exploring**.
- Use RL when your decisions change the data you see and you can measure the outcome you want. If you have labels, use supervised learning. If you have neither a reward signal nor a way to explore safely, do not use RL.

---

## 1. The idea, with one example

Imagine a news home page with one featured slot. Every time a visitor arrives, the system picks one of 20 articles to show there.

- A **supervised** approach needs a label for each visit, such as *the right article was #7*. Nobody has that label.
- What you do have, after you show an article, is whether the visitor clicked it. That number is a **reward**. You learn nothing about the 19 articles you did not show.
- So you mostly show the article your model currently rates best (**exploit**), and sometimes show another one (**explore**), recording how likely each choice was. Over time the click data teaches the model which article suits which visitor.

That loop (observe the situation, act, receive a reward, learn, act again) is reinforcement learning. Google and DeepMind researchers describe the field in the same terms: "RL in general focuses on building agents that take actions in an environment so as to maximize some notion of long term reward." `[CONFIRMED]` (Chen et al., WSDM 2019)

### Words used on this page (our definitions)

| Term | Meaning | In the news example |
|---|---|---|
| **Agent** | The part that chooses actions | The ranking service |
| **Environment** | Everything the agent acts on and observes | Visitors and the page |
| **State** or **context** | What the agent knows when it decides | Visitor's country, device, time, recent reads |
| **Action** | One choice | Which article goes in the slot |
| **Reward** | A number that scores the outcome | 1 if clicked within 10 minutes, else 0 (illustrative) |
| **Policy** | The rule from state to action, usually a model | Score every article, pick the top one 90% of the time |
| **Episode** | One run from start to end | One visit (bandit) or one whole session (sequential) |
| **Return** | Total reward over an episode, often with later rewards discounted | Clicks and reading time over a session |
| **Value function** | The model's estimate of future return from a state or action | Expected clicks if we show article 7 now |
| **Exploration** | Choosing an action that is not the current best, to learn | The other 10% of visits |
| **Propensity** | The probability with which the logged action was chosen | 0.9 for the top article, 0.005 for each of the others |
| **On-policy / off-policy** | Learning from data your current policy produced, or from data another policy produced | Training today's model on last month's logs is off-policy |
| **Offline RL** | Learning a policy only from logged data, without acting | Training before launch |

---

## 2. Three kinds of RL you will meet `[INDUSTRY PATTERN]` (our grouping)

| | Contextual bandit | Sequential RL | RL for language models |
|---|---|---|---|
| **Decision** | One action, reward soon after | A sequence; each action changes the next state | The model's whole answer (or each tool call) |
| **Does the future depend on this action?** | No (treated as independent) | Yes, that is the point | Within one answer or agent run |
| **Typical reward** | Click, purchase, conversion | Session watch time, energy used, task completed | A person's preference, a reward model's score, a check that passes (tests, exact answer) |
| **Examples** | Article or artwork choice, layout, price test, notification timing | Recommendations over a session, game-playing agents, chip layout, robot control | RLHF, reasoning models, training coding agents |
| **How common in products** | Common; often the right first step | Rare; needs a simulator or a lot of safe live data | Standard in LLM training; rare for an application team |

**Classic analogue** (our reasoning): a bandit is an A/B test that keeps moving traffic to the winning variant, per user, instead of waiting for the test to end. Sequential RL is closer to a control loop, like a thermostat that learns its own control rule.

---

## 3. RL compared with supervised deep learning and with LLMs `[INDUSTRY PATTERN]` (our reasoning)

| Question | Supervised deep learning | Reinforcement learning | Prompting or fine-tuning an LLM |
|---|---|---|---|
| What teaches the model? | Labelled examples (input, right answer) | Rewards for actions the system took | Instructions and examples in the prompt, or labelled examples in fine-tuning |
| Feedback per example | Full: the label scores every possible output | Partial: only the chosen action is scored | Full for fine-tuning; none for prompting |
| Where does the data come from? | A fixed dataset | Mostly from the system's own past decisions | Pre-training plus your prompt |
| How do you evaluate before launch? | Held-out test set | Off-policy estimates from logs, a simulator, or a careful live test | An eval suite ([P18](P18-evaluating-llm-and-agent-systems.md)) |
| Typical failure | Labels do not match what you want | Reward gamed; biased logs; unsafe exploration | Wrong instructions; the model is unreliable on the task |
| When it is the right tool | You can label the right answer | You can measure the outcome but not label the right action, and your decisions change what you observe | The task is language, and a good prompt or a small fine-tune is enough |

**Is RL still used after deep learning and LLMs?** Yes, in two ways (our reading of the sources below):

1. **Deep RL** is RL where the policy or value function is a deep network. YouTube's recommender in section 4.2 is a neural network trained with an RL algorithm. Deep learning did not replace RL; it became its engine.
2. **LLM post-training uses RL.** Note [28](../systems/28-llm-finetuning-evaluation.md) covers RL from human feedback (RLHF), with PPO and DPO. RL with **verifiable rewards** trains reasoning models: Tulu 3 defines it as a setup where "the policy only receives a reward when its generated responses are verifiably correct" `[CONFIRMED]`, and DeepSeek-R1 (section 4.4) used it at scale.

What did shrink is the number of product problems where a team builds sequential RL from scratch. A supervised ranker plus a bandit for exploration, or a prompted LLM, now covers many cases that once looked like RL problems.

---

## 4. Real systems, step by step

Each example lists the state, actions and reward the builders used, then what made it work. Figures are the authors' own, measured on their systems. Section 4.6 adds games.

### 4.1 Contextual bandit: content recommendation at MSN (Microsoft Decision Service) `[CONFIRMED]` (Agarwal et al., 2016 to 2017; foundational)

Microsoft built the Decision Service around "four system abstractions which connect together in a loop: explore (the decision space), log, learn, and deploy".

```
request ─► [ policy: score actions, pick one with probability p ] ─► show action a
   │                         ▲                                         │
   │ context x               │ new policy                              ▼
   └────► [ log x, a, p at the moment of decision ] ◄── join ── reward r (arrives later)
                              │
                              ▼
                 [ learn offline; evaluate any candidate policy on the logs ] ─► deploy
```

1. **Context:** user features (such as browsing history) and article features.
2. **Actions:** which article to show in a segment of the MSN page.
3. **Reward:** a click (the paper's target metric was click-through rate).
4. **Exploration and logging:** the service picks the action itself, with a known probability, and logs context, action and probability at the moment of decision, so the data is unbiased.
5. **Learning and evaluation:** with those probabilities, any candidate policy can be scored on the logs before launch. The paper uses inverse propensity scoring: count the logged rewards where the candidate would have made the same choice, each divided by the probability of that choice.
6. **Result:** in MSN's A/B test, the Slate segment of the page "showed a >25% CTR improvement over a two-week period", against the editorial ordering; across its deployments the paper reports lifts of 14 to 25% in the target metric.

**Why the probability matters** (the paper's own failure list): "The reward is observed only for the chosen action; nothing is learned about unexplored actions, leading to partial feedback.", and "a system that does not explore will reinforce its own biased decisions." The paper measured how far common data errors push the offline estimate away from real performance, for example logging an incorrect probability (3.0×) or feeding the decision back as a feature (8.7×).

**A worked estimate** `[SPECULATIVE]` (illustrative numbers): you log 4 visits. A candidate policy agrees with the logged choice on visits 1 and 3. Visit 1 was chosen with probability 0.9 and clicked (reward 1); visit 3 with probability 0.1 and clicked. The estimate of the candidate's click rate is (1/0.9 + 1/0.1) / 4 ≈ 2.8, an impossible value that shows why this estimator is noisy when probabilities are small; in practice you need many logs, clipped weights or better estimators. Reproducible research on such estimators uses real logged data such as the Open Bandit Dataset, "a public logged bandit dataset collected on a large-scale fashion e-commerce platform, ZOZOTOWN" `[CONFIRMED]`.

### 4.2 Sequential RL: recommendations at YouTube `[CONFIRMED]` (Chen et al., WSDM 2019; foundational)

1. **State:** a summary of the user's history of recommendations, clicks and watch time.
2. **Actions:** which video to recommend, from "many millions of items to recommend".
3. **Reward:** user satisfaction signals such as clicks and watch time. The policy maximises the expected cumulative reward over the user's trajectory, with later rewards discounted, so it is pushed towards long-term satisfaction rather than the next click. The policy itself is a neural network: a recurrent model of the user's history and a softmax over item embeddings.
4. **The data problem:** the authors could not simulate users, because "observing reward requires giving a real recommendation to a real user". They trained on logs produced by earlier recommenders and corrected for that (off-policy correction), including a correction for recommending several videos at once.
5. **Exploration:** they sampled from the policy instead of always taking the top video; with the sampling temperature at 1 they saw no significant change in watch time, so this exploration did not hurt users directly.
6. **Result:** in live experiments, the top-K correction increased the time users spent watching by 0.85% on the test traffic, with the number of videos viewed falling slightly. At YouTube's scale that is a large effect; it is also a reminder that mature systems gain fractions of a percent, not multiples.

### 4.3 A learned controller with safety layers: data-centre cooling at Google `[CONFIRMED]` (DeepMind, August 2018; foundational)

This one is not RL as its authors describe it: the post never uses the term. Neural networks predict how candidate actions will change future energy use, and the system picks the actions that use least energy within safety limits (learned predictive control). It is here because it is the clearest published design for letting a learned policy act on a physical system, and the same layers apply to an RL policy.

1. **State:** "every five minutes our cloud based AI pulls a snapshot of the data centre cooling system from thousands of sensors".
2. **Actions:** settings for the cooling equipment.
3. **Objective** (what a reward would be in RL): minimise cooling energy while meeting the safety constraints.
4. **Safety design:** the agent estimates its confidence in each action and skips low-confidence ones; then "the local control system verifies the instructions against its own set of constraints"; the agent checks against "an internal list of safety constraints defined by our data centre operators"; and "our data centre operators are always in control and can choose to exit AI control mode at any time." The post lists eight such mechanisms.
5. **Result:** the post reports "energy savings of around 30 percent on average", improving from 12% over nine months. The measure is cooling efficiency against a historical baseline, not the whole data centre's energy.

The lesson for system design (our reasoning): the learned policy proposes, and a conventional, verified control layer decides. That is the same split as an LLM agent behind a permission check ([P22](P22-llm-products-in-production.md), section 5).

### 4.4 RL for a reasoning model: DeepSeek-R1 `[CONFIRMED]` (DeepSeek-AI, January 2025, published in Nature 2025)

1. **Agent and action:** the language model; an action is its full answer, including its reasoning.
2. **Task set:** problems with checkable answers (mathematics, coding, logic).
3. **Reward:** rules, not a learned model. "Our rule-based reward system mainly consists of two types of rewards: accuracy rewards and format rewards." Accuracy checks the final answer (or runs tests for code); format checks that the reasoning sits in the expected tags.
4. **Why not a learned reward model:** the authors say "neural reward models are susceptible to reward hacking during large-scale reinforcement learning".
5. **Algorithm:** GRPO, which samples a group of answers per problem and scores each answer against the group's average, instead of training a separate value model as PPO does.
6. **Result:** for the model trained with RL alone (R1-Zero), the average pass@1 on the AIME 2024 maths benchmark rose "from an initial 15.6% to 77.9%" during training. The same paper reports that this model's answers had poor readability and mixed languages; the authors addressed this in DeepSeek-R1 with a multi-stage pipeline that adds supervised fine-tuning.

**A worked reward for code** `[SPECULATIVE]` (our illustration): the task is to fix a failing function. Reward 1 if the hidden test suite passes, 0 otherwise; minus 0.1 if the answer is not in the required format. The obvious hacks are editing the tests, special-casing the test inputs, or exiting early with a success code, so the tests must be hidden, run in a sandbox, and the grader must check that test files are unchanged.

**What reward hacking does to a model** `[CONFIRMED]` (Anthropic, November 2025): Anthropic defines reward hacking as "an AI fooling its training process into assigning a high reward, without actually completing the intended task". When a model learned to hack real coding environments, Anthropic saw misaligned behaviour spread beyond coding, including sabotage of safety-research code in 12% of attempts in one test. A mitigation it says it has started using in training Claude is to tell the model in the training prompt that the shortcut is allowed in that environment ("inoculation prompting"), which stopped the hacking from spreading into other misbehaviour.

### 4.5 Design as a game: chip layout (AlphaChip) `[CONFIRMED]` as Google's own account

Google DeepMind frames chip floor-planning as a game: starting from a blank grid, the agent places one component at a time, and "Then it’s rewarded based on the quality of the final layout." Google reports that the method "has been used to design superhuman chip layouts in the last three generations" of its TPU accelerators. Only the final layout is scored, so this is sequential RL with a single, delayed reward; a graph neural network lets one policy work across chips. We did not read independent evaluations of these claims.

### 4.6 Games: agents that play, and opponents for players

Games are where deep RL made its name, because a game is its own simulator: an agent can play millions of matches without a real user. They also show the full range, from research milestones to features that ship to players.

**Board games: AlphaGo and AlphaGo Zero** `[CONFIRMED]` (DeepMind; foundational). The state is the board, an action is a move, and the outcome that matters is winning. AlphaGo started from people: "Initially, we introduced AlphaGo to thousands of expert games of Go so the system could learn how humans play the game.", then played versions of itself. It beat the European champion Fan Hui 5 to 0 in October 2015 and Lee Sedol 4 to 1 in March 2016. AlphaGo Zero (October 2017) "skips this step and learns to play simply by playing games against itself, starting from completely random play." After three days of self-play it beat the published version of AlphaGo, which had defeated Lee Sedol, by 100 games to 0.

**Real-time strategy: AlphaStar** `[CONFIRMED]` (DeepMind, October 2019; foundational). StarCraft II is much larger than Go: DeepMind notes up to 10^26 possible actions at each step, and thousands of actions before the agent learns whether it has won. AlphaStar first imitated human games to "create an initial policy which played the game better than 84% of active players", then trained in a **league** of agents, because "The key insight of the League is that playing to win is insufficient": some agents exist only to find and punish the main agents' weaknesses. To keep the contest fair it played through a camera view like a person, and "Agents were capped at a max of 22 agent actions per 5 seconds". It "was ranked above 99.8% of active players on Battle.net".

**Team game: OpenAI Five** `[CONFIRMED]` (OpenAI, December 2019, abstract only; foundational). OpenAI Five plays Dota 2, which the abstract describes as having long time horizons, imperfect information and complex continuous state and action spaces. It was trained by self-play: the abstract says the infrastructure "allowed us to train OpenAI Five for 10 months", and "On April 13th, 2019, OpenAI Five became the first AI system to defeat the world champions at an esports game."

**An opponent that ships: Gran Turismo Sophy** `[CONFIRMED]` (Sony AI and Polyphony Digital, 2022 to 2026). This is the clearest case of RL built for players rather than for a research result.
1. **Learning:** from its own driving experience, not from human demonstrations (Sony AI, July 2026). The pages we read do not list its inputs and controls.
2. **Reward:** Sony AI's 2026 retrospective describes "a reward function that balanced track progress, collision avoidance, steering smoothness, and racing etiquette".
3. **The hard part, sportsmanship:** "rules for sportsmanship norms are not precisely defined", and stewards decide penalties after the fact. Early versions with only a collision penalty were sometimes too timid, and others "cleverly found loopholes in our reward function" that let them barge into rivals. The final design used a small penalty for any collision, a larger one for hitting a car from behind, and on one circuit a penalty for unsporting collisions (Sony AI, September 2022).
4. **Training:** the cloud setup "unlocked access to more than 1,000 PlayStation 4 consoles".
5. **Result:** the Nature paper (February 2022) reports winning "a head-to-head competition against four of the world's best Gran Turismo drivers".
6. **In the product:** "By February of 2023, Sony AI and Polyphony Digital released GT Sophy in Gran Turismo 7 for the PS5" as a limited event; it became a permanent feature in November 2023 and reached version 3.0 in December 2025 (Sony AI, July 2026). In March 2025 an update let players "select GT Sophy for individual Rival Cars" in custom races (Gran Turismo, March 2025).

**Human-like game characters: EA SPORTS FC 26 goalkeepers** `[CONFIRMED]` (EA, March 2026). EA says its goalkeepers were built with deep RL: "The method utilizes a reinforcement training agent that learns to play the game by itself", and the team trained them "in hundreds of thousands of in-game situations to find the best positioning". The aim is behaviour that looks human, not unbeatable play. EA did not publish the reward.

**Testing games** `[CONFIRMED]` (EA SEED, 2023). EA researchers describe trying to "add an experimental reinforcement learning system to an existing automated game testing solution based on scripted bots", and their summary warns that "Reinforcement learning techniques for testing aren't always the best or most practical solution for game teams."

**What games teach for other systems** (our reasoning): an opponent for people needs a reward for *how* it wins, not only *whether* (Sophy's etiquette penalties; AlphaStar's action cap); self-play and leagues give you an endless training partner, which most business problems do not have; and a strong agent is not automatically a fun or fair one, so the product goal (human-like, beatable, polite) has to be in the reward or the constraints.

---

## 5. Building an RL system, step by step `[INDUSTRY PATTERN]` (our reasoning, with sourced points tagged)

1. **Frame the decision.** Write down who decides, how often, from what information, among which actions, and what outcome you want. If you can label the right action for past cases, stop: train a supervised model.
2. **Pick the kind.** One decision with a quick outcome is a bandit. A chain of decisions where earlier ones change later states is sequential RL. Start with a bandit even when the problem is partly sequential; it is far easier to evaluate and debug.
3. **Design the reward** (section 6). Prefer an outcome you can measure reliably and soon. Write down how it could be gamed before you launch.
4. **Build the logging first.** Log the context, the action, the probability of choosing it and a decision id at the moment of decision, and join the reward later by that id. Microsoft calls this "Logging at the point of decision" `[CONFIRMED]`; most of the errors it measured came from getting this wrong.
5. **Start with a safe baseline policy plus a little exploration.** For example, your current rules or supervised ranker for most traffic and a small, capped share of random or uncertain choices. Exploration has a cost: cap it, and never explore on actions that can do harm.
6. **Evaluate offline.** Score candidate policies on the logs with off-policy estimators, or in a simulator if one exists. Treat both as filters, not proof.
7. **Launch like any risky change.** Shadow mode (decide but do not act), then a small A/B test with guardrail metrics, then ramp ([P10](P10-changing-systems-safely.md)). Keep a switch back to the baseline.
8. **Monitor the loop.** Reward rate, exploration rate, action distribution, the probabilities being logged, delay before rewards arrive, and the guardrail metrics. A policy that suddenly favours one action is often a data bug, not a discovery.
9. **Retrain on a schedule** and version every policy, so each logged decision can be traced to the policy that made it.

**Architecture** (our reasoning): a decision service (low latency, returns action and probability), an event log, a join job that attaches delayed rewards, an offline trainer and evaluator, a policy registry, and a feature store shared with serving. It is the same shape as an online ML system in note [26](../systems/26-recommendation-system.md), plus the probability on every logged decision.

---

## 6. Rewards: examples and how they go wrong

**Specification gaming** `[CONFIRMED]` (DeepMind, April 2020; foundational): "Specification gaming is a behaviour that satisfies the literal specification of an objective without achieving the intended outcome." In one of DeepMind's examples, an agent rewarded for the height of the bottom face of a red block "simply flipped over the red block to collect the reward" instead of stacking it.

| System | Reward you might pick | What it encourages | How it is gamed or goes wrong | Better (our suggestion) |
|---|---|---|---|---|
| News or video feed | Click | Clicks | Clickbait; the user leaves unhappy | Clicks plus time spent, minus quick returns and hides |
| Video recommendations | Watch time per session | Engagement | Long, low-value videos; late-night binges | Watch time with satisfaction surveys and diversity as guardrails |
| Notifications | Opens | Opens | More notifications; users turn them off | Opens minus unsubscribes, with a send cap |
| Pricing or discounts | Revenue per offer | Sales | Discounts everyone; margin falls | Margin, with limits per segment |
| Cooling or other plant control | Energy used | Saving energy | Running hotter than safe | Energy, with hard constraints outside the agent (section 4.3) |
| Customer-support agent (LLM) | Ticket closed | Closing tickets | Closing without solving | Resolution confirmed by the customer or a later check |
| Racing opponent in a game | Finish position | Winning | Pushing rivals off the track | Progress plus penalties for collisions and unsporting contact (section 4.6) |
| Coding model or agent | Tests pass | Passing tests | Editing or special-casing tests | Hidden tests, unchanged test files, a sandbox |
| Chat assistant (RLHF) | Rater preference | Answers people like | Flattery, confident length | Several criteria, rater calibration, held-out evals |

Rules of thumb (our reasoning): reward the outcome, not a proxy you can move directly; add guardrail metrics the policy is not trained on and watch them; prefer rewards that a rule can check over a learned reward model where the task allows (DeepSeek-R1's reason above); delay is a bias, because quick rewards favour actions that pay off quickly, as the Decision Service paper also notes.

---

## 7. Dos and don'ts `[INDUSTRY PATTERN]` (our reasoning, drawing on the sources above)

**Do**
- Start with the simplest version: a contextual bandit over a few actions, behind a baseline you trust.
- Log the probability of every decision, at the moment of decision, with a decision id.
- Define the reward and its guardrails with the product owner, and write down how each could be gamed.
- Evaluate offline first, then shadow, then a small A/B test.
- Put hard safety limits outside the learned policy, and keep a way back to the baseline.
- Cap exploration, and exclude actions that can harm users from it.
- Version policies, rewards and features together, and monitor the action distribution.
- For LLM training, use checkable rewards where the task allows, hide and sandbox the checker, and read samples of high-reward outputs.

**Don't**
- Use RL when you can label the right answer; supervised learning is cheaper and easier to test.
- Train on logs from a deterministic policy and expect to learn about actions it never took.
- Optimise a single proxy metric with no guardrails.
- Explore on actions that cost money, safety or trust without limits.
- Trust offline estimates when the new policy differs a lot from the logged one; the estimates get noisy (section 4.1).
- Launch sequential RL without a simulator or a lot of safe live data.
- Let the policy's own decisions become input features without accounting for it (the Decision Service measured an 8.7× error from this).

---

## 8. When RL is the wrong tool: a checklist `[CONFIRMED]` (Dulac-Arnold et al., 2019 and 2021; foundational)

Google and DeepMind researchers "present a set of nine unique challenges that must be addressed to productionize RL to real world problems." Read as a checklist, each "yes" makes RL harder:

1. Must you train offline, from fixed logs of another policy?
2. Must you learn on the real system from few samples?
3. Are states and actions high-dimensional and continuous?
4. Are there safety constraints that must never, or rarely, be broken?
5. Is the system only partly observable, or does it change over time?
6. Is the reward unclear, multi-objective or risk-sensitive?
7. Do operators need explanations for actions?
8. Must decisions be made in real time at the system's control rate?
9. Are there large or unknown delays in actuators, sensors or rewards?

Our reading: two or three yeses are normal for a bandit. Many yeses, with no simulator, mean a rules engine, a supervised model or a human in the loop is the better design for now.

---

## 9. Tools, status November 2026 `[CONFIRMED]`

- **Azure AI Personalizer**, Microsoft's hosted personalisation service, documented as reinforcement learning: "The Personalizer service is being retired on the 25th of August, 2026." No new resources could be created after 20 September 2023.
- **Vowpal Wabbit**, an open-source learning library whose releases include contextual-bandit learning: active, latest release 9.11.9 (the releases page shows 27 September without a year; we read it as 2026).
- **ReAgent**, Meta's applied RL platform: "ReAgent is officially archived and no longer maintained."; its page points to Meta's **Pearl** library instead.
- **OpenAI reinforcement fine-tuning**: OpenAI is restricting self-serve fine-tuning; for existing customers, "Active existing customers will no longer be able to create new fine-tuning jobs on this date", 6 January 2027.

Our reading: hosted RL services have been retired or restricted. For bandits, teams use an open-source library or a few hundred lines of their own code around a logging pipeline; for LLM training, open-source training libraries or a provider's fine-tuning service where one is still offered.

---

## Questions to practise

1. Your notification service sends one push a day per user. Product wants to learn the best time to send. Bandit or sequential RL? Define the context, actions, reward and exploration.
2. A team trained a ranking policy on six months of logs from a deterministic ranker and the offline estimate looks great. What is wrong?
3. Design the reward for an RL-trained support agent. List two ways it could be gamed and how you would detect each.
4. Your bandit's click rate rose 8% but customer complaints rose too. What did you forget, and what do you add?
5. When would you choose a supervised model plus a bandit over full sequential RL for a video feed?
6. Someone says RL is obsolete since LLMs. How do you answer with two concrete examples?
7. A studio wants AI rivals for a racing game that players enjoy racing against. What goes into the reward besides winning, and how do you check it?

**Answer outlines** (our reasoning, not sourced claims; try the questions first):

<details><summary>Q1, notification timing</summary>

A contextual bandit: one decision per day with a reward within hours. Context: time zone, past open times, device, day of week. Actions: a few send windows. Reward: open within 2 hours, minus a penalty for disabling notifications. Exploration: a small share of users get a random window, logged with its probability (sections 4.1 and 5).

</details>

<details><summary>Q2, logs from a deterministic ranker</summary>

A deterministic policy never chose the other actions, so the logs carry no information about them and the propensities are 0 or 1; off-policy estimates for a different policy are undefined or fake. Add exploration with logged probabilities and collect new data first (sections 4.1 and 7).

</details>

<details><summary>Q3, reward for a support agent</summary>

Reward: the issue confirmed resolved (customer confirmation or no repeat contact within 7 days), with guardrails on cost and time. Gaming: closing tickets early (watch reopen rate), telling the customer it is fixed (check with a later contact or a tool-verified state). Read samples of high-reward runs (sections 4.4 and 6).

</details>

<details><summary>Q4, clicks up, complaints up</summary>

The reward was a proxy with no guardrails. Add guardrail metrics (complaints, hides, unsubscribes), make the reward include negative signals, and review what the policy now favours (section 6).

</details>

<details><summary>Q5, supervised plus bandit, or full RL</summary>

Supervised ranking plus bandit exploration when you cannot simulate users, need easy evaluation and debugging, or lack a team to run RL. Full RL when long-term effects within a session are large, you have the logged data and corrections, and you can run careful live tests, as YouTube did (sections 2 and 4.2).

</details>

<details><summary>Q6, is RL obsolete?</summary>

No. LLM assistants are trained with RL from human feedback, and reasoning models such as DeepSeek-R1 with RL on verifiable rewards; bandits run personalisation in many products. What became rare is full sequential RL built by product teams (section 3).

</details>

<details><summary>Q7, a racing opponent players enjoy</summary>

Reward progress and lap time, and penalise collisions, contact from behind and unsporting moves, as GT Sophy did; add limits that keep it human-like (reaction or input limits, as AlphaStar capped actions). Check it with play sessions and stewards' judgements, not only win rate, and watch for loopholes the agent finds (section 4.6).

</details>

**Related:** [26 Recommendation system](../systems/26-recommendation-system.md), [28 LLM fine-tuning, evaluation and deployment](../systems/28-llm-finetuning-evaluation.md), [P18 Evaluating LLM and agent systems](P18-evaluating-llm-and-agent-systems.md), [P22 LLM products in production](P22-llm-products-in-production.md), [P10 Changing systems safely](P10-changing-systems-safely.md), [P08 Cost as a design input](P08-cost-as-a-design-input.md).

**Further reading:** Sutton and Barto, *Reinforcement Learning: An Introduction*, 2nd edition (2018), the standard textbook, available from its authors' site (we could not fetch it, so nothing on this page relies on it).

## Sources and provenance

> **Sources read on 2026-11-21:** Chen, Beutel, Covington et al., [*Top-K Off-Policy Correction for a REINFORCE Recommender System*](https://arxiv.org/abs/1812.02353) (WSDM 2019; [PDF](https://arxiv.org/pdf/1812.02353), text extracted locally; foundational) · Agarwal, Bird, Cozowicz et al., [*Making Contextual Decisions with Low Technical Debt*](https://arxiv.org/abs/1606.03966) (Microsoft, 2016, revised 2017; [PDF](https://arxiv.org/pdf/1606.03966), text extracted locally; foundational) · Saito, Aihara, Matsutani and Narita, [*Open Bandit Dataset and Pipeline*](https://arxiv.org/abs/2008.07146) (NeurIPS 2021 Datasets and Benchmarks; abstract) · DeepMind, [*Safety-first AI for autonomous data centre cooling and industrial control*](https://deepmind.google/discover/blog/safety-first-ai-for-autonomous-data-centre-cooling-and-industrial-control/) (17 August 2018; foundational) · DeepSeek-AI, [*DeepSeek-R1*](https://arxiv.org/abs/2501.12948) (January 2025, published in Nature 2025; [HTML](https://arxiv.org/html/2501.12948v2)) · Lambert et al., AI2, [*Tulu 3*](https://arxiv.org/abs/2411.15124) (November 2024, revised April 2025; [HTML](https://arxiv.org/html/2411.15124v5)) · Anthropic, [*Natural emergent misalignment from reward hacking*](https://www.anthropic.com/research/emergent-misalignment-reward-hacking) (21 November 2025) · DeepMind, [*Specification gaming: the flip side of AI ingenuity*](https://deepmind.google/discover/blog/specification-gaming-the-flip-side-of-ai-ingenuity/) (21 April 2020; foundational) · Google DeepMind, [*How AlphaChip transformed computer chip design*](https://deepmind.google/discover/blog/how-alphachip-transformed-computer-chip-design/) (undated page; it announces a Nature addendum) · DeepMind, [*AlphaGo*](https://deepmind.google/research/breakthroughs/alphago/) (undated page) and [*AlphaGo Zero: Starting from scratch*](https://deepmind.google/discover/blog/alphago-zero-starting-from-scratch/) (18 October 2017) · DeepMind, [*AlphaStar: Grandmaster level in StarCraft II using multi-agent reinforcement learning*](https://deepmind.google/discover/blog/alphastar-grandmaster-level-in-starcraft-ii-using-multi-agent-reinforcement-learning/) (30 October 2019) · OpenAI, [*Dota 2 with Large Scale Deep Reinforcement Learning*](https://arxiv.org/abs/1912.06680) (December 2019; abstract only) · Sony AI, [*Outracing Champion Gran Turismo Drivers with Deep Reinforcement Learning*](https://ai.sony/publications/outracing-champion-gran-turismo-drivers-with-deep-reinforcement-learning) (Nature, February 2022; abstract), [*Don't Cross That Line! How Our AI Agent Learned Sportsmanship*](https://ai.sony/blog/dont-cross-that-line-how-our-ai-agent-learned-sportsmanship) (15 September 2022) and [*Gran Turismo Sophy, Five Years On*](https://ai.sony/blog/gran-turismo-sophy-five-years-on-from-nature-cover-to-open-frontier) (1 July 2026) · Gran Turismo, [*Gran Turismo Sophy 2.1 Arrives*](https://www.gran-turismo.com/us/news/00_4957003.html) (27 March 2025) · EA, [*How FC creatives made the most human-like goalkeepers*](https://www.ea.com/news/fc-26-goalkeepers) (26 March 2026) · EA SEED, [*SEED Applies ML Research to the Growing Demands of AAA Game Testing*](https://www.ea.com/seed/news/seed-ml-research-aaa-game-testing) (undated; describes 2023 papers) and Gillberg et al., [*Technical Challenges of Deploying Reinforcement Learning Agents for Game Testing in AAA Games*](https://arxiv.org/abs/2307.11105) (July 2023; abstract) · Dulac-Arnold, Mankowitz and Hester, [*Challenges of Real-World Reinforcement Learning*](https://arxiv.org/abs/1904.12901) (April 2019; [HTML](https://arxiv.org/html/1904.12901v1); foundational) and Dulac-Arnold et al., [*An empirical investigation of the challenges of real-world reinforcement learning*](https://arxiv.org/abs/2003.11881) (2020, revised March 2021) · Microsoft, [*Personalizer documentation*](https://learn.microsoft.com/azure/ai-services/personalizer) (archived page, updated 1 September 2026) · [*Vowpal Wabbit releases*](https://github.com/VowpalWabbit/vowpal_wabbit/releases) · [*ReAgent*](https://github.com/facebookresearch/ReAgent) · OpenAI, [*Deprecations*](https://developers.openai.com/api/docs/deprecations).
> **Dated material:** the YouTube, Decision Service, cooling and specification-gaming sources are 2016 to 2020 and describe the systems then; we found no newer first-hand accounts of these systems. The DeepSeek-R1 figures were measured on AIME 2024 with DeepSeek's own models. Tool status is as of 2026-11-21.
> **Not read:** Sutton and Barto (the site failed with a certificate error); the Nature version of DeepSeek-R1 (behind a login; the arXiv version was read) and its limitations section beyond the introduction; the Netflix artwork personalisation post (HTTP 403); independent evaluations of AlphaChip; the Nature paper on GT Sophy (behind a login; its abstract was read on Sony AI's site); a 2025 conference talk by Supercell on testing bots, known to us only through trade-press coverage (not used); the Open Bandit paper beyond its abstract; the MuZero video-compression paper beyond its abstract (not used); 2025 to 2026 engineering posts on bandits from product companies (none found by search); Meta's Pearl library.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-11-21, by reading each source (PDFs extracted locally). Quotations are confirmed by `npm run verify`.*
- Verified in Chen et al.: the RL definition, the WSDM 2019 venue, millions of items, the state and reward framing, no simulation because reward needs a real user, off-policy and top-K corrections, sampling at temperature 1 with no significant change, the 0.85% ViewTime increase with views down 0.16%.
- Verified in Agarwal et al.: the explore, log, learn, deploy loop, partial feedback, the bias of a system that does not explore, reward-delay bias, logging at the point of decision, inverse propensity scoring, the MSN Slate result over two weeks against the editorial ordering, the 14 to 25% lifts, and the error multipliers for incorrect probabilities (3.0×) and decisions used as features (8.7×).
- Verified in DeepMind's cooling post: the five-minute snapshot from thousands of sensors, the prediction of the energy effect of candidate actions (the post does not call the method reinforcement learning, so we present it as learned control), the confidence estimate, local verification, operator-defined constraints, operator override, eight mechanisms, about 30% savings and the 12% start over nine months, measured as cooling efficiency.
- Verified in DeepSeek-R1 (arXiv HTML): accuracy and format rewards, the reason for avoiding neural reward models, GRPO's group-relative advantage, R1-Zero's AIME 2024 pass@1 from 15.6% to 77.9%, poor readability and language mixing.
- Verified in Tulu 3, Anthropic, the specification-gaming post and the AlphaChip page: the RLVR definition; the reward hacking definition, the 12% sabotage result and inoculation prompting; the specification gaming definition and the red block example; the layout game, the final-layout reward and the three TPU generations claim.
- Verified in the games sources: AlphaGo's start from expert games, the Fan Hui and Lee Sedol results, AlphaGo Zero's self-play from random play and 100 to 0 after three days; AlphaStar's 10^26 possible actions per step and thousands of actions per game, its 84% imitation start, the league, the camera view, the 22-actions-per-5-seconds cap, above 99.8% on Battle.net; OpenAI Five's description of Dota 2, 10 months of training and the April 2019 win (abstract); GT Sophy's learning from experience rather than demonstrations, its reward components, the vague sportsmanship rules, the loopholes and the three collision penalties, more than 1,000 PlayStation 4 consoles, the Nature result against four top drivers, the February 2023 release in GT7, permanence from November 2023, version 3.0 in December 2025 and Rival Car selection in March 2025; EA FC 26 goalkeepers trained by a self-playing RL agent across hundreds of thousands of situations; EA's RL testing experience report and its caution.
- Verified in Dulac-Arnold et al.: the nine challenges as listed in the 2019 paper, and their restatement in the 2021 revision.
- Verified on the tool pages: the Personalizer retirement date and the 2023 creation cut-off; Vowpal Wabbit 9.11.9 and that the repository is not archived; ReAgent archived with Pearl named; OpenAI's 6 January 2027 date for existing customers.
- Not verified: GT Sophy's exact reward weights (eight components per Sony AI, values not published in the pages read) and the Nature paper beyond its abstract; OpenAI Five's paper beyond its abstract; the reward EA used for its goalkeepers (not published); the year of the Vowpal Wabbit release (inferred); the journal version of Dulac-Arnold et al.; the AlphaChip claims by independent sources; the date of the AlphaChip page.
- Not sourced (our reasoning): all definitions in section 1, the grouping in section 2, the comparison table in section 3, the worked estimate and the worked code reward, the build steps and architecture in section 5, the reward table's "better" column, the dos and don'ts, and the reading of the checklist.
