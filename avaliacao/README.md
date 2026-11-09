# Avaliação do ThingsBoard 4.4 (licença, Edge e RBAC)

Pedido da reunião de 2026-10-20: avaliar se a 4.4 completa, gratuita até 100 dispositivos, resolve o RBAC por projeto e as regras sincronizadas com o Edge funcionando sem internet. Rodada de 2026-10-21, em ambiente isolado (`thingsboard-4.4-test/compose.yaml`, fora deste repositório; projeto `embrapa-tb44-test`, portas só no loopback, sem tocar na 4.3).

Desde 2026-10-25 os scripts ficam neste repositório e leem endereços e contas do `.env` desta pasta, para rodar também contra a stack do branch `iot` quando ela passar para a 4.4.

- **Servidor:** `thingsboard/tb-node:4.4.0`.
- **Edges:** dois `thingsboard/tb-edge-pe:4.4.0EDGEPE` (Edge01, Edge02); o Edge02 foi removido em 24/10, depois do teste da chave Free.
- **Licença:** sem chave, em modo de não produção (`NON_PRODUCTION_USE=true`). Uma chave gratuita de produção exige conta no License Portal, que só o usuário pode criar.

## Como rodar

```bash
# 1. subir o ambiente testado (hoje, o isolado: na pasta thingsboard-4.4-test)
docker compose up -d                       # servidor e Postgres
docker compose --profile edge up -d edge1  # o Edge (o plano Free permite um)

# 2. nesta pasta (avaliacao/)
npm ci
cp .env.example .env                       # preencher as contas; endereços têm padrão
node 01-setup.mjs                          # cria o sysadmin (setup lock) e mostra os limites
node 02-tenant-edges.mjs                   # tenant de teste e as entidades Edge (TB44_EDGE_COUNT)
node 03-edge-offline.mjs                   # Edge sem servidor, inclusive reiniciando (~6 min)
node 04-rbac.mjs                           # cenário de RBAC (não versionado; ver abaixo)
node 06-customer-cria-dispositivo.mjs      # customer user criando dispositivos
node 07-modelos-rbac.mjs [--manter]        # combinações de RBAC para unidades e localidades
node 11-implantar-rbac.mjs [--aplicar]     # papéis e grupos na Central de desenvolvimento (simula sem --aplicar)
node 12-definir-responsaveis.mjs "email=Localidade|unidade:Título" [--aplicar]  # torna alguém Responsável
node 13-regras-do-edge.mjs                 # papel sobre o Edge alcança as rule chains dele? (Central, cria e apaga)
node 14-cadastro-por-laboratorio.mjs       # pesquisador cadastra só no próprio laboratório (Central, cria e apaga)
node 15-mcp-por-perfil.mjs                 # o que gestor, Responsável e Equipe fazem pelo MCP (não versionado; Central, cria e apaga)
```

Credenciais geradas ficam no `.env` desta pasta e nunca são impressas. As chaves que o `02` grava (`TB44_EDGE<n>_KEY` e `_SECRET`) precisam ir também para o `.env` do Edge que vai usá-las.

### Acesso pelo navegador

| Interface | Endereço | Contas (e-mail e senha no `.env`) |
|---|---|---|
| Servidor 4.4 | <http://127.0.0.1:9290> | sysadmin (`TB44_SYSADMIN_*`), administrador do tenant (`TB44_TENANT_*`), `ana@tb44.local` (`TB44_ANA_PASSWORD`), `bruno@tb44.local` (`TB44_BRUNO_PASSWORD`) |
| Edge01 | <http://127.0.0.1:9293> | administrador do tenant (sincronizado do servidor) |

`ana` é usuária de unidade (Customer "Embrapa Gado de Corte"), com leitura só no grupo de dispositivos `pasto-certo`. `bruno` é usuário do tenant, com leitura em `pasto-certo` e o papel genérico "Editor de regras". O `04-rbac.mjs` recria os dois a cada rodada, usando as senhas do `.env`.

## Resultados

### Licença e instalação

| Item | Resultado |
|---|---|
| Edge 4.4 | Publicado só como `tb-edge-pe:4.4.0EDGEPE` (05/10). O `tb-edge` e o repositório `thingsboard-edge` (Apache 2.0) param na 4.3.1.6. |
| Sem chave | O servidor sobe, mas não ativado: nem o login do sysadmin funciona até a ativação. |
| Modo de não produção | Cotas ilimitadas, aviso visível e **desligamento ao completar 30 dias de uso acumulado** (`NonProductionEntitlementEnforcer`, verificação a cada 15 min). |
| Chave de produção | Ativada por "claim" no License Portal (`/api/noauth/setup/claim`). |
| Limites aplicados pelo servidor | `maxDevices`, `maxAssets`, **`maxEdges`** e `maxAgents` (`/api/admin/licenseUsageInfo`). Acima do limite, a criação é recusada: "Maximum allowed devices/edges limit reached!". |
| Limite de 100 dispositivos | **Não testado:** exige a chave gratuita de produção. |

### Verificação online (código da biblioteca `client-1.3.3.jar`)

| Item | Servidor | Edge 4.4 |
|---|---|---|
| Verificação | Horária, em `license.thingsboard.io` | **Nenhuma própria:** com `licenseVersion: 2`, o Edge usa a licença do servidor |
| Sem conseguir verificar | Tolerância de **3 dias (72 h)** (`DEFAULT_OFFLINE_TIMEOUT`) | Não se aplica |
| Depois do prazo | **Trava só o plano de gestão** ("management plane locked"); o resto segue | Não se aplica |
| Envio de estatísticas | Dentro da verificação; desligável (`TB_ANONYMOUS_USAGE_REPORTING`) | — |

O código do Edge ainda tem o caminho antigo (`licenseVersion < 2`): licença própria, tolerância de 7 dias (30 com chave offline), avaliação de 30 dias e `System.exit` ao estourar. Esse caminho não é usado com um servidor 4.4.

### Edge sem servidor (`03-edge-offline.mjs`): 10 PASS

| ID | Caso | Resultado |
|---|---|---|
| E1 | Atribuição ao Edge por **grupo de dispositivos** (a rota direta da CE não existe) | ✅ |
| E2–E5 | Login local, sincronização, MQTT no Edge e gravação pela rule chain local | ✅ |
| E7 | **Edge reiniciado com o servidor desligado** volta em 66 s | ✅ |
| E8–E9 | Sem servidor, o Edge recebe e processa a telemetria | ✅ |
| E10 | Nenhum erro de licença nem encerramento no log | ✅ (o filtro foi corrigido depois da rodada) |
| E11 | Servidor religado recebe a leitura feita sem conexão | ✅ |

Limite deste teste: o servidor estava em modo de não produção. Com uma chave real, o Edge continua no modelo `licenseVersion: 2`, mas vale repetir o teste.

### Chave Free real (2026-10-24)

A chave gerada no License Portal foi aplicada por `TB44_LICENSE_SECRET`. O servidor deu prioridade à chave sobre `NON_PRODUCTION_USE`, ativou a instância online e passou a rodar **em modo de produção**. A chave veio como **Free** (não Development).

| Limite (`planData` / `licenseUsageInfo`) | Valor |
|---|---|
| `maxDevices` | 100 |
| `maxAssets` | 100 |
| **`maxEdges`** | **1** |
| `maxAgents` | 1 |
| `maxInstances` (instâncias de produção) | 1 |
| `edge` (Edge Computing) | habilitado |
| `whitelabeling` | não |
| `maxAiCredits` | 1 pacote |

Com dois Edges já cadastrados (acima do limite), criar um terceiro dá **HTTP 403 "Maximum allowed edges limit reached!"**. Os Edges existentes não foram removidos.

Os dois Edges que já existiam **continuaram conectando** (`active: true`). O limite só bloqueia a criação.

Testes repetidos com a chave ativa:
- `03-edge-offline.mjs`: 10 PASS, com o Edge reiniciado sem servidor e de volta em 59 s.

**Ativação presa ao contêiner.** Por padrão, a ativação fica gravada em `instance-license.data`, no diretório de trabalho do contêiner, fora do volume. Ao recriar o servidor (para trocar as portas), o arquivo se perdeu. O servidor tentou ativar outra instância e recebeu `ACTIVE_INSTANCES_CAPACITY_EXCEEDED(104)`, porque o Free só tem uma vaga, ainda presa à ativação anterior, e passou a responder 423 `LICENSE_REQUIRED`. Para destravar, é preciso liberar a instância antiga no License Portal. O compose agora define `TB_LICENSE_INSTANCE_DATA_FILE=/data/instance-license.data`, no volume. Em produção, a mesma armadilha aparece em toda atualização de imagem.

**Conclusão:** o plano gratuito permite **um único Edge**. O desenho com Edges em vários locais exige licença comercial ou o Community Grant (Edges conforme o registrado).

### Customer user cadastrando dispositivos (`06-customer-cria-dispositivo.mjs`, 2026-10-24): 6 PASS

Papel de grupo "Gestor de dispositivos do projeto" (`READ`, `CREATE`, `WRITE`, `DELETE`, `RPC_CALL`, credenciais e atributos) dado à `equipe-pasto-certo`.

| ID | Caso | Resultado |
|---|---|---|
| C1–C3 | ana cria um dispositivo num grupo **pertencente ao customer** dela, lê o token e edita | ✅ HTTP 200; o dispositivo nasce com dono CUSTOMER |
| C4 | ana tenta criar no grupo `pasto-certo`, que é **do tenant**, com o mesmo papel | ✅ HTTP 403: `CREATE` em grupo só vale para o dono do grupo |
| C5 | ana cria sem informar o grupo | HTTP 403 (precisa de `?entityGroupId=`) |
| C7 | Cota | O dispositivo conta nos 100 da licença. O script apaga os de teste no fim |

Para o pesquisador cadastrar os próprios dispositivos, os grupos de cada projeto precisam pertencer ao customer da unidade, e não ao tenant.

### Combinações de RBAC (`07-modelos-rbac.mjs`, 2026-10-27)

**Cenário:** um tenant, a unidade A com duas localidades (L1 com 2 sensores e L2 com 1) e a unidade B com 1 sensor.

**Pessoas:**
- o gestor da A;
- o Maintainer e o Developer da L1;
- um Developer só da L2;
- um Developer nas duas localidades;
- um Maintainer da B que colabora com a L1.

Para cada pessoa e sensor, o script testa quatro ações: ver (V), configurar com atributo compartilhado (C), comandar por RPC (R) e ler o token (K). Testa também a lista de dispositivos visíveis e o cadastro de um sensor novo. O resultado é comparado com o comportamento desejado:
- **Maintainer:** tudo na própria localidade;
- **Developer:** só ver;
- **colaborador de outra unidade:** só ver;
- **gestor:** tudo na própria unidade.

| Modelo | Como é montado | Diferenças |
| --- | --- | --- |
| C1 Unidade aberta | Papéis genéricos na unidade inteira; o perfil vira o papel | 9: todos da unidade veem todas as localidades |
| **C2 Localidade como grupo** | Por localidade: um grupo de dispositivos e dois de usuários (Responsáveis e Equipe), todos da unidade; papéis de grupo | **0** |
| **C3 Derivação como sub-customer** | Cada localidade é um sub-customer, dono dos sensores; papéis genéricos no sub-customer | **0** |
| C5 Posse no tenant | Sensores do tenant em grupos do tenant (estado deixado pelo upgrade) | 7: o gestor não vê nada; ninguém cadastra sensor |

**Mesmo resultado, custo diferente entre C2 e C3:**

| Situação | C2 | C3 |
| --- | --- | --- |
| Pessoa em duas localidades | Entra nos dois grupos | Precisa de um grupo extra no sub-customer dela, mais um compartilhamento |
| `customerId` do sensor | A unidade, como o backend espera | O sub-customer, então o backend teria de subir a hierarquia |
| Gestor por derivação | Não tem | Tem (administradores do sub-customer) |

**Achados:**

| ID | Achado |
| --- | --- |
| C4-P1 a P4 | Um grupo só aceita entidades do mesmo dono ("Unable to add entity with other owner than group"). Não dá para montar um grupo de projeto com sensores ou pessoas de unidades diferentes, nem no tenant. |
| C2-share, C3-share | O administrador do tenant compartilha um grupo da unidade A com um grupo de usuários da B por permissão direta (`/api/groupPermission`), com o papel escolhido. |
| C2-G4 | O gestor da A **não** consegue compartilhar com a B: dá 403 na permissão direta e na rota da interface (`/api/v2/entityGroup/{id}/share`). O compartilhamento entre unidades fica com uma conta do tenant. |
| Compartilhamento "Read" | Pela rota da interface, o compartilhamento de leitura sem papel próprio deu **RPC 200** ao colaborador; só configurar foi bloqueado. Compartilhar sempre com um papel definido por nós. |
| C2-T0 | O grupo padrão "Customer Users" recebe o papel `Customer User`, que dá token (`READ_CREDENTIALS`) e comando (`RPC_CALL`) em **toda** a unidade. Ninguém deve ser posto nele. |
| G1, G2, G3, C3-G5 | O gestor (grupo "Customer Administrators") cria usuários e sub-customers na própria unidade, não vê sensores da outra unidade e não vê rule chains. |
| S1, S2 | Contas de serviço com papel genérico mínimo funcionam. O papel de telemetria (`DEVICE: READ, READ_TELEMETRY`) lê histórico e recebe 403 para gravar, comandar e ler token. O papel de usuários (`USER: READ, READ_ATTRIBUTES`) lê o atributo `manager` e recebe 403 nos sensores. |
| S3 | O administrador obtém o token de uma pessoa (`/api/user/{id}/token`) e vê exatamente o que ela vê. Esse é o jeito de o backend calcular a aba Disponíveis. |
| E1, E2 | O Edge recebe um grupo que pertence à unidade, e os sensores chegam a ele com o dono preservado. |
| O1 | A troca de dono tenant → unidade preenche o `customerId`, mas **tira o sensor dos grupos do tenant**. O script de migração precisa recolocá-lo nos grupos da unidade. |
| Rota de listagem | `/api/deviceInfos/all` só devolve sensores do tenant; os das unidades exigem `includeCustomers=true`. O backend precisa disso depois da troca de dono. |

### Segregação de regras (`09-segregacao-regras.mjs`, 2026-10-27): 10 PASS

Rule chains não têm grupo. Já os campos calculados e as regras de alarme, que por dentro são um campo calculado do tipo `ALARM`, ficam na própria entidade. Eles são controlados pelas operações `READ_CALCULATED_FIELD` e `WRITE_CALCULATED_FIELD` sobre ela.

| ID | Caso | Resultado |
| --- | --- | --- |
| RC1–RC3 | Usuário da unidade com papel genérico `RULE_CHAIN: ALL`; Maintainers | 403 em listar e criar rule chains |
| CF1, AR1 | Maintainer **usuário da unidade** (`CUSTOMER_USER`) com `WRITE_CALCULATED_FIELD` na L1 cria regra num sensor da L1 | 403: a autoridade `CUSTOMER_USER` nunca usa regras, como diz a documentação de papéis |
| CF1T, AR1T | Maintainer **usuário do tenant** (`TENANT_ADMIN`) **só com o papel de grupo** sobre a L1 cria campo calculado e regra de alarme num sensor da L1 | ✅ 200 |
| CF2T, AR2T, CF5T | O mesmo usuário cria regra num sensor da L2 ou no perfil de dispositivo | ✅ 403 (`WRITE_CALCULATED_FIELD ... DEVICE 'rbac9-l2-sensor'` e `... DEVICE_PROFILE 'default'`) |
| CF3 | Developer da L1, só com leitura de regras, cria regra | ✅ 403 |
| CF6 | Regra no servidor: temperatura 15 → atributo compartilhado `valvula = 1` | ✅ |
| E1 | A regra criada pelo Maintainer chega ao Edge quando o grupo da L1 é atribuído a ele | ✅ |
| E2 | **Servidor desligado:** o Edge aplica a regra sozinho (temperatura 25 → `valvula = 0`; 12 → `valvula = 1`) | ✅ |

**Formato da regra.** O tipo `SIMPLE` só aceita fórmula matemática (`t * 2`). Condições exigem `SCRIPT` em TBEL, com a chave do objeto entre aspas: `return {"valvula": v};`. Por padrão, o resultado passa pela rule chain (`strategy: RULE_CHAIN`) antes de ser gravado.

**Quem cria grupos (teste avulso):**
- O gestor da unidade cria grupos de sensores e de usuários na própria unidade.
- O gestor só liga uma equipe a um grupo usando um papel **da própria unidade**; com um papel do tenant, dá 403 (`READ ... ROLE`).
- Os Maintainers não criam grupos (403 `CREATE ... DEVICE group`), mas cadastram sensores na localidade. O sensor nasce com a unidade como dona, mesmo quando quem o cadastra é usuário do tenant.

### Rule chains só do Edge (`13-regras-do-edge.mjs`, 2026-11-02)

Pergunta: um papel sobre o Edge (que tem grupo, ao contrário das rule chains) libera só as rule chains atribuídas a ele? Rodado na Central de desenvolvimento (4.4.0), com um Edge só de cadastro, rule chains de teste e limpeza no fim. A raiz do tenant só foi lida.

| Pessoa | Edge | Lista as rule chains do Edge | Lê, regrava, cria, desatribui ou atribui rule chain; lê a raiz do Edge ou do tenant |
| --- | --- | --- | --- |
| U1: usuário da unidade, `ALL` no grupo do Edge | 200 | 403 | 403 em todos |
| U2: usuário do tenant, `ALL` no grupo do Edge | 200 | 200 (só nome e id) | 403 em todos (`... operation with RULE_CHAIN`) |
| U3: usuário do tenant, genérico `EDGE: ALL` | 200 | 200 (só nome e id) | 403 em todos |

**Credenciais do Edge (casos K, mesma data):** `GET /api/edge/{id}` devolve `routingKey` e `secret` a **qualquer** pessoa que leia o Edge, inclusive um usuário da unidade só com `READ` no grupo do Edge (U0). Com elas, um Edge falso pode conectar no lugar do verdadeiro e receber o que está atribuído a ele. A listagem `/api/customer/{id}/edgeInfos` deu 403 a todos. Consequência: leitura de Edge é só para a equipe técnica.

**Conclusão:** a permissão sobre o Edge não se estende às rule chains dele. Toda operação é checada no recurso `RULE_CHAIN`, que só existe como papel genérico para o tenant inteiro (R7/R8). Não há como liberar ao pesquisador só as regras do Edge pelo RBAC da 4.4.

### Regras com a chave Free (`16-regras-com-licenca.mjs`, 2026-11-07): 6 PASS

Pergunta de Camilo (03/11): as restrições de rule chain vinham da falta da licença? Repete os casos centrais do 09 na Central, já com a chave Free ativa. A parte do Edge fica de fora, porque o Free tem uma única vaga de Edge e ela está ocupada. As entidades `rbac16` foram apagadas no fim, e a limpeza foi conferida.

| ID | Caso | Resultado |
| --- | --- | --- |
| RC1, RC2 | Usuário da unidade com o papel genérico `RULE_CHAIN: ALL` lista e cria rule chains | 403 |
| RC3T | Usuário do tenant, só com papel de grupo, lista rule chains | 403 (`READ ... RULE_CHAIN`) |
| CF1 | Usuário da unidade com `WRITE_CALCULATED_FIELD` na L1 cria campo calculado | 403 (informativo; igual ao 09) |
| CF1T | Usuário do tenant, só com papel de grupo, cria campo calculado num sensor da L1 | 200 |
| CF2T, CF5T | O mesmo usuário num sensor da L2 ou no perfil | 403 |

**Conclusão:** a licença não muda nada; a resposta é idêntica à do modo de não produção. Rule chains continuam sem grupo. O "se X, aciona Y" segregado por localidade é o campo calculado, para Responsável com autoridade `TENANT_ADMIN` e só papel de grupo.

### Regra modelo da plataforma, parâmetros do pesquisador (`17-regra-modelo-parametros.mjs`, 2026-11-07): 11 PASS

É a alternativa para dar "se X, aciona Y" sem usuário do tenant. A plataforma, com a chave de API do tenant, instala no atuador um campo calculado modelo. O Responsável, usuário da unidade com o papel real "Laboratório · Edição", só ajusta `limite_min`, `limite_max` e `habilitada`, atributos de servidor do atuador. O dispositivo confirma o estado em `estado` (atributo de cliente), que a histerese usa. O teste rodou na Central, com entidades `rbac17` apagadas no fim e limpeza conferida.

| ID | Caso | Resultado |
| --- | --- | --- |
| M1 | Plataforma instala a regra "Modelo · Controle de umidade v1" no umidificador da L1, lendo o sensor da L1 | ✅ 200 |
| P1 | Responsável ajusta limites e habilita | ✅ 200 |
| P2, P3 | Responsável num umidificador da L2; Equipe na L1 | ✅ 403 (`WRITE_ATTRIBUTES`) |
| P4, P6 | Responsável cria regra própria ou apaga a instalada | ✅ 403 |
| P5 | Responsável lê a regra | ℹ️ 403: usuário da unidade não enxerga campos calculados; vê só os parâmetros |
| F1 | Histerese 45/55, umidade 60→44→43→50→56→57 | ✅ desligado, liga, liga, liga, desliga, desliga |
| F2 | Responsável muda os limites para 30/40 | ✅ vale na leitura seguinte |
| F3 | Limites invertidos (60/40) | ✅ ignorados; o atuador fica como estava |
| F4 | `habilitada = false` | ✅ a regra não mexe no atuador |
| A1 | Responsável grava direto o atributo de saída `ligar` | ℹ️ 200: quem ajusta parâmetros também aciona por atributo |
| A2 | Equipe grava o atributo de saída | ✅ 403 |

A sincronização com o Edge e o funcionamento offline não foram repetidos aqui, porque a única vaga de Edge do Free está ocupada. Já tinham sido provados nos testes 09 (E1/E2) e 10.

### Painel de controle e regra com dois atuadores (`18-painel-controle.mjs`, 2026-11-07)

No PAVAP da Central foram criados três dispositivos simulados: "Teste controle · Sensor de umidade da sala", "· Umidificador" e "· Ar-condicionado". A plataforma instalou duas regras modelo, **uma por atuador**, porque o campo calculado só grava no próprio dispositivo. As duas leem o mesmo sensor e os mesmos parâmetros, que ficam no umidificador. O painel "Teste controle · Umidade da sala do PAVAP" fica no grupo de painéis do PAVAP.

Arquivos do teste:
- `18-simulador.mjs` responde pelos equipamentos: lê `ligar`, confirma em `estado` e faz a umidade subir ou cair.
- `18-navegador.mjs` abre o painel como uma pessoa, num Edge sem interface, e clica, digita e salva.
- `18-estado.mjs` mostra os valores atuais.
- Para remover tudo: `node 18-painel-controle.mjs --limpar`.

Widgets usados, todos de fábrica e sem RPC:
- *Single switch* com a ação **Set attribute**: `ligar` (compartilhado) e `habilitada` (servidor). O estado inicial é **Get attribute**, com o `estado` confirmado pelo equipamento.
- *Update Multiple Attributes* para `limite_min` e `limite_max` (servidor, número).

| Quem | Ação no navegador | Resultado |
| --- | --- | --- |
| fdsfds (Responsável, usuário da unidade) | Abre o painel | ✅ 5 widgets, sem erro; os botões refletem o estado real |
| fdsfds | Desliga "Automático" e liga o umidificador à mão | ✅ `habilitada=false`; umidificador pedido e confirmado |
| fdsfds | Digita 40 e 60 no formulário e salva | ✅ limites 40/60 gravados |
| fdsfds | Religa "Automático" com a umidade em 63 % | ✅ a regra desliga o umidificador e liga o ar-condicionado, os dois confirmados |
| maxwell (Equipe) | Clica nos botões e salva limites | ✅ 403, aviso "Falha ao executar a ação" na tela; nada mudou |

Não testado no navegador: editar os limites pela aba de atributos do dispositivo. A permissão é a mesma `WRITE_ATTRIBUTES` do caso P1 do teste 17.

### Rule chain só para leitura (`19-regras-so-leitura.mjs`, 2026-11-07): 4 PASS

Teste do papel genérico `RULE_CHAIN: READ`, rodado na Central, com entidades `rbac19` apagadas no fim.

| Quem | Lista | Abre o conteúdo (nós e scripts) | Renomeia ou cria |
| --- | --- | --- | --- |
| Usuário da unidade | 403 | 403 | 403 |
| Usuário do tenant | 200, **todas** as rule chains do tenant | 200 | 403 |

**Conclusão:**
- Leitura sem edição existe, mas só para usuário do tenant, e vale para todas as rule chains do tenant, não só as do laboratório.
- Para usuário da unidade, não existe acesso nenhum.

### Widget "Regras do equipamento" (`20-widget-regras.mjs`, 2026-11-07): 11 PASS no navegador

O pesquisador, como usuário da unidade, cria regras simples nos próprios equipamentos de dentro do ThingsBoard. O modelo é "se `<chave do sensor>` ficar acima/abaixo de X, ligar/desligar este equipamento; voltar quando passar de Y".

**Como funciona:**
1. O widget (tipo de tenant `embrapa_regras_equipamento`, no pacote "Embrapa · Regras") chama o backend do Embrapa I/O (`/iot/rules`) com o **token da sessão do ThingsBoard**.
2. O backend descobre quem é a pessoa e confere no próprio ThingsBoard o que ela pode fazer:
   - permissão de grupo com `WRITE_ATTRIBUTES` no atuador;
   - gravação real do atributo `regras_alteradas_por` com o token dela.
3. Se puder, gera **um campo calculado por atuador** e o instala com a chave da plataforma. A expressão só contém identificadores gerados pelo backend e números validados.
4. As regras ficam guardadas no Mongo (`iotrulesets`).
5. "Regras ativas" grava `regras_ativas` com o token da pessoa; desligado, o equipamento fica no manual.

**Código:** `backend/helper/iotRules.js`, `business/iotRules.js`, `model/iotRuleSet.js` e `test/iotRules.test.js` (5 testes unitários).

**Painel de teste:** "Teste regras · Sala do PAVAP", com os dispositivos simulados do teste 18 (as regras modelo do 18 foram retiradas). O simulador é o `18-simulador.mjs`. O teste no navegador é o `20-navegador.mjs <email> <pasta> responsavel|equipe`. Para remover: `node 20-widget-regras.mjs --limpar`.

| ID | Caso | Resultado |
| --- | --- | --- |
| W1 | Responsável abre o painel | ✅ vê os dois equipamentos, sem "Somente leitura" |
| W2 | Retorno do lado errado (acima de 60, voltar abaixo de 70) | ✅ recusado: "o retorno precisa ser menor que 60 (por exemplo, 55)" |
| W3 | Prévia | ✅ "Se humidity (…) ficar acima de 60, ligar este equipamento. Desligar quando ficar abaixo de 55." |
| W4–W6 | Salva regras no ar-condicionado e no umidificador (duas no mesmo equipamento) | ✅ um campo calculado por equipamento, combinando as regras em ordem |
| W7–W9 | Pausar, retomar e excluir (com confirmação) | ✅ |
| W10 | Equipe abre o painel | ✅ vê as regras com "Somente leitura" e sem botões |
| W11 | Equipe chama a API direto do navegador, com o próprio token | ✅ 403 |

A sala simulada reagiu às regras: com 69 %, o ar-condicionado ligou e o umidificador desligou. A rota pública (`IO_PUBLIC_URL/iot/rules`, pelo Tailscale) respondeu 401 sem token e o preflight de CORS respondeu 204, então o widget funciona aberto pelo Tailscale.

### Widget "Objetivos do ambiente" (`21-widget-objetivos.mjs`, 2026-11-07): 10 PASS no navegador

É a segunda versão do plugin, feita depois de Dalian achar o widget de regras "muito especializado". Em vez de "se X > Y, ligar; voltar quando…", o pesquisador diz **o que quer manter** e **quais equipamentos ajudam**. Exemplo: "umidade da sala entre 40 e 60 %", com o umidificador ↑ aumenta e o ar-condicionado ↓ diminui.
- O equipamento que aumenta liga abaixo do mínimo, e o que diminui liga acima do máximo. Os dois desligam no meio da faixa, então nunca brigam.
- Por dentro, o objetivo vira as mesmas regras (`goalId`) e o mesmo campo calculado por equipamento.
- Código: `model/iotGoal.js` e rotas `/iot/goals` em `business/iotRules.js`. Os testes unitários de `iotRules.test.js` passaram de 5 para 8.

**O cartão mostra:**
- o valor atual em destaque;
- uma barra com a faixa desejada e a posição atual;
- a situação: dentro da faixa, abaixo ou acima;
- cada equipamento com uma frase e o estado confirmado (ligado ou desligado);
- o botão "Automático" (desligado, os equipamentos ficam no manual).

O editor ocupa o widget inteiro: grandeza com nome amigável, faixa com barra de prévia, equipamentos com "↑ aumenta / ↓ diminui" (sugerido pelo nome) e frases de prévia ao vivo. O painel é "Teste objetivos · Sala do PAVAP" e substituiu o do teste 20. O teste no navegador é o `21-navegador.mjs <email> <pasta> responsavel|equipe`.

| ID | Caso | Resultado |
| --- | --- | --- |
| O1–O2 | Cartão do objetivo; editor de "Novo objetivo" com as três perguntas | ✅ |
| O3–O4 | Editar a faixa para 45–65: prévia ao vivo e gravação | ✅ |
| O5–O6 | Desligar e religar "Automático" | ✅ |
| O7 | Voltar para 40–60 | ✅ |
| O8–O9 | Equipe: "Somente leitura", sem editar, excluir ou criar; "Automático" desabilitado | ✅ |
| O10 | Equipe chama a API direto, com o próprio token | ✅ 403 |

### Cadastro só no próprio laboratório (`14-cadastro-por-laboratorio.mjs`, 2026-11-02): 14 PASS

Usuário da unidade (`CUSTOMER_USER`) com o papel de grupo "Edição" (`READ`, atributos, telemetria, `CREATE`, `WRITE`, `WRITE_ATTRIBUTES`, `DELETE`, `READ_CREDENTIALS`) sobre o grupo do laboratório L1, mais o genérico "Interface" com `DEVICE_PROFILE: READ`. Central de desenvolvimento, entidades de teste apagadas no fim.

| ID | Caso | Resultado |
| --- | --- | --- |
| D1–D5 | Cria sensor na L1 (nasce com a unidade como dona), lê o token, edita, lista perfis, exclui | ✅ 200 |
| N1 | Cria sensor em outro laboratório da **mesma unidade** (L2) | ✅ 403 (`READ ... DEVICE group`) |
| N2 | Cria sensor em laboratório de outra unidade | ✅ 403 |
| N3 | Cria sem indicar o grupo | ✅ 403 |
| N4, N5 | Põe o próprio sensor na L2; traz um sensor da L2 para a L1 | ✅ 403 (`ADD_TO_GROUP`) |
| N6–N8 | Lê token, edita ou exclui sensor da L2 | ✅ 403 |

### MCP por perfil (`15-mcp-por-perfil.mjs`, 2026-11-04): 39 PASS, mais 3 casos restritos

Pergunta da reunião de 03/11: dá para cada pessoa criar painéis e regras pelo MCP do ThingsBoard, com o próprio cliente de IA?

**Cenário:**
- Central de desenvolvimento (4.4.0, sem chave), modelo de laboratórios.
- `thingsboard/mcp` **2.1.0**, a versão mais recente publicada (26/02/2026), por STDIO.
- Para cada pessoa, o tenant gera uma API key de 1 h. O MCP sobe com ela, e as mesmas operações são repetidas pela REST, com a mesma chave, para o que o MCP não cobre.
- Perfis da Gado de Corte:
  - gestor: `gestor.gadodecorte`;
  - Responsável pelo PAVAP: conta temporária só no grupo "PAVAP · Responsáveis", porque a conta real `fdsfds` nunca foi ativada;
  - Equipe do PAVAP: `maxwell`.
- Tudo o que foi criado foi apagado no fim, inclusive as chaves.

| ID | Operação | Gestor | Responsável | Equipe |
| --- | --- | --- | --- | --- |
| M0 | Ferramentas oferecidas | 124, **nenhuma de painel, rule chain, campo calculado ou RPC** | igual | igual |
| M1 | `getUserDevices` | 7 (a unidade) | 5 (PAVAP) | 5 (PAVAP) |
| M2 | `getTenantDevices` | 403 | 403 | 403 |
| M3–M5 | Último valor: PAVAP / Campo experimental / Pantanal | ✅ / ✅ / 403 | ✅ / 403 / 403 | ✅ / 403 / 403 |
| M6 | Caso de isolamento | ver `RESTRITO-isolamento.md` | | |
| M7 | Token MQTT de sensor do PAVAP | 403 | ✅ | 403 |
| M8 | Grava atributo em sensor do PAVAP | 403 | ✅ | 403 |
| M9 | `createOrUpsertDevice` no grupo do PAVAP | 403 | **403** | 403 |
| M9b | `saveDevice` com `entityGroupId` do PAVAP | 403 | ✅ | 403 |
| M10 | `saveAlarm` | 403 | 403 | 403 |
| M11 | `getCustomerUsers` da unidade | ✅ (5) | 403 | 403 |
| R1 | REST: painéis visíveis | 1 | 1 | 1 |
| R2 | REST: cria painel no grupo de painéis do PAVAP | 403 | ✅ | 403 |
| R3 | REST: lista rule chains | 403 | 403 | 403 |
| R4 | REST: cria campo calculado em sensor do PAVAP | 403 | 403 | 403 |
| R5 | REST: RPC ao umidificador do PAVAP | 403 | 403 | 403 |
| R6 | REST: gera a própria API key | 403 | 403 | 403 |

**Achados:**
1. **O MCP oficial não cria painéis nem regras.** A versão 2.1.0 cobre dispositivos, assets, alarmes, telemetria, relações, usuários, grupos e OTA. Dashboards, rule chains, campos calculados e RPC ficam de fora. Pela REST, com a mesma chave, o Responsável cria painel no grupo do laboratório (R2). Regras e RPC dão 403 a todos (R3–R5), como nos testes 09 e 13.
2. **O MCP respeita o RBAC** nos casos M1–M5, M7, M8 e M9b. O M6 está no arquivo restrito.
3. **A ferramenta "principal" de cadastro não serve a usuários de customer.** O `createOrUpsertDevice` consulta `/api/tenant/devices` antes de gravar e dá 403 até para o Responsável. É preciso orientar o cliente de IA a usar o `saveDevice` com `entityGroupId`. O `getUsers` também falha para usuários de customer, com 400 em `/api/users`.
4. **Ninguém gera a própria API key** (R6: 403, `WRITE` em `USER`). A documentação pede o recurso `API Key` mais `Write` em `User`, e dar `Write` em `User` a pesquisadores abriria a edição de outras contas. O caminho é a plataforma gerar a chave de cada pessoa: o tenant pode gerá-la para usuários dos customers, com prazo, e ela é exibida uma única vez.
5. **Conta nunca ativada não usa API key:** responde 401 "User account is not active". A chave só funciona depois de a pessoa ativar a conta.

### Regra de controle criada pelo pesquisador (`10-regra-hvac.mjs`, 2026-10-27): 7 PASS

**Cenário:** o Responsável da localidade "Sala 1" é usuário do tenant, só com papel de grupo incluindo `WRITE_CALCULATED_FIELD`. Ele cria no HVAC um campo calculado `SCRIPT` com três argumentos:
- a temperatura do **sensor da sala**, outro dispositivo da mesma localidade (`refEntityId`);
- o `alvo`, atributo de servidor do HVAC;
- o `estado`, atributo de cliente que o HVAC confirma.

A saída é o atributo compartilhado `ligado`, com estratégia `IMMEDIATE` e `updateAttributesOnlyOnValueChange`. A histerese é de ±0,5 °C em torno de 24 °C.

| ID | Caso | Resultado |
| --- | --- | --- |
| H0, H1 | Responsável grava o alvo e cria a regra pela API | ✅ |
| H2 | Servidor: 26 → ligado; 24,2 → continua ligado; 23 → desligado; 24,3 → continua desligado; 25 → ligado | ✅ |
| H3 | A regra chega ao Edge quando o grupo da localidade é atribuído a ele | ✅ |
| H4 | **Servidor desligado:** 22 → desligado; 24,4 → continua desligado; 27 → ligado | ✅ |
| H5 | O HVAC, conectado por MQTT ao Edge, recebe `{"ligado":false}` e `{"ligado":true}` por push (`v1/devices/me/attributes`) | ✅ |
| H6 | Religada a Central, ela recebe o último estado decidido offline | ✅ |

**Achado.** A regra **não recebe o próprio resultado como argumento**: um argumento `ligado`, que é a própria saída, fica sempre no valor padrão. Na primeira rodada, isso quebrou a histerese. Para ter estado, a regra usa o que o dispositivo confirma, num atributo de cliente ou em telemetria. É também o que recomenda o guia de SCADA.

**Login pelo Embrapa I/O (testes avulsos de 2026-10-27):**
- O frontend aceita `?accessToken=...&refreshToken=...` na URL e apaga os parâmetros ao carregar.
- Uma conta com o papel genérico `USER: READ, IMPERSONATE` obtém o token de qualquer usuário, **inclusive de administradores do tenant**.
- O mesmo papel, restrito a um grupo de usuários, dá 403 até para quem está no grupo.
- Conclusão: a credencial que faz o login único vale tanto quanto a de administrador do tenant.

### Papéis e grupos na Central de desenvolvimento (`11-implantar-rbac.mjs`)

Diferente dos outros scripts, este age na **Central local** (`TB_CENTRAL_URL`, padrão `http://127.0.0.1:9095`), com a chave de API do `backend/.env`. Sem `--aplicar`, só lê e lista o que faria. Pode rodar de novo sem duplicar nada.

| Modelo herdado da 4.3 | Vira |
| --- | --- |
| Asset da localidade, com `Contains` para os sensores | Grupo `LOC · <localidade>` da unidade; cada sensor passa a ser da unidade |
| `AccessibleBy` asset → pessoa da mesma unidade | Pessoa em `<localidade> · Equipe` (papel Membro) |
| `AccessibleBy` asset → pessoa de outra unidade | Pessoa em `<localidade> · Colaboradores`, grupo da unidade dela (papel Membro) |
| `AccessibleBy` sensor → pessoa | `DISP · <sensor>` só com ele, sem ampliar para a localidade |
| Grupo "Customer Users" da unidade (vê tudo, com comando) | Esvaziado |

Também cria os papéis "Responsável pela localidade", "Membro da localidade" e "Gestor da unidade", além de um grupo `Gestores` por unidade e um `<localidade> · Responsáveis` no tenant. O grupo de cada localidade com sensores no Edge01 é atribuído a ele.

Ficam como estão: assets, relações `AccessibleBy` (o backend ainda as usa), contas de serviço e os grupos `Responsáveis`, que nascem vazios porque a Central não sabe quem é Maintainer.

**Aplicado em 2026-10-27**, depois do backup `thingsboard/backup/thingsboard-20261027-140137-antes-rbac.sql.gz`:
- foram 93 mudanças, das quais 15 trocas de dono e 1 atribuição ao Edge01, sem erro;
- uma segunda rodada deu 0 mudanças.

Três consequências, aceitas:
- 3 pessoas sem localidade perderam a visão da unidade;
- 2 sensores sem localidade ficaram no tenant;
- o Edge01 passou a receber a localidade PAVAP inteira, com 3 sensores a mais.

**Verificação:** com o token de cada pessoa, a Central e o `resolveAllowedScope` do backend deram o mesmo número de sensores.

| Pessoa | Sensores |
| --- | --- |
| fdsfds, com PAVAP e Nhumirim como colaboradora | 8 |
| stage1.pilot | 5 |
| mariana.pereira | 1 |
| As outras três | 0 |

Em todos os casos, a pessoa lê a telemetria e recebe 403 ao gravar atributo.

**Responsáveis (`12-definir-responsaveis.mjs`, aplicado em 2026-10-28)**, depois do backup `thingsboard-20261028-165443-antes-responsaveis.sql.gz`.

O Responsável precisa ser usuário do tenant, então a conta de unidade é apagada e recriada com o mesmo e-mail. A unidade de origem fica em `additionalInfo.unidadeOrigem`. O script preserva duas coisas:
- as leituras que a pessoa já tinha, em grupos equivalentes do tenant;
- as relações `AccessibleBy`, refeitas para o id novo, mais as das localidades novas;
- os atributos de servidor da conta antiga. Na primeira rodada, isso não acontecia: fdsfds perdeu o `manager = true`, que o `auth-gateway` exige na porta 9090, e o atributo foi reposto à mão.

A conta recriada nasce **sem senha**: até ser ativada pelo link de ativação, o login dá "User is not active". Pela 9090, isso aparece como 401, e depois como 429 pelo limite de 5 tentativas por minuto do Nginx.

| Pessoa | Responsável por | Também lê | Sensores |
| --- | --- | --- | --- |
| fdsfds (origem: Gado de Corte) | PAVAP, Casa de vegetação 01 e Campo Grande | Nhumirim, como colaboradora | 12 |
| maxwell (origem: Pantanal) | PAVAP | — | 6 |

**Verificação, com o token de cada um:**
- grava atributo e cria campo calculado nas próprias localidades;
- recebe 403 ao gravar ou criar regra em Nhumirim e fora delas;
- recebe 403 nas rule chains;
- a lista de usuários volta vazia;
- o `resolveAllowedScope` do backend dá os mesmos 12 e 6.

**Regressão encontrada:** depois da troca de dono, `/api/deviceInfos/all` só devolve os sensores da unidade com `includeCustomers=true`. Sem esse parâmetro, o status online do backend cobria só 2 dos 17 sensores; o `helper/thingsboard.js` foi corrigido.

## Conclusões

1. **O Edge 4.4 atende ao requisito offline:** reinicia e processa regras sem servidor e não faz verificação de licença própria.
2. **O servidor depende de internet:** verifica a licença a cada hora. Depois de 72 h sem conseguir, só a gestão trava.
3. **O pesquisador não pode receber permissão de regras restrita ao projeto.** Um papel de regras dá acesso a todas as rule chains do tenant, inclusive à raiz.
4. **O MCP 2.1.0 não cria painéis nem regras.** A API key de cada pessoa precisa ser gerada pela plataforma (`15-mcp-por-perfil.mjs`).
5. **Falta testar:** o bloqueio na prática do limite de 100 dispositivos (criar o 101º). O número de Edges do Free (1) e o Edge com chave de produção já foram testados em 24/10.

Os resultados de isolamento entre projetos (`04-rbac.mjs`, `05-confirma-vazamento.mjs`, `08-historico-websocket.mjs` e `15-mcp-por-perfil.mjs`) ficam fora deste repositório público até o relato ao fornecedor.

## Encerrar o ambiente

```bash
# na pasta thingsboard-4.4-test
docker compose --profile edge stop      # para tudo, mantendo os dados
docker compose --profile edge down -v   # remove contêineres e volumes da avaliação
```
