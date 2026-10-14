# ThingsBoard for Embrapa I/O

Configuração de _deploy_ do [ThingsBoard CE](https://thingsboard.io) (_middleware IoT_) no ecossistema do Embrapa I/O.

Baseado na [configuração de _deploy_ do ThingsBoard usando Docker](https://thingsboard.io/docs/user-guide/install/docker/?ubuntuThingsboardQueue=kafka).

## Pilha tecnológica

Imagens fixadas na **macro-versão** de cada componente, recebendo apenas _patches_ de segurança/_bugfix_ (sem _breaking changes_). O ThingsBoard é a exceção: fica fixado no _patch_ exato, porque o projeto permanece na linha 4.3 (a 4.4 mudou para licença BUSL) e qualquer atualização deve ser deliberada:

| Componente | Imagem | Versão |
|---|---|---|
| ThingsBoard CE | `thingsboard/tb-node` | `4.3.1.1` |
| PostgreSQL | `postgres` | `17` |
| Apache Kafka | `bitnamilegacy/kafka` | `4.0` |
| pgAdmin 4 | `dpage/pgadmin4` | `9` |
| Backup do Postgres | `prodrigestivill/postgres-backup-local` | `17` |
| Grafana IoT | `grafana/grafana` (+ plugin Infinity) | `12.4.11` (Infinity `4.1.1`) |

## Deploy

Gere os certificados de desenvolvimento antes do primeiro bootstrap:

    .\generate-dev-mqtt-certs.ps1

Em Linux ou macOS:

    bash ./generate-dev-mqtt-certs.sh

```sh
./bootstrap.sh
docker compose up -d --wait
```

O `bootstrap.sh` é **idempotente**:

- Gera `.env` (a partir de `.env.example`) com senhas aleatórias `[0-9a-zA-Z]` para `DB_PASSWORD` e `PGADMIN_PASSWORD`. Se o `.env` já existir, preserva os valores atuais.
- Cria os volumes Docker externos (`thingsboard_kafka`, `thingsboard_db`, `thingsboard_data`, `thingsboard_pgadmin`) e os _bind-mounts_ locais (`./log` → `thingsboard_log`, `./backup` → `thingsboard_backup`).

## Entrada web e prova de conceito de autorização

O serviço `nginx` é a única porta web publicada pela Central (`PORT_WEB`). O
ThingsBoard fica acessível apenas na rede Docker interna e o `auth-gateway` também
não publica porta no host. MQTT, MQTTS e Edge RPC continuam nas portas próprias e
não passam pela política web.

O gateway encaminha login e renovação ao ThingsBoard e só devolve tokens quando o
usuário possui o atributo de servidor `manager` com valor booleano real `true`.
Usuários sem o atributo, com `false` ou com valor textual recebem `403`; falhas da
dependência negam por `503`. O gateway não registra credenciais nem tokens.

Antes de subir a entrada web, crie no ThingsBoard uma credencial exclusiva e
revogável para o gateway, com permissão suficiente para consultar atributos de
usuários, e defina somente no `.env` (nunca no navegador):

```dotenv
TB_AUTH_GATEWAY_TOKEN=<token-interno-do-auth-gateway>
```

O valor não deve ser reutilizado pelo backend ou por um usuário humano. Sem essa
variável o gateway permanece em falha fechada e os logins retornam `503`.

Valide a configuração e os testes do gateway antes de recriar a stack:

```sh
cd auth-gateway
npm test
cd ..
node --test nginx/test/embrapa-access-denied.test.js
docker compose config -q
```

Quando o gateway nega o login com `403`, o Nginx injeta uma customização pequena
no frontend oficial do ThingsBoard. O diálogo resultante mostra o título
`Acesso negado`, explica que o usuário não possui acesso e oferece somente o
botão `Ok`. Esse botão fecha o aviso sem executar logout ou uma nova tentativa
de login. A customização está em
`nginx/static/embrapa-access-denied.js` e só atua no diálogo padrão de acesso
proibido; os demais diálogos não são modificados.

## Camada de telemetria e Grafana IoT

A telemetria é lida por `/telemetry/`, sempre via API do ThingsBoard e sem
passar pelo Embrapa I/O. O `telemetry-gateway` valida um JWT assinado com
`TELEMETRY_JWT_SECRET` e o NGINX repassa ao ThingsBoard somente a consulta
normalizada por ele, com a credencial de serviço `TB_TELEMETRY_TOKEN`, que
nunca sai da stack.

Há dois escopos de token:

- **projeto**: gerado pelo autômato `iot` do Embrapa I/O e gravado no
  data source Infinity da organização do projeto no Grafana. Lista os
  dispositivos vinculados; o caminho leva o ID: `/telemetry/DEVICE/{id}/...`.
- **dispositivo**: gerado pelo backend na aba Consumo do diálogo "Dados de
  acesso". O ID vem do próprio token: `/telemetry/values/timeseries`.

Somente leitura de telemetria é aceita (`values/timeseries` e
`keys/timeseries`, apenas GET). Períodos maiores que `TELEMETRY_MAX_RANGE_DAYS`
são recortados para os dias mais recentes e cada consulta devolve no máximo
`TELEMETRY_MAX_POINTS` pontos. Exemplo:

```sh
curl -H "Authorization: Bearer $TOKEN"   "http://localhost:9090/telemetry/values/timeseries?keys=temperature&startTs=1788235200000&endTs=1790827200000&agg=AVG&interval=86400000"
```

`TB_TELEMETRY_TOKEN` é uma API key de um usuário de serviço exclusivo
(`telemetry-gateway@iot.embrapa.br`, tenant admin ativado, sem o atributo
`manager`). O ThingsBoard só aceita API keys de usuários ativados.

O Grafana IoT roda nesta stack (`grafana`), com o plugin Infinity
pré-instalado. Cada projeto do Embrapa I/O tem uma organização própria: no
Grafana OSS qualquer membro consulta qualquer data source da organização, então
pastas e equipes não isolam dados. Até a fase do OAuth GitLab, o login é feito
pelo Embrapa I/O via auth proxy; o header de usuário só é aceito da rede
`GRAFANA_PROXY_NETWORK` (sub-rede em `GRAFANA_AUTH_PROXY_WHITELIST`), que liga
apenas o NGINX do dashboard ao Grafana. O `bootstrap.sh` cria essa rede.

Testes da camada:

```sh
cd telemetry-gateway
npm test
```

## Certificados MQTTS para desenvolvimento

Antes de habilitar o listener MQTTS, gere uma autoridade certificadora e um certificado local para o servidor.

No PowerShell:

    .\generate-dev-mqtt-certs.ps1

Para incluir o IP da máquina utilizado por devices na rede local:

    .\generate-dev-mqtt-certs.ps1 -IpAddress @('127.0.0.1', '192.168.1.50')

No Bash:

    MQTT_CERT_IP_ADDRESSES="127.0.0.1,192.168.1.50" bash ./generate-dev-mqtt-certs.sh

Por padrão, o certificado inclui os nomes DNS localhost e thingsboard, além do IP 127.0.0.1. Para adicionar outros nomes no Bash:

    MQTT_CERT_DNS_NAMES="localhost,thingsboard,nome-da-maquina" bash ./generate-dev-mqtt-certs.sh

Se já existirem certificados, os scripts interrompem a execução. Para substituí-los conscientemente, use -Force no PowerShell ou MQTT_CERT_FORCE=true no Bash.

Os arquivos são gravados em certs e ignorados pelo Git. O arquivo ca.pem é público e deve ser instalado nos clientes de desenvolvimento. As chaves ca_key.pem e server_key.pem são secretas.

O compose monta somente `server.pem` e `server_key.pem` no container e mantém
MQTTS habilitado na porta `8883`. O transporte MQTT precisa permanecer ativo
para isso; a porta `1883` fica presa ao loopback interno por padrão e não é
anunciada pelo backend.

Para habilitar MQTT simples conscientemente em um ambiente local, defina no
`.env` da Central e no `.env` do backend:

```dotenv
MQTT_BIND_ADDRESS=0.0.0.0
THINGSBOARD_DEVICE_MQTT_ENABLED=true
```

Depois recrie apenas o serviço da Central com `docker compose up -d
--force-recreate thingsboard`. Em produção, mantenha o bind em loopback e
`THINGSBOARD_DEVICE_MQTT_ENABLED=false`, anunciando somente MQTTS aos devices.

Nunca use a CA de desenvolvimento em produção. O ambiente definitivo deve utilizar certificado emitido para o domínio real e proteger a chave privada por meio do mecanismo de segredos da infraestrutura.

## Configuração

Usuários e senhas padrões do ThingsBoard:

- System Administrator: `sysadmin@thingsboard.org` / `sysadmin`
- Tenant Administrator: `tenant@thingsboard.org` / `tenant`
- Customer User: `customer@thingsboard.org` / `customer`

## Update

Para subir a versão do ThingsBoard, ajuste a tag em `docker-compose.yml` (linha do serviço `thingsboard`) e execute o procedimento oficial de _upgrade_:

```sh
docker compose stop && docker compose pull && docker compose up -d db
echo '4.3.1.1' > $(pwd)/log/.upgradeversion
docker run -it --rm \
  --network "$(docker compose ps --format '{{.Service}} {{.Network}}' db | awk '{print $2}')" \
  -e SPRING_DATASOURCE_URL=jdbc:postgresql://db:5432/thingsboard \
  -e SPRING_DATASOURCE_USERNAME="$(grep ^DB_USER= .env | cut -d= -f2)" \
  -e SPRING_DATASOURCE_PASSWORD="$(grep ^DB_PASSWORD= .env | cut -d= -f2)" \
  thingsboard/tb-node:<nova-versao> upgrade-tb.sh
docker compose rm thingsboard
docker compose up -d --force-recreate --wait
```

Substitua `'4.3.1.1'` pela versão **atual** instalada (que será sobrescrita pela nova) e `<nova-versao>` pela mesma _tag_ colocada no `docker-compose.yml` (ex.: `4.3.1.6`). Não use versões 4.4 ou superiores.
