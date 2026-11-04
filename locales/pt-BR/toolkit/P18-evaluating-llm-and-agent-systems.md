# P18 — Evaluating LLM and agent systems

*Um primer sobre como saber se uma funcionalidade de LLM ou um agent funciona, e se uma mudança o deixou melhor ou pior. Cobre o vocabulário e os tipos de avaliador do guia da Anthropic sobre evals de agents, as métricas de RAG sem referência do paper do Ragas, como a AWS divide a nota de um agent em objetivo e partes por tool, e o que o estudo MAST encontrou sobre verificação em sistemas multi-agent. Afirmações dessas fontes estão marcadas; o pipeline e os conselhos de entrevista são raciocínio nosso e estão sinalizados.*

## At a glance

- Um eval é um teste: "give an AI an input, then apply grading logic to its output to measure success". Para um agent, a entrada é uma tarefa num ambiente e o que se avalia normalmente é o **outcome** (o estado do ambiente no final), não o que o agent diz que fez.
- Há três tipos de avaliador: **código** (rápido, barato, objetivo, frágil), **modelo** (flexível, precisa de calibração com pessoas) e **humano** (a referência, lento e caro). Use código onde puder e modelos onde precisar, e use pessoas para calibrar os dois.
- Mantenha duas suítes: evals de **capacidade**, que começam com taxa de aprovação baixa e dão algo para melhorar, e evals de **regressão**, que devem passar quase 100% das vezes e pegam retrocessos.
- Agents não são determinísticos, então rode várias **trials**. pass@k (pelo menos uma de k dá certo) serve para ferramentas em que um sucesso basta. pass^k (todas as k dão certo) serve para agents voltados a clientes, e cai rápido: 75% por trial dá cerca de 42% em três trials.
- Respostas de retrieval podem ser pontuadas sem respostas de referência (faithfulness, answer relevance e context relevance do Ragas), e a execução de um agent pode ser pontuada como um objetivo inteiro mais uma nota para cada tool que ele usou.
- Muitas vezes o que está quebrado é o próprio eval. Leia transcripts antes de confiar numa nota.

---

## 1. Vocabulary `[CONFIRMED]` (Anthropic, *Demystifying evals for AI agents*, January 2026)

- **Task:** um teste com entradas e critérios de sucesso definidos. **Trial:** uma tentativa numa task; rodam-se várias trials "because model outputs vary between runs".
- **Grader:** lógica que pontua um aspecto do desempenho; uma task pode ter vários graders, cada um com várias asserções.
- **Transcript** (trace, trajetória): o registro completo de uma trial, incluindo saídas, chamadas de tools, raciocínio e resultados intermediários.
- **Outcome:** o estado final do ambiente. Um agent de reserva de voos pode dizer que o voo está reservado, mas "the outcome is whether a reservation exists in the environment's SQL database".
- **Evaluation harness:** roda tasks, muitas vezes em paralelo, registra cada passo, avalia e agrega. **Agent harness** (scaffold): o sistema que permite ao modelo agir como agent. Avaliar "um agent" é avaliar o harness e o modelo juntos.

O post acrescenta que evals de agents são mais difíceis que os de um turno só porque os erros "can propagate and compound" ao longo de muitos turnos, e porque um modelo forte pode achar uma solução válida que o eval não previu. Um exemplo: numa task de reserva de voos do τ2-bench, o Opus 4.5 achou uma brecha na política. Ele foi reprovado na task como escrita, mas chegou a um resultado melhor para o usuário.

## 2. Graders, and how to combine them `[CONFIRMED]` (Anthropic, January 2026)

| Grader | Exemplos do post | Ponto forte | Ponto fraco |
|---|---|---|---|
| Código | comparação de strings, testes unitários (fail-to-pass, pass-to-pass), análise estática, checagem das chamadas de tools e seus parâmetros, checagens do transcript (turnos, tokens) | rápido, barato, reproduzível | frágil diante de variações válidas; fraco em tarefas subjetivas |
| Modelo | rubricas, asserções em linguagem natural, comparação aos pares, avaliação com referência, vários juízes chegando a consenso | flexível, lida com saídas abertas | não determinístico, custa mais, "requires calibration with human graders for accuracy" |
| Humano | especialistas no assunto, crowdsourcing, checagens por amostragem, testes A/B | a referência de qualidade; usado para calibrar graders de modelo | caro e lento |

O conselho do post para escolher graders: "We recommend choosing deterministic graders where possible, LLM graders where necessary or for additional flexibility, and using human graders judiciously for additional validation." A nota de uma task pode ser ponderada, binária (todos os graders precisam aprovar) ou uma mistura das duas.

- **Avalie o que foi produzido, não o caminho.** Exigir uma sequência exata de chamadas de tools é rígido demais, porque agents acham abordagens válidas que quem desenhou o eval não esperava.
- **Dê crédito parcial** quando uma task tem várias partes. Um agent de suporte que achou o problema e verificou o cliente mas não processou o reembolso foi melhor que um que falhou logo de cara.
- **Para graders de modelo:** use uma rubrica estruturada, dê ao juiz uma saída (responder `Unknown` quando lhe falta informação) e "grade each dimension with an isolated LLM-as-judge rather than using one to grade all dimensions". Os vieses conhecidos de juízes (posição, tamanho, preferência pelas próprias saídas) estão em [28 LLM fine-tuning and evaluation](../systems/28-llm-finetuning-evaluation.md).
- **Por tipo de agent:** coding agents são avaliados principalmente por testes (o SWE-bench Verified só aprova se os testes que falhavam forem corrigidos sem quebrar outros). Agents de conversa checam o estado final, limites do transcript e uma rubrica, muitas vezes com um segundo LLM simulando o usuário (τ-Bench, τ2-Bench). Agents de pesquisa checam groundedness, cobertura e qualidade das fontes, com rubricas calibradas contra especialistas. Agents de computer use checam o estado real, como se um pedido foi de fato feito, e não só se apareceu uma página de confirmação.

## 3. Capability and regression suites; pass@k and pass^k `[CONFIRMED]` (Anthropic, January 2026)

- **Evals de capacidade** perguntam o que o agent faz bem. Eles "should start at a low pass rate", mirando tasks em que o agent tem dificuldade.
- **Evals de regressão** perguntam se ele ainda dá conta do que dava, e "should have a nearly 100% pass rate". Uma queda sinaliza que algo quebrou. Tasks de capacidade que chegam a uma taxa de aprovação alta podem passar para a suíte de regressão.
- **Trials e métricas.** pass@k é a chance de pelo menos uma de k trials dar certo; sobe com k. pass^k é a chance de todas as k darem certo; cai com k (uma taxa de 75% por trial dá (0,75)³ ≈ 42% para três trials). Com k = 1 as duas são iguais. Com k = 10, pass@k fica perto de 100% e pass^k perto de 0%.
- **Quantas tasks.** "20-50 simple tasks drawn from real failures is a great start". As primeiras mudanças têm efeitos grandes, então amostras pequenas bastam; agents maduros precisam de suítes maiores e mais difíceis. De onde tirar tasks: as checagens que você já faz à mão, o bug tracker e a fila de suporte.
- **Equilíbrio.** Teste tanto onde um comportamento deve acontecer quanto onde não deve. Os evals de busca na web da Anthropic precisaram cobrir consultas que exigem busca e consultas que o modelo deve responder com o que já sabe, senão o modelo aprendia a buscar tudo.
- **Isolamento.** Comece cada trial num ambiente limpo. Arquivos que sobraram, caches ou recursos esgotados tornam as falhas correlacionadas. Num eval interno, o Claude ganhou uma vantagem injusta lendo o histórico do git de trials anteriores.

## 4. Grading retrieval without reference answers: Ragas `[CONFIRMED]` (Es et al., arXiv, September 2023)

Quando ainda não há respostas rotuladas, o Ragas pontua uma resposta de RAG só com a pergunta, o contexto recuperado e a resposta, por meio de prompts a um LLM:
- **Faithfulness:** afirmações sustentadas ÷ todas as afirmações da resposta. Uma resposta é fiel "if the claims that are made in the answer can be inferred from the context".
- **Answer relevance:** o quanto a pergunta original se parece com perguntas geradas a partir da resposta.
- **Context relevance:** a fração das frases do contexto necessárias para responder.

No conjunto WikiEval dos autores (50 páginas da Wikipedia, dois anotadores), essas métricas coincidiram com a escolha humana em 95%, 78% e 70% das comparações aos pares, contra 72%, 52% e 63% quando se pediu ao ChatGPT uma nota direta. O teste de faithfulness opunha cada resposta a uma gerada sem nenhum contexto, um contraste fácil. O avaliador foi o gpt-3.5-turbo-16k. Detalhes e ressalvas estão em [23 RAG knowledge assistant, seção 4b](../systems/23-rag-knowledge-assistant.md).

## 5. Grading an agent's run: goal plus per-tool scores `[CONFIRMED]` (AWS Machine Learning Blog, April 2025)

O framework open source da AWS para avaliar Amazon Bedrock Agents mostra um jeito de estruturar a nota de uma execução. Um job de avaliação chama o agent com um dataset de perguntas e ground truth, faz o parsing dos traces de invocação, pontua e envia notas e traces para o Langfuse.
- **Objetivo do agent, em toda pergunta:** um juiz de modelo compara o raciocínio do agent com suas instruções. Pontua helpfulness, faithfulness e instruction following, sem resposta de referência.
- **Acurácia da task, só quando uma tool foi usada:** "The task accuracy metrics are only evaluated when the corresponding tool is used to answer the question." Para retrieval usa métricas do Ragas (faithfulness, answer relevancy, context recall, similaridade semântica com o ground truth). Para text-to-SQL checa se a query é equivalente à query de referência e se a resposta bate.
- **Multi-agent:** no exemplo de pesquisa farmacêutica do post, um agent supervisor dirige quatro especialistas. O retrieval é pontuado no sub-agent de evidências clínicas, o SQL no sub-agent do banco de dados e o objetivo na resposta final do supervisor.
- **Datasets como trajetórias:** as perguntas são agrupadas por tema, não por sub-agent, "to simulate how a user might interact with the agent", então uma trajetória exercita várias tools. A execução de exemplo teve 56 perguntas em 21 trajetórias.
- Cada trace registra os passos, os tokens de entrada e saída, o custo, o modelo e o tipo de agent ao lado das notas, então uma nota ruim pode ser rastreada até o passo que a causou.

O post mostra as notas médias só numa captura de tela e não declara limitações do método.

**Verificação dentro de sistemas multi-agent** `[CONFIRMED]` (Cemri et al., NeurIPS 2025). Nos 1.642 traces do MAST (a maioria rotulada por um anotador LLM), falhas de verificação da tarefa (término prematuro, checagens ausentes ou incompletas, checagens incorretas) foram 23,5% das falhas. A conclusão deles é que "sole reliance on final-stage, low-level checks is inadequate". Num framework (ChatDev, um conjunto de 32 tarefas), uma nova topologia com uma checagem do objetivo de alto nível da tarefa elevou o sucesso nas tarefas de 25,0% para 40,6%, o que os autores ainda não consideram uma melhoria substancial. Um LLM juiz (o1 com exemplos few-shot) rotulou os modos de falha com κ = 0,77 em relação a anotadores especialistas. Veja [25 AI agent platform, seção 4d](../systems/25-ai-agent-platform.md).

## 6. When the eval is the problem `[CONFIRMED]` (Anthropic, January 2026)

- **Tasks ambíguas.** "A good task is one where two domain experts would independently reach the same pass/fail verdict." Por exemplo, uma task do Terminal-Bench pedia um script sem dizer o caminho, enquanto os testes assumiam um.
- **0% é um sinal de alerta.** Com modelos de fronteira, 0% em muitas trials (0% pass@100) "is most often a signal of a broken task, not an incapable agent". Escreva uma solução de referência para cada task para provar que ela tem solução.
- **Bugs de avaliação.** O Opus 4.5 primeiro tirou 42% no CORE-Bench. Depois de correções na avaliação rígida (ela penalizava "96.12" frente a um esperado 96.124991…), nas especificações ambíguas e nas tasks que não podiam ser reproduzidas, e com um scaffold menos restrito, tirou 95%.
- **Trapaça.** Os graders devem resistir a atalhos, para que passar exija resolver o problema.
- **Saturação.** Em 100% um eval acompanha regressões mas não dá sinal de melhoria. Perto da saturação, grandes ganhos de capacidade aparecem como pequenas mudanças na nota.
- **Leia os transcripts.** O transcript de uma task reprovada mostra se o agent errou ou se o grader rejeitou uma solução válida. A Anthropic diz que não aceita notas pelo valor de face até alguém ler transcripts.
- **Evals automatizados são uma camada.** O post lista monitoramento em produção, testes A/B, feedback de usuários, revisão manual de transcripts e estudos humanos sistemáticos, e os compara ao modelo do queijo suíço: cada camada deixa passar algo que outra pega.

## 7. Evaluation in a system design `[INDUSTRY PATTERN]` (our reasoning)

```
mudança (prompt, modelo, tool, retrieval) ─► suíte offline no CI
        gate de regressão (≈100%) + nota de capacidade + custo e latência por task
                    │ aprovado
                    ▼
     canary ou A/B ─► traces de produção ─► amostrados para avaliação por modelo e por humanos
                    ▲                                 │
                    └── falha nova vira uma task ◄────┘
```

- **Guarde cada trace** (entradas, contexto recuperado, chamadas de tools, saídas, tokens, custo, latência) com um id de execução, e guarde a versão de cada prompt, modelo e tool. Sem isso, uma nota não pode ser explicada nem reproduzida.
- **Condicione releases à suíte de regressão** e reporte a nota de capacidade, o custo por task e a latência ao lado. Uma mudança que melhora a qualidade mas dobra o custo é uma decisão, não um ganho de graça.
- **Amostre o tráfego de produção** para avaliação por modelo e mande uma amostra menor para pessoas. Acompanhe com que frequência as notas do modelo e das pessoas concordam, e recalibre o juiz quando essa taxa mudar.
- **Feche o ciclo:** cada falha de produção vira uma task, depois de remover dados pessoais. Veja [P17 Privacy by design](P17-privacy-by-design.md).
- **Reserve orçamento para avaliação.** Chamadas de juiz custam dinheiro: tamanho da suíte × trials × graders × custo por chamada. Use graders de código primeiro, juízes mais baratos para triagem e várias trials só onde a consistência importa.
- **Pontue as partes e o todo.** Recall do retrieval, acurácia por tool e o objetivo final dizem onde uma falha aconteceu, não só que ela aconteceu.

## 8. Using this in a design discussion `[INDUSTRY PATTERN]`

1. Defina sucesso como um outcome que você consegue checar (estado, testes, uma referência), não como o relato do próprio modelo.
2. Nomeie os graders: código primeiro, juízes de modelo com rubricas onde a saída é aberta, pessoas para calibrar.
3. Separe um gate de regressão de uma nota de capacidade, e diga quantas trials você roda e se precisa de pass@k ou pass^k.
4. Pontue os componentes (retrieval, cada tool) e o objetivo de ponta a ponta.
5. Diga onde a avaliação roda: CI, canary, traces de produção amostrados, e como falhas viram tasks novas.
6. Ponha um número no custo da avaliação e diga como o mantém limitado.

---

## Questions to practise

1. Seu agent de suporte passa em 90% das tasks numa trial. O produto promete respostas consistentes aos clientes. Que métrica você reporta, e como ela fica em três trials?
2. Projete a avaliação de um assistente de RAG que ainda não tem respostas rotuladas. O que você pontua no primeiro dia, e o que acrescenta depois?
3. Um modelo novo tira 0% numa task em que o antigo tirava 60%. O que você checa primeiro?
4. Um agent com um supervisor e três sub-agents especialistas dá uma resposta final errada. Como sua avaliação diria qual parte falhou?
5. Seu LLM juiz e seus avaliadores humanos começam a discordar com mais frequência. O que pode ter mudado, e o que você faz?
6. Como evitar que uma suíte de evals sature?

**Relacionados:** [23 RAG knowledge assistant](../systems/23-rag-knowledge-assistant.md), [25 AI agent platform](../systems/25-ai-agent-platform.md), [28 LLM fine-tuning, evaluation and deployment](../systems/28-llm-finetuning-evaluation.md), [41 Moderation and fraud ML](../systems/41-moderation-fraud-ml.md), [P07 SLOs and incidents](P07-slos-and-incidents.md), [P10 Changing systems safely](P10-changing-systems-safely.md).

**Leitura complementar:** Fahim Ul Haq, [*Generative AI System Design Interview*](https://www.systemdesignhandbook.com/guides/generative-ai-system-design-interview/) (System Design Handbook, sem data, acessado em 2026-11-03; secundária). Um passo a passo de entrevista para um sistema baseado em LLM (esclarecimento, orçamento de tokens, arquitetura, RAG, custo, segurança). Não cita fontes primárias, e seus números de preço e throughput não têm fonte, então use-o pela estrutura, não pelos fatos.

## Sources and provenance

> **Sources read on 2026-11-03:** Grace, Hadfield, Olivares and De Jonghe, Anthropic, [*Demystifying evals for AI agents*](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (9 de janeiro de 2026) · Es, James, Espinosa-Anke and Schockaert, [*Ragas: Automated Evaluation of Retrieval Augmented Generation*](https://arxiv.org/pdf/2309.15217) (arXiv 2309.15217, setembro de 2023; texto do PDF extraído localmente) · Chandra, Poonawala and Shin, AWS Machine Learning Blog, [*Evaluate Amazon Bedrock Agents with Ragas and LLM-as-a-judge*](https://aws.amazon.com/blogs/machine-learning/evaluate-amazon-bedrock-agents-with-ragas-and-llm-as-a-judge/) (28 de abril de 2025) · Cemri et al., [*Why Do Multi-Agent LLM Systems Fail?*](https://arxiv.org/pdf/2503.13657) (arXiv 2503.13657 v3, NeurIPS 2025 Datasets and Benchmarks; texto do PDF extraído localmente).
> **Material datado:** a prática de avaliação de IA muda rápido. O post da Anthropic reflete seus próprios modelos e clientes em janeiro de 2026; os resultados do Ragas usaram o gpt-3.5-turbo-16k como avaliador; o framework da AWS mira os Amazon Bedrock Agents de abril de 2025.
> **Not read:** a documentação da biblioteca Ragas, o código e o README do framework da AWS, os benchmarks citados no post da Anthropic (SWE-bench Verified, Terminal-Bench, τ-Bench e τ2-Bench, BrowseComp, WebArena, OSWorld, CORE-Bench) e os frameworks de eval do seu apêndice (Harbor, Braintrust, LangSmith, Langfuse, Arize).
> **Tags:** `[CONFIRMED]` declarado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo. Tudo que não está marcado como `[CONFIRMED]` é raciocínio nosso.

---
## ✅ Verification log

*Fact-check, 2026-11-03, by reading each source in full (the AWS post's score table is an image and was not read). Quotations are confirmed by `npm run verify`.*
- Verified in Anthropic's post: the eval definition, task, trial, grader, transcript, outcome and harness definitions, the flight-booking outcome example, the τ2-bench loophole, the grader table (methods, strengths, weaknesses), the grader-choice sentence, weighted and binary scoring, grading outputs not paths, partial credit, the way out for the judge and one judge per dimension, the per-agent-type advice, capability and regression definitions and graduation, pass@k and pass^k with the 42% example and the k = 10 divergence, 20 to 50 tasks, balanced sets and the web-search example, trial isolation and the git-history example, the two-experts test, the Terminal-Bench path example, 0% pass@100, reference solutions, CORE-Bench 42% to 95%, grader hacking, saturation, reading transcripts, the other evaluation methods and the Swiss cheese comparison.
- Verified in the Ragas paper: the three metrics and their computation, WikiEval (50 pages, two annotators), Table 1 agreement figures, gpt-3.5-turbo-16k as grader.
- Verified in the AWS post: the evaluation job workflow, the goal and task-accuracy split, the conditional task metrics, the metric names, the Langfuse trace contents, the multi-agent mapping, trajectories grouped by topic, 56 questions in 21 trajectories, scores shown only in a screenshot.
- Verified in the MAST paper: 1,642 traces, task verification at 23.5% and its modes, the final-stage checks sentence, the ChatDev intervention results (25.0% to 40.6%, 32 tasks) and the authors' caveat, κ = 0.77 for the o1 few-shot judge.
- Not verified: the AWS post's average scores (an image only) and any behaviour of the Ragas library or the AWS framework beyond what the posts describe.
- Not sourced (our reasoning): the evaluation pipeline diagram, trace storage, release gates, production sampling and judge recalibration, the evaluation cost formula and the design-discussion checklist.
