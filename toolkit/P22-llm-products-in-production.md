# P22 — LLM products in production: what works and what fails

*A primer on the engineering around an LLM feature or agent once real users depend on it: managing context, keeping long runs alive across crashes and context limits, designing tools, defending against prompt injection, bounding loops and cost, and tracing what happened. It draws on operators' own accounts of production systems (Anthropic's research agent and coding harnesses, 2025 and 2026), Microsoft's architecture guidance, the security rules published by Meta, OWASP and the MCP specification, and the OpenTelemetry conventions. Statements from sources are tagged; the checklists are our reasoning. Evaluation has its own page, [P18](P18-evaluating-llm-and-agent-systems.md).*

## At a glance

- Most production failures are not the model lacking ability. They are context that is too long or missing, a run that dies halfway with no way to resume, a tool that invites mistakes, untrusted text treated as instructions, or a loop with no limit.
- **Context is a budget.** Anthropic's advice is to find "the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome". Compaction (summarising old context to free space), notes kept outside the context and sub-agents that return summaries are the main tools.
- **Agents are long-running stateful processes.** Treat them like workflows: checkpoint after each step, resume instead of restarting, deploy new versions without killing running ones.
- **Security rule of thumb:** an agent that reads untrusted input, can reach private data and can act or send externally can be turned against its user. Meta's "Rule of Two" says to allow at most two of the three without a human check.
- **Bound everything:** steps, time, tokens, money, retries, handoffs. Every loop in [P19](P19-llm-workflow-patterns.md) and [P20](P20-agent-and-multi-agent-architectures.md) needs a cap and a defined behaviour at the cap.
- Gap in the evidence: we searched for 2026 engineering posts by companies other than model vendors describing production agent architectures and found none we could use; the lessons here rest on vendors' accounts of their own systems, official guidance and research.

---

## 1. Context engineering `[CONFIRMED]` (Anthropic, September 2025)

**Context engineering** "refers to the set of strategies for curating and maintaining the optimal set of tokens (information) during LLM inference" (inference: running the model to produce output). It is the successor to prompt engineering: it covers the system prompt, tool definitions, retrieved data and the history of the run, not only the instructions.

Why it matters: as the context grows, the model recalls less of it (the post calls this context rot), so "Context, therefore, must be treated as a finite resource with diminishing marginal returns." and "Every new token introduced depletes this budget by some amount".

The techniques the post describes:

| Technique | What it does | Classic analogue (our reasoning) |
|---|---|---|
| **Compaction** | "Compaction is the practice of taking a conversation nearing the context window limit, summarizing its contents" and continuing in a fresh context with the summary | Log compaction; a snapshot plus the tail |
| **Structured notes** | "the agent regularly writes notes persisted to memory outside of the context window" (to-do lists, a notes file) and reads them back | A write-ahead log or a checkpoint file |
| **Sub-agents** | each works in a clean context and "returns only a condensed, distilled summary of its work" | A worker that returns a result, not its scratch data |
| **Just-in-time retrieval** | keep identifiers (file paths, queries, links) and load the data with tools when needed | Lazy loading; a pointer instead of a copy |

Our reasoning for the edge cases: a summary loses detail, so keep what later steps need (decisions taken, open problems, ids) and drop raw tool output first. Test compaction with your eval suite, because a bad summary fails quietly many steps later.

**Memory across sessions** `[CONFIRMED]` (Anthropic and LangChain documentation, read November 2026): because the model keeps nothing between calls, memory that outlives one conversation is data your system stores and feeds back. Anthropic's memory tool is a directory of files the model reads and writes through tool calls; "The memory tool operates client-side: Claude requests file operations, and your application runs them." and "Memory lives entirely in your application." LangGraph separates short-term memory (the thread, kept by checkpoints) from long-term memory: "Long-term memory in LangGraph allows systems to retain information across different conversations or sessions", stored as JSON documents in a namespaced store, and its docs group memories into semantic (facts), episodic (experiences) and procedural (instructions). Our reasoning: treat memory as a user-data store with the usual rules: per-user isolation, a way to inspect and delete it, retention limits ([P17](P17-privacy-by-design.md)), and the knowledge that anything written from untrusted input can carry an injection into later sessions (section 5).

## 2. Long runs: harnesses, progress files and handoff artifacts `[CONFIRMED]` (Anthropic, November 2025 and March 2026)

A **harness** is the code around the model that runs the loop, manages context and tools, and decides when a session ends. Anthropic published two accounts of harnesses for coding tasks that take hours.

- **November 2025** (the post names Claude Opus 4.5 with the Claude Agent SDK; the March 2026 post says this earlier harness used Sonnet 4.5, and we did not resolve the difference): a first session sets up the environment, a feature list and a progress file; each later session reads the progress file and the git log, picks one unfinished feature, works on it, commits and updates the progress file. Failures seen without this: the agent tried to build everything at once and ran out of context mid-feature, or "a later agent instance would look around, see that progress had been made, and declare the job done." The feature list is JSON because "the model is less likely to inappropriately change or overwrite JSON files".
- **March 2026** (Claude Sonnet 4.5, then Opus 4.5 and 4.6): a planner, a generator and a separate evaluator that tests the running application. The post reports that "models tend to lose coherence on lengthy tasks as the context window fills", and that with one model "they begin wrapping up work prematurely as they approach what they believe is their context limit". With a newer model that behaviour largely went away and the harness dropped context resets in favour of compaction. Cost example from the post: one full run of the final harness took "about 4 hours and $124 in token costs".

Lessons we draw (our reasoning): store progress in files or a database, not in the context; make "done" something a check decides (tests, a feature list), not the model's claim; and simplify the harness when a new model removes the failure it was built for.

## 3. Durable execution: crash, resume, deploy `[CONFIRMED]` (Anthropic, June 2025; LangChain docs)

Anthropic's research system post: "Agents are stateful and errors compound." Restarting a long run from the beginning is slow and costly, so "Instead, we built systems that can resume from where the agent was when the errors occurred." Deploys use rainbow deployments "to avoid disrupting running agents, by gradually shifting traffic from old to new versions", keeping old and new versions running side by side.

Framework runtimes now build this in. LangGraph's overview lists persistence ("Checkpoint state and resume after failures or pauses.") and human-in-the-loop ("Pause execution, inspect or edit state, then continue."). See [P21](P21-agent-frameworks-and-protocols-2026.md) for the other runtimes.

**Classic analogue** (our reasoning): durable workflow engines and sagas ([P03](P03-distributed-transactions.md)). The same rules apply:
- Make every tool with side effects **idempotent** (an idempotency key per step, see [P05](P05-api-design.md)), because a resumed step may run twice. Under MCP 2026-07-28 this is required, not optional: a client whose response stream breaks must reissue the tool call as a new request ([P21](P21-agent-frameworks-and-protocols-2026.md), section 2).
- Keep the run's state (plan, step, tool results) in a store you can read, so a person can inspect a stuck run.
- Version prompts, tools and models with the run, so a resumed run does not continue with a different prompt.
- A run waiting for human approval is a paused workflow, not an open connection. Store it and resume it from an event.

## 4. Tool design `[CONFIRMED]` (Anthropic, December 2024 and September 2025)

A **tool** is the interface the model uses to act, so its design decides how often the model gets it wrong. Anthropic's 2024 post asks you to "plan to invest just as much effort in creating good agent-computer interfaces" as in human interfaces, and to "Poka-yoke your tools. Change the arguments so that it is harder to make mistakes." (its example: requiring absolute file paths fixed a class of errors). The September 2025 post on writing tools adds:

- Choose a few tools that match real tasks, rather than wrapping every API endpoint (its example: a `search_logs` tool instead of a `read_logs` tool that dumps everything).
- "Namespacing tools to define clear boundaries in functionality", so similar tools are not confused.
- Return meaningful context (names, not opaque ids) and "Optimizing tool responses for token efficiency": pagination, filtering, truncation, a concise or detailed response mode.
- Write tool descriptions as you would for a new colleague, and improve them by running an evaluation and reading the transcripts.

Our reasoning: tool errors should be messages the model can act on (`date must be YYYY-MM-DD`), not stack traces. Treat a tool's schema like a public API: version it and test it ([W06](W06-review-an-api.md)).

## 5. Security: prompt injection and the Rule of Two `[CONFIRMED]`

**Prompt injection** (OWASP LLM01:2025): "A Prompt Injection Vulnerability occurs when user prompts alter the LLM's behavior or output in unintended ways." With agents, the dangerous kind is **indirect**: instructions hidden in a web page, email, document or tool result that the agent reads.

**The lethal trifecta** (Simon Willison, June 2025): an agent that combines "Access to your private data", "Exposure to untrusted content" and "The ability to externally communicate in a way that could be used to steal your data" can be tricked into sending that data to an attacker.

**The Agents Rule of Two** (Meta, October 2025) turns this into a design rule. The three properties are: [A] "An agent can process untrustworthy inputs", [B] "An agent can have access to sensitive systems or private data", [C] "An agent can change state or communicate externally". Until prompt injection can be reliably detected, agents "must satisfy no more than two of the following three properties within a session"; a task that needs all three "at a minimum requires supervision", meaning human approval or another reliable check.

**Tool protocol risks** (MCP security best practices, 2026-07-28): confused-deputy attacks through proxy servers, access-token passthrough (OAuth credentials, not text tokens: a server "MUST NOT accept any tokens that were not explicitly" issued for it), SSRF, hijacking of the state handles servers hand out (session hijacking applies to revisions 2025-11-25 and earlier) and compromised local servers.

OWASP also published a *Top 10 for Agentic Applications for 2026* (9 December 2025); we read only its landing page, not the list.

Design moves (our reasoning, building on [P06](P06-security-threat-modeling.md)):
- Split agents along the Rule of Two: the agent that reads the web has no credentials; the agent with credentials reads only trusted, structured input. Taint carries across the split: a summary written by the agent that read untrusted text is itself untrusted, so it must not reach the credentialed agent as instructions ([P20](P20-agent-and-multi-agent-architectures.md), section 4).
- Use the end user's narrow, short-lived credentials, never one powerful service account; check permissions in the tool, not in the prompt.
- Require approval for irreversible or external actions (payments, emails, deletes), and show the exact action to the approver.
- Mark tool results as data in the prompt, and do not let a tool result change which tools are available.
- Classifiers that detect injections help but are not a boundary; the permission model is.

**Design patterns with provable limits** `[CONFIRMED]` (Beurer-Kellner et al., June 2025; Willison, April 2023; Debenedetti et al., 2025): the design-patterns paper states the principle that "once an LLM agent has ingested untrusted input" it "must be constrained so that it is impossible for that input to trigger any consequential actions", and proposes six patterns that enforce it:

| Pattern | How it stops an injection |
|---|---|
| Action-selector | The model only picks from fixed actions, and results never flow back into it |
| Plan-then-execute | The plan of tool calls is fixed before any untrusted data is read |
| LLM map-reduce | Each untrusted item goes to an isolated model; only constrained results are combined |
| Dual LLM | A privileged model plans and calls tools but never sees untrusted text; a quarantined model reads it and has no tools |
| Code-then-execute | The model writes a program up front; untrusted data is only data inside it |
| Context-minimisation | The user's prompt is removed from the context once it has chosen the action |

The dual LLM idea comes from Willison's 2023 post, where untrusted output is stored as variables and "The Privileged LLM only ever sees those variable names." CaMeL (Debenedetti and others, 2025) builds on it by separating control flow from data flow and attaching capabilities to data; its abstract reports solving 77% of AgentDojo tasks with provable security, against 84% for an undefended system (abstract only, not checked in the paper). The price of each pattern is capability: the agent can do less with what it reads.

## 6. Limits, budgets and failure behaviour `[INDUSTRY PATTERN]` (our reasoning, with `[CONFIRMED]` guidance quoted)

Microsoft's guide: "To guard against infinite tool-call loops, set iteration limits", and for generate-and-check loops, set a cap and define what happens when it is reached ([P19](P19-llm-workflow-patterns.md), section 7) `[CONFIRMED]`.

| Limit | Typical failure it stops | At the limit |
|---|---|---|
| Steps per run | A loop that repeats the same tool call | Stop, return partial result and reason |
| Tokens and money per run, per user, per tenant | One request costing as much as a day of traffic | Stop; alert; per-tenant quota as in [P14](P14-multi-tenancy.md) |
| Wall-clock time | A run stuck waiting on a slow tool | Checkpoint and pause, or fail with a clear status |
| Handoffs or sub-agents per run | Agents bouncing a request between them | Escalate to a human or a general agent |
| Retries per tool | Hammering a failing dependency | Circuit breaker, then a fallback path ([P07](P07-slos-and-incidents.md)) |

Cost reasoning: Anthropic's numbers give the scale. Its multi-agent research system used several times the tokens of a single agent ([P20](P20-agent-and-multi-agent-architectures.md), section 5a); its March 2026 harness post compares a solo run of about 20 minutes and $9 with a full harness run of about 6 hours and $200 on the same prompt. Budget per task, not per call, and route easy work to cheaper models ([P08](P08-cost-as-a-design-input.md)).

**Prompt caching** `[CONFIRMED]` (Anthropic and OpenAI API documentation, read November 2026): an agent resends a growing history on every call, and both providers can reuse the processed start of a prompt. Anthropic's "Prompt caching covers the full prefix" (tools, then system prompt, then messages), "By default, the cache has a 5-minute lifetime." with a 1-hour option, and "Modifying tool definitions (names, descriptions, parameters) invalidates the entire cache"; cache writes cost more than normal input and reads much less (multipliers vary by model, see the page). At OpenAI, "Prompt caching is enabled by default for supported OpenAI models." Our reasoning for agents: keep the prefix stable (tools and system prompt first, never a timestamp at the top), append to the history rather than editing it, and expect compaction or a changed tool list to cost a cache miss. Each MCP tool you connect adds its definition to that prefix, so many tools cost context and cache space even when unused.

## 7. Observability and release `[CONFIRMED]` for the conventions; the rest our reasoning

Trace every run as a tree: the run, each model call (model, tokens, latency), each tool call (arguments, result size, errors), each handoff or sub-agent. OpenTelemetry's GenAI conventions define agent spans such as `invoke_agent` and `invoke_workflow`, still at Development status ([P21](P21-agent-frameworks-and-protocols-2026.md), section 5). Traces carry user content, so apply the retention and access rules of [P17](P17-privacy-by-design.md).

Release changes to prompts, tools, models and harness code like code: an offline eval gate, then a canary, then sampled production grading ([P18](P18-evaluating-llm-and-agent-systems.md), section 7). Keep old versions running for in-flight runs (section 3).

## 8. Failure catalogue `[INDUSTRY PATTERN]` (our reasoning; sources in the sections above)

| Symptom | Likely cause | First fix |
|---|---|---|
| Agent says it is done, work is incomplete | "Done" decided by the model | An external check (tests, feature list) decides |
| Quality falls on long runs | Context rot, or compaction dropped key facts | Notes outside context, better compaction, sub-agents |
| Same tool called again and again | No progress signal, vague tool errors | Step cap, actionable error messages |
| Sub-agents produce inconsistent parts | Implicit decisions not shared ([P20](P20-agent-and-multi-agent-architectures.md), section 5b) | Share decisions explicitly, or use one agent |
| Data sent somewhere it should not go | All three Rule of Two properties in one session | Split agents, approvals, narrow credentials |
| Cost spike from one tenant | No per-run or per-tenant budget | Budgets with hard stops |
| A deploy breaks runs in progress | Runs pinned to nothing | Versioned runs, rainbow deploys |
| Lenient self-review | Same model grading its own work | Separate evaluator, code checks first |

---

## Questions to practise

1. Design the state store for an agent that runs up to two hours and may wait a day for approval. What is in each checkpoint, and what makes a resumed tool call safe?
2. An email assistant reads incoming mail, can search the user's documents and can send mail. Apply the Rule of Two. What do you change, and what does the user experience lose?
3. Your agent's quality is fine on short tasks and poor after about 80 tool calls. List three hypotheses and how you would test each.
4. Set budgets for a customer-facing research agent: per run, per user per day, per tenant per month. What happens at each limit?
5. A prompt change passed the offline evals and broke 2% of production runs that were already in progress. What in your release process should have caught it?

**Related:** [25 AI agent platform](../systems/25-ai-agent-platform.md), [P18 Evaluating LLM and agent systems](P18-evaluating-llm-and-agent-systems.md), [P06 Security for architects](P06-security-threat-modeling.md), [P03 Distributed transactions](P03-distributed-transactions.md), [P07 SLOs and incidents](P07-slos-and-incidents.md), [P08 Cost as a design input](P08-cost-as-a-design-input.md), [P17 Privacy by design](P17-privacy-by-design.md), [P21 Frameworks and protocols](P21-agent-frameworks-and-protocols-2026.md).

## Sources and provenance

> **Sources read on 2026-11-21:** Anthropic Applied AI team, [*Effective context engineering for AI agents*](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) (29 September 2025) · Young, Anthropic, [*Effective harnesses for long-running agents*](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents) (26 November 2025) · Rajasekaran, Anthropic, [*Harness design for long-running application development*](https://www.anthropic.com/research/harness-design-long-running-apps) (24 March 2026) · Hadfield et al., Anthropic, [*How we built our multi-agent research system*](https://www.anthropic.com/research/multi-agent-research-system) (13 June 2025; foundational) · LangChain, [*LangGraph overview*](https://docs.langchain.com/oss/python/langgraph/overview) · Schluntz and Zhang, Anthropic, [*Building effective agents*](https://www.anthropic.com/research/building-effective-agents) (19 December 2024; foundational) · Aizawa et al., Anthropic, [*Writing effective tools for AI agents*](https://www.anthropic.com/research/writing-tools-for-agents) (11 September 2025) · OWASP GenAI Security Project, [*LLM01:2025 Prompt Injection*](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) and [*OWASP Top 10 for Agentic Applications for 2026*](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) (landing page only) · Willison, [*The lethal trifecta for AI agents*](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) (16 June 2025; practitioner essay, foundational) · Meta AI, [*Agents Rule of Two: A Practical Approach to AI Agent Security*](https://ai.meta.com/blog/practical-ai-agent-security/) (31 October 2025) · Anthropic, [*Memory tool*](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) and [*Prompt caching*](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · OpenAI, [*Prompt caching*](https://developers.openai.com/api/docs/guides/prompt-caching) · LangChain, [*Memory*](https://docs.langchain.com/oss/python/langgraph/memory) (API and framework documentation, undated pages; the caching pages read partly through a summary) · Beurer-Kellner et al., [*Design Patterns for Securing LLM Agents against Prompt Injections*](https://arxiv.org/abs/2506.08837) (arXiv, June 2025; [HTML](https://arxiv.org/html/2506.08837)) · Willison, [*The Dual LLM pattern*](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/) (25 April 2023; foundational) · Debenedetti et al., [*Defeating Prompt Injections by Design*](https://arxiv.org/abs/2503.18813) (CaMeL, arXiv, March 2025, revised June 2025; abstract only) · Model Context Protocol, [*Changelog, 2026-07-28*](https://modelcontextprotocol.io/specification/2026-07-28/changelog) and [*Security Best Practices*](https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices) (revision 2026-07-28) · Microsoft, Azure Architecture Center, [*AI agent orchestration patterns*](https://learn.microsoft.com/azure/architecture/ai-ml/guide/ai-agent-design-patterns) (12 February 2026, updated 21 September 2026) · OpenTelemetry, [*GenAI agent spans*](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md).
> **Dated material:** the harness observations depend on the models named (Claude Sonnet 4.5, Opus 4.5 and 4.6); the post itself shows a newer model removing a failure. Cost figures are Anthropic's own runs, not general prices.
> **Not read:** the items of the OWASP agentic Top 10 (PDF not downloaded); Anthropic's posts on managed agents and agent memory listed on its engineering index; production write-ups from companies other than model vendors (none found by search on 2026-11-21; results were low-quality blog posts, not used); papers measuring prompt-injection defences.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-11-21, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in Anthropic's context engineering post: the definition, context rot, finite resource, the attention budget, the smallest-set advice, compaction, notes, sub-agent summaries and just-in-time retrieval.
- Verified in Anthropic's November 2025 harness post: the setup session, progress file, git log, one feature at a time, the early-victory failure and the JSON feature list.
- Verified in Anthropic's March 2026 harness post: loss of coherence, premature wrap-up, the move to compaction with a newer model, the $124 run and the $9 and $200 comparison.
- Verified in Anthropic's June 2025 post: stateful errors compound, resume from the point of error, rainbow deployments.
- Verified in LangGraph's overview: persistence and human-in-the-loop descriptions.
- Verified in Anthropic's tool posts: agent-computer interfaces, poka-yoke and the absolute-path example, few tools, namespacing, meaningful context, token efficiency, evaluation-driven descriptions.
- Verified in OWASP, Willison, Meta and MCP pages: the LLM01 definition, the three trifecta ingredients, the three Rule of Two properties and the rule, the supervision requirement, the MCP attack list (state handle hijacking in 2026-07-28), the token passthrough rule and the reissue rule (from the 2026-07-28 changelog); the agentic Top 10's title and date.
- Verified in the memory docs: Anthropic's client-side memory tool and where memory lives; LangGraph's short-term and long-term memory and the three memory types.
- Verified in the caching docs: Anthropic's prefix order, 5-minute default and 1-hour option, write and read pricing direction, invalidation by tool changes; OpenAI's caching on by default. Exact multipliers are left to the pages because they vary by model.
- Verified in the injection papers: the design-patterns principle and the six patterns (paper section 3); Willison's privileged and quarantined models and variable names; CaMeL's 77% and 84% on AgentDojo from its abstract only.
- Not verified: CaMeL's results in the paper body; the contents of the OWASP agentic Top 10; how widely the Rule of Two is adopted; any measured effectiveness of injection classifiers.
- Not sourced (our reasoning): the classic analogues, the durable-execution rules (idempotency, versioned runs, paused workflows), the tool error advice, the security design moves, the limits table, observability and release advice and the failure catalogue.
