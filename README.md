# ThingsBoard for Embrapa I/O

Configuração de _deploy_ do [ThingsBoard CE](https://thingsboard.io) (_middleware IoT_) no ecossistema do Embrapa I/O.

Baseado na [configuração de _deploy_ do ThingsBoard usando Docker](https://thingsboard.io/docs/user-guide/install/docker/?ubuntuThingsboardQueue=kafka).

## Pilha tecnológica

Imagens fixadas na **macro-versão** de cada componente, recebendo apenas _patches_ de segurança/_bugfix_ (sem _breaking changes_). O ThingsBoard é a exceção: fica fixado no _patch_ exato. Ver a nota abaixo da tabela:

| Componente | Imagem | Versão |
|---|---|---|
| ThingsBoard CE | `thingsboard/tb-node` | `4.3.1.1` |
| PostgreSQL | `postgres` | `17` |
| Apache Kafka | `bitnamilegacy/kafka` | `4.0` |
| pgAdmin 4 | `dpage/pgadmin4` | `9` |
| Backup do Postgres | `prodrigestivill/postgres-backup-local` | `17` |
| Grafana IoT | `grafana/grafana` (+ plugin Infinity) | `12.4.11` (Infinity `4.1.1`) |

> **Não atualizar para a 4.4 ou superior.** A partir da 4.4 (29/09/2026) o ThingsBoard passou para a _Business Source License_ 1.1: uso gratuito limitado a 100 dispositivos (ou 1.000 sem fins comerciais), marca obrigatória e chave de licença com checagem _online_. A linha 4.3 continua Apache 2.0 de forma irrevogável e recebe _patches_ de segurança até 20/07/2027. Neste branch (`iot-tb4.3`, linha 4.3 congelada como base da avaliação) a imagem fica no _patch_ exato (`4.3.1.1`), para que o ambiente avaliado seja reproduzível; um _patch_ 4.3.1.x novo entra só por decisão deliberada. **Nunca** troque a tag para `latest` puro ou para 4.4+. O instalador da 4.4 converte o banco CE para a edição licenciada, o que torna um _upgrade_ acidental irreversível.

## Deploy

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

## MQTT em desenvolvimento local

A Central não termina TLS: em produção, o MQTTS (8883) e o MQTT plain (1883) são
atendidos pelo nginx do host (ver "Portas e transportes"). Na máquina de
desenvolvimento, sem esse nginx e no Docker Desktop (que não tem journald),
defina no `.env` da Central:

```dotenv
MQTT_PROXY_PROTOCOL_ENABLED=false
TB_LOG_DRIVER=json-file
```

Os devices de teste conectam em MQTT plain em `127.0.0.1:${PORT_MQTT}` (1884). No
`.env` do backend, anuncie esse endereço com `THINGSBOARD_DEVICE_MQTT_ENABLED=true`.

## Certificados MQTTS do Edge para desenvolvimento

Os certificados abaixo não são mais usados pela Central. Servem ao MQTTS do
ThingsBoard Edge em desenvolvimento, cujo compose monta, por padrão,
`../thingsboard/certs/server.pem` e `server_key.pem`.

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

Nunca use a CA de desenvolvimento em produção. O ambiente definitivo deve utilizar certificado emitido para o domínio real e proteger a chave privada por meio do mecanismo de segredos da infraestrutura.

## Configuração

Usuários e senhas padrões do ThingsBoard:

- System Administrator: `sysadmin@thingsboard.org` / `sysadmin`
- Tenant Administrator: `tenant@thingsboard.org` / `tenant`
- Customer User: `customer@thingsboard.org` / `customer`

## Portas e transportes

Um único _hostname_ (`iot.embrapa.io`) atende todos os transportes, diferenciados pela porta. Tudo o que é exposto à internet passa pelo **nginx instalado no host** (fora dos containers): ele termina TLS (HTTPS e MQTTS) com certificado **Let's Encrypt** renovado pelo `certbot`, e fronteia também o MQTT plain para entregar ao ThingsBoard o IP real de cada device via **PROXY protocol**. Os serviços do compose são publicados **somente em `127.0.0.1`** (exceto o gRPC dos Edges).

| Porta pública | Quem escuta | Protocolo | Encaminha para | Uso |
|---|---|---|---|---|
| `80/tcp` | nginx (host) | HTTP | — | _Redirect_ para HTTPS e desafio ACME do `certbot` |
| `443/tcp` | nginx (host) | HTTPS | `127.0.0.1:${PORT_WEB}` | UI, API REST e WebSocket |
| `1883/tcp` | nginx (host, bloco `stream`) | MQTT plain | `127.0.0.1:${PORT_MQTT}` + PROXY protocol | Devices legados que não fazem _handshake_ TLS (ex.: ESPHome). Autenticação por _access token_ do device |
| `8883/tcp` | nginx (host, bloco `stream`) | **MQTTS** | `127.0.0.1:${PORT_MQTT}` + PROXY protocol | **Porta padrão** para devices (Tasmota, gateways). Obrigatória para devices com atuadores |
| `7070/tcp` | Docker (port binding) | gRPC | container `thingsboard` | Sincronização dos ThingsBoard Edge das Unidades |

> **Não publicados**: CoAP (`5683-5688/udp`) foi removido do `docker-compose.yml` em set/2026 por não ter uso na plataforma. Kafka (`${PORT_KAFKA}`), pgAdmin (`${PORT_PGADMIN}`), a UI HTTP (`${PORT_WEB}`) e o MQTT do container (`${PORT_MQTT}`, padrão `1884`) só escutam em `127.0.0.1`.

Em nenhum caso o ThingsBoard aceita conexão MQTT anônima: todo `CONNECT` exige credencial do device (_access token_, usuário/senha ou certificado X.509), e um device só publica/assina os próprios tópicos (`v1/devices/me/...`).

### Proteção contra força bruta (bloqueio por IP + fail2ban)

Três camadas, todas versionadas neste repositório:

| Camada | Onde | Regra |
|---|---|---|
| **ThingsBoard** (nativo) | `docker-compose.yml` → `TB_TRANSPORT_IP_RATE_LIMITS_ENABLED=true` | Após **10** `CONNECT` com credencial inválida vindos do mesmo IP (`TB_TRANSPORT_MAX_WRONG_CREDENTIALS_PER_IP`), o IP é bloqueado por **60 s** (`TB_TRANSPORT_IP_BLOCK_TIMEOUT`, padrão do produto) e o evento vai ao log: `IP address blocked due to constantly wrong credentials`. Funciona porque o nginx repassa o IP real com PROXY protocol (`MQTT_PROXY_PROTOCOL_ENABLED=true`) |
| **fail2ban** (host) | [`fail2ban/filter.d/thingsboard-mqtt.conf`](fail2ban/filter.d/thingsboard-mqtt.conf) e [`fail2ban/jail.d/thingsboard.conf`](fail2ban/jail.d/thingsboard.conf) | Jail `thingsboard-mqtt`: lê o log do container pelo journal (`backend = systemd`, `journalmatch = CONTAINER_TAG=thingsboard`); **5** bloqueios do ThingsBoard (≥ 50 `CONNECT` inválidos) em **30 min** ⇒ **ban de 1 h** no firewall nas portas `1883` e `8883`. Jail `recidive`: **3** bans em **1 dia** ⇒ **1 semana** fora, em todas as portas. Jail `sshd` habilitada. `ignoreip` cobre loopback e a rede Docker (e pode receber o IP de NAT de uma Unidade que precise de tolerância) |
| **nginx** (host) | [`nginx/mqtt-stream.conf`](nginx/mqtt-stream.conf) | `limit_conn` de **500** conexões simultâneas por IP em `1883` e `8883` (generoso: uma Unidade inteira pode sair por um único NAT) |

> **Efeito colateral conhecido**: os limites são por IP de origem. Um único device com token errado, insistindo a cada 10 s atrás do NAT de uma Unidade, bloqueia os vizinhos do mesmo NAT por 60 s a cada ciclo e, se persistir por meia hora, leva ao ban de 1 h. É intencional: torna o device mal configurado visível. Para liberar: `fail2ban-client set thingsboard-mqtt unbanip <IP>`.

### _Setup_ no host (uma vez)

Pré-requisito: nginx + certbot já instalados no host com o certificado de `iot.embrapa.io` emitido para o HTTPS (443).

```sh
# 1. Módulo stream do nginx + fail2ban com suporte a journal
sudo apt install -y libnginx-mod-stream fail2ban python3-systemd

# 2. Bloco stream no nível top do nginx.conf (fora de http {}), se ainda não existir
grep -q 'stream.d' /etc/nginx/nginx.conf || sudo tee -a /etc/nginx/nginx.conf <<'EOF'

stream {
    include /etc/nginx/stream.d/*.conf;
}
EOF
sudo install -d /etc/nginx/stream.d
sudo install -m 0644 nginx/mqtt-stream.conf /etc/nginx/stream.d/mqtt.conf

# 3. Firewall: o host iot.embrapa.io NÃO tem ufw; quem filtra é o firewall de
#    perímetro da Embrapa (SITI). A 8883/TCP precisa ser liberada lá, preservando
#    o IP de origem (chamado aberto em set/2026). Em hosts com ufw:
#    sudo ufw allow 1883,8883/tcp

# 4. Recriar o ThingsBoard com o MQTT em 127.0.0.1:${PORT_MQTT} (1884), PROXY protocol,
#    bloqueio por IP e logging journald. Antes: (a) PORT_MQTT=1884 no .env;
#    (b) o site nginx do 443 deve apontar para 127.0.0.1/localhost:${PORT_WEB},
#        pois a UI passa a escutar só em loopback:
grep -rn proxy_pass /etc/nginx/sites-enabled/
sed -i 's/^PORT_MQTT=1883$/PORT_MQTT=1884/' .env && grep ^PORT_MQTT .env
docker compose up -d --force-recreate --remove-orphans thingsboard

# 5. Só agora o nginx consegue escutar a 1883 (o docker-proxy a liberou)
sudo nginx -t && sudo systemctl reload nginx

# 6. Deploy hook do certbot: recarregar o nginx após cada renovação (443 e 8883 usam o mesmo cert)
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/bash
nginx -s reload
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

# 7. fail2ban
sudo install -m 0644 fail2ban/filter.d/thingsboard-mqtt.conf /etc/fail2ban/filter.d/
sudo install -m 0644 fail2ban/jail.d/thingsboard.conf        /etc/fail2ban/jail.d/
sudo systemctl enable --now fail2ban && sudo systemctl restart fail2ban
sudo fail2ban-client status thingsboard-mqtt
```

### Validação

A partir de qualquer máquina na internet — **fora da VPN da Embrapa**. Pela VPN o tráfego entra por dentro do perímetro e chega ao host com o IP do concentrador (`172.20.0.165`), o que mascara tanto o filtro do perímetro quanto os limites por IP.

```sh
# Handshake TLS na 8883 deve apresentar o cert Let's Encrypt de iot.embrapa.io
openssl s_client -connect iot.embrapa.io:8883 -servername iot.embrapa.io </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates

# Publicação MQTTS com access token de um device (cadeia pública, sem CA custom)
mosquitto_pub -h iot.embrapa.io -p 8883 --tls-use-os-certs \
  -t "v1/devices/me/telemetry" -u "<ACCESS_TOKEN>" -m '{"temperatura":25.4}'

# A mesma publicação em MQTT plain (1883) continua funcionando para devices legados
mosquitto_pub -h iot.embrapa.io -p 1883 \
  -t "v1/devices/me/telemetry" -u "<ACCESS_TOKEN>" -m '{"temperatura":25.4}'

# Bloqueio por IP: 10 CONNECT com token inválido => 11º é recusado na conexão
for i in $(seq 1 11); do mosquitto_pub -h iot.embrapa.io -p 8883 --tls-use-os-certs \
  -t v1/devices/me/telemetry -u token-invalido -m '{}' 2>&1 | tail -1; done
```

No host:

```sh
# O log do container deve mostrar o IP REAL do cliente (não 127.0.0.1) e o bloqueio
journalctl CONTAINER_TAG=thingsboard --since -10m | grep -i "IP address blocked"
# ... e o fail2ban deve ter banido
sudo fail2ban-client status thingsboard-mqtt
sudo fail2ban-client set thingsboard-mqtt unbanip <IP>   # para desfazer o teste
```

> **Limitação conhecida**: com o TLS terminado no nginx, o ThingsBoard não recebe o certificado do cliente, portanto credenciais **X.509 (TLS mútuo)** não funcionam nesta topologia. Se vier a ser necessário, habilitar o TLS nativo no transporte MQTT do ThingsBoard (`MQTT_SSL_ENABLED=true` com o PEM do Let's Encrypt montado no container) em vez do bloco `stream`.

> **Firmware dos devices**: o ESPHome não valida a cadeia TLS de forma prática (exigiria embarcar o certificado, renovado a cada ~90 dias). Para MQTTS, usar **Tasmota** (`MqttHost iot.embrapa.io`, `MqttPort 8883`, `SetOption103 1`) ou bibliotecas com _CA bundle_ do sistema.

## Update

Para subir a versão do ThingsBoard (apenas _patches_ 4.3.1.x; **nunca** para a 4.4 ou superior), ajuste a tag em `docker-compose.yml` (linha do serviço `thingsboard`) e execute o procedimento oficial de _upgrade_:

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
