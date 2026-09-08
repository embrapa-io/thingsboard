# ThingsBoard for Embrapa I/O

Configuração de _deploy_ do [ThingsBoard CE](https://thingsboard.io) (_middleware IoT_) no ecossistema do Embrapa I/O.

Baseado na [configuração de _deploy_ do ThingsBoard usando Docker](https://thingsboard.io/docs/user-guide/install/docker/?ubuntuThingsboardQueue=kafka).

## Pilha tecnológica

Imagens fixadas na **macro-versão** de cada componente, recebendo apenas _patches_ de segurança/_bugfix_ (sem _breaking changes_):

| Componente | Imagem | Versão |
|---|---|---|
| ThingsBoard CE | `thingsboard/tb-node` | `4.3.1-latest` |
| PostgreSQL | `postgres` | `17` |
| Apache Kafka | `bitnamilegacy/kafka` | `4.0` |
| pgAdmin 4 | `dpage/pgadmin4` | `9` |
| Backup do Postgres | `prodrigestivill/postgres-backup-local` | `17` |

## Deploy

```sh
./bootstrap.sh
docker compose up -d --wait
```

O `bootstrap.sh` é **idempotente**:

- Gera `.env` (a partir de `.env.example`) com senhas aleatórias `[0-9a-zA-Z]` para `DB_PASSWORD` e `PGADMIN_PASSWORD`. Se o `.env` já existir, preserva os valores atuais.
- Cria os volumes Docker externos (`thingsboard_kafka`, `thingsboard_db`, `thingsboard_data`, `thingsboard_pgadmin`) e os _bind-mounts_ locais (`./log` → `thingsboard_log`, `./backup` → `thingsboard_backup`).

## Configuração

Usuários e senhas padrões do ThingsBoard:

- System Administrator: `sysadmin@thingsboard.org` / `sysadmin`
- Tenant Administrator: `tenant@thingsboard.org` / `tenant`
- Customer User: `customer@thingsboard.org` / `customer`

## Portas e transportes

Um único _hostname_ (`iot.embrapa.io`) atende todos os transportes, diferenciados pela porta. O TLS de HTTPS e de MQTTS é terminado pelo **nginx instalado no host** (fora dos containers), com certificado **Let's Encrypt** renovado automaticamente pelo `certbot` — o mesmo padrão do boilerplate `thingsboard-edge` usado nos Edges das Unidades.

| Porta | Quem escuta | Protocolo | Uso |
|---|---|---|---|
| `80/tcp` | nginx (host) | HTTP | _Redirect_ para HTTPS e desafio ACME do `certbot` |
| `443/tcp` | nginx (host) → `127.0.0.1:${PORT_WEB}` | HTTPS | UI, API REST e WebSocket |
| `1883/tcp` | Docker (port binding do serviço `thingsboard`) | MQTT plain | Devices legados que não fazem _handshake_ TLS (ex.: ESPHome). Autenticação por _access token_ do device |
| `8883/tcp` | nginx (host, bloco `stream`) → `127.0.0.1:1883` | **MQTTS** | **Porta padrão** para devices (Tasmota, gateways, Edges). Obrigatória para devices com atuadores |
| `7070/tcp` | Docker (port binding) | gRPC | Sincronização dos ThingsBoard Edge das Unidades |

> **Não publicados**: CoAP (`5683-5688/udp`) foi removido do `docker-compose.yml` em set/2026 por não ter uso na plataforma. Kafka (`${PORT_KAFKA}`) e pgAdmin (`${PORT_PGADMIN}`) são publicados apenas para acesso local/administrativo e devem permanecer bloqueados no _firewall_ do host.

Em nenhum caso o ThingsBoard aceita conexão MQTT anônima: todo `CONNECT` exige credencial do device (_access token_, usuário/senha ou certificado X.509), e um device só publica/assina os próprios tópicos (`v1/devices/me/...`).

### MQTTS (8883) — TLS terminado pelo nginx do host

A porta `8883` **não** aparece no `docker-compose.yml`: quem escuta nela é o nginx do host, que termina o TLS e encaminha em MQTT plain para o port binding `127.0.0.1:1883` do container. O certificado é o mesmo já emitido para `iot.embrapa.io` (HTTPS) — o cliente MQTTS valida o **nome do host**, não o protocolo.

O bloco de configuração está versionado em [`nginx/mqtts-stream.conf`](nginx/mqtts-stream.conf). _Setup_ no host (uma vez):

```sh
# 1. Módulo stream do nginx (Ubuntu)
sudo apt install -y libnginx-mod-stream

# 2. Bloco stream no nível top do nginx.conf (fora de http {}), se ainda não existir
grep -q 'stream.d' /etc/nginx/nginx.conf || sudo tee -a /etc/nginx/nginx.conf <<'EOF'

stream {
    include /etc/nginx/stream.d/*.conf;
}
EOF

# 3. Instalar o snippet versionado neste repositório
sudo install -d /etc/nginx/stream.d
sudo install -m 0644 nginx/mqtts-stream.conf /etc/nginx/stream.d/mqtts.conf

# 4. Firewall
sudo ufw allow 8883/tcp

# 5. Validar e aplicar
sudo nginx -t && sudo systemctl reload nginx

# 6. Deploy hook do certbot: recarregar o nginx após cada renovação (443 e 8883 usam o mesmo cert)
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/bash
nginx -s reload
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
```

Validação a partir de qualquer máquina na internet:

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
```

> **Limitação conhecida**: com o TLS terminado no nginx, o ThingsBoard não recebe o certificado do cliente, portanto credenciais **X.509 (TLS mútuo)** não funcionam nesta topologia. Se vier a ser necessário, habilitar o TLS nativo no transporte MQTT do ThingsBoard (`MQTT_SSL_ENABLED=true` com o PEM do Let's Encrypt montado no container) em vez do bloco `stream`.

> **Firmware dos devices**: o ESPHome não valida a cadeia TLS de forma prática (exigiria embarcar o certificado, renovado a cada ~90 dias). Para MQTTS, usar **Tasmota** (`MqttHost iot.embrapa.io`, `MqttPort 8883`, `SetOption103 1`) ou bibliotecas com _CA bundle_ do sistema.

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
  thingsboard/tb-node:4.3.1-latest upgrade-tb.sh
docker compose rm thingsboard
docker compose up -d --force-recreate --wait
```

Substitua `'4.3.1.1'` pela versão **atual** instalada (que será sobrescrita pela nova).
