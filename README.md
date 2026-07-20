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

O compose monta somente server.pem e server_key.pem no container, habilita MQTTS na porta 8883 e não publica a porta MQTT sem TLS 1883 no host.

O listener simples permanece vinculado ao loopback interno do container. Clientes externos devem utilizar exclusivamente MQTTS.

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
  thingsboard/tb-node:4.3.1-latest upgrade-tb.sh
docker compose rm thingsboard
docker compose up -d --force-recreate --wait
```

Substitua `'4.3.1.1'` pela versão **atual** instalada (que será sobrescrita pela nova).
