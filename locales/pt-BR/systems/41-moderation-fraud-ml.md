# 41 — Content Moderation and Fraud Detection with ML

*Partes de sistemas reais a partir do paper do Immune System do Facebook (2011), do post da Stripe sobre como o Radar é construído (2023) e da sua documentação de regras, e do post da Meta AI sobre o Few-Shot Learner, além de um design de referência para uma plataforma de integridade. Como foi obtido e o que não foi verificado está em **Sources and provenance** perto do final.*

## At a glance

**Em 60 segundos.** Moderação e detecção de fraude dão uma nota a ações (um post, uma mensagem, um pagamento, um cadastro) e decidem: permitir, bloquear, desafiar, mandar para uma pessoa ou rebaixar. Diferente da maior parte do ML, o outro lado se adapta: os atacantes mudam aquilo em que o modelo se apoia. Por isso o design privilegia a **velocidade de resposta** em vez de um modelo perfeito: atributos, regras e modelos precisam ser atualizados online sem reiniciar; uma **camada de políticas** transforma notas em ações e reserva tráfego para medir; a **revisão humana** cuida do meio incerto e produz rótulos; e **ciclos de feedback** (denúncias de usuários, chargebacks, recursos) alimentam o próximo modelo. As verificações síncronas ficam no caminho da requisição com um orçamento de latência apertado; análises mais pesadas rodam de forma assíncrona e agem depois.

**Números-chave** (conforme publicado, com datas)
- Immune System do Facebook (2011): 25 bilhões de verificações por dia, 650.000 por segundo no pico; classificação síncrona mantida abaixo de 50 ms; cerca de 20% das ações são escritas `[CONFIRMED]`.
- Stripe Radar (post de março de 2023): mais de 1.000 características por transação, uma decisão em menos de 100 ms, 0,1% dos pagamentos legítimos bloqueados; a fraude é cerca de 1 a cada 1.000 pagamentos; o tempo de treino caiu mais de 85% (para menos de duas horas) depois da mudança para um modelo só de DNN `[CONFIRMED]`.
- Few-Shot Learner da Meta (post sem data, período de 2021): adapta-se a novos tipos de conteúdo nocivo em semanas em vez de meses, em mais de 100 idiomas `[CONFIRMED]`.
- Os números de custo aqui são ilustrativos.

**Decisões e trade-offs**

| Opção | Ponto forte | Ponto fraco |
|---|---|---|
| Regras escritas à mão | Imediatas, explicáveis, nas mãos dos analistas | Frágeis; os atacantes as aprendem; proliferação de regras |
| Classificadores supervisionados | Generalizam entre variantes | Precisam de rótulos; atrasam diante de ataques novos |
| Modelos few-shot ou gerais | Novas políticas em semanas, poucos dados rotulados | Caros de servir; mais difíceis de explicar |
| Verificação síncrona na requisição | Impede o dano antes que aconteça | O orçamento de latência limita o tamanho do modelo |
| Revisão assíncrona depois do fato | Modelos mais pesados, mais contexto | O dano pode já ter se espalhado |
| Bloquear | Interrompe a ação | Falsos positivos prejudicam usuários reais |
| Desafiar (3DS, CAPTCHA, nova autenticação) ou revisão humana | Deixa passar o usuário legítimo | Atrito e custo de revisores |

**Erros comuns**
- Otimizar a precisão de um único modelo em vez do tempo de resposta a todos os ataques.
- Escolher atributos baratos para o atacante mudar (padrões de texto) em vez dos caros (infraestrutura, histórico da conta).
- Não ter holdout, e assim ninguém sabe se uma regra ou modelo ainda ajuda.
- Tratar recursos e chargebacks como chamados de suporte em vez de rótulos.

---

## 🧒 Non-technical explanation

Uma loja tem uma segurança na porta. A maioria dos clientes entra direto. A segurança tem uma lista curta de regras (nada de máscara depois que escurece) e um bom faro para problemas, aprendido com muitos casos passados. Se alguém parece estranho, ela pode pedir um documento em vez de barrar a pessoa, ou chamar o gerente. Toda noite a equipe conta a ela quem roubou e quem foi barrado sem motivo, e ela se ajusta. Os ladrões trocam de casaco, então ela observa o que é difícil de mudar: como chegaram, com quem vieram.

---

## TL;DR for engineers

- **Immune System do Facebook (2011):** verificações em tempo real em toda leitura e escrita; serviços de classificação que nunca são reiniciados; uma linguagem de atributos (FXL) cujos atributos e regras carregam online; um motor de políticas que liga classificações a respostas e mantém holdouts; ciclos de atributos que agregam dados de classificação e o feedback dos usuários `[CONFIRMED]`.
- **Stripe Radar (2023):** um modelo para toda a rede dá nota a cada pagamento em menos de 100 ms; a arquitetura passou de regressão logística para um ensemble de XGBoost com DNN e depois para um modelo só de DNN; engenharia de atributos a partir de investigações de ataques passados; os risk insights explicam as decisões; os usuários acrescentam regras de permitir, bloquear, revisar e 3DS por cima `[CONFIRMED]`.
- **Few-Shot Learner da Meta:** um modelo grande, multimodal e multilíngue que recebe o texto da política e poucos exemplos, medido por testes A/B sobre a prevalência `[CONFIRMED]`.
- **Filas de revisão, pipelines de rótulos, modo sombra, níveis de custo:** design de referência `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcionais:** dar nota a ações em tempo real · agir (permitir, bloquear, desafiar, revisar, rebaixar, desativar a conta) · permitir que analistas escrevam regras · mandar os casos incertos para pessoas · coletar feedback e rótulos · explicar decisões e aceitar recursos.

**Não funcionais:** **latência** no caminho da requisição (dezenas de milissegundos) · **vazão** (toda ação) · **agilidade** (responder a um ataque novo em horas) · **precisão com os bons usuários** (falsos positivos custam caro) · **auditabilidade** · **custo** (modelos e revisores).

**Perguntas de esclarecimento:** qual superfície (pagamentos, posts, cadastros)? É síncrono? Quais ações são permitidas? Qual taxa de falsos positivos é aceitável? Há obrigações legais de reporte? Idiomas e tipos de mídia?

---

## 2. Facebook's Immune System (2011) `[CONFIRMED]`

O paper trata a proteção como **aprendizado adversarial**: "the attacker creating the pattern does not want the pattern to be learned". Os ataques passam por fases (ataque, detecção, defesa, mutação), e o sistema busca encurtar as fases que o atacante controla. Ele tem duas vantagens: o feedback dos usuários (explícito, como marcar como spam; implícito, como apagar um post ou recusar um pedido de amizade) e o conhecimento global do que é normal.

A precisão não é o objetivo principal: "response and detection latencies can be more important than precision and recall". O exemplo do paper: uma taxa de falsos positivos de 2% hoje num ataque que atinge 1.000 usuários é melhor que uma de 1% amanhã no mesmo ataque atingindo 100.000. "Done is often better than perfect." Os atributos devem ser os caros para o atacante mudar, como sinais ligados ao IP em vez de padrões de texto.

Componentes: **serviços de classificação** atrás de uma única interface (random forests, SVMs, regressão logística, boosting), "designed never to be restarted"; a **FXL**, uma linguagem funcional estaticamente tipada para atributos e regras, carregada online; **carregamento dinâmico de modelos**; um **motor de políticas** em que as políticas são expressões booleanas em FXL sobre classificações que disparam respostas (bloquear uma ação, exigir um desafio de autenticação, desativar uma conta) e que também definem holdouts para avaliar os classificadores; e **ciclos de atributos** que agregam de volta, como atributos, os dados de classificação, o feedback dos usuários, resultados de crawlers e consultas ao data warehouse. Escala no começo de 2011: 25 bilhões de ações de leitura e escrita por dia, classificação síncrona abaixo de 50 ms.

## 3. Stripe Radar (2023) `[CONFIRMED]`

O Radar dá nota a cada pagamento em menos de 100 ms usando mais de 1.000 características, bloqueia os arriscados ou os manda para verificações extras, e bloqueia 0,1% dos pagamentos legítimos. A fraude é rara, cerca de 1 a cada 1.000 pagamentos, e o grande trunfo é a amplitude da rede da Stripe. O modelo passou de regressão logística para um ensemble "Wide & Deep" de XGBoost com uma DNN, e em meados de 2022 para uma arquitetura só de DNN com vários ramos, inspirada no ResNeXt; simplesmente tirar o XGBoost teria custado 1,5% de recall, então a nova DNN precisou recuperar a capacidade de memorização dele. O tempo de treino caiu mais de 85%, para menos de duas horas, e um aumento de 10× nos dados de treino ainda melhorou o modelo.

Os atributos vêm de investigar ataques passados em detalhe e de buscar sinais correlacionados na rede; alguns atributos promissores acrescentam pouco porque o modelo já captura o padrão. Como uma DNN é difícil de explicar, a Stripe construiu os **risk insights**, que mostram quais atributos levaram a uma recusa. A fraude migrou de cartões roubados para o **card testing** em alta velocidade.

**Regras por cima.** Os usuários escrevem regras na forma `{action} if {attribute} {operator} {value}`; as regras padrão mandam para revisão os pagamentos de risco elevado, e a regra de bloqueio do risco mais alto (ativada por padrão, agora marcada como obsoleta) está dando lugar a controles de risco que bloqueiam os pagamentos de maior risco com limites dinâmicos. As regras de solicitar 3DS são avaliadas antes das regras de revisão, bloqueio e permissão; as regras de permissão sobrepõem os padrões da Stripe e devem ser usadas com moderação; e a documentação avisa que uma regra mal configurada pode permitir muitos pagamentos arriscados ou bloquear muitos legítimos.

## 4. Adapting to new harms: Few-Shot Learner (Meta AI) `[CONFIRMED]`

Treinar um classificador para um novo tipo de conteúdo nocivo "typically takes several months to collect and label thousands, if not millions, of examples". O Few-Shot Learner da Meta parte de um modelo geral grande treinado em bilhões de exemplos de linguagem, depois em conteúdo rotulado que viola as políticas ou fica no limite, depois em texto que descreve uma política nova, e funciona com zero exemplos, menos de 50 exemplos, ou um ajuste fino leve. As entradas combinam o post inteiro (texto, imagem, URL), o texto da política e os exemplos que houver. Ele foi avaliado com testes offline e testes A/B online sobre a **prevalência** (a parcela de visualizações de conteúdo violador) no Facebook e no Instagram. O post é explícito sobre os limites: a IA ainda não consegue ler dezenas de páginas de política e aplicá-las.

---

## 5. Reference design for an integrity platform `[INDUSTRY PATTERN]`

- **Caminho síncrono:** o produto chama um serviço de risco com a ação; ele busca atributos pré-calculados (idade da conta, contadores de velocidade, reputação do dispositivo e da rede), roda regras rápidas e um modelo pequeno e devolve uma decisão dentro do orçamento. No timeout, falhar aberto ou fechado conforme a superfície (pagamentos podem desafiar; posts podem ser permitidos e verificados de novo).
- **Caminho assíncrono:** toda ação vai para um stream; modelos mais pesados (multimodais, de grafo, few-shot) e clustering rodam ali e agem depois (remover, rebaixar, desativar contas ligadas).
- **Camada de políticas:** regras versionadas sobre as notas, com holdouts por regra e um **modo sombra** que registra o que uma regra ou modelo novo faria antes de agir.
- **Revisão humana:** filas ordenadas por gravidade e alcance, ferramentas para revisores com contexto, decisões registradas como rótulos; recursos reabrem casos e também viram rótulos.
- **Feedback e rótulos:** denúncias, chargebacks, recursos e decisões de revisores alimentam os conjuntos de treino; atenção ao atraso dos rótulos (chargebacks chegam semanas depois).
- **Avaliação:** precisão e recall offline no limite de operação, prevalência ou perda por fraude online, taxa de falsos positivos em bons usuários e tempo entre um ataque novo e a resposta.
- **Limites de segurança:** humanos no ciclo para ações graves ou irreversíveis, um caminho de recurso, logs de auditoria, rate limiting em ações automáticas sobre contas e cuidado com atributos sensíveis.
- **Controle de custo:** uma cascata em níveis (regras, depois um modelo pequeno, depois um modelo grande ou uma pessoa só para a faixa incerta), atributos em cache e capacidade de revisão planejada em função do tamanho da fila.

---

## 6. Failure scenarios

- **Um ataque novo que o modelo nunca viu.** Analistas publicam uma regra online em horas, como a FXL do Immune System permite, enquanto um modelo é retreinado `[CONFIRMED]` para regras online / `[INDUSTRY PATTERN]` para o fluxo de trabalho.
- **Uma regra bloqueia bons usuários em massa.** A Stripe avisa que regras podem bloquear muitos pagamentos legítimos; publique regras em modo sombra com holdout, alerte em saltos na taxa de bloqueio e faça rollback `[CONFIRMED]` para o risco / `[INDUSTRY PATTERN]` para os controles.
- **Serviço de risco lento ou fora do ar.** Fallback por superfície: permitir com nova verificação assíncrona, ou desafiar `[INDUSTRY PATTERN]`.
- **O atraso dos rótulos esconde uma deriva.** Chargebacks chegam tarde; acompanhe sinais antecipados (disputas abertas, denúncias) e métricas de janelas recentes `[INDUSTRY PATTERN]`.
- **A fila de revisão acumula durante um incidente.** Priorize por gravidade e alcance, eleve temporariamente os limites automáticos e registre a mudança `[INDUSTRY PATTERN]`.
- **Atacantes sondam o limite.** O card testing são muitas tentativas pequenas; atributos de velocidade e limites por conta o pegam `[CONFIRMED]` para a tendência / `[INDUSTRY PATTERN]` para a resposta.

---

## 7. Capacity and cost reasoning (illustrative)

- Com 650.000 verificações por segundo e um orçamento de 50 ms, cada verificação só cabe em bem menos de um milissegundo de CPU de modelo por núcleo numa frota grande se os atributos forem pré-calculados; a parte cara é buscar os atributos, não o modelo (nosso raciocínio).
- Se 1 em cada 1.000 ações é ruim e um modelo marca 1% do tráfego para revisão, os revisores veem dez vezes mais casos bons que ruins; a precisão no limite de revisão define o custo dos revisores.
- Uma cascata em que um modelo grande vê só os 2% de itens sobre os quais o modelo pequeno tem dúvida corta o custo do modelo grande em cerca de 50 vezes em relação a dar nota a tudo.

---

## ⚠️ Reviewer notes

1. **As datas importam aqui.** O paper do Immune System é de 2011, o post da Stripe de março de 2023, e o post do Few-Shot Learner não tem data na página (seus exemplos tratam de conteúdo sobre a vacina da COVID-19). Nenhum deles descreve os sistemas como são hoje.
2. **Os 0,1% e os 100 ms da Stripe são números da própria Stripe** num post sobre o produto; o post não diz como os 0,1% foram medidos.
3. **A Meta relata reduções de prevalência sem números** no post; os 55% e 12% que ela dá são sobre benchmarks de few-shot learning, não sobre produção.
4. **Artigos populares costumam apresentar a moderação como um único classificador.** Todas as fontes aqui descrevem um sistema de regras, modelos, pessoas e feedback.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Nossa análise, não das fontes. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características determinantes (Ch 4–5):** **agilidade** (tempo de resposta), **desempenho** (latência no caminho da requisição), **precisão**, **auditabilidade**, **custo**.
- **Estilo (Ch 13–17):** um serviço de risco síncrono parecido com **microkernel**, com regras e modelos como plug-ins, mais um caminho assíncrono **orientado a eventos**.
- **Quanta (Ch 7):** o avaliador no caminho da requisição, a análise em stream e as ferramentas de revisão são quanta separados.
- **Trade-off (First Law, Ch 1):** **falsos positivos vs falsos negativos, e velocidade vs certeza.** As fontes preferem responder rápido com um modelo imperfeito a esperar por um melhor.
- **Esboço de ADR (Ch 19):** *"Vamos dar nota a toda ação de forma síncrona com regras e um modelo pequeno em menos de 50 ms, rodar os modelos pesados de forma assíncrona e lançar toda regra nova em modo sombra com 1% de holdout. Aceitamos a remoção depois do fato para alguns danos em troca de um caminho de requisição rápido."*
- Em linguagem simples: observe o que é difícil para o ladrão mudar.

---

## Interview questions to practice

1. Projete um sistema de detecção de fraude para pagamentos.
2. Projete a moderação de conteúdo de uma rede social com bilhões de posts.
3. Um golpe novo aparece hoje. Com que rapidez seu sistema responde, e como?
4. Como medir se a moderação está funcionando?
5. Como manter baixos os falsos positivos em bons usuários?
6. Onde entram as pessoas, e como controlar o custo delas?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes.

**Um roteiro de 45 minutos**

1. Esclarecer: superfície, síncrono ou não, ações, falsos positivos aceitáveis, obrigações legais.
2. Estimar: ações por segundo, orçamento de latência, volume de revisão num limite ([P01](../toolkit/P01-estimation.md)).
3. API: `assess(action, context) → {decision, score, reasons}`, `report(item)`, `appeal(decision)`.
4. Design: feature store e contadores, regras e modelos, camada de políticas, análise assíncrona em stream, filas de revisão, pipeline de rótulos.
5. Aprofundar: adaptação adversarial, atributos caros de mudar, holdouts e modo sombra, explicações.
6. Falhas e escala: ataque novo, regra ruim, queda do serviço, atraso dos rótulos, tráfego 10×.

**Se crescer 10×**
- Empurrar mais decisões para os níveis baratos; reservar os modelos grandes para a faixa incerta.
- Dividir os contadores de atributos por entidade; pré-calcular agregados.
- Escalar a revisão com melhor roteamento e ferramentas, não só com mais gente.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Um golpe novo hoje</summary>

Os analistas encontram um atributo que distingue o golpe, de preferência difícil de mudar (infraestrutura, vínculos entre contas, padrões de pagamento), e publicam uma regra online em modo sombra, depois a aplicam após conferir a taxa de acerto em bons usuários. Em paralelo, rotulam exemplos (ou usam um modelo few-shot) e retreinam. Meça o tempo entre a primeira denúncia e a aplicação.

</details>

<details><summary>A moderação está funcionando?</summary>

Prevalência (parcela de visualizações que violam as regras), estimada por amostragem e rótulos humanos, não só a contagem de remoções; precisão das ações automáticas a partir do resultado dos recursos; tempo até a ação; e taxa de falsos positivos em bons usuários. Para fraude: perdas, taxa de disputas e a parcela de bons pagamentos bloqueados.

</details>

<details><summary>Onde entram as pessoas</summary>

Na faixa incerta e nas ações graves ou irreversíveis, e para criar rótulos. Controle o custo com uma cascata em níveis, prioridade de fila por gravidade e alcance, e ferramentas que mostram o contexto. Os recursos dão uma segunda verificação e alimentam o treino.

</details>

## 📚 Further reading

- As fontes listadas em Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundário).
- Relacionados neste repositório: [17 Payments](17-payment-system.md), [02 Rate limiter](02-rate-limiter.md), [26 Recommendations](26-recommendation-system.md), [28 Fine-tuning and evaluation](28-llm-finetuning-evaluation.md), [31 Stream aggregation](31-ad-click-aggregation.md), [P06 Security](../toolkit/P06-security-threat-modeling.md).

## Sources and provenance

> **Kind:** partes de sistemas reais (Immune System do Facebook, Stripe Radar, Few-Shot Learner da Meta) com um design de referência `[INDUSTRY PATTERN]`.
> **Sources read on 2026-11-01:** Tao Stein, Erdong Chen and Karan Mangla, [*Facebook Immune System*](https://css.csail.mit.edu/6.858/2012/readings/facebook-immune.pdf) (EuroSys Social Network Systems workshop, April 2011) · Stripe, [*How we built it: Stripe Radar*](https://stripe.com/blog/how-we-built-it-stripe-radar) (29 March 2023) · Stripe, [Radar rules](https://docs.stripe.com/radar/rules) (current docs) · Meta AI, [*Harmful content can evolve quickly. Our new AI system adapts to tackle it*](https://ai.meta.com/blog/harmful-content-can-evolve-quickly-our-new-ai-system-adapts-to-tackle-it/) (undated on the page).
> **Material datado:** 2011, 2023 e um post sem data da época de 2021; modelos, números e produtos mudaram desde então.
> **Not read:** as páginas do Transparency Center da Meta (renderizadas por script, não obtidas), o paper de pesquisa do Few-Shot Learner, posts posteriores da Stripe sobre o Radar, material de moderação do YouTube ou do TikTok, trabalhos acadêmicos sobre ML adversarial.
> **Tags:** `[CONFIRMED]` declarado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-11-01, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Immune System paper: adversarial learning framing, attack phases, user feedback and global knowledge, latency over precision and recall, the 2% versus 1% example, features expensive for attackers, classifier services, FXL, dynamic model loading, the policy engine with responses and holdouts, feature loops, 25 billion checks a day, 650,000 per second, 20% writes and the 50 ms budget.
- Verified in Stripe's post: 1,000+ characteristics, under 100 ms, 0.1% of legitimate payments blocked, 1 in 1,000 fraud rate, the model history, the 1.5% recall cost, 85% faster training, the 10× data result, feature investigations, risk insights and card testing.
- Verified in Stripe's rules docs: rule syntax, default rules, evaluation order for 3DS rules, the allow-rule warning and the misconfiguration warning.
- Verified in Meta AI's post: months to label, weeks to adapt, 100+ languages, the training stages, zero and few-shot modes, inputs, prevalence-based A/B tests and the stated limits.
- Not sourced (our reasoning): the integrity platform design, shadow mode, label-delay handling, cascades, safety limits and cost figures.
- Not claimed: how Meta, Facebook or Stripe run these systems today.
