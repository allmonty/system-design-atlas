# P18 — Evaluating LLM and agent systems

*A primer on how to tell whether an LLM feature or an agent works, and whether a change made it better or worse. It covers the vocabulary and grader types in Anthropic's guide to agent evals, reference-free RAG metrics from the Ragas paper, how AWS splits an agent's score into goal and per-tool parts, and what the MAST study found about verification in multi-agent systems. Statements from those sources are tagged; the pipeline and interview advice are our reasoning and are labelled.*

## At a glance

- An eval is a test: "give an AI an input, then apply grading logic to its output to measure success". For an agent, the input is a task in an environment and the thing to grade is usually the **outcome** (the state of the environment at the end), not what the agent says it did.
- Graders come in three kinds: **code** (fast, cheap, objective, brittle), **model** (flexible, needs calibration with people) and **human** (the reference, slow and expensive). Use code where you can and models where you must, and use people to calibrate both.
- Keep two suites: **capability** evals that start with a low pass rate and give you something to improve, and **regression** evals that should pass nearly 100% of the time and catch backsliding.
- Agents are not deterministic, so run several **trials**. pass@k (at least one of k succeeds) suits tools where one success is enough. pass^k (all k succeed) suits customer-facing agents, and it falls fast: 75% per trial gives about 42% over three trials.
- Retrieval answers can be scored without reference answers (Ragas faithfulness, answer relevance, context relevance), and an agent's run can be scored as a whole goal plus a score for each tool it used.
- The eval itself is often what is broken. Read transcripts before trusting a score.

---

## 1. Vocabulary `[CONFIRMED]` (Anthropic, *Demystifying evals for AI agents*, January 2026)

- **Task:** one test with defined inputs and success criteria. **Trial:** one attempt at a task; several trials are run "because model outputs vary between runs".
- **Grader:** logic that scores one aspect of performance; a task can have several graders, each with several assertions.
- **Transcript** (trace, trajectory): the complete record of a trial, including outputs, tool calls, reasoning and intermediate results.
- **Outcome:** the final state of the environment. A flight-booking agent may say the flight is booked, but "the outcome is whether a reservation exists in the environment's SQL database".
- **Evaluation harness:** runs tasks, often concurrently, records every step, grades and aggregates. **Agent harness** (scaffold): the system that lets the model act as an agent. Evaluating "an agent" evaluates the harness and the model together.

The post adds that agent evals are harder than single-turn ones because mistakes "can propagate and compound" over many turns, and because a strong model can find a valid solution that the eval did not anticipate. One example: on a τ2-bench flight-booking task, Opus 4.5 found a loophole in the policy. It failed the task as written but found a better outcome for the user.

## 2. Graders, and how to combine them `[CONFIRMED]` (Anthropic, January 2026)

| Grader | Examples from the post | Strength | Weakness |
|---|---|---|---|
| Code | string match, unit tests (fail-to-pass, pass-to-pass), static analysis, checks on tool calls and their parameters, transcript checks (turns, tokens) | fast, cheap, reproducible | brittle to valid variations; weak on subjective tasks |
| Model | rubrics, natural-language assertions, pairwise comparison, reference-based grading, several judges reaching consensus | flexible, handles open-ended output | not deterministic, costs more, "requires calibration with human graders for accuracy" |
| Human | subject-matter experts, crowdsourcing, spot checks, A/B tests | the quality reference; used to calibrate model graders | expensive and slow |

The post's advice on grader choice: "We recommend choosing deterministic graders where possible, LLM graders where necessary or for additional flexibility, and using human graders judiciously for additional validation." A task's score can be weighted, binary (all graders must pass) or a mix of the two.

- **Grade what was produced, not the path.** Checking for an exact sequence of tool calls is too rigid, because agents find valid approaches the eval designer did not expect.
- **Give partial credit** when a task has several parts. A support agent that found the problem and verified the customer but did not process the refund did better than one that failed at once.
- **For model graders:** use a structured rubric, give the judge a way out (answer `Unknown` when it lacks information), and "grade each dimension with an isolated LLM-as-judge rather than using one to grade all dimensions". Known judge biases (position, length, favouring its own outputs) are covered in [28 LLM fine-tuning and evaluation](../systems/28-llm-finetuning-evaluation.md).
- **By agent type:** coding agents are graded mainly by tests (SWE-bench Verified passes only if failing tests are fixed without breaking others). Conversational agents check the end state, transcript limits and a rubric, often with a second LLM simulating the user (τ-Bench, τ2-Bench). Research agents check groundedness, coverage and source quality, with rubrics calibrated against experts. Computer-use agents check real state, such as whether an order was actually placed, not just whether a confirmation page appeared.

## 3. Capability and regression suites; pass@k and pass^k `[CONFIRMED]` (Anthropic, January 2026)

- **Capability evals** ask what the agent can do well. They "should start at a low pass rate", targeting tasks the agent struggles with.
- **Regression evals** ask whether it still handles what it used to, and "should have a nearly 100% pass rate". A drop signals that something broke. Capability tasks that reach a high pass rate can graduate into the regression suite.
- **Trials and metrics.** pass@k is the chance that at least one of k trials succeeds; it rises with k. pass^k is the chance that all k succeed; it falls with k (a 75% per-trial rate gives (0.75)³ ≈ 42% for three trials). At k = 1 the two are equal. By k = 10, pass@k is near 100% and pass^k near 0%.
- **How many tasks.** "20-50 simple tasks drawn from real failures is a great start". Early changes have large effects, so small samples are enough; mature agents need larger and harder suites. Sources of tasks: the checks you already run by hand, the bug tracker and the support queue.
- **Balance.** Test both where a behaviour should happen and where it should not. Anthropic's web-search evals had to cover queries that need a search and queries the model should answer from what it knows, or the model learned to search for everything.
- **Isolation.** Start each trial from a clean environment. Leftover files, caches or exhausted resources make failures correlated. In one internal eval, Claude gained an unfair advantage by reading the git history of earlier trials.

## 4. Grading retrieval without reference answers: Ragas `[CONFIRMED]` (Es et al., arXiv, September 2023)

When there are no labelled answers yet, Ragas scores a RAG answer from the question, the retrieved context and the answer alone, by prompting an LLM:
- **Faithfulness:** supported statements ÷ all statements in the answer. An answer is faithful "if the claims that are made in the answer can be inferred from the context".
- **Answer relevance:** how similar the original question is to questions generated from the answer.
- **Context relevance:** the share of context sentences needed to answer.

On the authors' WikiEval set (50 Wikipedia pages, two annotators), these matched the human choice in 95%, 78% and 70% of pairwise comparisons, against 72%, 52% and 63% when ChatGPT was asked directly for a score. The faithfulness test pitted each answer against one generated with no context, an easy contrast. The grader was gpt-3.5-turbo-16k. Details and caveats are in [23 RAG knowledge assistant, section 4b](../systems/23-rag-knowledge-assistant.md).

## 5. Grading an agent's run: goal plus per-tool scores `[CONFIRMED]` (AWS Machine Learning Blog, April 2025)

AWS's open-source framework for evaluating Amazon Bedrock Agents shows one way to structure the score of a run. An evaluation job calls the agent with a dataset of questions and ground truth, parses the invocation traces, scores them, and sends scores and traces to Langfuse.
- **Agent goal, on every question:** a model judge compares the agent's reasoning with its instructions. It scores helpfulness, faithfulness and instruction following, with no reference answer.
- **Task accuracy, only when a tool was used:** "The task accuracy metrics are only evaluated when the corresponding tool is used to answer the question." For retrieval it uses Ragas metrics (faithfulness, answer relevancy, context recall, semantic similarity against the ground truth). For text-to-SQL it checks whether the query is equivalent to the reference query and whether the answer matches.
- **Multi-agent:** in the post's pharmaceutical research example, a supervisor agent directs four specialists. Retrieval is scored on the clinical-evidence sub-agent, SQL on the database sub-agent, and the goal on the supervisor's final answer.
- **Datasets as trajectories:** questions are grouped by topic, not by sub-agent, "to simulate how a user might interact with the agent", so one trajectory exercises several tools. The example run had 56 questions in 21 trajectories.
- Each trace records the steps, the input and output tokens, the cost, the model and the agent type next to the scores, so a bad score can be followed back to the step that caused it.

The post reports average scores only in a screenshot and states no limitations of the method.

**Verification inside multi-agent systems** `[CONFIRMED]` (Cemri et al., NeurIPS 2025). In MAST's 1,642 traces (most labelled by an LLM annotator), task verification failures (premature termination, no or incomplete checks, incorrect checks) made up 23.5% of failures. Their conclusion is that "sole reliance on final-stage, low-level checks is inadequate". In one framework (ChatDev, a 32-task set), a new topology with a check of the task's high-level objective raised task success from 25.0% to 40.6%, which the authors still do not call a substantial improvement. An LLM judge (o1 with few-shot examples) labelled failure modes with κ = 0.77 against expert annotators. See [25 AI agent platform, section 4d](../systems/25-ai-agent-platform.md).

## 6. When the eval is the problem `[CONFIRMED]` (Anthropic, January 2026)

- **Ambiguous tasks.** "A good task is one where two domain experts would independently reach the same pass/fail verdict." For example, a Terminal-Bench task asked for a script without naming its path while the tests assumed one.
- **0% is a warning sign.** With frontier models, 0% across many trials (0% pass@100) "is most often a signal of a broken task, not an incapable agent". Write a reference solution for each task to prove it can be solved.
- **Grading bugs.** Opus 4.5 first scored 42% on CORE-Bench. After fixes for rigid grading (it penalised "96.12" against an expected 96.124991…), ambiguous specifications and tasks that could not be reproduced, and with a less constrained scaffold, it scored 95%.
- **Cheating.** Graders should resist bypasses, so that passing requires solving the problem.
- **Saturation.** At 100% an eval tracks regressions but gives no signal for improvement. Near saturation, large capability gains show up as small score changes.
- **Read the transcripts.** A failed task's transcript shows whether the agent erred or the grader rejected a valid solution. Anthropic says it does not take scores at face value until someone has read transcripts.
- **Automated evals are one layer.** The post lists production monitoring, A/B tests, user feedback, manual transcript review and systematic human studies, and compares them to the Swiss cheese model: each layer misses something another catches.

## 7. Evaluation in a system design `[INDUSTRY PATTERN]` (our reasoning)

```
change (prompt, model, tool, retrieval) ─► offline suite in CI
        regression gate (≈100%) + capability score + cost and latency per task
                    │ pass
                    ▼
     canary or A/B ─► production traces ─► sampled for model and human grading
                    ▲                                 │
                    └── new failure becomes a task ◄──┘
```

- **Store every trace** (inputs, retrieved context, tool calls, outputs, tokens, cost, latency) with a run id, and keep the version of each prompt, model and tool. Without that, a score cannot be explained or reproduced.
- **Gate releases on the regression suite** and report the capability score, cost per task and latency next to it. A change that improves quality but doubles cost is a decision, not a free win.
- **Sample production traffic** for model grading and send a smaller sample to people. Track how often model and human grades agree, and recalibrate the judge when that rate drifts.
- **Close the loop:** each production failure becomes a task, after removing personal data. See [P17 Privacy by design](P17-privacy-by-design.md).
- **Budget for evaluation.** Judge calls cost money: suite size × trials × graders × cost per call. Use code graders first, cheaper judges for screening, and several trials only where consistency matters.
- **Score the parts and the whole.** Retrieval recall, per-tool accuracy and the final goal tell you where a failure happened, not just that it happened.

## 8. Using this in a design discussion `[INDUSTRY PATTERN]`

1. Define success as an outcome you can check (state, tests, a reference), not as the model's own report.
2. Name the graders: code first, model judges with rubrics where output is open-ended, people to calibrate.
3. Separate a regression gate from a capability score, and say how many trials you run and whether you need pass@k or pass^k.
4. Score the components (retrieval, each tool) and the end-to-end goal.
5. Say where evaluation runs: CI, canary, sampled production traces, and how failures become new tasks.
6. Put a number on evaluation cost and say how you keep it bounded.

---

## Questions to practise

1. Your support agent passes 90% of tasks on one trial. The product promises customers consistent answers. Which metric do you report, and what does it look like over three trials?
2. Design the evaluation for a RAG assistant that has no labelled answers yet. What do you score on day one, and what do you add later?
3. A new model scores 0% on a task where the old one scored 60%. What do you check first?
4. An agent with a supervisor and three specialist sub-agents gives a wrong final answer. How would your evaluation tell you which part failed?
5. Your LLM judge and your human graders start to disagree more often. What could have changed, and what do you do?
6. How do you stop an eval suite from saturating?

**Related:** [23 RAG knowledge assistant](../systems/23-rag-knowledge-assistant.md), [25 AI agent platform](../systems/25-ai-agent-platform.md), [28 LLM fine-tuning, evaluation and deployment](../systems/28-llm-finetuning-evaluation.md), [41 Moderation and fraud ML](../systems/41-moderation-fraud-ml.md), [P07 SLOs and incidents](P07-slos-and-incidents.md), [P10 Changing systems safely](P10-changing-systems-safely.md).

**Further reading:** Fahim Ul Haq, [*Generative AI System Design Interview*](https://www.systemdesignhandbook.com/guides/generative-ai-system-design-interview/) (System Design Handbook, undated, accessed 2026-11-03; secondary). A step-by-step interview walkthrough for an LLM-backed system (clarifying, token budget, architecture, RAG, cost, security). It cites no primary sources, and its prices and throughput numbers are unsourced, so use it for structure, not facts.

## Sources and provenance

> **Sources read on 2026-11-03:** Grace, Hadfield, Olivares and De Jonghe, Anthropic, [*Demystifying evals for AI agents*](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (9 January 2026) · Es, James, Espinosa-Anke and Schockaert, [*Ragas: Automated Evaluation of Retrieval Augmented Generation*](https://arxiv.org/pdf/2309.15217) (arXiv 2309.15217, September 2023; PDF text extracted locally) · Chandra, Poonawala and Shin, AWS Machine Learning Blog, [*Evaluate Amazon Bedrock Agents with Ragas and LLM-as-a-judge*](https://aws.amazon.com/blogs/machine-learning/evaluate-amazon-bedrock-agents-with-ragas-and-llm-as-a-judge/) (28 April 2025) · Cemri et al., [*Why Do Multi-Agent LLM Systems Fail?*](https://arxiv.org/pdf/2503.13657) (arXiv 2503.13657 v3, NeurIPS 2025 Datasets and Benchmarks; PDF text extracted locally).
> **Dated material:** AI evaluation practice changes quickly. Anthropic's post reflects its own models and customers as of January 2026; the Ragas results used gpt-3.5-turbo-16k as the grader; the AWS framework targets Amazon Bedrock Agents as of April 2025.
> **Not read:** the Ragas library documentation, the AWS framework's code and README, the benchmarks the Anthropic post names (SWE-bench Verified, Terminal-Bench, τ-Bench and τ2-Bench, BrowseComp, WebArena, OSWorld, CORE-Bench) and the eval frameworks in its appendix (Harbor, Braintrust, LangSmith, Langfuse, Arize).
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-11-03, by reading each source in full (the AWS post's score table is an image and was not read). Quotations are confirmed by `npm run verify`.*
- Verified in Anthropic's post: the eval definition, task, trial, grader, transcript, outcome and harness definitions, the flight-booking outcome example, the τ2-bench loophole, the grader table (methods, strengths, weaknesses), the grader-choice sentence, weighted and binary scoring, grading outputs not paths, partial credit, the way out for the judge and one judge per dimension, the per-agent-type advice, capability and regression definitions and graduation, pass@k and pass^k with the 42% example and the k = 10 divergence, 20 to 50 tasks, balanced sets and the web-search example, trial isolation and the git-history example, the two-experts test, the Terminal-Bench path example, 0% pass@100, reference solutions, CORE-Bench 42% to 95%, grader hacking, saturation, reading transcripts, the other evaluation methods and the Swiss cheese comparison.
- Verified in the Ragas paper: the three metrics and their computation, WikiEval (50 pages, two annotators), Table 1 agreement figures, gpt-3.5-turbo-16k as grader.
- Verified in the AWS post: the evaluation job workflow, the goal and task-accuracy split, the conditional task metrics, the metric names, the Langfuse trace contents, the multi-agent mapping, trajectories grouped by topic, 56 questions in 21 trajectories, scores shown only in a screenshot.
- Verified in the MAST paper: 1,642 traces, task verification at 23.5% and its modes, the final-stage checks sentence, the ChatDev intervention results (25.0% to 40.6%, 32 tasks) and the authors' caveat, κ = 0.77 for the o1 few-shot judge.
- Not verified: the AWS post's average scores (an image only) and any behaviour of the Ragas library or the AWS framework beyond what the posts describe.
- Not sourced (our reasoning): the evaluation pipeline diagram, trace storage, release gates, production sampling and judge recalibration, the evaluation cost formula and the design-discussion checklist.
