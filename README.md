# ThingsBoard for Embrapa I/O

Configuração de deploy do [ThingsBoard](https://thingsboard.io) (_middleware IoT_) no ecossistema do Embrapa I/O.

Baseado na [configuração de _deploy_ do ThingsBoard usando Docker](https://thingsboard.io/docs/user-guide/install/docker/?ubuntuThingsboardQueue=kafka).

## Deploy

```
docker volume create thingsboard_kafka
docker volume create thingsboard_db
docker volume create thingsboard_data
docker volume create --driver local --opt type=none --opt device=$(pwd)/log --opt o=bind thingsboard_log
docker volume create --driver local --opt type=none --opt device=$(pwd)/backup --opt o=bind thingsboard_backup

cp .env.example .env

docker-compose up --force-recreate --build --remove-orphans --wait
```

## Configuração

...

## Update

...
