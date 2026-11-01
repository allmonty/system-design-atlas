# 36 — Typeahead and Autocomplete

*Partes de sistemas reais do typeahead do Facebook (2010), do Cleo do LinkedIn (2012), da descrição do Autocomplete pelo Google (2020) e da documentação do completion suggester do Elasticsearch, além de um design de referência para completar consultas. Como foi obtido e o que não foi verificado está em **Sources and provenance** perto do final.*

## At a glance

**Em 60 segundos.** O typeahead devolve uma lista curta e ranqueada enquanto o usuário ainda está digitando, então cada tecla é uma consulta e o orçamento de latência é de dezenas de milissegundos. Há dois produtos sob o mesmo nome: **typeahead de entidades** (encontrar uma pessoa, página ou empresa; os resultados são registros, muitas vezes personalizados pelo grafo social) e **completar consultas** (terminar a busca que o usuário está digitando; as sugestões vêm de consultas passadas). Os dois pré-calculam muito: índices de prefixo em memória, resultados globais em cache, dados de cada usuário enviados ao navegador com antecedência. As perguntas de design são onde fica o índice de prefixos, como ele é ranqueado e atualizado, como a personalização se junta aos resultados globais e quais sugestões nunca podem aparecer.

**Números-chave** (conforme publicado)
- Facebook: mais de 100 ms para obter um resultado faz o typeahead "engasgar" (stutter); o sistema atendia 400 milhões de usuários em 2010 `[CONFIRMED]`.
- Cleo do LinkedIn: typeahead de rede sobre mais de 150 milhões de membros em cerca de 20 ms em média; prefixos de consulta de no máximo 4 caracteres indexam as listas invertidas `[CONFIRMED]`.
- Todo o resto aqui (taxa de teclas, taxas de acerto de cache, tamanhos de índice) é ilustrativo.

**Decisões e trade-offs**

| Opção | Ponto forte | Ponto fraco |
|---|---|---|
| Top-k pré-calculado por prefixo (trie ou FST) | Uma consulta por tecla | Caro de reconstruir; a atualização atrasa |
| Índice invertido de prefixos varrido na consulta | Atual, ranking flexível | Mais trabalho por consulta; precisa de particionamento |
| Pré-carregar dados do usuário no navegador | Zero idas e voltas no caso comum | Só cabe em conjuntos pequenos por usuário (amigos, itens recentes) |
| Resultados globais em cache pelo texto da consulta | Alta taxa de acerto para prefixos populares | Inútil para resultados personalizados |
| Serviços pessoais e globais unidos por um agregador | Cada folha ranqueia pelos próprios sinais | A latência do fan-out é a da folha mais lenta |

**Erros comuns**
- Enviar uma requisição a cada tecla sem cache no cliente, debounce ou cancelamento.
- Tratar a completação apenas como uma lista das consultas mais frequentes, ignorando atualidade, idioma e região e filtragem por política.
- Personalizar resultados que poderiam ficar em cache global, ou colocar em cache resultados que são pessoais.
- Esquecer a verificação de privacidade nos resultados de entidades antes de exibi-los.

---

## 🧒 Non-technical explanation

Pense numa bibliotecária que começa a andar até a estante certa assim que você diz as primeiras letras de um título. Ela guarda, para cada começo de título, um cartão com os títulos mais pedidos, então quase nunca precisa andar. Para coisas que só você pede (os nomes dos seus amigos), ela te entregou um cartão próprio quando você chegou. E há algumas frases que ela nunca sugere em voz alta, mesmo que muita gente peça.

---

## TL;DR for engineers

- **Facebook (2010):** ao focar a caixa de busca, o navegador pré-carrega amigos, páginas, grupos e eventos do usuário; um agregador faz fan-out para serviços folha (um global com cache de consultas em memcached, um de grafo para a vizinhança do usuário), junta e ranqueia; a camada web busca os dados e verifica privacidade `[CONFIRMED]`.
- **Cleo do LinkedIn:** índice invertido de prefixos em memória, Bloom filter por documento e índice direto, particionado e depois unido; typeahead genérico (global) versus de rede (personalizado); novos membros buscáveis em tempo real `[CONFIRMED]`.
- **Autocomplete do Google:** as previsões vêm de buscas reais, ajustadas por idioma, localização e atualidade, e filtradas por política, com equipes humanas removendo o que os sistemas deixam passar `[CONFIRMED]`.
- **Pipeline de logs de consulta, top-k por prefixo, debounce, troca de versões do índice:** design de referência `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcionais:** devolver até k sugestões para um prefixo · ranquear por popularidade, relevância pessoal e atualidade · oferecer resultados de entidades (pessoas, itens) e completações de consulta · esconder sugestões que violam a política.

**Não funcionais:** **latência** (um resultado bem abaixo de 100 ms de ponta a ponta, para que a lista acompanhe a digitação) · **vazão** (uma requisição por tecla, muito mais que buscas completas) · **atualidade** (novas entidades e consultas em alta aparecem rápido) · **disponibilidade** (uma falha no typeahead não pode bloquear a busca).

**Perguntas de esclarecimento:** entidades, consultas ou ambos? Personalizado? Quão rápido novos itens precisam aparecer? Quais idiomas e regiões? O que nunca pode ser sugerido?

---

## 2. Facebook's typeahead (2010) `[CONFIRMED]`

O post acompanha uma consulta em sete passos. **Bootstrapping:** quando o usuário foca a caixa de busca, o navegador pede todos os amigos, páginas, grupos, aplicativos e próximos eventos do usuário e os guarda no cache do navegador, para que esses resultados apareçam "without sending another request". **Requisição AJAX:** se o cache não tem resultados suficientes, o navegador envia o texto da consulta mais os resultados já exibidos. **Agregador:** um endpoint PHP envolve um serviço Thrift, o agregador, que é "stateless and have no index of their own"; ele delega a vários serviços de nível mais baixo em paralelo. **Serviços folha:** cada um busca e ranqueia por poucos atributos. O serviço global indexa todas as páginas e aplicativos sem personalização, então "we can save latency by storing recent results in a memcached-based query cache"; o serviço de grafo busca na vizinhança do usuário no grafo. **Junção:** o agregador ranqueia os resultados unidos com um modelo e devolve ids. **Busca e validação:** a camada web busca nomes e fotos no memcache e no MySQL e faz a verificação de privacidade "to make sure that the searcher is allowed to see each result". **Exibição:** os resultados entram no cache do navegador, para que consultas parecidas depois não passem pelo backend.

Antes do lançamento, eles fizeram um dark test fazendo o typeahead antigo enviar uma consulta a cada tecla, o que expôs limites de rede e mudou a topologia. O post trata a busca como um trilema entre desempenho, recall e relevância, e põe o desempenho em primeiro lugar: "late answers are wrong answers". Consultas de cauda longa continuam indo para a página de resultados completa.

## 3. LinkedIn's Cleo (2012) `[CONFIRMED]`

O Cleo alimenta o typeahead do LinkedIn para membros, empresas, grupos, perguntas e habilidades, em duas categorias: typeahead **genérico** (a mesma consulta dá a todos os mesmos resultados, ranqueados globalmente, por exemplo por popularidade) e typeahead **de rede** (resultados filtrados pelas conexões de primeiro e segundo grau do membro e ranqueados com os scores do People You May Know). Ele faz "out-of-order prefix matching over a very large number of elements by means of in-memory scanning", com três estruturas por partição: um **índice invertido** de prefixos para documentos (ou uma **lista de adjacência** de membros para membros no typeahead de rede), um **Bloom filter** por documento para descartar os que não podem casar, e um **índice direto** para confirmar que cada termo da consulta é prefixo de algum termo indexado. Uma consulta por `linked` usa o prefixo `link`, já que os prefixos têm no máximo 4 caracteres. As partições devolvem resultados que são unidos. As atualizações são em tempo real: novos membros, empresas e grupos ficam buscáveis na hora.

## 4. Query completion: where predictions come from `[CONFIRMED]`

O Google diz que suas "predictions reflect searches that have been done on Google": os sistemas partem de consultas comuns e em alta que casam com o que foi digitado, depois ajustam pelo idioma e pela localização de quem busca, preveem só o final de consultas muito longas, e reforçam previsões quando detectam interesse crescente. As previsões são filtradas: os sistemas bloqueiam termos que podem ser violentos, sexualmente explícitos, de ódio, depreciativos ou perigosos, suprimem previsões que provavelmente não levam a conteúdo confiável (por exemplo boatos depois de uma notícia urgente), aplicam uma política cautelosa a nomes, e equipes de fiscalização removem o que passa, incluindo variantes próximas. O filtro se aplica só às previsões; ele "does not impact the ability for someone to finish typing a query".

A documentação do Elasticsearch descreve o trade-off de um índice de completação: o completion suggester "is optimized for speed" e usa estruturas de dados "that enable fast lookups, but are costly to build and are stored in-memory".

---

## 5. Reference design for query completion `[INDUSTRY PATTERN]`

- **Pipeline offline:** coletar logs de consulta, normalizar (maiúsculas, espaços), descartar consultas raras (privacidade e ruído), contar numa janela com decaimento, aplicar o filtro de política e montar listas top-k por prefixo (uma trie ou estrutura de estados finitos). Enviar o índice montado como um arquivo imutável e versionado e trocá-lo de forma atômica em cada nó de serviço.
- **Caminho de atualidade:** um job de streaming conta consultas recentes por prefixo e serve uma pequena camada de "em alta" unida ao índice batch (veja [34 Top-K](34-top-k-leaderboard.md) e [31 Stream aggregation](31-ad-click-aggregation.md)).
- **Serviço:** servidores de sugestão sem estado mantêm o índice em memória, divididos por faixa de prefixo se ele não couber num nó; uma CDN ou cache de borda serve os prefixos curtos mais populares.
- **Cliente:** aplicar debounce às teclas (dezenas de milissegundos), cancelar requisições em andamento quando o prefixo muda, guardar respostas em cache por prefixo e filtrar localmente uma lista maior já em cache quando o usuário digita mais um caractere.
- **Personalização:** juntar as sugestões globais às consultas ou entidades recentes do próprio usuário, como o Facebook faz com o pré-carregamento.

---

## 6. Failure scenarios

- **Serviço de sugestão lento ou fora do ar.** O cliente mostra sugestões em cache ou nenhuma; a caixa de busca em si precisa continuar funcionando `[INDUSTRY PATTERN]`.
- **Um serviço folha está lento.** O agregador espera pela folha mais lenta; defina um prazo e devolva o que chegou (veja a seção de latência de cauda no [P07](../toolkit/P07-slos-and-incidents.md)) `[INDUSTRY PATTERN]`.
- **Uma previsão nociva aparece.** Bloqueie no momento do serviço com uma lista de bloqueio que se atualiza mais rápido que o índice, e remova no próximo build; o Google descreve tanto filtros automáticos quanto equipes de fiscalização `[CONFIRMED]` para a política, `[INDUSTRY PATTERN]` para o mecanismo da lista de bloqueio.
- **Um build ruim do índice vai para produção.** Mantenha a versão anterior em disco e faça rollback trocando o ponteiro `[INDUSTRY PATTERN]`.
- **Tempestade de teclas depois de um lançamento.** O Facebook encontrou limites de rede fazendo dark test de consultas por tecla antes do lançamento `[CONFIRMED]`.

---

## 7. Capacity reasoning (illustrative)

- Se 10 milhões de buscas por dia levam 8 teclas cada e o cliente descarta metade com debounce, são cerca de 40 milhões de requisições de sugestão por dia, perto de 460 por segundo em média e alguns milhares no pico (nossa conta).
- Um índice de 10 milhões de consultas distintas com listas top-10 para cada prefixo de até 20 caracteres tem no máximo 200 milhões de entradas de prefixo antes do compartilhamento; tries compartilham prefixos comuns, então o número real é bem menor. Meça antes de partir para sharding.
- A maioria das requisições é de prefixos curtos, que são poucos e muito acessados: um cache pequeno na frente dos servidores absorve a maior parte da carga.

---

## ⚠️ Reviewer notes

1. **Os posts do Facebook e do LinkedIn são de 2010 e 2012.** Os dois descrevem sistemas que mudaram desde então; esta nota não afirma o design atual de nenhuma das empresas.
2. **O post do Google descreve comportamento e política, não arquitetura.** O pipeline da seção 5 é o nosso design de referência.
3. **Artigos de entrevista costumam apresentar uma trie com top-k em cada nó como "o" design.** As fontes mostram dois produtos diferentes (typeahead de entidades e de consultas) e índices de prefixo em memória construídos de mais de um jeito; a trie é uma opção.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Nossa análise, não das fontes. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características determinantes (Ch 4–5):** **desempenho** (a latência é a funcionalidade), **escalabilidade**, **disponibilidade** e uma restrição de **segurança** sobre o que pode ser mostrado.
- **Estilo (Ch 13–17):** uma árvore de serviços **scatter-gather** (agregador e folhas) sobre dados **pré-calculados** por um pipeline batch.
- **Quanta (Ch 7):** a camada de serviço e o build do índice são quanta separados, ligados só por um arquivo versionado.
- **Trade-off (First Law, Ch 1):** **atualidade vs latência e custo.** Pré-calcular listas por prefixo deixa as leituras baratas e as atualizações lentas.
- **Esboço de ADR (Ch 19):** *"Vamos servir completações a partir de um índice imutável em memória reconstruído de hora em hora, com uma camada de streaming para o que está em alta e uma lista de bloqueio no momento do serviço. Aceitamos até uma hora de atraso para consultas que não estão em alta em troca de uma consulta por tecla."*
- Em linguagem simples: deixe os cartões de resposta na mesa.

---

## Interview questions to practice

1. Projete o autocomplete de busca de um grande buscador.
2. Projete o typeahead para encontrar amigos e páginas numa rede social.
3. Como manter as sugestões atuais quando algo começa a viralizar?
4. Como impedir sugestões ofensivas ou perigosas?
5. O que o cliente faz para manter a taxa de requisições baixa?
6. Como personalizar sugestões sem perder a possibilidade de cache?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes.

**Um roteiro de 45 minutos**

1. Esclarecer: entidades ou consultas, personalização, atualidade, regiões, política.
2. Estimar: teclas por segundo no pico, tamanho do índice, taxa de acerto do cache ([P01](../toolkit/P01-estimation.md)).
3. API: `GET /suggest?q=prefix&locale=...&limit=10`.
4. Design: debounce e cache no cliente, cache de borda, servidores de sugestão com índice em memória, build batch, camada de alta, lista de bloqueio.
5. Aprofundar: montar o top-k por prefixo, juntar pessoal e global, sinais de ranking.
6. Falhas e escala: folha lenta, build ruim do índice, previsão nociva, tráfego 10×.

**Se crescer 10×**
- Dividir o índice em shards por faixa de prefixo e pôr os prefixos mais quentes em cache na borda.
- Levar mais filtragem para o cliente (baixar uma lista maior, filtrar localmente).
- Separar o serviço pessoal do global para que a parte global continue cacheável.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Como manter as sugestões atuais?</summary>

Mantenha o índice pesado como um build batch periódico e acrescente uma pequena camada de streaming que conta consultas recentes por prefixo numa janela curta. No momento do serviço, junte as duas, dando um reforço à camada quando sua taxa sobe muito. O Google descreve reforçar previsões quando detecta interesse crescente.

</details>

<details><summary>Como impedir sugestões nocivas?</summary>

Filtre no build com classificadores de política e listas de termos, filtre de novo no serviço com uma lista de bloqueio que pode ser atualizada em minutos, e tenha um caminho de denúncia com pessoas que revisam e removem, incluindo variantes próximas. Nunca deixe o filtro bloquear a busca do próprio usuário.

</details>

<details><summary>Personalizado e cacheável ao mesmo tempo?</summary>

Divida a resposta: a parte global depende só do prefixo e da região, então funciona bem em cache; a parte pessoal é pequena e ou é pré-carregada no cliente (como o Facebook fazia com os amigos) ou servida por um serviço separado. Junte as duas no cliente ou num agregador fino.

</details>

## 📚 Further reading

- As fontes listadas em Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundário).
- Relacionados neste repositório: [20 Web crawler and search](20-web-crawler-search.md), [34 Top-K and leaderboards](34-top-k-leaderboard.md), [32 Distributed cache](32-distributed-cache.md), [P07 Reliability](../toolkit/P07-slos-and-incidents.md).

## Sources and provenance

> **Kind:** partes de sistemas reais (Facebook, LinkedIn, Google, Elasticsearch) com um design de referência `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-31:** Keith Adams, [*The Life of a Typeahead Query*](https://engineering.fb.com/2010/05/17/web/the-life-of-a-typeahead-query/) (Facebook Engineering, 17 May 2010) · LinkedIn Engineering, [*Cleo: the open source technology behind LinkedIn's typeahead search*](https://web.archive.org/web/20150227001852/https://engineering.linkedin.com/open-source/cleo-open-source-technology-behind-linkedins-typeahead-search) (2012; Internet Archive copy, the live page returns 404) · Google, [*How Google autocomplete predictions are generated*](https://blog.google/products/search/how-google-autocomplete-predictions-work/) (8 October 2020) · Elastic, [Suggesters: completion suggester](https://www.elastic.co/guide/en/elasticsearch/reference/current/search-suggesters.html) (current docs).
> **Material datado:** os posts do Facebook e do LinkedIn têm mais de uma década; o post do Google é de 2020.
> **Not read:** a página publicada de políticas do Autocomplete do Google, a implementação de FST do Lucene, posts posteriores do LinkedIn sobre typeahead, trabalhos acadêmicos sobre completação de consultas.
> **Tags:** `[CONFIRMED]` declarado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-10-31, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Facebook post: the seven steps (bootstrap, AJAX, aggregator, leaves, merge, fetch and privacy check, display), the memcached query cache for the global service, dark testing, the 100 ms stutter remark, "late answers are wrong answers" and the 400 million users.
- Verified in the Cleo post: generic versus network typeahead, inverted index or adjacency list, Bloom filter, forward index, the 4-character prefix example, real-time updates, and about 20 ms over more than 150 million members.
- Verified in Google's post: predictions from real searches, language, location and freshness adjustments, policy filtering and enforcement, the names policy, and that filtering does not stop the search.
- Verified in the Elasticsearch docs: the completion suggester is optimised for speed with in-memory structures that are costly to build.
- Not sourced (our reasoning): the query-log pipeline, versioned index swaps, the trending overlay, client debounce and caching, the deny-list mechanism, and the capacity arithmetic.
- Not claimed: how Facebook, LinkedIn or Google build typeahead today.
