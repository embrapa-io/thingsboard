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
4. **Falta testar:** o bloqueio na prática do limite de 100 dispositivos (criar o 101º). O número de Edges do Free (1) e o Edge com chave de produção já foram testados em 24/10.

Os resultados de isolamento entre projetos (`04-rbac.mjs` e `05-confirma-vazamento.mjs`) ficam fora deste repositório público até o relato ao fornecedor.

## Encerrar o ambiente

```bash
# na pasta thingsboard-4.4-test
docker compose --profile edge stop      # para tudo, mantendo os dados
docker compose --profile edge down -v   # remove contêineres e volumes da avaliação
```
