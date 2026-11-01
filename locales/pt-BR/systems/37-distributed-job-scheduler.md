# 37 — Distributed Job Scheduler (cron at scale)

*Nota de sistemas reais a partir do cron distribuído do Google (livro de SRE, 2016), do Asynchronous Task Framework do Dropbox (2020) e da documentação do CronJob do Kubernetes, além de um design de referência para um agendador genérico. Como foi obtido e o que não foi verificado está em **Sources and provenance** perto do final.*

## At a glance

**Em 60 segundos.** Um agendador de jobs inicia trabalho num horário: periodicamente (cron) ou uma vez, mais tarde (tarefas adiadas). Numa máquina só, isso é um daemon lendo uma tabela. Em escala, o agendador precisa sobreviver à perda de máquinas, então seu estado é replicado e um líder dispara os jobs; a parte difícil é o momento do disparo, porque um líder pode morrer depois de iniciar um job e antes de registrá-lo. Todo design escolhe então um lado: **pular um disparo ou arriscar um disparo duplo**. O cron do Google prefere pular; o framework de tarefas do Dropbox garante at-least-once e pede que o código das tarefas tolere repetições. Tarefas adiadas costumam ficar num banco indexado pelo próximo horário de execução, consultado periodicamente e empurrado para filas de workers que reivindicam, enviam heartbeats e reportam.

**Números-chave** (conforme publicado)
- Cron do Google: três réplicas por padrão, estado replicado com Paxos, reeleição do líder "within seconds", failover bem dentro de um minuto `[CONFIRMED]`.
- ATF do Dropbox: projetado para 10.000 tarefas por segundo desde o início; atendia 9.000 tarefas agendadas por segundo para 28 equipes na época do post; 95% das tarefas começam em até 5 segundos do horário marcado; 99,9% de disponibilidade para agendamento; o banco é consultado a cada 2 segundos `[CONFIRMED]`.
- CronJob do Kubernetes: o controlador verifica a cada 10 segundos; mais de 100 horários perdidos interrompe a recuperação `[CONFIRMED]`.

**Decisões e trade-offs**

| Opção | Ponto forte | Ponto fraco |
|---|---|---|
| Um único crond | Trivial | Uma máquina é todo o domínio de falha |
| Estado replicado, um só líder dispara (Google) | Sobrevive à perda de máquinas, registro de disparo consistente | Consenso para operar; disparos precisam ser idempotentes ou consultáveis |
| Banco consultado por horário, filas, workers que reivindicam (Dropbox) | Escala a milhares por segundo, isolamento por tipo de tarefa | Latência definida pelo intervalo de consulta; at-least-once, então há repetições |
| CronJob da plataforma (Kubernetes) | Nenhum serviço para operar | Aproximado: uma execução pode ser duplicada ou perdida; os jobs precisam ser idempotentes |

**Erros comuns**
- Supor que o agendador oferece execução exactly-once.
- Todo mundo agendando jobs diários à meia-noite (um thundering herd).
- Nenhum prazo para começar atrasado, então um agendador que volta repete horas de execuções perdidas.
- Um worker que continua rodando depois de perder sua reivindicação, e assim dois workers rodam a mesma tarefa.

---

## 🧒 Non-technical explanation

Uma escola tem uma única pessoa que toca o sinal. Se ela fica doente, ninguém toca, então a escola treina duas substitutas que sentam ao lado dela e anotam cada sinal tocado. Se ela desmaia no meio de um toque, uma substituta assume, mas antes confere o caderno: aquele sinal foi tocado ou não? Alguns sinais nunca podem tocar duas vezes (o do treino de incêndio), então, na dúvida, as substitutas pulam e avisam alguém.

---

## TL;DR for engineers

- **Cron do Google:** as réplicas compartilham estado via Paxos; um líder dispara; o início e o fim de cada disparo são registrados de forma síncrona antes e depois do disparo; no failover, o novo líder resolve os disparos em aberto com operações idempotentes ou consulta de estado, usando nomes de job que incluem o horário agendado; o crontab estendido com `?` espalha a carga `[CONFIRMED]`.
- **ATF do Dropbox:** um banco de tarefas indexado pelo próximo horário de disparo, um consultor que empurra tarefas prontas para filas SQS por (tipo de tarefa, prioridade), controladores e executores que puxam, reivindicam, enviam heartbeat e reportam; at-least-once sem execução concorrente da mesma tarefa `[CONFIRMED]`.
- **CronJob do Kubernetes:** aproximadamente um Job por horário agendado, políticas de concorrência (Allow, Forbid, Replace), um prazo para começar, e jobs que "should be idempotent" `[CONFIRMED]`.
- **Dividir agendas em shards, dependências em DAG, tratamento de tarefas presas com dead-letter:** design de referência `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcionais:** registrar jobs periódicos e avulsos · disparar cada um (perto do) seu horário · acompanhar o estado de cada execução · repetir falhas · pausar, cancelar e inspecionar.

**Não funcionais:** **confiabilidade** (sobreviver à perda de máquinas e de zonas) · **semântica de disparo** (dita com clareza: at-most-once, at-least-once ou pular na dúvida) · **pontualidade** (começar segundos após o horário) · **vazão** (milhares de disparos por segundo para filas de tarefas) · **isolamento** (a enxurrada de uma equipe não deixa outra sem recursos).

**Perguntas de esclarecimento:** periódico, adiado ou ambos? Uma execução perdida é pior que uma duplicada? Os jobs são idempotentes? Quão tarde um job pode começar? Há dependências entre jobs?

---

## 2. Google's distributed cron `[CONFIRMED]`

**Por que o cron de uma máquina só falha.** "Cron's failure domain is essentially just one machine", os disparos são do tipo dispara-e-esquece, e o único estado é o crontab. Os tipos de job diferem: alguns são idempotentes (coleta de lixo), alguns não podem rodar duas vezes (um boletim por e-mail), alguns podem pular uma execução (coleta frequente) e outros não (a folha de pagamento mensal). Por isso, "we favor skipping launches rather than risking double launches", já que é mais fácil se recuperar de um disparo pulado; o serviço prefere "fail closed" e os donos devem monitorar seus jobs.

**Design.** O cron roda como algumas réplicas que disparam jobs pelo agendador do datacenter (Borg), com as réplicas espalhadas por domínios de energia. O estado é pequeno, então fica dentro do serviço e não no GFS, replicado com Paxos. Um único líder é a única réplica que muda o estado ou dispara jobs. Para cada disparo, o líder anuncia o início via Paxos e espera o quorum antes de disparar, depois anuncia a conclusão; os seguidores acompanham os **disparos em aberto** (iniciados, não concluídos). O disparo é identificado pelo job e pelo horário agendado. Quando o líder perde a liderança, "it must immediately stop interacting with the datacenter scheduler", para que o líder antigo e o novo nunca ajam ao mesmo tempo.

**Falha parcial.** Um novo líder precisa concluir os disparos em aberto. Isso exige que todas as operações em sistemas externos sejam idempotentes, ou que seu estado possa ser consultado. O Google pré-calcula nomes de job que incluem o horário agendado do disparo e os distribui às réplicas, então o novo líder os consulta e dispara só os que faltam; sem o horário no nome, um failover longo pode causar o disparo duplo de um job curto.

**Estado.** Os logs e snapshots do Paxos ficam nos discos locais das réplicas (três cópias); os snapshots também têm backup no sistema de arquivos distribuído; os logs não, aceitando perder as mudanças desde o último snapshot se as três máquinas morrerem. Uma réplica nova pode buscar o snapshot e os logs de uma que já está rodando.

**Thundering herd.** As pessoas marcam jobs diários para a meia-noite, e 30 equipes disparando cada uma um MapReduce ao mesmo tempo é um pico. O crontab ganhou o `?`, que deixa o sistema escolher o valor por hash da configuração do job dentro do intervalo; a carga continua com picos porque alguns jobs realmente precisam de um horário exato.

## 3. Dropbox's Asynchronous Task Framework (2020) `[CONFIRMED]`

O ATF executa callbacks (que ele chama de lambdas) como tarefas, agendadas para agora ou para depois, com prioridades e bloqueio por tipo. Suas garantias: uma tarefa executa **pelo menos uma vez** depois de agendada, e "at most one instance of a task will be actively executing" por vez; os tipos de tarefa são isolados (clusters de workers, filas e cotas de agendamento dedicados). Suas metas: 95% das tarefas começam em até cinco segundos do horário; 99,9% de disponibilidade para agendamento.

**Componentes.** Um **frontend** aceita RPCs de Schedule e grava no **banco de tarefas** (o Edgestore do Dropbox; qualquer banco com consultas indexadas serve), onde uma associação guarda o próximo horário de disparo. O **Store Consumer** consulta o banco atrás de tarefas vencidas (novas ou em nova tentativa) e as empurra para uma fila SQS por (lambda, prioridade). Em cada host de worker, um **Controller** puxa das filas e atende RPCs de NextWork dos **Executors**; ele reivindica a tarefa pelo **Heartbeat and Status Controller (HSC)**; os executores enviam heartbeats enquanto rodam e reportam o status final (sucesso, falha fatal, falha que admite nova tentativa).

**Como as garantias se sustentam.** Toda mudança de estado também move o próximo horário de disparo, então uma tarefa que trava em qualquer ponto (perdida numa fila, controlador caiu depois de reivindicar, executor parou de enviar heartbeat) é encontrada de novo e volta para a fila. A execução concorrente é evitada por um estado exclusivo Claimed, e por executores que se encerram depois de três heartbeats seguidos com falha, com o timeout de heartbeat maior que isso, para que a tarefa não seja reencontrada enquanto o executor antigo ainda possa estar rodando. As lambdas precisam tolerar execução repetida em hosts diferentes.

**Lições que o post lista.** A latência de entrega é ajustada pelo intervalo de consulta (a cada dois segundos na época). Tarefas presas em loops infinitos de nova tentativa por bugs exigiram intervenção manual; o post propõe um número máximo de tentativas e uma dead letter queue. Tarefas periódicas e encadeamento eram extensões futuras.

## 4. Kubernetes CronJob `[CONFIRMED]`

Um CronJob cria um Job "approximately once per execution time of its schedule"; em algumas circunstâncias, dois Jobs ou nenhum podem ser criados, então os jobs devem ser idempotentes. `concurrencyPolicy` é Allow (padrão), Forbid (pula a nova execução se a anterior ainda está rodando) ou Replace. `startingDeadlineSeconds` pula uma execução que não consegue começar dentro do prazo; sem ele, e com mais de 100 horários perdidos desde a última execução, o controlador registra um erro e não inicia o Job. Fusos horários são definidos com `.spec.timeZone`.

---

## 5. Reference design for a general scheduler `[INDUSTRY PATTERN]`

- **Definições** (job, agenda, dono, política) num banco fortemente consistente; **execuções** (job, horário agendado, estado, tentativa) numa tabela indexada por `next_run_at`.
- **Disparo:** um agendador escolhido por eleição de líder (veja [33 Coordination](33-distributed-coordination-locks.md)) ou um conjunto de agendadores em que cada um é dono de uma faixa de hash de jobs, materializando as execuções vencidas com um id de execução `job + scheduled time` para que duplicatas se fundam.
- **Despacho:** execuções vencidas vão para filas por tenant ou por prioridade ([04 Kafka](04-message-queue-kafka.md) ou SQS); workers reivindicam com um lease e um token de fencing, enviam heartbeat e reportam.
- **Política por job:** comportamento em execução perdida (pular, rodar uma vez, recuperar dentro de um prazo), concorrência (permitir, proibir, substituir), novas tentativas com backoff e limite, e depois uma dead letter queue.
- **Espalhar a carga:** jitter ou horários de início por hash para jobs que não precisam de um minuto exato.
- **Dependências:** um DAG de execuções (um motor de workflow) é uma camada acima; mantenha o disparo em si simples.

---

## 6. Failure scenarios

- **O líder morre no meio de um disparo.** O novo líder consulta, ou repete de forma idempotente, os disparos em aberto identificados pelo horário agendado `[CONFIRMED]` (Google).
- **O líder antigo continua disparando depois de perder a liderança.** Ele precisa parar de falar com o agendador do datacenter na hora; num design genérico, bloqueie-o com um token de fencing `[CONFIRMED]` / `[INDUSTRY PATTERN]`.
- **Um worker trava mas continua rodando.** O executor que se encerra depois de três heartbeats com falha evita uma segunda cópia `[CONFIRMED]` (Dropbox).
- **O agendador fica fora do ar por horas.** Sem um prazo para começar, um controlador de CronJob pode se recusar a recuperar (mais de 100 perdidos); com um prazo, ele começa uma vez `[CONFIRMED]` (Kubernetes).
- **Um bug faz uma tarefa tentar de novo para sempre.** Limite as tentativas e mova a tarefa para uma dead letter queue; o Dropbox propôs isso depois de limpezas manuais `[CONFIRMED]` para o problema, `[INDUSTRY PATTERN]` para a solução.
- **Pico da meia-noite.** Espalhe os horários de início com hash ou jitter `[CONFIRMED]` (o `?` do Google).

---

## 7. Capacity reasoning (illustrative)

- 10 milhões de tarefas avulsas por dia dão cerca de 116 por segundo em média; com um pico de 10×, cerca de 1.200 por segundo, cada uma custando algumas escritas no banco (agendar, reivindicar, heartbeat, resultado).
- Consultar a cada 2 segundos por tarefas vencidas significa um atraso mediano de cerca de 1 segundo só por causa da consulta; reduzir o intervalo pela metade dobra as consultas (nossa conta; o Dropbox aponta o intervalo de consulta como a alavanca da latência).
- Um job periódico a cada minuto são 1.440 execuções por dia; 100.000 jobs assim são 1.667 disparos por segundo, então a tabela de execuções precisa de particionamento por tempo ou por hash do job.

---

## ⚠️ Reviewer notes

1. **O capítulo do Google é de 2016 (publicado antes na ACM Queue, em 2015)** e o post do Dropbox é de 2020; nenhum dos dois descreve o sistema atual.
2. **"Agendamento exactly-once" em artigos populares.** Nenhuma das fontes promete isso. O Google pula na dúvida e registra os disparos; o Dropbox e o Kubernetes prometem at-least-once ou aproximadamente uma vez e exigem jobs idempotentes.
3. **Not read:** a documentação posterior do Borg e do Cloud Scheduler do Google, a documentação do Airflow e do Temporal, o Cadence da Uber, o clustering do Quartz.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Nossa análise, não das fontes. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características determinantes (Ch 4–5):** **confiabilidade**, **recuperabilidade**, **escalabilidade** (filas de tarefas), **isolamento**.
- **Estilo (Ch 13–17):** um **plano de controle replicado** (líder mais consenso) sobre um **pool de workers baseado em filas**.
- **Quanta (Ch 7):** o agendador e o cluster de workers de cada equipe são quanta separados; o Dropbox faz os donos rodarem os próprios workers.
- **Trade-off (First Law, Ch 1):** **execução perdida vs execução dupla.** Nenhum design evita as duas sob falha; escolha por job e torne o job seguro para o outro caso.
- **Esboço de ADR (Ch 19):** *"Vamos identificar cada execução pelo job e pelo horário agendado, registrá-la antes do despacho e exigir handlers idempotentes. Aceitamos execuções repetidas ocasionais em troca de nunca pular uma execução em silêncio."*
- Em linguagem simples: anote cada sinal antes de tocá-lo.

---

## Interview questions to practice

1. Projete um serviço de cron distribuído.
2. Projete uma fila de tarefas adiadas (rode isto em 30 minutos) a 10.000 tarefas por segundo.
3. O que acontece se o líder do agendador morre logo depois de disparar um job?
4. Como impedir que dois workers rodem a mesma tarefa?
5. Mil equipes agendam jobs à meia-noite. O que quebra e como você corrige?
6. O agendador ficou fora do ar por duas horas. O que deve rodar quando ele voltar?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes.

**Um roteiro de 45 minutos**

1. Esclarecer: periódico ou adiado, semântica de disparo, tolerância a atraso, escala, multi-tenancy.
2. Estimar: disparos por segundo, crescimento da tabela de execuções, custo das consultas ([P01](../toolkit/P01-estimation.md)).
3. API: `createJob(schedule, target, policy)`, `schedule(task, runAt)`, `pause`, `listRuns`.
4. Design: banco de definições, tabela de execuções indexada por tempo, líder ou disparadores particionados, filas, workers que reivindicam.
5. Aprofundar: registro de disparo e failover, reivindicações e heartbeats, política de execução perdida.
6. Falhas e escala: perda do líder, workers travados, tempestades de novas tentativas, picos da meia-noite, 10× mais tarefas.

**Se crescer 10×**
- Particionar os disparadores por hash do job; particionar a tabela de execuções por tempo e arquivar execuções antigas.
- Separar filas e workers por tenant ou prioridade, como o Dropbox faz por lambda.
- Espalhar jobs periódicos com deslocamentos de início por hash.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>O líder morre logo depois de disparar um job</summary>

Se o disparo foi registrado como iniciado mas não concluído, o novo líder não tem como saber se ele aconteceu. Torne isso consultável: nomeie o job externo pelo id do job mais o horário agendado e, ao assumir, consulte e dispare só se estiver faltando. Se não der para consultar, a operação precisa ser idempotente, ou a política daquele job decide entre pular e arriscar uma repetição.

</details>

<details><summary>Dois workers rodam a mesma tarefa</summary>

Reivindique com uma mudança de estado condicional (só de Enqueued para Claimed), dê à reivindicação um lease, renove-o por heartbeat e faça o worker parar quando não conseguir renovar, com o timeout do lease maior que o tempo de parada. Ainda assim, suponha que uma repetição pode acontecer e torne o handler idempotente.

</details>

<details><summary>De volta depois de duas horas fora do ar</summary>

Decida por job: jobs de manutenção frequentes pulam as execuções perdidas; relatórios diários rodam uma vez agora; a cobrança roda cada período perdido, em ordem. Garanta isso com um prazo para começar e um limite de recuperação, para que a volta não vire um pico próprio.

</details>

## 📚 Further reading

- As fontes listadas em Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundário).
- Relacionados neste repositório: [33 Coordination and locks](33-distributed-coordination-locks.md), [04 Message queue](04-message-queue-kafka.md), [10 Notification system](10-notification-system.md), [16 Reservations](16-reservation-scheduler.md), [P03 Distributed transactions](../toolkit/P03-distributed-transactions.md).

## Sources and provenance

> **Kind:** sistemas reais (cron do Google, ATF do Dropbox, CronJob do Kubernetes) com um design de referência `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-31:** Štěpán Davidovič (edited by Kavita Guliani), [*Distributed Periodic Scheduling with Cron*](https://sre.google/sre-book/distributed-periodic-scheduling/) (Google, *Site Reliability Engineering*, 2016, chapter 24) · Dropbox, [*How we designed Dropbox ATF: an async task framework*](https://dropbox.tech/infrastructure/asynchronous-task-scheduling-at-dropbox) (11 November 2020) · Kubernetes, [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/) (current docs).
> **Material datado:** o capítulo do cron (2016) e o post do ATF (2020) descrevem esses sistemas naquela época.
> **Not read:** a versão do artigo do cron na ACM Queue, os papers do Borg, motores de workflow (Airflow, Temporal, Cadence), Quartz.
> **Tags:** `[CONFIRMED]` declarado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-10-31, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the cron chapter: single-machine failure domain, job types and the skip-over-double preference, Paxos replicas and the single leader, synchronous launch start and end records, mutual exclusion on losing leadership, open launches and the idempotent-or-lookup rule, job names with scheduled time, local logs and snapshots with snapshot backup, the midnight herd and the `?` extension.
- Verified in the ATF post: guarantees, the 95% within 5 seconds and 99.9% targets, 10,000 and 9,000 tasks per second, 28 teams, the components and RPCs, trigger timestamps, claim state, three-heartbeat self-termination, the 2-second poll, the retry-loop problem and the dead letter queue proposal.
- Verified in the Kubernetes docs: approximately once, idempotent jobs, concurrency policies, starting deadline, the 10-second check, the 100 missed schedules rule and `.spec.timeZone`.
- Not sourced (our reasoning): the general reference design, run ids, fencing for a general scheduler, per-job missed-run policies, and the capacity arithmetic.
- Not claimed: how Google, Dropbox or Kubernetes schedule jobs today beyond the cited documents.
