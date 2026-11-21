# P21 — Agent frameworks and protocols, status November 2026

*A dated snapshot of the frameworks and protocols used to build LLM agents: what each one is for, its current version and status, and what changed in the last year. Every row was checked on the project's own documentation, changelog or package index on 2026-11-21. This page ages faster than any other in the atlas: check the linked page before you rely on a version or a date. The patterns these tools implement are in [P19](P19-llm-workflow-patterns.md) and [P20](P20-agent-and-multi-agent-architectures.md).*

## At a glance

- **Protocols** connect parts that different teams or vendors build. **MCP** (Model Context Protocol) connects an agent to tools and data; **A2A** (Agent2Agent) connects an agent to other agents. MCP was a founding project of the Linux Foundation's Agentic AI Foundation, and the A2A site lists A2A as part of it.
- MCP's current revision, **2026-07-28**, is its largest change so far: the protocol became **stateless**, with no session and no initialisation handshake. Clients and servers may support several revisions, but adopting 2026-07-28 means changes to code written for 2025 revisions.
- **Frameworks** give you the agent loop, multi-agent topologies, state persistence, human approval steps and tracing. In 2026 most moved towards **graphs with durable state**: Google ADK 2.0 replaced its hierarchy with a graph runtime; Microsoft merged AutoGen and Semantic Kernel into Agent Framework and archived AutoGen on 20 November 2026.
- **Retired or retiring in 2026:** OpenAI's Assistants API (shut down 26 August 2026; use the Responses and Conversations APIs), and OpenAI's Agent Builder, shutting down on 30 November 2026.
- **Tracing standard:** OpenTelemetry's GenAI conventions, including agent spans, exist but are still marked **Development**, not stable.
- Pick a framework for its durability, tracing and approval features, and keep your prompts, tools and evals portable. The patterns outlive the libraries.

---

## 1. What a framework or protocol does for you `[INDUSTRY PATTERN]` (our reasoning)

| Layer | Problem | Classic analogue |
|---|---|---|
| Tool protocol (MCP) | Every app wrote its own adapter for every tool | A driver interface, or an API standard such as OpenAPI |
| Agent-to-agent protocol (A2A) | Agents from different vendors cannot call each other | Service-to-service RPC with discovery |
| Framework runtime | Loops, retries, state, approvals and tracing written by hand | A workflow engine (step functions, durable execution) plus an RPC library |
| Tracing conventions | Every tool logs agent runs differently | OpenTelemetry semantic conventions for HTTP and databases |

In our view the core of Anthropic's 2024 advice still holds: start with the model API directly and understand the code under any framework ([P19](P19-llm-workflow-patterns.md), section 8). The post itself now opens with a note that "Much of the tooling landscape described in this post has changed since December 2024", and points to Anthropic's managed agents (section 3). What frameworks add in 2026 is mostly operational: checkpointing, resuming, approvals and traces ([P22](P22-llm-products-in-production.md)).

## 2. Protocols `[CONFIRMED]` (checked 2026-11-21)

### MCP, Model Context Protocol

- **Status:** revision 2026-07-28 is marked current. The versioning page defines current as "the current protocol version, which is ready for use and may continue to receive backwards compatible changes." The previous revision was 2025-11-25; note [25](../systems/25-ai-agent-platform.md) describes 2025-06-18.
- **Main changes in 2026-07-28** (changelog): "Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake"; "Remove protocol-level sessions and the `Mcp-Session-Id` header from the Streamable HTTP transport"; servers must answer a new `server/discover` request; requests from server to client (sampling, elicitation) become multi-round-trip requests; tasks moved "out of the core protocol and into an official extension"; roots, sampling, logging and the old HTTP+SSE transport are deprecated; authorisation tightened (clients must validate the RFC 9207 `iss` parameter).
- **Why stateless matters** (our reasoning): an MCP server can now sit behind an ordinary load balancer with no sticky sessions, like any stateless HTTP service. State that has to last across calls moves into the requests themselves: the changelog says "servers that need cross call state use explicit server minted handles passed as ordinary tool arguments" `[CONFIRMED]`. Long tasks move to the tasks extension, and change notifications to `subscriptions/listen`, "a single long lived post response stream" `[CONFIRMED]`.
- **Retries are now the client's job** `[CONFIRMED]`: stream resumability was removed, so "a broken response stream loses the in flight request clients must re issue it as a new request". A reissued `tools/call` can run the tool twice, which makes idempotent tools a requirement, not a nicety ([P22](P22-llm-products-in-production.md), section 3).
- **Security:** the specification's security best practices page lists confused-deputy attacks through proxy servers, **access-token passthrough** (OAuth credentials, not text tokens: "an anti-pattern where an MCP server accepts tokens from an MCP client without validating" them), SSRF, hijacking of the state handles that resources and tools hand out (the page sends readers of 2025-11-25 and earlier to that version for session hijacking), compromised local servers, OAuth mix-up and redirect attacks, and scope minimisation. See [P22](P22-llm-products-in-production.md).
- **Governance:** the Linux Foundation announced the Agentic AI Foundation on 9 December 2025 with "founding contributions of three leading projects": Anthropic's MCP, Block's goose and OpenAI's AGENTS.md.

### A2A, Agent2Agent

- **What it is:** "An open protocol enabling communication and interoperability between opaque agentic applications." Its site puts the split this way: "MCP connects an agent to tools, APIs, and data. A2A connects it to other agents." Opaque means each agent keeps its internals private and exposes only tasks and messages.
- **Status:** v1.0.0 released 12 March 2026; the latest release is v1.0.1 (release notes dated 26 May 2026, the release itself shows 28 May). The site shows A2A as part of the Agentic AI Foundation.
- **When to use it** (our reasoning): when agents are owned and deployed by different teams or organisations. Inside one codebase, an agent as a tool or a handoff in your framework is simpler.

## 3. Frameworks `[CONFIRMED]` (versions from the package index or release page, 2026-11-21)

| Framework | Latest checked | Status and 2026 changes | Model coupling |
|---|---|---|---|
| **LangGraph** (LangChain) | 1.2.24, 20 Nov 2026 | Described as "a low-level orchestration framework for building, managing, and deploying long-running, stateful agents". Graph of nodes with checkpointed state; durable execution, human-in-the-loop interrupts. langgraph and langchain 1.0.0 were both published on PyPI on 17 October 2025. | Any model |
| **OpenAI Agents SDK** | openai-agents 0.25.0, 18 Nov 2026 | Primitives: agents, agents as tools and handoffs, guardrails; plus sessions and built-in tracing. Uses the Responses API by default for OpenAI models; other providers are supported. Version is below 1.0. | Any model, OpenAI first |
| **Google ADK** (Agent Development Kit) | Python 2.15.0, 19 Nov 2026 | 2.0 GA: Python 19 May, Go 30 June, TypeScript 21 August 2026. "The ADK 2.0 release introduces the Workflow Runtime, transitioning ADK from a hierarchical agent executor to a graph-based execution engine." Sequential, parallel and loop agent classes deprecated in Python and TypeScript. | Any model, Gemini first |
| **Microsoft Agent Framework** | agent-framework 1.26.0 (PyPI), 12 Nov 2026 | 1.0.0 on PyPI on 2 April 2026. Microsoft calls it "the direct successor, created by the same teams" to AutoGen and Semantic Kernel. Graph-based workflows. | Any model, Azure first |
| **AutoGen** (Microsoft) | archived | The repository was archived on 20 November 2026; the README says "New users should start with Microsoft Agent Framework." Do not start new work on it. | — |
| **CrewAI** | 1.15.44, 19 Nov 2026 | Flows are "The backbone of your AI application" and Crews are "The units of work within your Flow"; the docs advise production apps to start with a Flow. Conversational flows became stable in 1.15.18 (changelog seen through search results only). | Any model |
| **Claude Agent SDK** (Anthropic) | claude-agent-sdk 0.2.187 (Python), 20 Nov 2026 | Formerly the Claude Code SDK. "Build production AI agents with Claude Code as a library": the same tools, agent loop and context management as Claude Code, with hooks, subagents, MCP, permissions and sessions. PyPI marks it "3 - Alpha". | Claude |

**Reading the table** (our reasoning):
- Version numbers below 1.0 (OpenAI Agents SDK, Claude Agent SDK) mean the API may still change between minor versions; pin versions and read changelogs on upgrade.
- Several projects release more than once a week. Treat a framework as a fast-moving dependency: lock files, an upgrade test suite and the eval gate from [P18](P18-evaluating-llm-and-agent-systems.md).
- The convergence on graphs with checkpointed state is the useful signal: it is the workflow-engine model ([P22](P22-llm-products-in-production.md), section 3), applied to agents.

## 4. Retired or replaced `[CONFIRMED]`

| What | Date | Replacement | Source |
|---|---|---|---|
| OpenAI Assistants API | shut down 26 Aug 2026 | Responses API and Conversations API | the migration guide says it "was officially sunset on August 26, 2026, and is no longer available." |
| OpenAI Agent Builder | shutdown 30 Nov 2026 | Agents SDK or ChatGPT workspace agents | OpenAI deprecations page |
| AutoGen | archived 20 Nov 2026 | Microsoft Agent Framework | AutoGen README |
| ADK `SequentialAgent`, `ParallelAgent`, `LoopAgent` (Python, TypeScript) | deprecated in 2.0 (May 2026) | graph-based workflows | ADK 2.0 page |
| MCP sessions and initialise handshake | removed in 2026-07-28 | stateless requests, `server/discover` | MCP changelog |

## 5. Tracing: OpenTelemetry GenAI conventions `[CONFIRMED]`

The GenAI semantic conventions moved out of the main OpenTelemetry semantic conventions into their own repository, `semantic-conventions-genai`; the old page says they "have moved to the OpenTelemetry GenAI semantic conventions repository". Agent spans are defined there (`create_agent`, `invoke_agent`, `invoke_workflow`, `plan`), each marked **Status: Development**. Our reasoning: use the attribute names now so your traces line up with other tools, and expect renames before they become stable.

## 6. Choosing `[INDUSTRY PATTERN]` (our reasoning)

1. **Do you need a framework at all?** A workflow from [P19](P19-llm-workflow-patterns.md) is often a few functions around the model API.
2. **What must survive a crash?** If runs last minutes to hours or wait for a human, choose a runtime with checkpoints and resume (LangGraph, ADK 2.0, Agent Framework workflows, CrewAI Flows), or put the agent inside a workflow engine you already run.
3. **Which model?** Vendor SDKs are tuned for their own models and features; the model-neutral ones help if you route between providers ([P19](P19-llm-workflow-patterns.md), routing).
4. **Can you see inside?** Prefer frameworks that emit OpenTelemetry traces and let you read the exact prompts sent.
5. **Who else must interoperate?** MCP for tools you want to share across hosts; A2A only across team or company boundaries.
6. **Exit cost:** keep prompts, tool definitions (as MCP servers where possible) and eval suites outside the framework, so a migration like AutoGen to Agent Framework touches only the orchestration layer.

---

## Questions to practise

1. You built tools against MCP 2025-06-18 with session state on the server. What breaks under 2026-07-28, and how would you redesign the server for horizontal scaling?
2. When would you choose A2A over a sub-agent called as a tool? Give one case for each.
3. Your team's agent runs for 40 minutes and sometimes waits a day for approval. What do you need from the framework, and what could you use instead of one?
4. A framework you depend on is archived tomorrow. Which parts of your system should not have to change?
5. Why might you adopt OpenTelemetry GenAI attribute names while they are still in Development status?

**Related:** [25 AI agent platform](../systems/25-ai-agent-platform.md), [P19 Workflow patterns](P19-llm-workflow-patterns.md), [P20 Agent and multi-agent architectures](P20-agent-and-multi-agent-architectures.md), [P22 LLM products in production](P22-llm-products-in-production.md), [P09 Decisions and design docs](P09-decisions-and-design-docs.md) (boring technology), [P10 Changing systems safely](P10-changing-systems-safely.md).

## Sources and provenance

> **Sources read on 2026-11-21:** Schluntz and Zhang, Anthropic, [*Building effective agents*](https://www.anthropic.com/research/building-effective-agents) (19 December 2024; its note on the changed tooling) · Model Context Protocol, [*Changelog, 2026-07-28*](https://modelcontextprotocol.io/specification/2026-07-28/changelog), [*Versioning*](https://modelcontextprotocol.io/specification/versioning) and [*Security Best Practices*](https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices) · Linux Foundation, [*Linux Foundation Announces the Formation of the Agentic AI Foundation*](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation) (9 December 2025) · A2A, [*project site*](https://a2a-protocol.org/latest/) and [*releases*](https://github.com/a2aproject/A2A/releases) · [*langgraph* on PyPI](https://pypi.org/project/langgraph/) and [*LangGraph overview*](https://docs.langchain.com/oss/python/langgraph/overview) · [*openai-agents* on PyPI](https://pypi.org/project/openai-agents/) and [*OpenAI Agents SDK*](https://openai.github.io/openai-agents-python/) · Google, [*Welcome to ADK 2.0*](https://adk.dev/2.0/) and [*adk-python releases*](https://github.com/google/adk-python/releases) · Microsoft, [*Agent Framework overview*](https://learn.microsoft.com/agent-framework/overview/agent-framework-overview) (page date 23 October 2026), [*agent-framework* on PyPI](https://pypi.org/project/agent-framework/) and the [*AutoGen repository*](https://github.com/microsoft/autogen) · [*crewai* on PyPI](https://pypi.org/project/crewai/) and [*CrewAI introduction*](https://docs.crewai.com/en/introduction) · [*claude-agent-sdk* on PyPI](https://pypi.org/project/claude-agent-sdk/) and [*Agent SDK overview*](https://code.claude.com/docs/en/agent-sdk/overview) · OpenAI, [*Deprecations*](https://developers.openai.com/api/docs/deprecations) and [*Assistants migration guide*](https://developers.openai.com/api/docs/assistants/migration) · OpenTelemetry, [*GenAI semantic conventions (moved notice)*](https://opentelemetry.io/docs/specs/semconv/gen-ai/) and [*GenAI agent spans*](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md).
> **Dated material:** every version and status on this page is as of 2026-11-21. Package versions are the latest stable release on PyPI or GitHub that day, not a recommendation.
> **Not read:** the Microsoft Agent Framework GitHub repository and its releases page (both returned 404 to our fetch; versions come from PyPI); Microsoft's 1.0 announcement post; the MCP 2026-07-28 announcement blog post (so no publication date is given, only the revision identifier); the A2A specification body and its "joins the Agentic AI Foundation" post; the LangChain 1.0 announcement (the date comes from PyPI's release history); AWS Strands Agents and Amazon Bedrock AgentCore, LlamaIndex, Pydantic AI, Mastra and other frameworks not in the table; the OWASP agentic list (see P22).
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-11-21, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the MCP pages: 2026-07-28 marked current and the definition of current, the previous revision, the stateless handshake and session removals, `server/discover`, multi-round-trip requests, tasks as an extension, the deprecations, the `iss` requirement, server-minted handles for cross-call state, `subscriptions/listen`, the removal of stream resumability and the reissue rule, and the security page's list including token passthrough and state handle hijacking.
- Verified in the Linux Foundation release: the date and the three founding projects.
- Verified on the A2A site and releases: the description, the MCP and A2A split, v1.0.0 and v1.0.1 and their dates (the two dates for v1.0.1 disagree on the page), the foundation logo.
- Verified on PyPI or GitHub: the latest version and date of langgraph, openai-agents, google-adk (GitHub), agent-framework (including 1.0.0 on 2 April 2026), crewai and claude-agent-sdk, and the Alpha classifier.
- Verified in the framework docs: the LangGraph description; the Agents SDK primitives and Responses API default; ADK 2.0 GA dates, the graph runtime sentence and deprecated classes; Agent Framework as successor; AutoGen archived and its README advice; CrewAI Flows and Crews; the Claude Agent SDK description and capabilities.
- Verified on OpenAI's pages: the Assistants API shutdown and replacement, the Agent Builder shutdown date.
- Verified on OpenTelemetry: the moved notice, the agent span names and their Development status.
- Verified on PyPI's release history (re-checked 2026-11-21 after review): langgraph and langchain 1.0.0 published 17 October 2025.
- Not verified: CrewAI's stable conversational flows version, taken from its changelog through search results; the exact day Microsoft announced Agent Framework 1.0.
- Not sourced (our reasoning): the layer table, the meaning of stateless for scaling, when to use A2A, how to read version numbers and the choosing checklist.
