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
