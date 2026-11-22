# P19 — Workflow patterns for LLM features

*A primer on the building blocks of products that call a large language model: the complexity ladder from one call to an agent, the five workflow patterns in Anthropic's "Building effective agents" (December 2024, the essay that named them, so foundational rather than recent) and the matching patterns in Microsoft's Azure Architecture Center guide (February 2026, updated September 2026). Each pattern gets the classic system-design idea it resembles, the use cases it fits and the ways it fails. Multi-agent designs are in [P20](P20-agent-and-multi-agent-architectures.md), frameworks in [P21](P21-agent-frameworks-and-protocols-2026.md), production lessons in [P22](P22-llm-products-in-production.md). Statements from the sources are tagged; the analogies and advice are our reasoning and are labelled.*

## At a glance

- Start at the bottom of the ladder: one model call, then a fixed workflow, then a single agent with tools, and only then several agents. Microsoft's guide says to "Use the lowest level of complexity that reliably meets your requirements."
- A **workflow** is code you wrote that calls the model at fixed points. An **agent** is a model that decides its own next step in a loop. Workflows are easier to test, cheaper and more predictable; agents handle tasks whose steps you cannot list in advance.
- Five workflow patterns cover most features: **prompt chaining** (a pipeline), **routing** (a classifier in front of specialists), **parallelisation** (scatter-gather, or voting), **orchestrator-workers** (a planner that splits work at run time) and **evaluator-optimizer** (a generate-and-check loop).
- Each pattern maps to something you already know: a pipeline or ETL job, an API gateway route, scatter-gather, a job scheduler, a retry loop with validation. The new part is that a step can be wrong in plausible-looking ways, so every pattern needs a check, a limit and a way to see what happened.
- Frameworks are optional. Anthropic suggests starting with the model API directly, because many patterns take a few lines of code.

---

## 1. Words used on this page

The definitions below are our plain-language explanations unless tagged. Two facts matter more than any term, so they come first.

- **The model keeps no memory between calls.** Each call is independent, like a stateless HTTP request. To hold a conversation, the full history (instructions, earlier messages, tool results) is sent again on every call, either by your code or by a provider service that stores it for you. That is why the context grows during a run, why each step costs more than the last, and why "memory" in an LLM product is always something your system stores.
- **The same input can give different outputs.** Models pick each next word with some randomness (**sampling**), so two runs of one prompt can differ. You therefore test with several runs, can take several samples and vote (section 5), and should validate every output your code depends on.

- **LLM** (large language model): a model that takes text (and sometimes images) in and produces text out. One request and its response is an **LLM call**.
- **Prompt:** the instructions and data sent in a call. The **system prompt** is the standing part (role, rules, tool descriptions) sent first on every call; **prompt engineering** is the craft of writing prompts that work. The **context window** is the maximum amount of text, counted in **tokens** (pieces of words), that a call can hold. Cost and latency grow with tokens.
- **Tool call** (function calling): the model returns a structured request such as `search(query="...")`; your code runs it and sends the result back in the next call. The model never runs anything itself.
- **Eval** (evaluation): an automated test suite for model behaviour: tasks with checkable success criteria, graders that score each output, and several runs per task because outputs vary. It is how you show that a change helped. See [P18](P18-evaluating-llm-and-agent-systems.md).
- **Harness:** the code around the model that runs the loop, assembles each prompt, executes tool calls and decides when to stop. In an agent product, most of the engineering is in the harness.
- **Retrieval**, or RAG (retrieval-augmented generation): your code finds relevant documents and puts them in the prompt. See [23 RAG knowledge assistant](../systems/23-rag-knowledge-assistant.md).
- **Workflow** and **agent** `[CONFIRMED]` (Anthropic, December 2024): workflows are systems where LLMs and tools are "orchestrated through predefined code paths"; agents are systems where LLMs "dynamically direct their own processes and tool usage". Anthropic describes agents as "typically just LLMs using tools based on environmental feedback in a loop." The same distinction is the core of [25 AI agent platform](../systems/25-ai-agent-platform.md).

## 2. The complexity ladder

*`[CONFIRMED]` (Azure Architecture Center, February 2026)*

| Level | When it is enough | What it costs you |
|---|---|---|
| One model call (with a good prompt, maybe retrieval) | The task is one transformation: summarise, classify, extract, draft. "If prompt engineering can solve the problem, you don't need an agent." | Nothing extra |
| Fixed workflow (sections 3 to 7) | The steps are known in advance | Code to write and test, but each step is simple |
| One agent with tools | The steps depend on what the model finds. The guide calls this "Often the right default for enterprise use cases." | Unpredictable step count; needs limits: "To guard against infinite tool-call loops, set iteration limits." |
| Several agents ([P20](P20-agent-and-multi-agent-architectures.md)) | Separate domains, separate security boundaries, or work that runs in parallel | The guide's warning: it "Adds coordination overhead, latency, and failure modes." |

Anthropic's advice matches: find "the simplest solution possible, and only increasing complexity when needed", and add complexity "only when it demonstrably improves outcomes" `[CONFIRMED]`. Measuring "demonstrably" needs an evaluation suite, see [P18](P18-evaluating-llm-and-agent-systems.md).

**The building block** `[CONFIRMED]` (Anthropic): every pattern below is built from what Anthropic calls the augmented LLM: "an LLM enhanced with augmentations such as retrieval, tools, and memory." The post names the Model Context Protocol (MCP, a standard protocol for plugging tools and data sources into an LLM application) as one way to connect those augmentations (see [P21](P21-agent-frameworks-and-protocols-2026.md)).

## 3. Prompt chaining: a pipeline of calls

**What it is** `[CONFIRMED]` (Anthropic): split a task into a fixed sequence of calls, each working on the previous output, with optional checks in code between steps. "The main goal is to trade off latency for higher accuracy, by making each LLM call an easier task." Examples in the post: write marketing copy, then translate it; write an outline, check it against criteria, then write the document. Microsoft calls the same shape the **sequential** pattern: "The choice of which agent gets invoked next is deterministically defined as part of the workflow and isn't a choice given to agents in the process."

**Classic analogue** (our reasoning): an ETL pipeline or a Unix pipe. The gate between steps is a schema check or a validation stage.

**Fits:** document generation, extract then normalise then load, draft then review then polish.

**Fails when** `[CONFIRMED]` (Azure): stages are independent (run them in parallel instead), the flow needs backtracking, or an early stage produces bad output that later stages keep processing. Our reasoning: put a code check after any step whose output a later step trusts (valid JSON, required fields, length), and fail fast, the way a pipeline rejects a bad record instead of loading it.

**Structured outputs: the cheapest gate** `[CONFIRMED]` (Anthropic and OpenAI API documentation, read November 2026): both major APIs can force a response to match a JSON Schema you supply. Anthropic's docs say "Structured outputs guarantee schema-compliant responses through constrained decoding" (the model can only produce text the schema allows); OpenAI's say that compared with its older JSON mode, "While both ensure valid JSON is produced, only Structured Outputs ensure schema adherence." Both support only a subset of JSON Schema, and both docs describe cases where the output still does not match (for example a refusal), so keep the check in code. Our reasoning: a schema guarantees the shape, not the content; a field can be valid and wrong, so semantic checks still belong in the gate.

## 4. Routing: a classifier in front of specialists

**What it is** `[CONFIRMED]` (Anthropic): classify the input, then send it to a specialised prompt, tool set or model. "Routing works well for complex tasks where there are distinct categories that are better handled separately", provided the classification is accurate, by an LLM or by a traditional classifier. The post's examples: send customer-service queries to general, refund or technical flows; send easy questions to a smaller, cheaper model and hard ones to a larger one.

**Classic analogue** (our reasoning): an API gateway or layer-7 router that sends requests by path or header ([P04 Load balancing](P04-load-balancing.md), content-based routing), except the routing key is inferred from text.

**Fits:** support triage, model tiering for cost control ([P08](P08-cost-as-a-design-input.md)), sending sensitive requests to a stricter path.

**Detail and edge cases** (our reasoning):
- A wrong route is a silent failure: the specialist answers confidently in the wrong domain. Log the route and its confidence, evaluate the classifier separately and give it an "unsure" class that goes to a general path or a human.
- If the route can be computed from structured input (a product id, a form field), use code. Microsoft says the same about its handoff pattern: avoid it when the right agent "is identifiable from the initial input" and use deterministic routing instead `[CONFIRMED]`.
- Routing to a cheaper model saves money only if the classifier call costs less than it saves.

## 5. Parallelisation: scatter-gather and voting

**What it is** `[CONFIRMED]` (Anthropic): two variants. **Sectioning** means "Breaking a task into independent subtasks run in parallel." **Voting** means "Running the same task multiple times to get diverse outputs." Examples in the post: one call answers the user while another screens the input for inappropriate content; several prompts review the same code for vulnerabilities. Microsoft's **concurrent** pattern is the multi-agent version: "Agents operate independently and don't hand off results to each other."

**Classic analogue** (our reasoning): scatter-gather or map-reduce for sectioning. Voting is closer to N-version programming (several implementations of one function, a vote on the result) than to a quorum read: replicas hold the same value, while model answers can be wrong in correlated ways. Several samples from the same model are not independent opinions, as note [25](../systems/25-ai-agent-platform.md) shows for agents that pick the same branch name.

**Fits:** lower latency on independent subtasks, guardrails that run beside the main call, higher confidence through several reviews.

**Fails when** `[CONFIRMED]` (Azure): tasks depend on each other, you have no rule for resolving conflicting answers, or model quota is tight. Our reasoning: decide the merge rule before you build (majority, any-flag-wins for safety checks, a final synthesis call), and remember that voting multiplies cost by the number of votes.

## 6. Orchestrator-workers: a planner that splits work at run time

**What it is** `[CONFIRMED]` (Anthropic): a central model breaks the task down, sends pieces to worker calls and combines the results. The difference from parallelisation is that the "subtasks aren't pre-defined, but determined by the orchestrator based on the specific input". Examples: a coding change that touches several files; a search task that gathers information from many sources.

**Classic analogue** (our reasoning): a job scheduler that plans a DAG per request, or the orchestrator in an orchestrated saga ([P03 Distributed transactions](P03-distributed-transactions.md)). One place owns the plan, which makes it easy to see and limit.

**Fits:** tasks of variable shape: research, multi-file edits, report assembly.

**Detail and edge cases** (our reasoning): this is the bridge to agents. If workers themselves run tool loops, you have the multi-agent orchestrator of [P20](P20-agent-and-multi-agent-architectures.md), with its token cost. Cap the number of workers per request, give each worker a clear task description and output format, and make the combining step check for gaps and duplicates.

## 7. Evaluator-optimizer: generate, check, revise

**What it is** `[CONFIRMED]` (Anthropic): one call produces an answer, another evaluates it and gives feedback, in a loop. It is "particularly effective when we have clear evaluation criteria" and when feedback measurably improves the answer. Examples: literary translation with a critic; search where the evaluator decides whether more searching is needed. Microsoft lists the same idea as the **maker-checker** loop and warns: "Set an iteration cap to prevent infinite refinement loops, and define fallback behavior for when the cap is reached." `[CONFIRMED]`

**Why a separate checker** `[CONFIRMED]` (Anthropic, March 2026): in a later post on harnesses for coding tasks that run for hours, Anthropic found that "agents reliably skew positive when grading their own work", and that "Separating the agent doing the work from the agent judging it proves to be a strong lever to address this issue." The same post says that out of the box Claude made a poor QA agent and needed tuning; the checker is a component to evaluate in its own right.

**Classic analogue** (our reasoning): a retry loop with validation, or code review before merge. A code check (tests pass, schema valid) is the cheapest and strictest evaluator; use a model as evaluator only where the criteria are not checkable by code.

## 8. Choosing a pattern

*`[INDUSTRY PATTERN]` (our reasoning)*

| If the task... | Use | Watch for |
|---|---|---|
| is one transformation | one call | prompt quality, output validation |
| has fixed steps | prompt chaining | errors passed down the chain |
| falls into distinct categories | routing | silent misroutes |
| has independent parts, or needs several opinions | parallelisation | merge rule, cost × N |
| has parts you only know at run time | orchestrator-workers | worker count, gaps in the combined result |
| has checkable quality criteria | evaluator-optimizer | iteration cap, lenient checker |
| has steps that depend on what it finds | one agent with tools ([25](../systems/25-ai-agent-platform.md)) | loop limits, tool safety ([P22](P22-llm-products-in-production.md)) |

Patterns combine: a router can send hard cases to an orchestrator whose workers run chains. Keep each combination justified by an eval result, not by how the diagram looks.

**On frameworks** `[CONFIRMED]` (Anthropic, December 2024): the post reports that "the most successful implementations weren't using complex frameworks or specialized libraries", and suggests "developers start by using LLM APIs directly: many patterns can be implemented in a few lines of code", because frameworks "often create extra layers of abstraction that can obscure the underlying prompts and responses". The frameworks have changed a lot since then; see [P21](P21-agent-frameworks-and-protocols-2026.md) for what they offer now, mostly durable state and tracing rather than the patterns themselves.

---

## Questions to practise

1. A product manager asks for "an AI agent" that turns support tickets into a summary and a priority. Which rung of the ladder do you start on, and what would make you move up?
2. Your router sends 3% of refund requests to the technical-support flow. How would you find this, and what do you change?
3. You run three reviewers in parallel on each pull request. Two say "safe", one flags an injection risk. What should your merge rule be, and why is it different from a vote on style?
4. Design an evaluator-optimizer loop for SQL generation. What is the evaluator, what is the cap, and what happens at the cap?
5. Where does orchestrator-workers stop being a workflow and start being a multi-agent system? What changes in cost and testing?

**Answer outlines** (our reasoning, not sourced claims; try the questions first):

<details><summary>Q1, support tickets</summary>

One call per ticket with structured output (summary, priority from a fixed list) is the first rung. Move up only if an eval shows a need: a router if ticket types need different instructions, a chain if you must extract fields first, an agent only if the summary needs lookups whose order you cannot predict (section 2).

</details>

<details><summary>Q2, the 3% misroute</summary>

Find it by logging every route with its input and sampling routes for grading, plus an eval set of labelled refund requests. Fix the classifier prompt or examples, add an unsure class that goes to a general path, or route by a structured field when one exists (section 4).

</details>

<details><summary>Q3, three parallel reviewers</summary>

For a safety check, any flag wins: one credible injection finding blocks or escalates to a person, because a missed vulnerability costs far more than a false alarm. Style is a matter of taste, where a majority is fine. The three reviewers also share a model, so two safe votes are weaker evidence than they look (section 5).

</details>

<details><summary>Q4, SQL evaluator-optimizer</summary>

The evaluator is code first: parse the query, run it against a sandboxed copy or EXPLAIN it, check the result shape and a test case. A model judge only checks intent. Cap at two or three rounds; at the cap return the best attempt marked unverified, or ask a person, never loop on (section 7).

</details>

<details><summary>Q5, where workflows end</summary>

It becomes multi-agent when workers run their own tool loops and decide their own steps. Cost grows with tokens per worker, and testing moves from checking each fixed step to evaluating whole runs over several trials (sections 6 and 8, then P20).

</details>

**Related:** [P20 Agent and multi-agent architectures](P20-agent-and-multi-agent-architectures.md), [25 AI agent platform](../systems/25-ai-agent-platform.md), [23 RAG knowledge assistant](../systems/23-rag-knowledge-assistant.md), [P18 Evaluating LLM and agent systems](P18-evaluating-llm-and-agent-systems.md), [P03 Distributed transactions](P03-distributed-transactions.md), [P08 Cost as a design input](P08-cost-as-a-design-input.md).

## Sources and provenance

> **Sources read on 2026-11-21:** Schluntz and Zhang, Anthropic, [*Building effective agents*](https://www.anthropic.com/research/building-effective-agents) (19 December 2024; foundational: it named the workflow patterns, and the page now carries a note that the tooling has changed since) · Microsoft, Azure Architecture Center, [*AI agent orchestration patterns*](https://learn.microsoft.com/azure/architecture/ai-ml/guide/ai-agent-design-patterns) (page date 12 February 2026, updated 21 September 2026; about the first two thirds read verbatim, the rest through a summary) · Anthropic, [*Structured outputs*](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) and OpenAI, [*Structured Outputs*](https://developers.openai.com/api/docs/guides/structured-outputs) (API documentation, undated pages, read 2026-11-21; each read in part verbatim, the rest through a summary) · Rajasekaran, Anthropic, [*Harness design for long-running application development*](https://www.anthropic.com/research/harness-design-long-running-apps) (24 March 2026).
> **Dated material:** Anthropic's routing example names Claude Haiku 4.5 and Sonnet 4.5; model names and prices change, the pattern does not. The harness post's observations were made with Claude Sonnet 4.5 and Opus 4.5.
> **Not read:** the code samples and cookbooks the Anthropic post links; the Azure guide's implementation sections beyond the summary.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-11-21, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in Anthropic's December 2024 post: the workflow and agent definitions, the augmented LLM, the five workflow patterns with their examples, the simplicity advice and the framework advice.
- Verified in the Azure guide: the complexity ladder (direct call, single agent, multi-agent) and its three quotations, the sequential, concurrent and maker-checker definitions, the handoff avoid-when condition, and the avoid-when lists for sequential and concurrent (re-checked after review in the verifier's full copy of the page, in its opening sections).
- Verified in the Anthropic and OpenAI structured-outputs docs: constrained decoding to a JSON Schema (Anthropic), schema adherence versus JSON mode (OpenAI), supported subsets of JSON Schema and cases where output may not match (both, partly from the summarised parts of the pages).
- Verified in Anthropic's March 2026 post: self-grading skews positive, separating worker and judge, the untuned QA agent.
- Not verified: the Azure guide's text past the first two thirds of the page, which was read only through a summary; nothing on this page relies on it.
- Not sourced (our reasoning): the classic analogues, the choice table, the merge-rule and cap advice and the edge cases under routing and orchestrator-workers.
