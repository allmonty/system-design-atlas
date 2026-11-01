# 42 — Authorization at Scale (Zanzibar) and Identity

*Nota de sistema real a partir do paper do Zanzibar do Google (USENIX ATC 2019) e dos padrões de identidade e acesso delegado (OAuth 2.0, OpenID Connect, JWT), além de um design de referência para um serviço de permissões. Como foi obtido e o que não foi verificado está em **Sources and provenance** perto do final.*

## At a glance

**Em 60 segundos.** Duas perguntas ficam na frente de quase toda requisição: **quem é você?** (autenticação, identidade) e **você pode fazer isso com aquele objeto?** (autorização). A identidade está praticamente resolvida por padrões: um provedor de identidade faz o login dos usuários e emite tokens (o ID Token do OpenID Connect, os tokens de acesso e de refresh do OAuth, muitas vezes JWTs) que os serviços verificam sem uma ida e volta na rede. A autorização é o problema de sistema mais difícil quando as permissões são finas e compartilhadas: documentos em pastas compartilhadas com grupos que contêm grupos. O **Zanzibar** do Google guarda cada permissão como uma **relation tuple** (`doc:readme#viewer@group:eng#member`), deriva as permissões indiretas de regras de reescrita por namespace, responde verificações em milissegundos a partir de dados replicados e usa tokens de consistência (**zookies**) para que uma verificação nunca use permissões mais antigas que o conteúdo que ela protege.

**Números-chave** (conforme publicado, 2019)
- Zanzibar: mais de dois trilhões de ACLs, mais de 1.500 namespaces, milhões de verificações por segundo; latência no 95º percentil abaixo de 10 ms e disponibilidade acima de 99,999% ao longo de 3 anos `[CONFIRMED]`.
- Carga de pico: cerca de 4,2 milhões de requisições Check, 8,2 milhões de Read, 760.000 de Expand e 25.000 de Write por segundo, em mais de 10.000 servidores em algumas dezenas de clusters `[CONFIRMED]`.
- A latência do Check Safe nos percentis 50, 95, 99 e 99,9 tem picos de cerca de 3, 11, 20 e 93 ms `[CONFIRMED]`.

**Decisões e trade-offs**

| Opção | Ponto forte | Ponto fraco |
|---|---|---|
| Permissões dentro de cada serviço | Simples de começar | Semânticas inconsistentes, difícil compartilhar entre apps |
| Serviço central baseado em relações (estilo Zanzibar) | Um modelo, compartilhamento entre apps, verificações consistentes | Uma dependência crítica no caminho da requisição; pontos quentes |
| Acesso por papéis (RBAC) | Fácil de entender | Grosseiro; ruim para compartilhamento por objeto |
| Regras por atributos ou políticas (ABAC) | Condições expressivas | Mais difícil de indexar e de responder "quem pode ver X" |
| Tokens autocontidos (JWT) | Verificados localmente, sem consulta | Difíceis de revogar antes de expirar |
| Tokens opacos com introspecção | Revogáveis na hora | Uma consulta por requisição |

**Erros comuns**
- Colocar permissões num token: elas ficam velhas até ele expirar.
- Verificar autorização num cache sem limite de defasagem (o problema do "new enemy").
- Montar uma busca ou listagem que verifica cada resultado um a um no momento da consulta.
- Confundir autenticação (ID Token) com autorização (token de acesso, verificação de permissão).

---

## 🧒 Non-technical explanation

Um prédio de escritórios grande tem uma recepção que confere seu documento e te dá um crachá de visitante (identidade). Cada sala tem uma lista de convidados em vez de uma fechadura que conhece todo mundo: *a equipe de design pode entrar*, e em outro lugar *a Alice está na equipe de design*. Para saber se você pode entrar, o segurança segue essas listas. E se alguém foi tirado da equipe de design há um minuto, o segurança não pode usar uma cópia velha da lista para uma sala que foi remobiliada depois disso.

---

## TL;DR for engineers

- **Modelo de dados do Zanzibar:** relation tuples `object#relation@user`, em que o usuário pode ser um userset (`group:eng#member`); grupos são só ACLs com semântica de pertencimento `[CONFIRMED]`.
- **Configurações de namespace:** relações por tipo de objeto e regras de **userset rewrite** (por exemplo, editores são leitores; leitores da pasta pai são leitores) `[CONFIRMED]`.
- **API:** Check, Read, Write (com concorrência otimista), Watch (stream de mudanças nas tuplas) e Expand (a árvore do userset efetivo) `[CONFIRMED]`.
- **Consistência:** consistência externa e leituras de snapshot com defasagem limitada sobre o Spanner; os zookies fazem as verificações serem pelo menos tão atuais quanto a versão do conteúdo; a maior parte das verificações roda sobre dados replicados localmente `[CONFIRMED]`.
- **Desempenho:** um cache distribuído dividido por consistent hashing, deduplicação de requisições, hedging, quantização de timestamps e o índice Leopard para grupos profundamente aninhados `[CONFIRMED]`.
- **Identidade:** OAuth 2.0 para acesso delegado, o ID Token do OpenID Connect para autenticação, JWT como formato de token `[CONFIRMED]`.
- **Duração dos tokens, aplicação no gateway, filtragem de listas, isolamento multi-tenant:** design de referência `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcionais:** fazer o login dos usuários · emitir e verificar tokens · guardar permissões (donos, editores, leitores, grupos, pastas aninhadas) · responder *U pode fazer R em O?* · listar o que um usuário pode ver, ou quem pode ver um objeto · auditar mudanças.

**Não funcionais:** **latência** (as verificações estão no caminho crítico; poucos milissegundos) · **disponibilidade** (se a autorização cai, tudo cai) · **correção** (nenhum acesso depois da revogação; nenhuma ACL velha aplicada a conteúdo novo) · **escala** (bilhões de objetos, milhões de verificações por segundo) · **auditabilidade**.

**Perguntas de esclarecimento:** compartilhamento por objeto ou só papéis? Grupos aninhados? Compartilhamento entre aplicações? Com que rapidez a revogação precisa valer? Precisamos de *listar tudo que U pode ver*? Multi-tenant?

---

## 2. Identity: OAuth 2.0, OpenID Connect and JWT `[CONFIRMED]`

O **OAuth 2.0** (RFC 6749) "enables a third-party application to obtain limited access to an HTTP service", em nome de um dono de recurso ou em nome próprio. O servidor de autorização emite um **token de acesso** e, opcionalmente, um **token de refresh**, usado para obter um novo token de acesso quando o atual expira, possivelmente com escopo mais estreito; tokens de acesso podem ter vida mais curta e menos permissões do que o dono do recurso concedeu.

O **OpenID Connect** é "a simple identity layer on top of the OAuth 2.0" protocol. Seu acréscimo principal é o **ID Token**, "a security token that contains Claims about the Authentication of an End-User", representado como um JWT.

O **JWT** (RFC 7519) é uma forma compacta e segura para URL de levar claims como um objeto JSON assinado (JWS) ou criptografado (JWE). Um serviço pode verificar um token assinado com a chave pública do emissor sem chamada de rede, e por isso vidas curtas importam: o token continua válido até expirar.

## 3. Zanzibar's model (2019) `[CONFIRMED]`

O Zanzibar é "a global system for storing and evaluating access control lists" usado por centenas de serviços do Google, entre eles Calendar, Cloud, Drive, Maps, Photos e YouTube. Um sistema unificado dá semânticas consistentes, permite que as aplicações interoperem (um objeto de uma embutido em outra), sustenta infraestrutura compartilhada como um índice de busca que respeita o acesso, e resolve consistência e escala uma vez só.

**Relation tuples.** As ACLs são coleções de relation tuples `⟨object⟩#⟨relation⟩@⟨user⟩`, em que o usuário é um id de usuário ou um userset `⟨object⟩#⟨relation⟩`. Exemplos do paper: `doc:readme#owner@10` (o usuário 10 é dono do doc), `group:eng#member@11`, `doc:readme#viewer@group:eng#member` (membros de eng podem ver), `doc:readme#parent@folder:A#...` (o doc está na pasta A). Grupos são ACLs com semântica de pertencimento, então grupos podem se aninhar.

**Configuração de namespace.** Cada namespace (tipo de objeto) declara relações e regras de **userset rewrite** combinadas por união, interseção e exclusão: `_this` (tuplas diretas), `computed_userset` (outra relação no mesmo objeto: todo dono é editor, todo editor é leitor) e `tuple_to_userset` (seguir uma relação até outro objeto: leitores da pasta pai são leitores do doc). As tuplas guardam os fatos; a configuração guarda a política.

**API.** **Check** avalia uma expressão de userset num snapshot; **Read** devolve tuplas; **Write** muda tuplas, com ler-modificar-escrever usando concorrência otimista por meio de uma tupla de trava; **Watch** transmite as mudanças nas tuplas a partir de um zookie para que os clientes mantenham índices secundários; **Expand** devolve a árvore do userset efetivo.

## 4. Consistency: the "new enemy" problem and zookies `[CONFIRMED]`

Dois exemplos de falha guiam o design: Alice tira Bob de um documento e depois acrescenta conteúdo novo, e Bob o vê porque a verificação usou uma ACL de antes da remoção; ou mudanças de ACL são aplicadas fora de ordem. O Zanzibar precisa respeitar a ordem causal entre atualizações de ACL e de conteúdo, então oferece **consistência externa** e **leituras de snapshot com defasagem limitada**, guardando as ACLs no **Spanner**, cujos timestamps do TrueTime refletem a ordem causal.

Para evitar idas e voltas globais, os clientes cooperam: quando um conteúdo vai ser salvo, o cliente pede um **zookie**, um token opaco que codifica um timestamp global posterior a todas as escritas de ACL anteriores, e o guarda de forma atômica junto com o conteúdo. As verificações seguintes sobre esse conteúdo enviam o zookie, e o Zanzibar avalia num snapshot pelo menos tão atual quanto ele, que normalmente já está replicado localmente. A liberdade de escolher qualquer timestamp atual o bastante também permite quantizar os timestamps para compartilhar entradas de cache.

## 5. Architecture and performance `[CONFIRMED]`

Os **aclservers** em clusters respondem Check, Read, Expand e Write; uma requisição cai em qualquer servidor, que distribui o trabalho para outros (por exemplo, para percorrer grupos aninhados). O Spanner guarda um banco de relation tuples por namespace de cliente, um para todas as configurações de namespace e um changelog compartilhado por todos os namespaces; os watchservers acompanham o changelog, e um pipeline offline gera dumps de snapshots dos namespaces.

Os pontos quentes foram "the most critical frontier" para latência e disponibilidade. Os servidores de um cluster formam um **cache distribuído** de leituras e resultados de verificação, inclusive resultados intermediários, posicionados por **consistent hashing**; requisições idênticas simultâneas são **deduplicadas**; os timestamps são quantizados para que as requisições compartilhem entradas de cache. As chamadas ao Spanner e ao Leopard usam **request hedging**: mandar para vários servidores, usar a primeira resposta, cancelar o resto. Cache e agrupamento agressivos mantêm as leituras no Spanner em cerca de 20 milhões de RPCs por segundo; 1% delas (200.000 por segundo) se beneficiam do hedging. O **Leopard** é um sistema de indexação para conjuntos grandes e profundamente aninhados: ele lê snapshots periódicos, acompanha as mudanças e desnormaliza o pertencimento a grupos para responder rápido a consultas de conjuntos.

---

## 6. Reference design `[INDUSTRY PATTERN]`

- **Provedor de identidade:** login (senhas, passkeys, federação), MFA, sessões; emite tokens de acesso de vida curta e tokens de refresh de vida mais longa; publica as chaves de assinatura para verificação local e as rotaciona.
- **Gateway:** verifica a assinatura, o público e a validade do token, rejeita cedo e repassa o id do usuário; nunca confia em permissões dentro do token para acesso a objetos.
- **Serviço de permissões (estilo Zanzibar):** tuplas num banco fortemente consistente e replicado; configurações de namespace como código revisado; Check com uma indicação de consistência (um token tipo zookie guardado com cada objeto, ou "mais recente" para escritas sensíveis); um cache dividido por consistent hashing.
- **Filtragem de listas e buscas:** um índice alimentado pelo Watch (como o Leopard) ou visões materializadas por usuário para *o que U pode ver*; pós-filtrar resultados de busca com verificações em lote.
- **Revogação:** apagar tuplas (vale na próxima verificação num snapshot atual); para tokens, vidas curtas mais uma lista de bloqueio para casos urgentes.
- **Auditoria:** toda mudança de tupla registrada com quem e por quê.
- **Multi-tenancy:** id do tenant em todo id de objeto e namespace, para que uma verificação esquecida não atravesse tenants (veja [P14 Multi-tenancy](../toolkit/P14-multi-tenancy.md)).

---

## 7. Failure scenarios

- **New enemy.** Uma verificação usa uma ACL mais velha que o conteúdo; evitado ao avaliar num snapshot pelo menos tão atual quanto o zookie do conteúdo `[CONFIRMED]`.
- **Grupo ou objeto quente.** Um grupo popular sobrecarrega o armazenamento; cache de resultados intermediários, deduplicação e quantização de timestamps espalham a carga `[CONFIRMED]`.
- **Réplica lenta no backend.** Requisições com hedging cortam a cauda `[CONFIRMED]` (veja a seção de latência de cauda do [P07](../toolkit/P07-slos-and-incidents.md)).
- **Serviço de permissões indisponível.** Falhar fechado para escritas e leituras sensíveis; considerar uma permissão em cache de vida curta para leituras de baixo risco, registrada em log `[INDUSTRY PATTERN]`.
- **Chave de assinatura vazada.** Rotacionar a chave e revogar os tokens assinados com ela; os serviços devem buscar as chaves por id, não fixá-las no código `[INDUSTRY PATTERN]`.
- **Os clientes veem latência pior que a reportada pelo serviço.** O Zanzibar mede a latência do lado do servidor, em parte porque os jobs dos clientes estão fora do seu controle e às vezes sobrecarregados; meça dos dois lados antes de culpar qualquer um `[CONFIRMED]` para a escolha da medição / `[INDUSTRY PATTERN]` para o conselho.

---

## 8. Capacity reasoning (illustrative)

- As leituras de pico do Zanzibar (Check mais Read, cerca de 12,4 milhões por segundo) contra 25.000 escritas dão cerca de 500 leituras por escrita, e por isso ele otimiza para leitura e cache (nossa conta sobre os números do paper).
- Um app de documentos com 100 milhões de usuários, cada um abrindo 50 objetos por dia com 3 verificações por abertura, faz 15 bilhões de verificações por dia, cerca de 174.000 por segundo em média.
- Dois trilhões de tuplas a 50 bytes cada (suposição) dão cerca de 100 TB antes da replicação; o paper não informa o tamanho das tuplas.

---

## ⚠️ Reviewer notes

1. **Os números do Zanzibar são de 2019 (medições de dezembro de 2018)** e descrevem o sistema do Google naquela época.
2. **Existem sistemas open source inspirados no Zanzibar** (SpiceDB, OpenFGA e outros); não lemos a documentação deles e não afirmamos nada sobre eles.
3. **Artigos de entrevista costumam reduzir autorização a RBAC.** O Zanzibar mostra que permissões compartilhadas, aninhadas e por objeto precisam de um modelo de relações e de consistência explícita.
4. **Não lemos a OAuth 2.0 Security Best Current Practice nem os rascunhos do OAuth 2.1**, que mudam os fluxos recomendados (por exemplo, PKCE para todos os clientes).

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Nossa análise, não das fontes. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características determinantes (Ch 4–5):** **segurança**, **disponibilidade**, **desempenho** (caminho crítico), **consistência**, **auditabilidade**.
- **Estilo (Ch 13–17):** um **serviço de plataforma** compartilhado por trás de todo produto; identidade na borda (gateway), autorização como serviço central.
- **Quanta (Ch 7):** o provedor de identidade e o serviço de permissões são quanta separados dos quais quase todos os outros dependem, então precisam das metas de disponibilidade mais rígidas.
- **Trade-off (First Law, Ch 1):** **atualidade vs latência.** Verificar no snapshot mais recente é sempre correto e lento; os zookies permitem que a maioria das verificações use um snapshot um pouco mais velho que ainda é comprovadamente atual o bastante.
- **Esboço de ADR (Ch 19):** *"Vamos guardar as permissões como relation tuples num único serviço, avaliar as verificações num snapshot não mais velho que o token de consistência guardado com o objeto, e manter os tokens de acesso JWT em 10 minutos, sem permissões de objeto dentro deles. Aceitamos uma dependência central em troca de permissões consistentes, revogáveis e compartilháveis."*
- Em linguagem simples: a lista de convidados na porta, mantida em dia, é melhor que um crachá que lista todas as salas.

---

## Interview questions to practice

1. Projete o sistema de permissões do Google Drive.
2. Como fazer uma revogação valer imediatamente?
3. Como mostrar a um usuário só os documentos que ele pode ver nos resultados de busca?
4. JWT ou tokens opacos? Como revogar um JWT?
5. Autenticação versus autorização: onde cada uma acontece no seu design?
6. O serviço de permissões caiu. O que acontece com o produto?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes.

**Um roteiro de 45 minutos**

1. Esclarecer: modelo de compartilhamento, aninhamento, entre apps, velocidade de revogação, necessidade de listagens, tenants.
2. Estimar: verificações por segundo, tuplas, proporção de leituras para escritas ([P01](../toolkit/P01-estimation.md)).
3. API: `check(object, relation, user, consistency)`, `write(tuples)`, `read(filter)`, `watch(namespace, from)`, `expand(object, relation)`.
4. Design: provedor de identidade e tokens, verificação no gateway, banco de tuplas, configurações de namespace, avaliação de verificações com cache, índices alimentados pelo Watch.
5. Aprofundar: new enemy e tokens de consistência; grupos aninhados e pontos quentes.
6. Falhas e escala: serviço fora do ar, grupos quentes, rotação de chaves, 10× verificações.

**Se crescer 10×**
- Mais capacidade de cache por cluster e mais clusters perto da carga.
- Índices desnormalizados para grupos profundos (estilo Leopard).
- Verificações em lote para listagens; levar a filtragem para os índices.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Revogação imediata</summary>

Apague a tupla e faça a próxima verificação daquele objeto ser avaliada num snapshot pelo menos tão novo quanto a remoção. O Zanzibar faz isso guardando um token de consistência com cada versão do conteúdo e permitindo que quem chama peça uma avaliação atual. Não dependa de tokens de vida longa que carregam permissões; mantenha os tokens de acesso curtos e verifique as permissões de objeto no servidor.

</details>

<details><summary>Resultados de busca que um usuário pode ver</summary>

Verificar cada resultado no momento da consulta é lento para conjuntos grandes. Mantenha um índice que respeita o acesso, alimentado pelo stream de mudanças de permissão (a API Watch do Zanzibar existe para isso), filtre no índice e depois confirme os primeiros resultados com verificações em lote.

</details>

<details><summary>Revogação de JWT</summary>

Um JWT assinado é válido até expirar, por design. Mantenha vidas curtas, renove com um token de refresh que o servidor pode revogar, mantenha uma pequena lista de bloqueio para emergências e nunca ponha permissões de objeto no token.

</details>

## 📚 Further reading

- As fontes listadas em Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundário).
- Relacionados neste repositório: [33 Coordination](33-distributed-coordination-locks.md), [32 Distributed cache](32-distributed-cache.md), [06 File sync (Dropbox)](06-file-sync-dropbox.md), [P06 Security](../toolkit/P06-security-threat-modeling.md), [P14 Multi-tenancy](../toolkit/P14-multi-tenancy.md), [P16 Consistency](../toolkit/P16-consistency-and-cache-failures.md).

## Sources and provenance

> **Kind:** sistema real (Zanzibar do Google) e padrões (OAuth 2.0, OpenID Connect, JWT), com um design de referência `[INDUSTRY PATTERN]`.
> **Sources read on 2026-11-01:** Ruoming Pang et al., [*Zanzibar: Google's Consistent, Global Authorization System*](https://www.usenix.org/system/files/atc19-pang.pdf) (USENIX ATC, July 2019) · IETF, [RFC 6749, The OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749.txt) (2012) · OpenID Foundation, [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) · IETF, [RFC 7519, JSON Web Token](https://www.rfc-editor.org/rfc/rfc7519.txt) (2015).
> **Material datado:** as medições do Zanzibar são de dezembro de 2018; a RFC 6749 é de 2012 e tem atualizações de boas práticas posteriores, não lidas aqui.
> **Not read:** OAuth 2.0 Security BCP, OAuth 2.1, PKCE (RFC 7636), WebAuthn e passkeys, documentação do SpiceDB e do OpenFGA, os internos do Leopard além do paper.
> **Tags:** `[CONFIRMED]` declarado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-11-01, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Zanzibar paper: the client services, the reasons for a unified system, relation tuples and the Table 1 examples, groups as ACLs, namespace configs and userset rewrites (`_this`, `computed_userset`, `tuple_to_userset`), the Check, Read, Write, Watch and Expand APIs, optimistic concurrency with a lock tuple, the new enemy examples, external consistency and bounded-staleness snapshots on Spanner, zookies, aclservers and watchservers, the distributed cache with consistent hashing, deduplication, quantised timestamps, hedging, Leopard, and the numbers (two trillion ACLs, 1,500 namespaces, peak QPS by API, 10,000 servers, latency percentiles, 99.999%, 20 million Spanner RPCs, 1% hedged).
- Verified in RFC 6749: the abstract, refresh tokens and narrower-scope access tokens; in OpenID Connect Core: the identity layer and the ID Token as a JWT; in RFC 7519: the JWT definition.
- Not sourced (our reasoning): the reference design, token lifetimes, gateway behaviour, deny lists, fail-closed policy, list filtering, multi-tenant ids and the capacity arithmetic.
- Not claimed: how Google's Zanzibar runs today, or how any open-source Zanzibar-inspired system works.
