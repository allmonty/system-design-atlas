# P17 — Privacy by design for system architects

*Um primer sobre como transformar requisitos de privacidade em arquitetura: o que a obrigação europeia de proteção de dados desde a concepção e por padrão exige (na interpretação do European Data Protection Board), como o NIST enquadra o risco de privacidade, e como a Meta impõe a limitação de finalidade no código. Afirmações desses documentos estão marcadas; os padrões de design e os conselhos de entrevista são raciocínio nosso e estão sinalizados.*

## At a glance

- Privacidade é uma propriedade dos **fluxos de dados**, não de um banco. Um design é privado quando você consegue dizer, para cada dado pessoal, por que ele é coletado, para onde vai, quem pode usá-lo para quê e quando ele é apagado.
- O Artigo 25 do GDPR torna isso uma obrigação: incorporar os princípios de proteção de dados ao design "at the time of determination of the means for processing", e por padrão tratar só o que cada finalidade precisa.
- Quatro princípios viram arquitetura: **minimização de dados** (coletar e guardar menos), **limitação de finalidade** (usar os dados só para a finalidade declarada), **limitação de armazenamento** (apagar no prazo, incluindo backups e logs) e **segurança** (proteger o que sobra).
- Verificações pontuais (um `if` no código, uma ACL numa tabela) não acompanham o dado depois que ele é copiado. A Meta passou para o **controle de fluxo de informação**: rotular os dados e deixar a infraestrutura bloquear em tempo de execução os fluxos para finalidades não permitidas.
- Numa entrevista, a privacidade aparece como escolhas concretas de design: o que você não coleta, o que você agrega ou pseudonimiza, por onde a exclusão se propaga e como você prova isso.

---

## 1. What the law asks of the design `[CONFIRMED]` (EDPB Guidelines 4/2019 on Article 25)

O EDPB descreve a "core obligation" como "the implementation of appropriate measures and necessary safeguards that provide effective implementation of the data protection principles" e dos direitos dos titulares, desde a concepção e por padrão.

- **Quando:** no momento em que os meios de tratamento são decididos, que o EDPB diz ir dos elementos gerais aos detalhados do design, "including the architecture, procedures, protocols, layout and appearance". Vale também durante o tratamento (as medidas precisam ser revistas com regularidade) e "also applies to existing systems that are processing personal data".
- **Por padrão:** só são tratados os dados pessoais necessários para cada finalidade específica, e os dados pessoais não podem ficar acessíveis "to an indefinite number of natural persons" sem a intervenção da pessoa. Uma configuração de compartilhamento que começa como pública não cumpre isso.
- **Minimização de dados:** o controlador deve primeiro decidir se precisa de dados pessoais, e se "less detailed or aggregated personal data" bastariam; quando a identificação deixa de ser necessária (por exemplo, depois de agregar em estatísticas), apagar ou anonimizar.
- **Elementos de limitação de armazenamento** listados pelo EDPB: procedimentos claros de exclusão e anonimização, testes de que dados anonimizados não podem ser reidentificados e dados apagados não podem ser recuperados, exclusão **automatizada**, um prazo de retenção justificado por finalidade, aplicação das políticas de retenção, e decisões de retenção para **backups e logs**; os controladores devem limitar as cópias "temporárias" ao longo dos fluxos de dados.

## 2. How NIST frames privacy risk `[CONFIRMED]` (NIST Privacy Framework 1.0, 2020)

O NIST trata os eventos de privacidade como problemas que as pessoas podem sofrer com as operações de um sistema sobre dados, ao longo de todo o ciclo de vida, da coleta ao descarte. Seu Core tem cinco Functions: **Identify-P** (inventariar e mapear o tratamento de dados), **Govern-P**, **Control-P** (gerenciar os dados com granularidade suficiente para lidar com o risco), **Communicate-P** e **Protect-P**; o Protect-P cobre eventos de privacidade ligados à cibersegurança, como vazamentos. O ponto para arquitetos: a segurança protege os dados de quem está de fora, mas o risco de privacidade também vem do tratamento autorizado, então ele precisa de controles próprios.

## 3. Purpose limitation in infrastructure: Meta's Policy Zones `[CONFIRMED]` (Meta Engineering, August 2024)

A Meta descreve a **limitação de finalidade** como garantir que "data is only processed for explicitly stated purposes". Verificações pontuais (ifs no código, controles de acesso em datasets) são frágeis: precisam de "frequent and exhaustive code audits", e quando um job lê de uma origem e grava num destino, a restrição tem de ser propagada à mão. Acrescentar **linhagem de dados** (rastrear fluxos de origem para destino por análise estática, logs e processamento de consultas) ajuda em pequena escala, mas ainda depende de auditorias e não é em tempo real.

A resposta da Meta é o **controle de fluxo de informação** por meio das **Policy Zones**, parte da sua Privacy Aware Infrastructure:

- Os ativos de dados recebem uma **anotação** com um rótulo (no nível de tabela, coluna, linha ou potencialmente célula), e o rótulo carrega regras de fluxo que listam as finalidades permitidas.
- Quando dados anotados são tratados, uma **zona** é criada em volta da requisição, da pilha de chamadas de função ou do job batch, e o runtime verifica cada fluxo; gravar dados rotulados num destino fora da zona é uma violação.
- Uma zona roda primeiro em **modo de log**; depois que as violações são corrigidas (anotar o destino, ou remover o fluxo), ela passa para **aplicação**, e a partir daí uma nova gravação não permitida é bloqueada automaticamente.
- As Policy Zones estão integradas em sistemas baseados em funções (web, camada intermediária, backends) e em sistemas batch (SQL no data warehouse), então os rótulos acompanham os dados entre sistemas; os sistemas sem essa integração ainda usam verificações pontuais.
- A adoção em centenas de sistemas exigiu ferramentas (Policy Zone Manager) para achar os ativos de origem, descobrir os fluxos a jusante e corrigir.

---

## 4. Patterns that turn principles into architecture `[INDUSTRY PATTERN]`

| Princípio | Padrão | Exemplo |
|---|---|---|
| Minimização | Coletar o dado mais grosseiro que funciona; agregar cedo | Guardar a cidade em vez do trajeto de GPS para análise; descartar os eventos brutos depois da agregação ([31](../systems/31-ad-click-aggregation.md)) |
| Minimização | Pseudonimizar identificadores na ingestão | Trocar o id do usuário por um hash com chave no pipeline de análise; guardar a chave em outro lugar |
| Limitação de finalidade | Rotular os dados por finalidade e impor na plataforma | Tags de coluna mais um motor de consultas que recusa joins entre finalidades |
| Limitação de armazenamento | Retenção como configuração, com exclusão automática | TTL em tabelas e tópicos; retenção por dataset revista com o dono dos dados |
| Exclusão | Um serviço de exclusão que se espalha para todos os bancos | Id da solicitação de exclusão, um registro dos bancos que guardam dados do usuário, confirmação por banco, verificação |
| Exclusão em backups | Crypto-shredding | Criptografar os dados de cada usuário com uma chave própria; apagar a chave para tornar os backups ilegíveis |
| Acesso | Menor privilégio e acesso auditado | Permissões finas ([42](../systems/42-authorization-identity.md)); logs de acesso revisados |
| Padrões | Privado por padrão | Posts novos visíveis para amigos, não para o público; opt-in, não opt-out, para usos extras |
| Transparência | Inventário e linhagem de dados | Todo dataset tem um dono, uma finalidade e uma retenção, encontráveis num catálogo |

**A exclusão é a parte mais difícil.** Os dados do usuário se espalham por caches ([32](../systems/32-distributed-cache.md)), índices de busca, logs, data warehouses, atributos de ML, backups e terceiros. Monte o registro de onde os dados vivem antes de precisar apagar, dê a cada banco um tratador de exclusão, torne a exclusão idempotente e repetida em caso de falha, e meça o tempo até a conclusão.

**Logs também são dados pessoais.** Logs de requisição com IPs, ids de usuário e payloads costumam ser a maior cópia sem controle. Remova os dados sensíveis na origem, mantenha os logs curtos e separe os logs de segurança (mais longos, restritos) dos de depuração (curtos).

---

## 5. Using this in a design discussion `[INDUSTRY PATTERN]`

1. Nomeie os dados pessoais que o sistema toca e a finalidade de cada um.
2. Diga o que você não vai coletar, e onde vai agregar ou pseudonimizar.
3. Desenhe os fluxos de dados e marque onde cada finalidade termina.
4. Defina a retenção de cada banco, incluindo logs e backups, e como a exclusão se propaga.
5. Diga como o acesso é limitado e auditado, e quais são os padrões.
6. Diga como você provaria tudo isso: inventário, linhagem, verificação de exclusão, auditorias.

---

## Questions to practise

1. Um gerente de produto quer guardar para sempre o histórico bruto de localização, caso algum recurso futuro precise. O que você propõe em vez disso?
2. Projete a exclusão de conta de uma rede social com caches, busca, data warehouse, atributos de ML e backups noturnos.
3. Por que verificações pontuais não bastam para a limitação de finalidade, e o que as substitui?
4. O que o "por padrão" muda no design de um recurso de compartilhamento?
5. Seus logs de requisição contêm endereços de e-mail. O que você muda?

**Related:** [P06 Security and threat modeling](P06-security-threat-modeling.md), [P14 Multi-tenancy](P14-multi-tenancy.md), [08 Chat (end-to-end encryption)](../systems/08-chat-whatsapp.md), [42 Authorization and identity](../systems/42-authorization-identity.md), [31 Stream aggregation](../systems/31-ad-click-aggregation.md), [41 Moderation and fraud](../systems/41-moderation-fraud-ml.md).

## Sources and provenance

> **Sources read on 2026-11-01:** European Data Protection Board, [Guidelines 4/2019 on Article 25 Data Protection by Design and by Default, version 2.0](https://www.edpb.europa.eu/sites/default/files/files/file1/edpb_guidelines_201904_dataprotection_by_design_and_by_default_v2.0_en.pdf) (adopted 20 October 2020) · NIST, [Privacy Framework: A Tool for Improving Privacy through Enterprise Risk Management, Version 1.0](https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.01162020.pdf) (16 January 2020) · Meta Engineering, [How Meta enforces purpose limitation via Privacy Aware Infrastructure at scale](https://engineering.fb.com/2024/08/27/security/privacy-aware-infrastructure-purpose-limitation-meta/) (27 August 2024).
> **Material datado:** as diretrizes do EDPB são de 2020 e interpretam o GDPR como ele era então; o NIST trabalhou depois numa revisão do framework, não lida aqui.
> **Not read:** o texto do GDPR no EUR-Lex (a página não pôde ser obtida pelas nossas ferramentas, então o Artigo 25 é citado como o EDPB o cita e interpreta), a LGPD brasileira, a CCPA/CPRA da Califórnia, os sete princípios de Cavoukian e os outros posts da Meta sobre a Privacy Aware Infrastructure.
> **Tags:** `[CONFIRMED]` declarado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo. Tudo que não está marcado como `[CONFIRMED]` é raciocínio nosso. Este primer não é aconselhamento jurídico.

---
## ✅ Verification log

*Fact-check, 2026-11-01, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the EDPB guidelines: the core obligation, the time of determination of the means and what means include, application to existing systems, processing by default only what each purpose needs, the indefinite-number rule, the minimisation steps including aggregated data and deletion after identification is no longer needed, and the storage limitation elements (deletion, testing, automation, justification, enforcement, backups and logs, temporary copies).
- Verified in the NIST Privacy Framework: privacy events across the data life cycle, the five Functions and Protect-P's focus on cybersecurity-related events.
- Verified in Meta's post: the definition of purpose limitation, the weaknesses of point checks and lineage, information flow control, annotations and their granularity, zones, logging then enforcement, integration in function-based and batch systems, and Policy Zone Manager.
- Not verified: the GDPR article text directly; quotations of Article 25 come through the EDPB guidelines.
- Not sourced (our reasoning): the pattern table, deletion service, crypto-shredding, log advice and the design-discussion checklist.
