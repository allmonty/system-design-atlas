# P20 — Agent and multi-agent architectures

*A primer on what happens when the model, not your code, decides the next step, and when one agent becomes several. It covers the single agent loop, the multi-agent topologies named in current framework documentation (OpenAI Agents SDK, LangChain, Google ADK 2.0, the Azure Architecture Center), how each maps to orchestration and choreography in microservices, and what the evidence says about when several agents beat one: Anthropic's production research system (June 2025), Cognition's counter-argument (June 2025) and three 2026 preprints. Statements from sources are tagged; the analogies and the decision guide are our reasoning. Start with [P19](P19-llm-workflow-patterns.md) if fixed workflows are new to you.*

## At a glance

- An **agent** is a model calling tools in a loop until it decides it is done or hits a limit. A **multi-agent system** is several such loops, each with its own instructions, tools and context, connected by a topology.
- Four topologies cover nearly every design: **supervisor** (one agent calls others as tools and owns the answer), **handoff** (control moves to a specialist, which then talks to the user), **pipeline** (agents in a fixed order) and **group chat** (agents share one thread and a manager picks who speaks). Microsoft's "magentic" pattern is a supervisor that keeps an explicit plan.
- In microservice terms, a supervisor is **orchestration** and handoffs are closer to **choreography**: easier to extend, harder to see and stop. See [P03](P03-distributed-transactions.md) for the same trade-off in sagas.
- Several agents help most when the work splits into **independent parts that do not fit one context window**. Anthropic's research system beat a single agent by 90.2% on its internal eval, and used about 15 times the tokens of a chat. When parts depend on each other, or when you compare at equal cost, the advantage shrinks or disappears in the studies we read.
- Default to one agent with good tools. Add agents for a measured reason: context isolation, parallelism, a security boundary or separate teams.

---

## 1. The single agent loop

```
user goal ─► [model] ─► tool call? ──yes──► run tool (your code) ─► result back to model ─┐
                 ▲                                                                       │
                 └───────────────────────────────────────────────────────────────────────┘
                 no ─► final answer        stop also on: step cap, time, token budget, human approval
```

The mechanics (tool definitions, the ReAct loop, sandboxes, budgets) are in [25 AI agent platform](../systems/25-ai-agent-platform.md). Two terms used below:

- **Context:** everything the model sees in one call (instructions, conversation, tool results). It is limited and costly, so what each agent sees is a design decision (see [P22](P22-llm-products-in-production.md)).
- **Handoff** and **agent as tool:** the two ways one agent can involve another. As a tool, the other agent runs a subtask and returns a result; the caller keeps control. In a handoff, the other agent takes over the conversation.

## 2. Topologies `[CONFIRMED]` (framework documentation, read November 2026)

The frameworks name the same few shapes in different words.

| Topology | Who decides the next step | Names in the docs |
|---|---|---|
| **Supervisor** (manager, coordinator) | One agent calls specialists as tools and writes the answer | OpenAI: agents as tools; LangChain: subagents ("A main agent coordinates subagents as tools."); ADK: coordinator and dispatcher, hierarchical decomposition |
| **Handoff** (triage, transfer) | The current agent passes control to a specialist | OpenAI: handoffs; LangChain: handoffs; Azure: handoff |
| **Pipeline** | Your code, in a fixed order | Azure: sequential; ADK: sequential pipeline |
| **Fan-out** | Your code runs agents in parallel and merges | Azure: concurrent; ADK: parallel fan-out and gather |
| **Group chat** | A manager picks who speaks in a shared thread | Azure: group chat, with maker-checker as a special case |
| **Planner with ledger** | A manager builds and updates a task list, assigns work | Azure: magentic |

**OpenAI Agents SDK** `[CONFIRMED]`: the docs describe "two main ways to orchestrate agents": LLM-driven (the model plans, using tools and handoffs) and code-driven (your code sets the flow), and code-driven is "more deterministic and predictable, in terms of speed, cost and performance." Use an agent as a tool when the specialist "should help with a bounded subtask but should not take over the user-facing conversation"; use a handoff when "routing itself is part of the workflow and you want the chosen specialist to own the remainder of the current turn." Under the hood, "Handoffs are represented as tools to the LLM."

**Azure Architecture Center** `[CONFIRMED]` (February 2026): in a handoff, "Full control transfers from one agent to another agent", and the main risks are infinite handoff loops and bouncing between agents. For group chat it advises "limiting group chat orchestration to three or fewer agents." Magentic is "designed for open-ended and complex problems that don't have a predetermined plan of approach" and "focuses on building and debating viable plans, not optimizing for speed."

**Google ADK 2.0** `[CONFIRMED]` (May 2026): ADK moved "from a hierarchical agent executor to a graph-based execution engine", deprecated its sequential, parallel and loop agent classes in Python and TypeScript, and now says "For new code, express these patterns with a graph-based workflow". The topologies are the same; they are now drawn as graphs.

## 3. Mapping to classic architecture `[INDUSTRY PATTERN]` (our reasoning)

| Agent topology | Microservice analogue | What carries over |
|---|---|---|
| Supervisor | Orchestration (an orchestrated saga, a workflow engine) | One place to see the plan, set budgets and stop; a bottleneck and single point of failure |
| Handoff | Choreography (services react to events) | Easy to add a specialist; hard to see the whole flow; loops and lost requests are the typical bugs |
| Pipeline | ETL or a stream-processing DAG | Predictable; errors flow downstream unless you gate them |
| Fan-out | Scatter-gather | Latency of the slowest branch; needs a merge rule |
| Group chat | A shared blackboard or a meeting | Flexible; hard to bound, so cap turns and participants |
| Planner with ledger | A job scheduler with a persisted plan | The ledger is state: persist it, version it, let people read it |

The analogy has one weak point: a service has a typed interface, an agent receives text. A handoff that drops context, or a sub-agent that misreads its brief, fails silently, which is why the next two sections matter.

## 4. When several agents help `[CONFIRMED]` (Anthropic, June 2025)

Anthropic's Research feature uses a lead agent that plans and starts subagents in parallel, each searching with its own tools and context, and a final step that attributes citations. Published results, on its own internal research eval, with Claude Opus 4 as lead and Claude Sonnet 4 as subagents:

- The system "outperformed single-agent Claude Opus 4 by 90.2% on our internal research eval".
- On BrowseComp, "three factors explained 95% of the performance variance", and "token usage by itself explains 80% of the variance". Part of the gain is simply spending more tokens in parallel.
- Cost: "multi-agent systems use about 15× more tokens than chats".
- Limits: the post says multi-agent fits poorly in "some domains that require all agents to share the same context", or with many dependencies between agents, and that "most coding tasks involve fewer truly parallelizable tasks than research".
- A production constraint: "our lead agents execute subagents synchronously, waiting for each set of subagents to complete", so the slowest subagent sets the latency.

The coordination failures that appear when agents act as peers (and the MAST failure taxonomy) are summarised in [25 AI agent platform, section 4d](../systems/25-ai-agent-platform.md).

## 5. The case against `[CONFIRMED]` (Cognition, June 2025)

Cognition, which builds a coding agent, argued two principles: "Share context, and share full agent traces, not just individual messages", and "Actions carry implicit decisions, and conflicting decisions carry bad results". Its example: two subagents building parts of a game made incompatible style choices, because "The actions subagent 1 took and the actions subagent 2 took were based on conflicting assumptions not prescribed upfront." Its recommendation: "The simplest way to follow the principles is to just use a single-threaded linear agent", and compress history when the context overflows. The post is an argument from experience, not a measurement.

The two posts agree more than their titles suggest (our reading): parallel agents work when the parts are independent (separate searches), and fail when they must agree on decisions nobody wrote down (shared code, a shared style).

## 6. What 2026 studies found at equal cost `[CONFIRMED]` as the papers' own results; preprints, not peer reviewed

Many multi-agent wins compare a team against one agent that got less compute. Three 2026 arXiv preprints control for that, with different methods:

- **Equal calls** (arXiv 2609.04217, June 2026): a planner, executor and critic team against one agent, same frozen 7B model, ALFWorld and WebShop. The team reached "0.769 versus 0.754, p = 0.80, despite using 1.8 times more evaluation calls", and the planner and critic prompts evolved to near-empty. The authors' conclusion: "Under equal inference cost, multi-agent structure adds cost without clear benefit."
- **Equal thinking budget per step** (arXiv 2610.06069, October 2026): on a long ledger-reconciliation task, a model of attention and handoff costs predicted decomposition would win at depths of 20 to 100 steps, and "The decomposed system won at every depth, as predicted." The authors note "the runs test the winner past the crossover and not the crossing itself".
- **Equal calls, not tokens** (arXiv 2610.27488, October 2026): on a financial-review task with four models, a three-call team caught more defects but "raises more false alarms on all four", used 2.2 to 2.4 times the tokens, and "Balanced accuracy, an exploratory measure, changes by 0.02 or less". Sampling the single agent three times did better on the models where the team helped.

Our reading: decomposition pays when one context would be overloaded (long, stateful tasks, information beyond one window); on tasks that fit in one context, a single agent with more samples is a strong baseline. Always compare at equal cost.

## 7. Deciding `[INDUSTRY PATTERN]` (our reasoning)

Add a second agent only if you can name one of these reasons and measure it:

1. **Context isolation:** the work needs more material than fits in one context, or one agent has too many tools. LangChain's docs give the same reason ("Multi-agent patterns are particularly valuable when a single agent has too many" tools) and add that "not every complex task requires this approach" `[CONFIRMED]`.
2. **Parallelism:** independent subtasks where latency matters more than tokens.
3. **A security boundary:** one agent reads untrusted content, another holds credentials ([P22](P22-llm-products-in-production.md), the Rule of Two).
4. **Ownership:** different teams own different specialists and deploy them separately (agent-to-agent protocols in [P21](P21-agent-frameworks-and-protocols-2026.md)).

Then pick the topology: a supervisor if one answer must come out and you need control; handoffs if the user talks to one specialist at a time; a pipeline or fan-out if the steps are known (that is a workflow, [P19](P19-llm-workflow-patterns.md)). For every agent boundary, write down what context crosses it, in what format, and who checks the result.

---

## Questions to practise

1. A bank wants a chat assistant covering cards, loans and fraud. Supervisor or handoffs? What does the user experience look like in each when the question spans two domains?
2. Your supervisor calls five research subagents in parallel and the p95 latency is 90 seconds. Where does the time go and what are your options?
3. A colleague shows a multi-agent prototype that scores 15 points higher than the single agent. What do you ask before believing it?
4. Map a handoff-based support system to choreography. Which classic failure (lost message, loop, no owner) shows up, and how do you detect it?
5. Two coding subagents edit different files of the same feature and the result does not compile. Which of Cognition's principles was broken, and how would you redesign?

**Related:** [P19 Workflow patterns](P19-llm-workflow-patterns.md), [25 AI agent platform](../systems/25-ai-agent-platform.md), [P03 Distributed transactions](P03-distributed-transactions.md), [P18 Evaluating LLM and agent systems](P18-evaluating-llm-and-agent-systems.md), [P21 Frameworks and protocols](P21-agent-frameworks-and-protocols-2026.md), [P22 LLM products in production](P22-llm-products-in-production.md).

## Sources and provenance

> **Sources read on 2026-11-21:** OpenAI Agents SDK documentation, [*Agent orchestration*](https://openai.github.io/openai-agents-python/multi_agent/) and [*Handoffs*](https://openai.github.io/openai-agents-python/handoffs/) (openai-agents 0.25.0, released 18 November 2026) · LangChain documentation, [*Multi-agent*](https://docs.langchain.com/oss/python/langchain/multi-agent) · Google, [*Welcome to ADK 2.0*](https://adk.dev/2.0/) and [*Multi-agent patterns*](https://adk.dev/workflows/patterns/) (ADK Python 2.0 GA 19 May 2026; the patterns page read partly through a summary) · Microsoft, Azure Architecture Center, [*AI agent orchestration patterns*](https://learn.microsoft.com/azure/architecture/ai-ml/guide/ai-agent-design-patterns) (12 February 2026, updated 21 September 2026) · Hadfield et al., Anthropic, [*How we built our multi-agent research system*](https://www.anthropic.com/research/multi-agent-research-system) (13 June 2025; foundational) · Yan, Cognition, [*Don't Build Multi-Agents*](https://cognition.com/blog/dont-build-multi-agents) (12 June 2025; foundational counterpoint) · Dylan et al., [*At Equal Inference Cost, Multi-Agent Structure Does Not Beat a Single Frozen Agent*](https://arxiv.org/abs/2609.04217) (arXiv, v1 dated 25 June 2026) · Anchan and Sen, [*Attention Tax, Handoff Tax*](https://arxiv.org/abs/2610.06069) (arXiv, 5 October 2026; [HTML v1](https://arxiv.org/html/2610.06069v1)) · Liu, [*The More the Better? A Comparison of Single- and Multi-Agent LLM Setups on a Financial Review Task*](https://arxiv.org/abs/2610.27488) (arXiv, 20 October 2026).
> **Dated material:** the Anthropic figures were measured with Claude Opus 4 and Sonnet 4 in 2025 on Anthropic's own eval and on BrowseComp. The preprints used a frozen 7B model on ALFWorld and WebShop (2609.04217), gpt-oss-20b (2610.06069) and Qwen3.5 9B and 27B, Haiku 5.5 and Sonnet 5.5 (2610.27488). None has been peer reviewed as far as we know. Framework names and classes change often; check [P21](P21-agent-frameworks-and-protocols-2026.md).
> **Not read:** the full text of the three preprints (each was read in its abstract and about the first 40,000 characters of its HTML version; later sections only through a summary); ADK's graph and collaboration pages beyond the collaboration modes; the Cognition follow-up posts, if any.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-11-21, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the OpenAI Agents SDK docs: the two ways to orchestrate, the code-driven trade-off, when to use agents as tools and when to use handoffs, handoffs represented as tools.
- Verified in the LangChain docs: the subagents definition, the reason for multiple agents and the "not every complex task" caution.
- Verified in the ADK pages: the move to a graph engine, the deprecated workflow agent classes, the graph advice for new code, the pattern names.
- Verified in the Azure guide: the handoff, group chat and magentic statements.
- Verified in Anthropic's June 2025 post: the architecture, the 90.2% result and its eval, the 95% and 80% variance figures, the 15× token figure, the shared-context and coding limits, synchronous subagents.
- Verified in Cognition's post: the two principles, the conflicting-subagents example and the single-threaded recommendation.
- Verified in the preprints (abstracts and early sections): the setups, the cost-matching methods and the quoted results.
- Not verified: the preprints' later sections and appendices, including any replication or sensitivity analysis; whether any of the three has since been revised or accepted at a venue.
- Not sourced (our reasoning): the topology table's grouping of framework names, the microservice mapping, our reading of where Anthropic and Cognition agree, the reading of the preprints and the decision guide.
