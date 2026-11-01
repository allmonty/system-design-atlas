# 39 — Maps, Routing and ETA

*Partes de sistemas reais a partir do paper de Contraction Hierarchies (2008), do paper do Google sobre ETA com graph neural networks no Google Maps (CIKM 2021), do esquema de tiles do OpenStreetMap e do motor de rotas OSRM, além de um design de referência. Como foi obtido e o que não foi verificado está em **Sources and provenance** perto do final.*

## At a glance

**Em 60 segundos.** Um produto de mapas são três sistemas que compartilham um mesmo grafo de ruas. Os **tiles** desenham o mapa: o mundo é cortado em imagens quadradas (ou tiles vetoriais) por nível de zoom, endereçadas por `z/x/y`, então vão para o cache como arquivos estáticos. O **roteamento** encontra o melhor caminho: Dijkstra puro num grafo continental é lento demais por requisição, então o grafo é pré-processado (Contraction Hierarchies, partições em vários níveis) e uma consulta passa a tocar algumas centenas de nós. O **ETA** prevê quanto tempo a rota escolhida vai levar, usando velocidades ao vivo e históricas; o Google descreve uma graph neural network sobre "supersegments" de rua. As atualizações de trânsito chegam o tempo todo, então a pergunta de design é quais partes são pré-calculadas, quais são recalculadas quando as velocidades mudam e quão atual o ETA precisa ser.

**Números-chave** (conforme publicado)
- Contraction Hierarchies, rede de ruas da Europa Ocidental (18.029.721 nós, 42.199.587 arestas direcionadas): consultas em cerca de 160 a 220 µs num núcleo Opteron de 2008, com overhead de espaço negativo; uma tabela de distâncias de 10.000 × 10.000 em 10,2 s `[CONFIRMED]`.
- GNN de ETA do Google Maps: resultados de ETA ruins reduzidos em mais de 40% em cidades como Sydney em relação ao modelo de produção anterior; segmentos de rua têm em média 50 a 100 m e supersegments cerca de 20 segmentos; horizontes de 0, 10, 20, 30 e 60 minutos `[CONFIRMED]`.
- Tiles do OSM: 256 × 256 pixels; o zoom n tem 2^n × 2^n tiles, cerca de 4,3 bilhões no zoom 16 `[CONFIRMED]`.

**Decisões e trade-offs**

| Opção | Ponto forte | Ponto fraco |
|---|---|---|
| Dijkstra ou A* no grafo bruto | Sem pré-processamento, qualquer peso | Lento demais para rotas longas na taxa de requisições |
| Contraction Hierarchies | Consultas em microssegundos, tabelas de distância rápidas | Pré-processamento a refazer quando os pesos mudam |
| Partição em vários níveis (o MLD do OSRM) | Atualização de pesos mais barata ("customise") | Consultas um pouco mais lentas que CH |
| Tiles raster | Simples de servir e de pôr em cache | Mudar o estilo exige renderizar de novo; grandes nos zooms altos |
| Tiles vetoriais | Estilizados no dispositivo, menores | Trabalho de renderização no cliente |
| Soma das velocidades dos segmentos para o ETA | Baseline simples | Ignora interações entre segmentos e o trânsito futuro |
| ETA aprendido sobre o grafo de ruas (Google) | Captura efeitos espaciais e temporais | Estabilidade do treino e custo de serviço |

**Erros comuns**
- Rodar uma busca de caminho mínimo sobre o continente inteiro a cada requisição.
- Usar só velocidades ao vivo, e assim um ETA às 17h ignora que a hora do rush está para começar.
- Tratar roteamento e ETA como um passo só: o paper do Google estima o tempo de uma rota sugerida por um sistema anterior.
- Renderizar todos os tiles de todos os zooms antecipadamente (bilhões, a maioria de oceano) em vez de sob demanda com cache.

---

## 🧒 Non-technical explanation

Uma cidade tem um mapa de papel cortado em quadrados de todos os tamanhos, empilhados por zoom, então você só busca os quadrados para os quais está olhando. Para achar um caminho atravessando o país, uma navegadora não confere cada rua; ela marcou antes quais ruas importam para viagens longas, então só olha ruas pequenas perto da partida e da chegada. Para dizer quando você vai chegar, ela lembra quão movimentada cada rua costuma ser nesse horário e quão movimentada está agora, e soma os pedaços ao longo do caminho.

---

## TL;DR for engineers

- **Contraction Hierarchies:** ordenar os nós por importância, contrair primeiro os menos importantes e acrescentar arestas de atalho que preservam os caminhos mínimos; uma consulta é uma busca bidirecional que só "sobe" a hierarquia a partir das duas pontas `[CONFIRMED]`.
- **OSRM:** um motor open source sobre dados do OpenStreetMap com os serviços Route, Table, Match (map-matching de trilhas de GPS), Nearest, Trip e Tile; suporta CH e Multi-Level Dijkstra, recomendando MLD por padrão `[CONFIRMED]`.
- **ETA do Google:** supersegments de segmentos de rua conectados, atributos de velocidade ao vivo e históricos (hora do dia, dia da semana), modelos GNN por horizonte, consultados ao longo da rota com horizontes interpolados `[CONFIRMED]`.
- **Tiles:** endereçamento `z/x/y` em Web Mercator, tiles de 256 pixels `[CONFIRMED]`.
- **Ingestão de trânsito por sondas GPS, recustomização de pesos, camadas de cache de tiles, recálculo de rota:** design de referência `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcionais:** mostrar o mapa em qualquer zoom · buscar lugares (veja [36 Typeahead](36-typeahead-autocomplete.md)) · calcular uma rota entre pontos, com alternativas · prever o horário de chegada · atualizar o ETA e recalcular a rota durante a viagem.

**Não funcionais:** **latência** (uma rota em bem menos de um segundo; tiles carregam enquanto você arrasta) · **atualidade** (o trânsito muda minuto a minuto) · **precisão** (erros de ETA que os usuários percebem) · **escala** (os tiles são de longe o maior volume de requisições) · **disponibilidade** (a navegação no meio da viagem precisa continuar funcionando, até offline).

**Perguntas de esclarecimento:** só carro, ou também a pé, bicicleta e transporte público? Trânsito ao vivo? Global ou um país? Suporte offline? Tabelas muitos-para-muitos (para despacho, veja [15 Uber](15-uber-proximity-dispatch.md))?

---

## 2. Tiles `[CONFIRMED]`

O esquema de tiles do OpenStreetMap serve imagens de 256 × 256 pixels em URLs da forma `/zoom/x/y.png`, um diretório por nível de zoom e por coluna, na projeção Web Mercator. O zoom 0 é um tile para o mundo todo; o zoom n tem 2^n × 2^n tiles, então o zoom 12 tem 16.777.216 tiles e o zoom 16 cerca de 4,3 bilhões. O zoom normalmente vai até 18. Como um tile é endereçado por três inteiros e muda raramente, ele funciona bem em cache em todas as camadas, do navegador até uma CDN (veja [38 CDN](38-cdn.md)). O OSRM também pode gerar tiles vetoriais com metadados de roteamento.

## 3. Routing with Contraction Hierarchies (2008) `[CONFIRMED]`

A ideia do paper: numerar os nós por "importância" e contraí-los nessa ordem. Contrair um nó v o remove preservando os caminhos mínimos entre os demais, acrescentando uma aresta de atalho ⟨u, w⟩ sempre que ⟨u, v, w⟩ era o único caminho mínimo. Uma consulta é um Dijkstra bidirecional modificado: a busca para frente só segue arestas para nós mais importantes e a busca para trás só arestas vindas de nós mais importantes; elas se encontram perto do topo da hierarquia. Na rede da Europa Ocidental, os autores relatam tempos cinco vezes menores, "lower query times than the best previous hierarchical" técnicas de aceleração baseadas em Dijkstra, e um overhead de espaço negativo (a estrutura de busca precisa de menos espaço que o grafo de entrada). Desempacotar um caminho de atalhos de volta para ruas reais leva cerca de 0,3 ms; uma tabela muitos-para-muitos de 10.000 × 10.000 leva 10,2 s. Os pesos das arestas eram tempos de viagem derivados do comprimento da rua e de uma de 13 categorias de via.

O pré-processamento (ordenação dos nós mais contração) levou cerca de 10 a 30 minutos naquele hardware, conforme a variante; quando os pesos mudam, pelo menos a contração precisa ser refeita, e por isso o OSRM oferece um segundo algoritmo.

## 4. OSRM `[CONFIRMED]`

O OSRM é um motor em C++ para dados do OpenStreetMap que expõe Nearest (encaixar na rede de ruas), Route, Table (durações ou distâncias entre todos os pares), Match (encaixar trilhas de GPS ruidosas no caminho de ruas mais plausível), Trip (um caixeiro-viajante guloso) e Tile. Ele suporta Contraction Hierarchies e Multi-Level Dijkstra e recomenda MLD por padrão, exceto em casos como matrizes de distância muito grandes, em que CH ainda se encaixa melhor. O pipeline do MLD divide o pré-processamento em passos de partição e de customização; o CH usa um único passo de contração.

## 5. ETA in Google Maps (2021) `[CONFIRMED]`

O paper enquadra o ETA como "providing an estimated travel time given a user-provided starting location and a route suggested by a prior system". A rede de ruas é modelada como **supersegments**, sequências de segmentos de rua conectados que seguem rotas típicas de trânsito (os segmentos têm em média 50 a 100 m; um supersegment cerca de 20 segmentos). Para cada supersegment, uma GNN prevê o tempo de viagem em horizontes fixos (0, 600, 1200, 1800 e 3600 segundos). No momento do serviço, os supersegments da rota são consultados em ordem, usando a chegada prevista a um supersegment para escolher e interpolar o horizonte do seguinte. Os atributos combinam velocidades e tempos ao vivo (17 janelas de dois minutos antes da previsão) com os históricos daquela hora do dia e dia da semana (média das últimas 17 semanas), o comprimento do segmento e a prioridade da via. O mundo é dividido em regiões com modelos específicos por região. Os modelos de produção anteriores eram regressões lineares por segmento; a GNN reduziu os resultados de ETA ruins (erro acima de um limite) em mais de 40% em cidades como Sydney. O treino precisou de estabilização (MetaGradients) para ficar pronto para produção.

---

## 6. Reference design `[INDUSTRY PATTERN]`

- **Pipeline de dados do mapa:** ingerir dados de ruas e lugares, montar o grafo roteável e as fontes dos tiles; publicar arquivos de grafo versionados para os servidores de rota.
- **Serviço de tiles:** pré-renderizar os zooms e regiões populares, renderizar o resto sob demanda e pôr tudo em cache atrás de uma CDN; tiles vetoriais para estilo no cliente.
- **Pipeline de trânsito:** sondas GPS anonimizadas de celulares e frotas passam por map-matching para os segmentos (o Match do OSRM faz esse tipo de encaixe), são agregadas em velocidades atuais por segmento a cada um ou dois minutos e guardadas junto com perfis históricos.
- **Serviço de rotas:** grafo pré-processado em memória, dividido por região; quando as velocidades ao vivo mudam, rodar o passo barato de customização (MLD) num cronograma e trocar os pesos de forma atômica.
- **Serviço de ETA:** dada uma rota, consultar o modelo aprendido ou uma baseline de soma de velocidades; devolver o horário de chegada e uma confiança.
- **Navegação:** o cliente pede o ETA de novo a cada poucos minutos e recalcula a rota quando o motorista sai dela ou aparece uma mais rápida; ele mantém a rota e os tiles próximos em cache para uso offline.

---

## 7. Failure scenarios

- **O feed de trânsito para.** Volte para as velocidades históricas daquela hora e dia, que o modelo de ETA já usa como atributos `[CONFIRMED]` para os atributos / `[INDUSTRY PATTERN]` para o fallback.
- **Rua fechada que ainda não está nos dados.** As sondas mostram fluxo zero; marque o segmento como fechado e recustomize; até lá, usuários são mandados para ele `[INDUSTRY PATTERN]`.
- **A atualização de pesos demora demais.** Com CH, a contração precisa ser refeita; o passo de customização do MLD é mais barato, e por isso o OSRM o recomenda por padrão `[CONFIRMED]` para a recomendação / `[INDUSTRY PATTERN]` para o raciocínio.
- **O servidor de rotas de uma região cai.** Calcule a rota a partir de uma réplica; rotas entre regiões precisam de um passo de costura nas fronteiras `[INDUSTRY PATTERN]`.
- **Regressão do modelo depois de um retreino.** Condicione as liberações ao erro de ETA offline e faça o rollout por região com fallback para o modelo anterior ([28 Evaluation](28-llm-finetuning-evaluation.md) usa a mesma ideia de portão) `[INDUSTRY PATTERN]`.
- **Tempestade de tiles depois de um estilo novo.** Todo tile vira um miss ao mesmo tempo; libere estilos aos poucos ou pré-renderize as áreas populares `[INDUSTRY PATTERN]`.

---

## 8. Capacity reasoning (illustrative)

- Os zooms 0 a 16 juntos somam cerca de 5,7 bilhões de tiles (a soma de 4^z), a maioria de oceano ou terra vazia; renderizar sob demanda e guardar em cache o que é visto custa muito menos que pré-renderizar todos (nossa conta).
- Com consultas CH perto de 0,2 ms de CPU em hardware de 2008, um núcleo responde milhares de rotas ponto a ponto por segundo; desempacotar o caminho e montar a resposta muitas vezes custa mais que a busca.
- Se 10 milhões de motoristas navegam no pico e cada cliente pede uma atualização de ETA a cada 2 minutos, são cerca de 83.000 requisições de ETA por segundo.

---

## ⚠️ Reviewer notes

1. **Os números de CH são de hardware de 2008 e de um conjunto de dados de 2008.** Eles mostram a ordem de grandeza da aceleração, não um benchmark atual.
2. **O paper do Google cobre o ETA, não o roteamento nem os tiles.** Ele não diz como o Google calcula rotas ou serve mapas; essas partes da nota são o nosso design de referência.
3. **Artigos de entrevista costumam apresentar o A* como a resposta para roteamento em escala.** O A* ajuda numa busca isolada; as acelerações publicadas, prontas para produção, vêm do pré-processamento do grafo.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Nossa análise, não das fontes. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características determinantes (Ch 4–5):** **desempenho**, **escalabilidade** (tiles), **precisão** (ETA), **disponibilidade**, **atualidade**.
- **Estilo (Ch 13–17):** **pipelines** que constroem artefatos (grafo, tiles, modelos) alimentando **serviços sem estado em memória**, mais um pipeline de trânsito em streaming.
- **Quanta (Ch 7):** tiles, roteamento, trânsito e ETA podem ser implantados e escalados separadamente; eles compartilham dados, não tempo de execução.
- **Trade-off (First Law, Ch 1):** **pré-processamento vs atualidade.** Mais pré-processamento deixa as consultas rápidas e as atualizações de peso lentas.
- **Esboço de ADR (Ch 19):** *"Vamos usar uma partição em vários níveis com customização por velocidade ao vivo a cada 2 minutos, e um ETA aprendido sobre a rota escolhida com fallback histórico. Aceitamos consultas de rota um pouco mais lentas que CH em troca de atualizações de trânsito rápidas."*
- Em linguagem simples: marque as vias principais uma vez, depois olhe só as ruas pequenas perto das pontas.

---

## Interview questions to practice

1. Projete o Google Maps.
2. Como calcular uma rota de carro atravessando um continente em milissegundos?
3. Como incluir o trânsito ao vivo nas rotas e nos horários de chegada?
4. Como os tiles de mapa são guardados e servidos? Quantos existem?
5. Como você atualizaria o ETA durante a viagem, e quando recalcula a rota?
6. Como avaliar se um novo modelo de ETA é melhor?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes.

**Um roteiro de 45 minutos**

1. Esclarecer: modos de transporte, trânsito ao vivo, escopo, offline, escala.
2. Estimar: tiles por zoom, taxa de requisições de tiles, rotas e ETAs por segundo, taxa de ingestão das sondas ([P01](../toolkit/P01-estimation.md)).
3. API: `GET /tiles/{z}/{x}/{y}`, `POST /route {from, to, mode}`, `POST /eta {route}`.
4. Design: pipeline de dados do mapa, serviço de tiles e CDN, serviço de rotas com grafo pré-processado, pipeline de trânsito, modelo de ETA.
5. Aprofundar: CH ou MLD e atualização de pesos; ETA com atributos históricos e ao vivo.
6. Falhas e escala: feed de trânsito fora, ruas fechadas, queda de região, regressões de modelo, 10× usuários.

**Se crescer 10×**
- Mais capacidade de CDN e renderização sob demanda para os tiles.
- Dividir o roteamento por região e replicar as regiões quentes.
- Agrupar as atualizações de ETA das viagens ativas e reduzir a frequência em rotas estáveis.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Rotas rápidas atravessando um continente</summary>

Pré-processe o grafo de ruas uma vez (Contraction Hierarchies ou uma partição em vários níveis) para que uma consulta explore só uma pequena parte dele: com CH, as duas buscas só sobem em direção a nós mais importantes e se encontram perto do topo. Mantenha o resultado em memória e desempacote os atalhos em segmentos reais no fim.

</details>

<details><summary>Trânsito ao vivo nas rotas</summary>

Faça map-matching das sondas GPS para os segmentos, agregue as velocidades por segmento a cada um ou dois minutos e combine-as com as velocidades históricas da hora do dia. Use-as como pesos de aresta numa estrutura de roteamento cujos pesos podem ser atualizados de forma barata (customização MLD), e preveja o ETA ao longo da rota escolhida com horizontes futuros, não só com as velocidades atuais.

</details>

<details><summary>O novo modelo de ETA é melhor?</summary>

Meça o erro contra as durações reais das viagens offline, em viagens separadas para teste, por região e hora do dia, incluindo a parcela de viagens com erro acima de um limite (o resultado de ETA ruim do Google). Depois faça um canário por região com rollback automático.

</details>

## 📚 Further reading

- As fontes listadas em Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundário).
- Relacionados neste repositório: [15 Uber proximity and dispatch](15-uber-proximity-dispatch.md), [38 CDN](38-cdn.md), [36 Typeahead](36-typeahead-autocomplete.md), [26 Recommendations](26-recommendation-system.md), [P01 Estimation](../toolkit/P01-estimation.md).

## Sources and provenance

> **Kind:** partes de sistemas reais (ETA do Google Maps, OSRM, tiles do OpenStreetMap) e um algoritmo de pesquisa (Contraction Hierarchies), com um design de referência `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-31:** Robert Geisberger, Peter Sanders, Dominik Schultes and Daniel Delling, [*Contraction Hierarchies: Faster and Simpler Hierarchical Routing in Road Networks*](https://ae.iti.kit.edu/download/contract.pdf) (WEA 2008) · Austin Derrow-Pinion et al., [*ETA Prediction with Graph Neural Networks in Google Maps*](https://arxiv.org/pdf/2108.11482) (CIKM 2021; arXiv, 25 August 2021) · OpenStreetMap Wiki, [Slippy map tilenames](https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames) · Project OSRM, [osrm-backend README](https://raw.githubusercontent.com/Project-OSRM/osrm-backend/master/README.md).
> **Material datado:** os números de CH são de hardware de 2008; o paper de ETA é de 2021.
> **Not read:** a versão em periódico do CH, o Customizable Route Planning (Microsoft), a documentação detalhada do MLD do OSRM, os internos de trânsito ou de roteamento do Google, roteamento de transporte público (RAPTOR), papers de map-matching.
> **Tags:** `[CONFIRMED]` declarado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-10-31, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the CH paper: node contraction with shortcuts, the upward bidirectional query, the Western Europe graph size, the five-times claim, negative space overhead, query times in Table 1, path unpacking around 0.3 ms, the 10.2 s many-to-many table, and edge weights from length and 13 road categories.
- Verified in the ETA paper: the problem framing, supersegments and their sizes, the horizons, sequential querying with interpolation, real-time and 17-week historical features, region-specific models, segment-level linear regression as the prior model, MetaGradients, and the over 40% reduction in Sydney.
- Verified on the OSM wiki: 256-pixel tiles, `/zoom/x/y.png`, tile counts per zoom and the usual maximum zoom of 18.
- Verified in the OSRM README: the services, CH and MLD, and the MLD default recommendation.
- Not sourced (our reasoning): the traffic pipeline, routing shards and weight swaps, navigation behaviour, fallbacks, and the capacity arithmetic.
- Not claimed: how Google Maps computes routes or serves tiles.
