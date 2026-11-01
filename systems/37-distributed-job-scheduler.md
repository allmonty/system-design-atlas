# 37 — Distributed Job Scheduler (cron at scale)

*Real-system note from Google's distributed cron (SRE book, 2016), Dropbox's Asynchronous Task Framework (2020) and the Kubernetes CronJob documentation, plus a reference design for a general scheduler. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** A job scheduler starts work at a time: periodically (cron) or once, later (delayed tasks). On one machine that is a daemon reading a table. At scale the scheduler must survive machine loss, so its state is replicated and one leader launches jobs; the hard part is the moment of launch, because a leader can die after starting a job and before recording it. Every design then picks a side: **skip a launch or risk a double launch**. Google's cron prefers skipping; Dropbox's task framework guarantees at-least-once and asks task code to tolerate repeats. Delayed tasks are usually stored in a database indexed by next run time, polled, and pushed onto queues for workers that claim, heartbeat and report.

**Key numbers** (as published)
- Google cron: three replicas by default, Paxos-replicated state, leader re-election "within seconds", failover well within one minute `[CONFIRMED]`.
- Dropbox ATF: designed for 10,000 tasks per second from the start; serving 9,000 scheduled tasks per second for 28 teams at the time of the post; 95% of tasks start within 5 seconds of their scheduled time; 99.9% availability for scheduling; the store is polled every 2 seconds `[CONFIRMED]`.
- Kubernetes CronJob: the controller checks every 10 seconds; more than 100 missed schedules stops catch-up `[CONFIRMED]`.

**Decisions and trade-offs**

| Option | Strength | Weakness |
|---|---|---|
| Single crond | Trivial | One machine is the whole failure domain |
| Replicated state, single leader launches (Google) | Survives machine loss, consistent launch record | Consensus to operate; launches must be idempotent or look-up-able |
| Store polled by time, queues, claiming workers (Dropbox) | Scales to thousands per second, isolation per task type | Latency set by poll interval; at-least-once, so repeats |
| Platform CronJob (Kubernetes) | No service to run | Approximate: a run can be doubled or missed; jobs must be idempotent |

**Common mistakes**
- Assuming the scheduler gives exactly-once execution.
- Everyone scheduling daily jobs at midnight (a thundering herd).
- No deadline for starting late, so a recovered scheduler replays hours of missed runs.
- A worker that keeps running after it lost its claim, so two workers run one task.

---

## 🧒 Non-technical explanation

A school has one bell ringer. If she is sick, nobody rings the bell, so the school trains two backups who sit beside her and write down every bell she rings. If she collapses mid-ring, a backup takes over, but first checks the notebook: was that bell rung or not? Some bells must never ring twice (the fire drill), so when in doubt the backups skip it and tell someone.

---

## TL;DR for engineers

- **Google cron:** replicas share state through Paxos; one leader launches; the start and end of every launch are recorded synchronously before and after the launch; on failover the new leader settles open launches by idempotent operations or state lookup, using job names that include the scheduled time; the extended crontab `?` spreads load `[CONFIRMED]`.
- **Dropbox ATF:** a task store indexed by next trigger time, a poller that pushes ready tasks to per-(task type, priority) SQS queues, controllers and executors that pull, claim, heartbeat and report; at-least-once with no concurrent execution of a task `[CONFIRMED]`.
- **Kubernetes CronJob:** approximately one Job per scheduled time, concurrency policies (Allow, Forbid, Replace), a starting deadline, and jobs that "should be idempotent" `[CONFIRMED]`.
- **Sharding schedules, DAG dependencies, dead-letter handling for stuck tasks:** reference design `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** register periodic and one-off jobs · launch each at (about) its time · track every run's state · retry failures · pause, cancel and inspect.

**Non-functional:** **reliability** (survive machine and zone loss) · **launch semantics** (stated plainly: at-most-once, at-least-once, or skip-on-doubt) · **timeliness** (start within seconds of schedule) · **throughput** (thousands of launches per second for task queues) · **isolation** (one team's flood does not starve another).

**Clarifying questions:** periodic, delayed or both? Is a missed run worse than a double run? Are jobs idempotent? How late may a job start? Dependencies between jobs?

---

## 2. Google's distributed cron `[CONFIRMED]`

**Why single-machine cron fails.** "Cron's failure domain is essentially just one machine", launches are fire-and-forget, and the only state is the crontab. Job types differ: some are idempotent (garbage collection), some must not run twice (an email newsletter), some can skip a run (frequent GC) and some cannot (monthly payroll). Because of that, "we favor skipping launches rather than risking double launches", since a skipped launch is easier to recover from; the service prefers to "fail closed" and owners should monitor their jobs.

**Design.** Cron runs as a few replicas that launch jobs through the datacenter scheduler (Borg), with replicas spread across power domains. State is small, so it is kept inside the service rather than on GFS, and replicated with Paxos. A single leader is the only replica that changes state or launches jobs. For each launch the leader announces the start through Paxos and waits for the quorum before launching, then announces completion; followers track **open launches** (started, not finished). The launch is identified by job and scheduled time. When the leader loses leadership "it must immediately stop interacting with the datacenter scheduler", so old and new leaders never act at once.

**Partial failure.** A new leader must conclude open launches. That requires either that all operations on external systems are idempotent, or that their state can be looked up. Google precomputes job names that include the scheduled launch time and distributes them to replicas, so the new leader looks them up and launches only the missing ones; without the time in the name, a long failover can cause a double launch of a short job.

**State.** Paxos logs and snapshots live on the replicas' local disks (three copies); snapshots are also backed up to the distributed filesystem; logs are not, accepting the loss of changes since the last snapshot if all three machines die. A fresh replica can fetch the snapshot and logs from a running one.

**Thundering herd.** People set daily jobs at midnight, and 30 teams each launching a MapReduce at once is a spike. The crontab was extended with `?`, letting the system pick the value by hashing the job configuration over the range; load is still spiky because some jobs genuinely need a specific time.

## 3. Dropbox's Asynchronous Task Framework (2020) `[CONFIRMED]`

ATF runs callbacks (which it calls lambdas) as tasks, scheduled for now or later, with priorities and per-type gating. Its guarantees: a task executes **at least once** after being scheduled, and "at most one instance of a task will be actively executing" at a time; task types are isolated (dedicated worker clusters, queues and scheduling quotas). Its targets: 95% of tasks start within five seconds of their time; 99.9% availability for scheduling.

**Components.** A **frontend** accepts Schedule RPCs and writes to the **task store** (Dropbox's Edgestore; any store with indexed queries works), where an association holds the next trigger timestamp. The **Store Consumer** polls the store for tasks that are due (new or retrying) and pushes them to an SQS queue per (lambda, priority). On each worker host a **Controller** pulls from the queues and serves NextWork RPCs to **Executors**; it claims the task through the **Heartbeat and Status Controller (HSC)**; executors heartbeat while running and report the final status (success, fatal failure, retriable failure).

**How the guarantees hold.** Every state change also moves the next trigger timestamp, so a task that stalls anywhere (lost from a queue, controller crashed after claiming, executor stopped heartbeating) is polled again and re-enqueued. Concurrent execution is prevented by an exclusive Claimed state, and by executors that kill themselves after three consecutive failed heartbeats, with the heartbeat timeout longer than that, so the task is not re-polled while the old executor might still run it. Lambdas must tolerate repeated execution on different hosts.

**Lessons it lists.** Delivery latency is tuned by the poll interval (every two seconds then). Tasks stuck in infinite retry loops from bugs needed manual intervention; the post proposes a maximum retry count and a dead letter queue. Periodic tasks and chaining were future extensions.

## 4. Kubernetes CronJob `[CONFIRMED]`

A CronJob creates a Job "approximately once per execution time of its schedule"; in some circumstances two Jobs or none may be created, so jobs should be idempotent. `concurrencyPolicy` is Allow (default), Forbid (skip the new run if the previous one is still going) or Replace. `startingDeadlineSeconds` skips a run that cannot start within the deadline; without it, and with more than 100 missed schedules since the last run, the controller logs an error and does not start the Job. Time zones are set with `.spec.timeZone`.

---

## 5. Reference design for a general scheduler `[INDUSTRY PATTERN]`

- **Definitions** (job, schedule, owner, policy) in a strongly consistent store; **runs** (job, scheduled time, state, attempt) in a table indexed by `next_run_at`.
- **Trigger:** a leader-elected scheduler (see [33 Coordination](33-distributed-coordination-locks.md)) or a set of schedulers that each own a hash range of jobs, materialising due runs with a run id of `job + scheduled time` so duplicates collapse.
- **Dispatch:** due runs go to per-tenant or per-priority queues ([04 Kafka](04-message-queue-kafka.md) or SQS); workers claim with a lease and fencing token, heartbeat, and report.
- **Policy per job:** missed-run behaviour (skip, run once, catch up within a deadline), concurrency (allow, forbid, replace), retry with backoff and a cap, then a dead letter queue.
- **Load spreading:** jitter or hashed start times for jobs that do not need an exact minute.
- **Dependencies:** a DAG of runs (a workflow engine) is a layer above; keep the trigger itself simple.

---

## 6. Failure scenarios

- **Leader dies mid-launch.** The new leader looks up or idempotently repeats open launches keyed by scheduled time `[CONFIRMED]` (Google).
- **Old leader keeps launching after losing leadership.** It must stop talking to the datacenter scheduler at once; in a general design, fence it with a token `[CONFIRMED]` / `[INDUSTRY PATTERN]`.
- **Worker hangs but keeps running.** Executor self-termination after three failed heartbeats prevents a second copy `[CONFIRMED]` (Dropbox).
- **Scheduler down for hours.** Without a starting deadline, a CronJob controller may refuse to catch up (over 100 missed); with a deadline, it starts once `[CONFIRMED]` (Kubernetes).
- **Bug makes a task retry forever.** Cap retries and move it to a dead letter queue; Dropbox proposed this after manual clean-ups `[CONFIRMED]` for the problem, `[INDUSTRY PATTERN]` for the fix.
- **Midnight spike.** Hash or jitter start times `[CONFIRMED]` (Google's `?`).

---

## 7. Capacity reasoning (illustrative)

- 10 million one-off tasks a day is about 116 per second on average; with a 10× peak, about 1,200 per second, each costing a few store writes (schedule, claim, heartbeat, result).
- Polling every 2 seconds for due tasks means a median delay of about 1 second from the poll alone; halving the interval doubles the poll queries (our arithmetic; Dropbox names the poll interval as the latency lever).
- A periodic job every minute is 1,440 runs a day; 100,000 such jobs is 1,667 launches per second, so the run table needs partitioning by time or job hash.

---

## ⚠️ Reviewer notes

1. **The Google chapter is from 2016 (first published in ACM Queue, 2015)** and the Dropbox post from 2020; neither describes the current system.
2. **"Exactly-once scheduling" in popular articles.** None of the sources promises it. Google skips when in doubt and records launches; Dropbox and Kubernetes promise at-least-once or approximately once and require idempotent jobs.
3. **Not read:** Google's later Borg and Cloud Scheduler docs, Airflow and Temporal docs, Uber's Cadence, Quartz clustering.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the sources. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **reliability**, **recoverability**, **scalability** (task queues), **isolation**.
- **Style (Ch 13–17):** a **replicated control plane** (leader plus consensus) over a **queue-based worker pool**.
- **Quanta (Ch 7):** the scheduler and each team's worker cluster are separate quanta; Dropbox makes owners run their own workers.
- **Trade-off (First Law, Ch 1):** **missed run vs double run.** No design avoids both under failure; pick per job and make the job safe for the other case.
- **ADR sketch (Ch 19):** *"We will key every run by job and scheduled time, record it before dispatch, and require handlers to be idempotent. We accept occasional repeated runs in exchange for never silently skipping a run."*
- Plain English: write down every bell before you ring it.

---

## Interview questions to practice

1. Design a distributed cron service.
2. Design a delayed task queue (run this in 30 minutes) at 10,000 tasks per second.
3. What happens if the scheduler leader dies just after launching a job?
4. How do you prevent two workers running the same task?
5. A thousand teams schedule jobs at midnight. What breaks and how do you fix it?
6. The scheduler was down for two hours. What should run when it comes back?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the sources.

**A 45-minute walkthrough**

1. Clarify: periodic or delayed, launch semantics, lateness tolerance, scale, multi-tenancy.
2. Estimate: launches per second, run-table growth, poll cost ([P01](../toolkit/P01-estimation.md)).
3. API: `createJob(schedule, target, policy)`, `schedule(task, runAt)`, `pause`, `listRuns`.
4. Design: definitions store, run table indexed by time, leader or sharded triggers, queues, claiming workers.
5. Deep dive: launch record and failover, claims and heartbeats, missed-run policy.
6. Failure and scale: leader loss, worker hangs, retry storms, midnight spikes, 10× tasks.

**If it grows 10×**
- Shard triggers by job hash; partition the run table by time and archive old runs.
- Separate queues and workers per tenant or priority, as Dropbox does per lambda.
- Spread periodic jobs with hashed start offsets.

**Answer outlines** (try the questions above first)

<details><summary>The leader dies just after launching a job</summary>

If the launch was recorded as started but not finished, the new leader cannot know if it happened. Make it knowable: name the external job by job id plus scheduled time, and on takeover look it up and launch only if missing. If lookup is impossible, the operation must be idempotent, or the policy for that job decides between skipping and risking a repeat.

</details>

<details><summary>Two workers run the same task</summary>

Claim with a conditional state change (only from Enqueued to Claimed), give the claim a lease, renew it by heartbeat, and make a worker stop when it cannot renew, with the lease timeout longer than the stop time. Still assume a repeat can happen and make the handler idempotent.

</details>

<details><summary>Back after two hours down</summary>

Decide per job: frequent maintenance jobs skip missed runs; daily reports run once now; billing runs every missed period in order. Enforce with a starting deadline and a catch-up limit so the recovery does not become its own spike.

</details>

## 📚 Further reading

- The sources listed under Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [33 Coordination and locks](33-distributed-coordination-locks.md), [04 Message queue](04-message-queue-kafka.md), [10 Notification system](10-notification-system.md), [16 Reservations](16-reservation-scheduler.md), [P03 Distributed transactions](../toolkit/P03-distributed-transactions.md).

## Sources and provenance

> **Kind:** real systems (Google cron, Dropbox ATF, Kubernetes CronJob) with a reference design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-31:** Štěpán Davidovič (edited by Kavita Guliani), [*Distributed Periodic Scheduling with Cron*](https://sre.google/sre-book/distributed-periodic-scheduling/) (Google, *Site Reliability Engineering*, 2016, chapter 24) · Dropbox, [*How we designed Dropbox ATF: an async task framework*](https://dropbox.tech/infrastructure/asynchronous-task-scheduling-at-dropbox) (11 November 2020) · Kubernetes, [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/) (current docs).
> **Dated material:** the cron chapter (2016) and the ATF post (2020) describe those systems at the time.
> **Not read:** the ACM Queue version of the cron article, Borg papers, workflow engines (Airflow, Temporal, Cadence), Quartz.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-31, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the cron chapter: single-machine failure domain, job types and the skip-over-double preference, Paxos replicas and the single leader, synchronous launch start and end records, mutual exclusion on losing leadership, open launches and the idempotent-or-lookup rule, job names with scheduled time, local logs and snapshots with snapshot backup, the midnight herd and the `?` extension.
- Verified in the ATF post: guarantees, the 95% within 5 seconds and 99.9% targets, 10,000 and 9,000 tasks per second, 28 teams, the components and RPCs, trigger timestamps, claim state, three-heartbeat self-termination, the 2-second poll, the retry-loop problem and the dead letter queue proposal.
- Verified in the Kubernetes docs: approximately once, idempotent jobs, concurrency policies, starting deadline, the 10-second check, the 100 missed schedules rule and `.spec.timeZone`.
- Not sourced (our reasoning): the general reference design, run ids, fencing for a general scheduler, per-job missed-run policies, and the capacity arithmetic.
- Not claimed: how Google, Dropbox or Kubernetes schedule jobs today beyond the cited documents.
