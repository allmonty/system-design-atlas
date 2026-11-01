# 40 — Video Conferencing

*Nota de sistema real a partir da arquitetura de voz e vídeo do Discord (2018), do paper "Last N" do Jitsi (NOSSDAV 2015) e dos documentos do IETF sobre topologias RTP, ICE e TURN, além de um design de referência para um serviço de reuniões. Como foi obtido e o que não foi verificado está em **Sources and provenance** perto do final.*

## At a glance

**Em 60 segundos.** Uma chamada de vídeo leva mídia em tempo real entre os participantes, então a latência vale mais que a completude: um pacote atrasado é inútil. Duas pessoas podem falar peer to peer; grupos precisam de um servidor. Um **mixer (MCU)** decodifica todo mundo, compõe um único stream e codifica de novo (muita CPU, clientes simples); uma **selective forwarding unit (SFU)** repassa os pacotes sem decodificar e escolhe quais streams cada participante recebe (pouca CPU, mais trabalho no cliente). As SFUs dominam hoje, e a decisão-chave é a **política de seleção**: repassar só os N últimos a falar, e escolher uma resolução que cada receptor aguente. Em volta da SFU ficam a sinalização (quem está na chamada, qual servidor), a travessia de NAT (ICE com STUN e relays TURN) e um plano de controle que coloca as chamadas nos servidores e as move quando um servidor falha.

**Números-chave** (conforme publicado)
- Last N do Jitsi: uma SFU repassando 10 de 30 participantes usou 45% menos CPU e 63% menos banda que repassar todos para todos `[CONFIRMED]`.
- Discord (2018): mais de 850 servidores de voz em 13 regiões (mais de 30 data centers), mais de 2,6 milhões de usuários de voz simultâneos, saída acima de 220 Gbps e 120 milhões de pacotes por segundo `[CONFIRMED]`.
- Os clientes nativos do Discord trocam cerca de 1.000 bytes para entrar num canal de voz, em vez de SDP que pode chegar perto de 10 KB ida e volta `[CONFIRMED]`.

**Decisões e trade-offs**

| Opção | Ponto forte | Ponto fraco |
|---|---|---|
| Malha peer-to-peer | Sem servidores de mídia | O upload cresce com os participantes; expõe IPs |
| Mixer (MCU) | Um stream por cliente, fácil para clientes fracos | Decodificar e recodificar para todos: pesado em CPU, acrescenta latência |
| Encaminhamento seletivo (SFU) | Sem transcodificação, baixa latência, CPU barata | Clientes decodificam vários streams; precisa de uma política de seleção |
| Repassar todos os streams | Simples | O tráfego no servidor cresce de forma quadrática |
| Repassar os N últimos a falar | Tráfego limitado, combina com o que as pessoas assistem | Precisa de uma boa detecção de quem está falando |
| UDP direto | Menor latência | Falha atrás de alguns NATs e firewalls |
| Relay TURN como fallback | Funciona em quase todo lugar | Um salto a mais e custo de banda no relay |

**Erros comuns**
- Projetar uma chamada em grupo como uma malha de conexões peer.
- Mandar mídia com entrega confiável estilo TCP e esperar retransmissões.
- Repassar todos os streams de vídeo para todos os participantes em reuniões grandes.
- Esquecer que sinalização e mídia são caminhos diferentes: uma queda na sinalização não precisa derrubar a mídia, e a falha de um servidor de mídia exige reatribuição via sinalização.

---

## 🧒 Non-technical explanation

Imagine uma reunião por walkie-talkie passando por uma telefonista. Ela não repete o que as pessoas dizem; só mexe nas chaves para que cada ouvinte escute quem está falando agora, no máximo poucos de cada vez. Se o rádio de alguém está fraco, ela manda para essa pessoa uma cópia de qualidade menor. Se a mesa dela quebra, todo mundo é avisado para sintonizar outra telefonista, que já sabe quem estava na sala.

---

## TL;DR for engineers

- **Topologias (RFC 7667):** malha, media-mixing mixer, media-switching mixer e a **Selective Forwarding Middlebox**, que disponibiliza cada fonte para cada endpoint e seleciona quais fontes ativas cada um recebe `[CONFIRMED]`.
- **Last N (Jitsi):** uma SFU ordena os endpoints pela atividade de áudio, repassa vídeo só dos N últimos falantes dominantes e mantém CPU e banda limitadas `[CONFIRMED]`.
- **Discord:** cliente-servidor (não peer to peer) para canais grandes, privacidade de IP e moderação; sinalização em Elixir mais uma SFU em C++ por servidor de voz; alocação ciente de carga via etcd; reatribuição rápida em falhas ou DDoS `[CONFIRMED]`.
- **ICE e TURN:** reunir endereços candidatos e testar a conectividade; recorrer a um relay quando os caminhos diretos falham `[CONFIRMED]`.
- **Camadas de simulcast, estimativa de banda por receptor, SFUs em cascata entre regiões, gravação:** design de referência `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcionais:** criar e entrar em reuniões · áudio, vídeo e compartilhamento de tela · ver quem está falando · silenciar e moderar · chat · (opcionalmente) gravar.

**Não funcionais:** **latência** (da boca ao ouvido bem abaixo de algumas centenas de milissegundos) · **qualidade sob perda e jitter** · **escala** (de 2 a centenas de participantes, milhões de usuários simultâneos) · **disponibilidade** (sobreviver à falha de um servidor de mídia no meio da chamada) · **privacidade e segurança** (criptografia, sem vazar IPs).

**Perguntas de esclarecimento:** tamanho máximo da reunião? Vídeo para todos ou principalmente áudio? Suporte a navegador? Gravação? Criptografia ponta a ponta é obrigatória (ela limita o que os servidores podem fazer)?

---

## 2. Topologies and why SFUs won `[CONFIRMED]`

A RFC 7667 cataloga as topologias RTP. Numa **malha**, cada endpoint manda seus streams para todos os outros endpoints por fluxos separados. Um **media-mixing mixer** produz mídia nova a partir das entradas (a ponte de áudio clássica). Uma **Selective Forwarding Middlebox** disponibiliza todas as fontes possíveis para cada endpoint e seleciona quais das fontes que estão transmitindo são enviadas para cada um, e a RFC liga essas arquiteturas ao scalable video coding e ao simulcast.

O paper do Last N expõe o trade-off: numa malha, "the endpoints quickly exhaust their available upstream bandwidth"; MCUs que misturam áudio e combinam vídeo precisam de muita computação; SFUs "forward RTP packets, optionally changing their headers, but without processing the payload", então são mais eficientes em CPU, e ficam eficientes em banda ao selecionar o que repassar. Repassar tudo para todos cresce de forma quadrática com os participantes no servidor, e os clientes não conseguem exibir nem decodificar tantos streams.

## 3. Last N: selecting what to forward (Jitsi, 2015) `[CONFIRMED]`

O Last N ordena os endpoints pela atividade de áudio usando um algoritmo de falante dominante sobre os níveis de áudio, e repassa vídeo só dos N falantes mais recentes (mais qualquer participante que um usuário fixar). Na avaliação, repassar para 10 endpoints numa conferência de 30 participantes usou 45% menos CPU e 63% menos banda que um encaminhador em estrela completa. A detecção do falante dominante precisa evitar trocar por ruídos curtos e não deixar um participante barulhento dominar de forma injusta.

## 4. Discord's voice and video (2018) `[CONFIRMED]`

Toda chamada no Discord é multipartidária, com canais de até 1.000 pessoas se revezando, então ele usa rede cliente-servidor: "peer-to-peer networking becomes prohibitively expensive as the number of participants increases". Passar pelos servidores do Discord também esconde os endereços IP dos usuários (protegendo-os de DDoS) e permite moderação, como silenciar um participante no servidor.

**Clientes.** Navegadores usam o WebRTC do navegador; os apps de desktop e celular usam um motor de mídia em C++ construído sobre a biblioteca nativa do WebRTC. Os clientes nativos dispensam o SDP (trocando cerca de 1.000 bytes de configuração), dispensam o ICE porque todo cliente se conecta a um servidor de relay conhecido, usam Salsa20 em vez de DTLS/SRTP e não mandam nada durante o silêncio para economizar banda e CPU. O backend de voz faz a ponte entre clientes de navegador e nativos.

**Backend.** Os serviços de sinalização são em Elixir. Os clientes mantêm um WebSocket com o Gateway; entrar num canal de voz faz o serviço Guilds escolher um servidor de voz: os servidores de voz reportam saúde e carga no etcd, e o Guilds "assigns the least utilized voice server in the given region to the guild". O cliente abre um segundo WebSocket com esse servidor de voz para configurar a mídia. Cada servidor de voz tem um componente de sinalização e uma SFU própria em C++, que repassa áudio e vídeo, descarta pacotes de usuários silenciados no servidor, traduz entre os transportes do navegador e dos nativos e cuida do RTCP para a qualidade do vídeo.

**Tratamento de falhas.** Se o processo da SFU cai, o componente de sinalização o reinicia e reconstrói seu estado sem envolver os clientes (o mesmo mecanismo dá atualizações da SFU sem downtime). Se um servidor de voz morre, ele falha no ping e sai da descoberta de serviços; os clientes percebem o WebSocket quebrado; o Guilds atribui um servidor novo, envia o estado de voz para ele, e os clientes se reconectam. Um DDoS num servidor de voz recebe o mesmo tratamento; trocar a região de uma guild também.

## 5. NAT traversal: ICE and TURN `[CONFIRMED]`

O ICE é um protocolo de travessia de NAT para comunicação baseada em UDP que usa STUN e TURN. Atrás de um NAT, a RFC diz que "can be impossible for that host to communicate directly with other hosts", então o TURN permite trocar pacotes com os pares através de um relay, e permite que um cliente alcance vários pares por um único endereço de relay. Os navegadores reúnem candidatos (local, server-reflexive via STUN, relayed via TURN) e testam pares para escolher um caminho. Com uma SFU, a própria SFU é a outra ponta; os apps nativos do Discord dispensam o ICE porque o endereço do servidor é conhecido.

---

## 6. Reference design `[INDUSTRY PATTERN]`

- **Serviço de sinalização:** participantes da reunião, permissões e atribuição da reunião a uma SFU (por região e carga); WebSocket com os clientes; estado guardado fora da SFU para que uma substituta possa ser montada rápido.
- **Frota de SFUs:** encaminhadores de mídia com pouco estado em muitas regiões; uma reunião numa SFU, ou SFUs **em cascata** entre regiões para reuniões globais, cada uma repassando uma cópia de um stream para a outra.
- **Simulcast:** cada remetente codifica duas ou três resoluções; a SFU repassa a camada que a estimativa de banda de cada receptor permite, e só para os quadros visíveis.
- **Seleção:** os N últimos a falar, mais os streams fixados e de compartilhamento de tela; áudio dos poucos falantes principais.
- **Servidores TURN** para clientes que não alcançam a SFU por UDP (TURN sobre TCP ou TLS na porta 443).
- **Gravação:** um participante robô recebe os streams da SFU e os mistura offline, para que a gravação não pese no caminho ao vivo.
- **Telemetria:** os clientes reportam métricas de qualidade (perda, jitter, tempo congelado), como o Discord faz, para alertas e alocação.

---

## 7. Failure scenarios

- **O processo da SFU cai.** Reiniciar e reconstruir a partir do estado da sinalização, com poucos pacotes perdidos `[CONFIRMED]` (Discord).
- **O servidor de voz ou o host morre.** Removido da descoberta, reunião reatribuída, clientes se reconectam `[CONFIRMED]` (Discord).
- **DDoS num servidor de mídia.** A mesma reatribuição; o servidor atacado volta quando o ataque termina `[CONFIRMED]` (Discord).
- **A rede de um participante piora.** Ele recebe uma camada de simulcast menor ou só áudio; envia menos camadas `[INDUSTRY PATTERN]`.
- **UDP bloqueado por um firewall corporativo.** Recorrer ao TURN sobre TCP ou TLS; a qualidade sofre com o bloqueio de cabeça de fila `[CONFIRMED]` para o TURN / `[INDUSTRY PATTERN]` para o fallback.
- **Queda da sinalização.** A mídia em andamento pode continuar, mas entradas e reatribuições param; deixe a sinalização altamente disponível e separada da mídia `[INDUSTRY PATTERN]`.

---

## 8. Capacity reasoning (illustrative)

- Um stream de 720p a cerca de 1,5 Mbit/s repassado para 9 receptores dá 13,5 Mbit/s de saída para um remetente; com os 10 participantes enviando, cerca de 135 Mbit/s para uma reunião. O Last N com N = 4 e miniaturas menores corta isso várias vezes (nossa conta).
- Áudio a cerca de 40 kbit/s é barato; a supressão de silêncio importa mais para a taxa de pacotes que para os bytes (os 120 milhões de pacotes por segundo do Discord mostram que a taxa de pacotes é um limite real).
- Na escala do Discord em 2018, 220 Gbps sobre 2,6 milhões de usuários dá cerca de 85 kbit/s por usuário em média, coerente com uso principalmente de áudio.

---

## ⚠️ Reviewer notes

1. **O post do Discord é de 2018** e descreve um uso dominado por voz; vídeo em canais grandes veio depois e não é coberto aqui. A nota [09 Discord](09-discord.md) usa o mesmo post.
2. **Os números do Last N vêm de um ambiente de teste de 2015**, não de uma frota em produção.
3. **Artigos populares costumam descrever a arquitetura do Zoom em detalhe.** Não lemos uma fonte primária do Zoom; nada aqui descreve o Zoom.
4. **A criptografia ponta a ponta** conflita com a mixagem no servidor e com alguns recursos da SFU; esta nota não cobre designs com E2EE (veja [08 Chat](08-chat-whatsapp.md) para E2EE em mensagens).

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Nossa análise, não das fontes. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características determinantes (Ch 4–5):** **latência**, **disponibilidade**, **escalabilidade**, **custo** (saída de dados), **segurança** (privacidade de IP, criptografia).
- **Estilo (Ch 13–17):** um **plano de controle** (sinalização, alocação) separado de um **plano de dados** (SFUs, TURN), como em [13 Netflix](13-netflix.md) e [29 Live streaming](29-live-streaming-twitch.md).
- **Quanta (Ch 7):** cada SFU é seu próprio quantum; as reuniões são divididas entre elas.
- **Trade-off (First Law, Ch 1):** **CPU do servidor vs trabalho e banda do cliente.** Mixers gastam CPU do servidor para simplificar os clientes; SFUs empurram a decodificação para os clientes e gastam banda.
- **Esboço de ADR (Ch 19):** *"Vamos usar SFUs regionais com simulcast e seleção dos N últimos, sinalização num serviço separado capaz de reconstruir o estado de uma SFU, e TURN sobre TLS como fallback. Aceitamos a decodificação de até N streams no cliente em troca de nenhuma transcodificação no servidor."*
- Em linguagem simples: mexa nas chaves, não repita as palavras.

---

## Interview questions to practice

1. Projete o Zoom ou o Google Meet.
2. Malha, MCU ou SFU: quando usar cada um?
3. Como suportar uma reunião de 300 pessoas?
4. Um participante está numa conexão móvel ruim. O que muda para ele?
5. O servidor de mídia que hospeda uma reunião morre. O que acontece em seguida?
6. Como os clientes atrás de firewalls rígidos se conectam?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes.

**Um roteiro de 45 minutos**

1. Esclarecer: tamanho da reunião, proporção de vídeo, navegadores, gravação, criptografia.
2. Estimar: streams por reunião, saída por SFU, reuniões simultâneas por servidor ([P01](../toolkit/P01-estimation.md)).
3. API: criar reunião, entrar (devolve o endereço da SFU e credenciais), mensagens de sinalização via WebSocket.
4. Design: sinalização, alocação, frota de SFUs, TURN, simulcast e seleção, robô de gravação.
5. Aprofundar: seleção dos N últimos e falante dominante; estimativa de banda e troca de camada.
6. Falhas e escala: queda da SFU, morte do servidor, DDoS, firewalls, 10× reuniões, reuniões de 300 pessoas.

**Se crescer 10×**
- Mais SFUs por região e alocação mais justa por carga.
- SFUs em cascata para reuniões grandes ou globais.
- Modo webinar: poucos remetentes, muitos receptores, possivelmente passando para um caminho de broadcast ([29 Live streaming](29-live-streaming-twitch.md)).

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Malha, MCU ou SFU</summary>

Malha para duas ou três pessoas quando você não quer servidores de mídia. MCU quando os clientes são muito fracos ou precisam de um único stream composto (sistemas de sala legados, entrada por telefone), aceitando CPU no servidor e latência a mais. SFU para quase todo o resto: sem transcodificação, e uma política de seleção mantém a banda limitada.

</details>

<details><summary>O servidor de mídia morre</summary>

A sinalização percebe (health checks perdidos ou conexões de clientes caídas), escolhe uma SFU nova na região, envia para ela o estado da reunião e manda os clientes se reconectarem; a mídia volta depois de uma pequena interrupção. Guarde o estado da reunião na sinalização, não só na SFU, para que uma substituta comece já aquecida, como o Discord faz.

</details>

<details><summary>300 participantes</summary>

A maioria das pessoas não envia vídeo; repasse áudio dos poucos falantes principais e vídeo dos N últimos mais os fixados e o compartilhamento de tela, como miniaturas na camada baixa do simulcast. Ponha SFUs em cascata se a audiência atravessa regiões, e considere um modo de broadcast para espectadores passivos.

</details>

## 📚 Further reading

- As fontes listadas em Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundário).
- Relacionados neste repositório: [09 Discord](09-discord.md), [08 Chat](08-chat-whatsapp.md), [29 Live streaming](29-live-streaming-twitch.md), [21 Game matchmaking](21-game-matchmaking-lobby-chat.md), [P04 Load balancing](../toolkit/P04-load-balancing.md).

## Sources and provenance

> **Kind:** sistema real (voz e vídeo do Discord) com pesquisa (Last N do Jitsi), padrões (RFC 7667, RFC 8445, RFC 8656) e um design de referência `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-31:** Jozsef Vass, [*How Discord Handles Two and Half Million Concurrent Voice Users using WebRTC*](https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc) (Discord, 10 September 2018) · Boris Grozev, Lyubomir Marinov, Varun Singh and Emil Ivov, [*Last N: Relevance-Based Selectivity for Forwarding Video in Multimedia Conferences*](https://jitsi.org/wp-content/uploads/2016/12/nossdav2015lastn.pdf) (NOSSDAV 2015) · IETF, [RFC 7667, RTP Topologies](https://www.rfc-editor.org/rfc/rfc7667.txt) (2015), [RFC 8445, ICE](https://www.rfc-editor.org/rfc/rfc8445.txt) (2018) and [RFC 8656, TURN](https://www.rfc-editor.org/rfc/rfc8656.txt) (2020).
> **Material datado:** Discord 2018, Jitsi 2015; as RFCs são padrões atuais.
> **Not read:** material de engenharia do Zoom, do Google Meet ou do Microsoft Teams, a RFC 8853 de simulcast, papers de controle de congestionamento do WebRTC (GCC), especificações de SVC.
> **Tags:** `[CONFIRMED]` declarado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-10-31, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Discord post: multiparty client-server design and its reasons, the native media engine, SDP and ICE skipped by native clients with about 1,000 bytes of setup, Salsa20, silence suppression, Elixir signaling, Gateway and voice WebSockets, etcd-based least-utilized placement, the C++ SFU and its duties, SFU restart, server failover, DDoS and region change handling, and the 850 servers, 13 regions, 2.6 million users, 220 Gbps and 120 Mpps.
- Verified in the Last N paper: the mesh, MCU and SFU comparison, the dominant-speaker ordering, the quadratic growth, and the 45% CPU and 63% bandwidth result.
- Verified in RFC 7667: mesh, mixer and Selective Forwarding Middlebox topologies and the link to simulcast and SVC; in RFC 8445 and RFC 8656: ICE's purpose and TURN's relay role.
- Not sourced (our reasoning): the reference design, simulcast layer choice, cascading, recording bot, firewall fallback, and the capacity arithmetic.
- Not claimed: how Zoom, Google Meet or Teams are built.
