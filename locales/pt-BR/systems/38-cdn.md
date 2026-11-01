# 38 — Content Delivery Network (CDN)

*Nota de sistemas reais a partir do relato de engenheiros da Akamai sobre os algoritmos da sua CDN (Maggs e Sitaraman, 2015), da documentação de cache da Cloudflare e da RFC 9111 (caching HTTP), além de um design de referência. Como foi obtido e o que não foi verificado está em **Sources and provenance** perto do final.*

## At a glance

**Em 60 segundos.** Uma CDN coloca caches compartilhados perto dos usuários e responde a partir deles, para que a maior parte dos bytes nunca percorra o caminho longo até a origem. Uma requisição passa por três decisões: **qual cluster** (por DNS, pela localização do resolvedor do usuário, equilibrando desempenho, carga e custo), **qual servidor dentro do cluster** (consistent hashing do conteúdo, para que cada objeto fique em poucos servidores) e, num miss, **de onde buscar** (pares no cluster, uma camada pai, depois a origem). As regras de cache vêm do HTTP (atualidade, validação, a chave de cache); a CDN acrescenta camadas para proteger a origem, filtra o que vale a pena guardar, serve conteúdo vencido enquanto revalida e faz purge sob demanda. O conteúdo que não pode ir para o cache também se beneficia: a CDN o retransmite por caminhos escolhidos numa rede overlay.

**Números-chave** (conforme publicado)
- Akamai: mais de 170.000 servidores de borda em mais de 1.300 redes em 102 países, servindo de 15 a 30% de todo o tráfego web (na época do paper de 2015) `[CONFIRMED]`.
- Num cluster, 74% de cerca de 400 milhões de objetos foram acessados uma única vez em dois dias; guardar só no segundo acesso elevou a taxa de acerto em bytes de cerca de 74% para 83% e cortou as escritas em disco em 44% `[CONFIRMED]`.
- Todo o resto aqui (taxas de acerto, tempos de purge, número de camadas) é ilustrativo.

**Decisões e trade-offs**

| Opção | Ponto forte | Ponto fraco |
|---|---|---|
| Seleção de cluster por DNS | Funciona para qualquer cliente, controle fino | Vê o resolvedor, não o usuário; os TTLs do DNS atrasam a reação |
| Roteamento anycast para o site mais próximo | Simples, failover rápido pelo roteamento | Menos controle sobre qual site atende quem |
| Consistent hashing dentro de um cluster | Cada objeto em poucos servidores, alta taxa de acerto | Objetos muito acessados precisam de mais de um servidor |
| Cache em camadas (inferior e superior) | Menos buscas e conexões na origem | Um salto a mais num miss |
| Guardar no segundo acesso | Mais espaço para objetos populares, menos escritas em disco | As primeiras requisições sempre dão miss |
| TTLs longos com purge | Alta taxa de acerto | O purge precisa ser confiável e rápido |

**Erros comuns**
- Deixar cookies ou parâmetros de rastreamento na chave de cache, e assim nada nunca dá acerto.
- Guardar respostas personalizadas num cache compartilhado (um incidente de privacidade, não um bug de desempenho).
- Esquecer que, sem camadas ou junção de requisições, cada miss de borda por um objeto novo pode chegar à origem ao mesmo tempo.
- Tratar a CDN como só arquivos estáticos: ela também termina TLS e retransmite tráfego dinâmico.

---

## 🧒 Non-technical explanation

Uma padaria famosa abre lojinhas pela cidade toda. Cada loja guarda os pães que mais gente compra. Se uma loja fica sem um pão, ela pergunta aos outros balcões da mesma loja, depois a uma loja regional maior, e só em último caso à padaria central. Uma loja não estoca um pão na primeira vez que alguém pede, porque a maioria dos pães pedidos uma vez nunca mais é pedida. Quando a padaria muda uma receita, ela liga para todas as lojas para jogarem fora os pães antigos.

---

## TL;DR for engineers

- **Caminho da requisição (Akamai):** o DNS autoritativo da CDN escolhe um cluster pelo endereço do resolvedor (ou pela EDNS client subnet) com um algoritmo de alocação estável; um segundo nível de DNS escolhe servidores no cluster por consistent hashing do número de série do cliente; os misses vão para os pares do cluster, depois para um cluster pai, depois para a origem `[CONFIRMED]`.
- **O que guardar (Akamai):** a maioria dos objetos é acessada uma única vez; uma regra de guardar no segundo acesso com dois Bloom filters em rodízio economiza disco e eleva a taxa de acerto `[CONFIRMED]`.
- **Camadas e conteúdo vencido (Cloudflare):** as camadas inferiores perguntam às superiores, e só as superiores perguntam à origem; com `stale-while-revalidate` a borda serve conteúdo vencido e revalida em segundo plano; purge por URL, tag, prefixo ou host, limitado por token bucket `[CONFIRMED]`.
- **Regras HTTP (RFC 9111):** caches compartilhados versus privados, a chave de cache (método e URI de destino, mais os cabeçalhos de `Vary`), atualidade e validação `[CONFIRMED]`.
- **Desenho da chave de cache, junção de requisições, dimensionamento do origin shield, estratégia de purge:** design de referência `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcionais:** servir conteúdo cacheável a partir da borda · buscar os misses na origem · respeitar as regras de cache do HTTP · fazer purge ou invalidar sob demanda · retransmitir tráfego não cacheável · terminar TLS.

**Não funcionais:** **latência** (borda próxima) · **disponibilidade** (sobreviver a falhas de servidores, clusters e redes) · **proteção da origem** (poucas requisições e conexões na origem) · **taxa de acerto** · **custo** (banda e armazenamento) · **isolamento entre clientes**.

**Perguntas de esclarecimento:** arquivos estáticos, segmentos de vídeo ou páginas dinâmicas? Quão atual o conteúdo precisa ser? Quão rápido um purge precisa ter efeito? Algum conteúdo é personalizado? Onde estão os usuários?

---

## 2. How a request finds a server (Akamai) `[CONFIRMED]`

O resolvedor do cliente pergunta ao servidor de nomes autoritativo da CDN, que olha o endereço do resolvedor (ou a EDNS client subnet que ele repassa) e escolhe um cluster. Essa escolha é o **balanceamento de carga global**: as unidades de mapa (grupos de clientes) têm preferências entre clusters, os clusters têm capacidades, e uma variante do algoritmo do casamento estável faz a atribuição, equilibrando desempenho, carga entre clusters e custo. A demanda muda rápido; o paper cita "flash crowds" como um evento normal.

Dentro do cluster escolhido, o **balanceamento de carga local** usa consistent hashing. Os objetos não recebem hash um a um: cada cliente recebe números de série, e todos os objetos de um número de série vão para o mesmo servidor, ou o mesmo conjunto de servidores quando são populares, para que um navegador busque os objetos de uma página por uma única conexão persistente. O cliente aponta um hostname para um nome da CDN com um CNAME; para cada número de série, o servidor de nomes mantém uma ordem aleatória dos servidores do cluster e devolve os k primeiros que estão no ar, com k dependendo da popularidade atual, em ordem aleatória para espalhar a carga.

Numa requisição, o servidor de borda confere seu cache; num miss, pergunta aos outros servidores do cluster, depois pode perguntar a um cluster "parent", e só então à origem.

Todo componente que toma decisões (entre eles os balanceadores de carga global e local) roda replicado em muitos servidores em vários data centers; cada um calcula sua resposta de forma independente, e uma **leader election** escolhe qual saída o resto do sistema usa, porque falhas de servidores e de data centers inteiros são comuns.

## 3. What is worth caching (Akamai) `[CONFIRMED]`

Em logs de um cluster de 45 servidores ao longo de dois dias, cerca de três quartos de uns 400 milhões de objetos foram pedidos uma vez e 90% menos de quatro vezes. Guardar esses "one-hit-wonders" desperdiça disco e escritas. A regra de **guardar no segundo acesso** registra os objetos pedidos num Bloom filter e só guarda um objeto se ele já foi visto antes; dois filtros (um primário e um secundário, trocados quando o primário enche) mantêm os falsos positivos sob controle e deixam os objetos antigos serem esquecidos. Num teste em campo com cerca de 47 servidores, a taxa de acerto em bytes subiu de cerca de 74% para 83% e as escritas em disco caíram de cerca de 10.209 para 5.738 por segundo, 44% a menos.

Os Bloom filters também servem para **resumir o cache**: os servidores trocam resumos compactos para que um descubra qual par tem um objeto (o Squid chama isso de digests), o que exige Bloom filters com contadores para permitir remoções.

## 4. Uncacheable content and overlay routing (Akamai) `[CONFIRMED]`

Sites dinâmicos, aplicações e vídeo ao vivo não podem ser servidos do cache, mas a borda ainda funciona como a porta de entrada deles. Retransmitir pelos servidores da CDN como uma rede overlay pode "reduce download time and increase availability": a CDN explora vários caminhos entre a borda e a origem, escolhe os mais rápidos e tem reservas quando um caminho falha.

## 5. Tiers, staleness and purging (Cloudflare) `[CONFIRMED]`

O **cache em camadas** divide os data centers em camadas inferiores (perto dos usuários) e superiores; num miss, uma camada inferior pergunta a uma superior, e "only the upper-tier can ask the origin for content", o que eleva as taxas de acerto e concentra as conexões com a origem em poucos lugares. A Cloudflare escolhe a camada superior por origem pela latência medida (Smart Tiered Cache) ou por um consistent hashing da chave de cache dentro de um grupo regional (Generic Global); mudar os IPs da origem pode trocar a camada superior e causar uma onda de misses enquanto a nova camada se enche.

**Revalidação.** Quando um recurso em cache vence e a origem enviou `stale-while-revalidate`, a primeira requisição dispara a revalidação em segundo plano, e ela e as seguintes recebem a cópia vencida até a origem responder; requisições condicionais com `If-Modified-Since` e ETags evitam baixar de novo o conteúdo que não mudou. Sem a diretiva, os usuários esperam pela origem. `must-revalidate`, `proxy-revalidate` e `s-maxage` impedem servir conteúdo vencido.

**Purge.** O conteúdo pode sofrer purge por URL (o recomendado), ou por tag, prefixo, hostname ou tudo, ou ser marcado como vencido (invalidado) para ser revalidado no próximo uso. Uma resposta de purge bem-sucedida significa que a requisição foi recebida, não que um objeto foi removido. As requisições de purge são limitadas com um token bucket por plano.

## 6. HTTP caching rules (RFC 9111) `[CONFIRMED]`

Um **cache compartilhado** guarda respostas para reuso por mais de um usuário (uma CDN); um **cache privado** é de um usuário só (o navegador). A **chave de cache** é composta, no mínimo, do método da requisição e da URI de destino; muitos caches guardam só GET e, por isso, usam só a URI como chave, e a negociação de conteúdo acrescenta os cabeçalhos da requisição citados em `Vary`. A atualidade e a validação decidem se uma resposta guardada pode ser reusada sem perguntar à origem.

---

## 7. Reference design `[INDUSTRY PATTERN]`

- **PoPs de borda** com terminação TLS, um cache HTTP (memória para objetos quentes, disco para o resto) e junção de requisições, para que misses concorrentes por um objeto façam uma única busca acima.
- **Roteamento** por DNS (controle) ou anycast (simplicidade), com health checks que retiram um PoP.
- **Dentro de um PoP**, consistent hashing da chave de cache entre os servidores; replicar as chaves quentes.
- **Camada de proteção** (uma camada superior por origem) na frente da origem.
- **Política de chave de cache por cliente:** remover parâmetros de rastreamento, ignorar cookies a menos que a resposta varie com eles, normalizar maiúsculas e a ordem da query.
- **Invalidação:** URLs versionadas para recursos estáticos (`app.3f9a.js`), para que nenhum purge seja necessário; purge por tag para conteúdo; um barramento de purge que distribui para todos os PoPs e recebe confirmações.
- **Configuração e logs:** um plano de controle distribui a configuração dos clientes; os logs voltam em stream para cobrança e análise.

---

## 8. Failure scenarios

- **Um servidor de borda morre.** O DNS para de devolvê-lo (ele é pulado na lista de servidores); o consistent hashing move só os objetos dele `[CONFIRMED]` (Akamai) / `[INDUSTRY PATTERN]`.
- **Um data center inteiro falha.** Os componentes de decisão são replicados entre data centers, e uma leader election escolhe a saída sobrevivente `[CONFIRMED]` (Akamai).
- **Flash crowd por um objeto.** Números de série populares ganham mais servidores; a junção de requisições e as camadas evitam que a origem veja o pico `[CONFIRMED]` para o k por popularidade da Akamai / `[INDUSTRY PATTERN]` para a junção.
- **A origem está lenta ou fora do ar.** Sirva conteúdo vencido onde a origem permitiu (`stale-while-revalidate`, e `stale-if-error` da RFC 5861, não lida aqui) `[CONFIRMED]` / `[SPECULATIVE]`.
- **Um deploy ruim na origem fica em cache em todo lugar.** Faça purge por tag, ou volte a URL versionada `[INDUSTRY PATTERN]`.
- **Uma página personalizada fica num cache compartilhado.** Usuários veem dados uns dos outros; marque essas respostas como `private` ou `no-store` e mantenha cookies fora dos caminhos cacheáveis `[INDUSTRY PATTERN]`.

---

## 9. Capacity reasoning (illustrative)

- Um site servindo 10 Gbit/s com 95% de acerto em bytes manda 0,5 Gbit/s para a origem; com 80%, 2 Gbit/s, quatro vezes mais. A taxa de acerto é a alavanca do custo da origem (nossa conta).
- Com 300 PoPs e sem camadas, um objeto novo pode causar até 300 buscas na origem; com uma camada superior por origem, uma (mais os misses durante o enchimento).
- Um PoP com 20 servidores e 10 TB de disco cada guarda 200 TB se cada objeto vai para um servidor, mas só 100 TB de conteúdo distinto se cada objeto é guardado duas vezes.

---

## ⚠️ Reviewer notes

1. **Os números da Akamai são do paper de 2015** (uma nota editorial, sem revisão por pares, de autores que construíram o sistema); a rede mudou desde então.
2. **A documentação da Cloudflare descreve o comportamento atual do produto**, que muda; Smart Tiered Cache e Smart Shield são nomes de produto.
3. **Artigos populares costumam igualar uma CDN a hospedagem de arquivos estáticos.** As duas fontes descrevem a retransmissão de tráfego não cacheável como uma função central.
4. **Not read:** o paper de visão geral da Akamai de 2010 (*The Akamai Network*), os posts da Cloudflare sobre a arquitetura anycast, a RFC 5861 (`stale-while-revalidate`, `stale-if-error`) e o Netflix Open Connect (veja [13 Netflix](13-netflix.md)).

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Nossa análise, não das fontes. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características determinantes (Ch 4–5):** **desempenho** (latência), **disponibilidade**, **escalabilidade**, **custo** (banda), **elasticidade** para flash crowds.
- **Estilo (Ch 13–17):** uma borda de caches na frente das origens, parecida com **space-based**, com um **plano de controle** separado para roteamento e configuração.
- **Quanta (Ch 7):** cada PoP serve por conta própria; o plano de controle e as origens são quanta separados.
- **Trade-off (First Law, Ch 1):** **atualidade vs taxa de acerto.** TTLs mais longos significam menos requisições à origem e conteúdo mais velho; purge e revalidação compram a atualidade de volta, com um custo.
- **Esboço de ADR (Ch 19):** *"Vamos versionar as URLs dos recursos estáticos e guardá-las em cache por um ano, guardar o HTML por 60 segundos com stale-while-revalidate e fazer purge por tag na publicação. Aceitamos até um minuto de defasagem no HTML em troca de uma alta taxa de acerto."*
- Em linguagem simples: deixe o pão mais vendido na loja do bairro.

---

## Interview questions to practice

1. Projete uma CDN.
2. Como a requisição de um usuário chega a um servidor próximo, e quais são as opções?
3. Como evitar que um objeto novo e popular sobrecarregue a origem?
4. O que entra na chave de cache, e o que dá errado se você errar?
5. Como fazer purge de conteúdo no mundo todo, e quão rápido isso pode ser?
6. Como uma CDN ajuda com conteúdo que não pode ir para o cache?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes.

**Um roteiro de 45 minutos**

1. Esclarecer: tipos de conteúdo, atualidade, velocidade do purge, personalização, geografia.
2. Estimar: banda no pico, taxa de acerto, saída da origem, armazenamento por PoP ([P01](../toolkit/P01-estimation.md)).
3. API: configuração do cliente (origem, regras de cache), API de purge, logs.
4. Design: roteamento (DNS ou anycast), interior do PoP (consistent hashing, memória e disco), camadas, origin shield.
5. Aprofundar: chave de cache e Vary, admissão (segundo acesso), revalidação, fan-out do purge.
6. Falhas e escala: falhas de servidor, de PoP e da origem, flash crowds, tráfego 10×.

**Se crescer 10×**
- Acrescentar PoPs e capacidade por PoP; aumentar o k para conteúdo quente.
- Acrescentar camadas regionais para que os misses da camada superior não atravessem continentes.
- Levar mais decisões para a borda (computação na borda) para conteúdo dinâmico.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Um objeto novo e popular e a origem</summary>

Sem proteção, todos os PoPs dão miss ao mesmo tempo e cada um faz uma busca. Junte os misses concorrentes em cada PoP numa única busca, passe os misses por uma camada superior por origem e pré-aqueça se o lançamento for conhecido. Sirva conteúdo vencido no vencimento enquanto revalida.

</details>

<details><summary>Erros na chave de cache</summary>

Ampla demais (cookies, parâmetros de rastreamento, variações de cabeçalho) e nada dá acerto; estreita demais (ignorando um cabeçalho do qual a resposta depende, como idioma ou autorização) e os usuários recebem o conteúdo errado ou o de outra pessoa. Comece pelo método e pela URI, acrescente só aquilo de que a resposta varia, e normalize.

</details>

<details><summary>Purge global</summary>

Prefira URLs versionadas para que a maior parte das mudanças não precise de purge. Para o resto, publique as requisições de purge (por URL ou tag) num barramento que todo PoP assina, faça cada PoP confirmar e meça o tempo até a última confirmação. Limite os purges para que um cliente não inunde o sistema.

</details>

## 📚 Further reading

- As fontes listadas em Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundário).
- Relacionados neste repositório: [13 Netflix](13-netflix.md) (Open Connect), [12 YouTube](12-youtube.md), [29 Live streaming](29-live-streaming-twitch.md), [32 Distributed cache](32-distributed-cache.md), [P04 Load balancing](../toolkit/P04-load-balancing.md), [C02 Cloudflare 2019](../toolkit/C02-cloudflare-2019.md).

## Sources and provenance

> **Kind:** partes de sistemas reais (Akamai, Cloudflare) e um padrão (RFC 9111), com um design de referência `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-31:** Bruce M. Maggs and Ramesh K. Sitaraman, [*Algorithmic Nuggets in Content Delivery*](https://people.cs.umass.edu/~ramesh/Site/HOME_files/CCRpaper_1.pdf) (ACM SIGCOMM Computer Communication Review, editorial note, 2015) · Cloudflare, [Tiered Cache](https://developers.cloudflare.com/cache/how-to/tiered-cache/), [Revalidation](https://developers.cloudflare.com/cache/concepts/revalidation/) and [Purge cache](https://developers.cloudflare.com/cache/how-to/purge-cache/) (current docs) · IETF, [RFC 9111, HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.txt) (2022).
> **Material datado:** os números da Akamai são de 2015; a documentação da Cloudflare descreve o comportamento atual.
> **Not read:** *The Akamai Network* (2010; o PDF devolveu 403), a RFC 5861, os posts da Cloudflare sobre anycast e rede, a documentação de outras CDNs.
> **Tags:** `[CONFIRMED]` declarado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-10-31, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Akamai paper: the DNS request path, stable-allocation global load balancing, flash crowds, serial numbers and consistent hashing with popularity-dependent k, the peer, parent and origin order, overlay routing for uncacheable content, replicated components with leader election, the 170,000 servers, 1,300 networks, 102 countries and 15 to 30% of web traffic, the one-hit-wonder analysis, the two-filter cache-on-second-hit rule and the 74% to 83% and 44% results.
- Verified in Cloudflare's docs: lower and upper tiers, only upper tiers contacting the origin, Smart and Generic Global selection, the miss burst after origin changes, background revalidation with stale-while-revalidate, the directives that disable it, purge methods, the meaning of a successful purge, and token-bucket purge limits.
- Verified in RFC 9111: shared and private caches, and the cache key.
- Not sourced (our reasoning): the reference design, request collapsing, cache-key policy, versioned URLs, the purge bus, and the capacity arithmetic.
- Not verified: `stale-if-error` (RFC 5861 not read), so its line is tagged speculative.
