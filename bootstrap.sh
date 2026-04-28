#!/usr/bin/env bash
#
# Bootstrap idempotente para o ThingsBoard CE no Embrapa I/O.
#
# Gera o arquivo .env (a partir de .env.example) substituindo senhas/segredos
# por valores aleatórios alfanuméricos [0-9a-zA-Z], e cria os volumes Docker
# externos requeridos pelo docker-compose.yml (incluindo bind-mounts locais
# para logs e backups). Pode ser executado quantas vezes forem necessárias —
# não sobrescreve estado existente.
#
# Uso: ./bootstrap.sh

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly ENV_FILE="${SCRIPT_DIR}/.env"
readonly ENV_EXAMPLE="${SCRIPT_DIR}/.env.example"
readonly LOG_DIR="${SCRIPT_DIR}/log"
readonly BACKUP_DIR="${SCRIPT_DIR}/backup"

# UID/GID dos usuários internos dos containers (definidos pelas próprias imagens).
readonly TB_UID=799     # 'thingsboard' em thingsboard/tb-node
readonly TB_GID=799
readonly PG_UID=999     # 'postgres' em postgres / prodrigestivill/postgres-backup-local (debian)
readonly PG_GID=999

# Variáveis cujos valores devem ser substituídos por segredos aleatórios.
readonly SECRET_VARS=(DB_PASSWORD PGADMIN_PASSWORD)

# Comprimento dos segredos gerados (32 caracteres alfanuméricos).
readonly SECRET_LENGTH=32

log() { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[bootstrap]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[bootstrap]\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "Dependência ausente: '$1'. Instale-a antes de prosseguir."
}

# Gera uma string aleatória [0-9a-zA-Z] de SECRET_LENGTH caracteres.
random_secret() {
  LC_ALL=C tr -dc '0-9a-zA-Z' </dev/urandom | head -c "${SECRET_LENGTH}"
}

# Substitui o valor de uma variável no arquivo .env de forma segura
# (sem usar sed com delimitadores que podem colidir com o segredo).
set_env_var() {
  local var="$1" value="$2" file="$3"
  local tmp
  tmp="$(mktemp)"
  awk -v var="${var}" -v val="${value}" '
    BEGIN { done = 0 }
    {
      if ($0 ~ "^" var "=") {
        print var "=" val
        done = 1
      } else {
        print
      }
    }
    END {
      if (!done) print var "=" val
    }
  ' "${file}" >"${tmp}"
  mv "${tmp}" "${file}"
}

ensure_env_file() {
  if [[ -f "${ENV_FILE}" ]]; then
    log ".env já existe — preservando valores atuais."
    return 0
  fi

  [[ -f "${ENV_EXAMPLE}" ]] || fail ".env.example não encontrado em ${ENV_EXAMPLE}"

  log "Gerando .env a partir de .env.example com segredos aleatórios."
  cp "${ENV_EXAMPLE}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"

  for var in "${SECRET_VARS[@]}"; do
    local secret
    secret="$(random_secret)"
    set_env_var "${var}" "${secret}" "${ENV_FILE}"
    log "  - ${var} definido (${SECRET_LENGTH} chars aleatórios)."
  done
}

ensure_local_dir() {
  local dir="$1"
  if [[ -d "${dir}" ]]; then
    return 0
  fi
  log "Criando diretório local: ${dir}"
  mkdir -p "${dir}"
}

# Ajusta ownership do diretório local para o UID/GID do usuário interno do container.
# Necessário para bind-mounts onde o processo do container não roda como root.
ensure_dir_owner() {
  local dir="$1" uid="$2" gid="$3"
  ensure_local_dir "${dir}"
  local current_uid current_gid
  current_uid="$(stat -c '%u' "${dir}" 2>/dev/null || stat -f '%u' "${dir}")"
  current_gid="$(stat -c '%g' "${dir}" 2>/dev/null || stat -f '%g' "${dir}")"
  if [[ "${current_uid}" == "${uid}" && "${current_gid}" == "${gid}" ]]; then
    return 0
  fi
  if [[ "$(id -u)" -ne 0 ]]; then
    warn "Ownership de ${dir} é ${current_uid}:${current_gid}, esperado ${uid}:${gid}. Re-execute com sudo para ajustar."
    return 0
  fi
  log "  - ajustando ownership de ${dir} para ${uid}:${gid}"
  chown -R "${uid}:${gid}" "${dir}"
}

# Cria um volume Docker nomeado se não existir. Idempotente.
ensure_named_volume() {
  local name="$1"
  if docker volume inspect "${name}" >/dev/null 2>&1; then
    log "  - volume '${name}' já existe."
    return 0
  fi
  log "  - criando volume '${name}'."
  docker volume create "${name}" >/dev/null
}

# Cria um volume Docker bind-mount apontando para um diretório local. Idempotente.
ensure_bind_volume() {
  local name="$1" path="$2" uid="${3:-}" gid="${4:-}"
  if [[ -n "${uid}" && -n "${gid}" ]]; then
    ensure_dir_owner "${path}" "${uid}" "${gid}"
  else
    ensure_local_dir "${path}"
  fi
  if docker volume inspect "${name}" >/dev/null 2>&1; then
    log "  - volume '${name}' (bind ${path}) já existe."
    return 0
  fi
  log "  - criando volume '${name}' (bind ${path})."
  docker volume create \
    --driver local \
    --opt type=none \
    --opt device="${path}" \
    --opt o=bind \
    "${name}" >/dev/null
}

# Lê o valor de uma variável a partir do .env (sem `source`, para não exportar tudo).
read_env_var() {
  local var="$1"
  awk -F= -v var="${var}" '$1 == var { sub(/^[^=]*=/, ""); print; exit }' "${ENV_FILE}"
}

ensure_volumes() {
  local v_kafka v_db v_tb v_log v_backup v_pgadmin
  v_kafka="$(read_env_var VOLUME_KAFKA)"
  v_db="$(read_env_var VOLUME_DB)"
  v_tb="$(read_env_var VOLUME_THINGSBOARD)"
  v_log="$(read_env_var VOLUME_LOG)"
  v_backup="$(read_env_var VOLUME_BACKUP)"
  v_pgadmin="$(read_env_var VOLUME_PGADMIN)"

  for pair in \
    "VOLUME_KAFKA:${v_kafka}" \
    "VOLUME_DB:${v_db}" \
    "VOLUME_THINGSBOARD:${v_tb}" \
    "VOLUME_LOG:${v_log}" \
    "VOLUME_BACKUP:${v_backup}" \
    "VOLUME_PGADMIN:${v_pgadmin}"; do
    [[ -n "${pair#*:}" ]] || fail "Variável '${pair%%:*}' está vazia no .env"
  done

  log "Provisionando volumes Docker externos:"
  ensure_named_volume "${v_kafka}"
  ensure_named_volume "${v_db}"
  ensure_named_volume "${v_tb}"
  ensure_named_volume "${v_pgadmin}"
  ensure_bind_volume "${v_log}" "${LOG_DIR}" "${TB_UID}" "${TB_GID}"
  ensure_bind_volume "${v_backup}" "${BACKUP_DIR}" "${PG_UID}" "${PG_GID}"
}

# Detecta se o schema do ThingsBoard já foi instalado no PostgreSQL (tabela 'queue').
tb_schema_installed() {
  local db_user
  db_user="$(read_env_var DB_USER)"
  docker compose exec -T db \
    psql -U "${db_user}" -d thingsboard -tAc "SELECT 1 FROM queue LIMIT 1" \
    >/dev/null 2>&1
}

# Roda o instalador do ThingsBoard (uma vez). O entrypoint da imagem detecta
# INSTALL_TB=true, executa o ThingsboardInstallApplication e finaliza o container.
ensure_tb_installed() {
  log "Verificando schema do ThingsBoard no PostgreSQL..."

  log "  - subindo container 'db' temporariamente para validação."
  docker compose up -d --wait db >/dev/null

  if tb_schema_installed; then
    log "  - schema já instalado, nada a fazer."
    return 0
  fi

  log "  - schema ausente; executando install (alguns minutos)..."
  docker compose run --rm \
    -e INSTALL_TB=true \
    -e LOAD_DEMO=false \
    thingsboard
  log "  - schema instalado com sucesso."
}

main() {
  require docker
  require awk
  require tr

  ensure_env_file
  ensure_volumes
  ensure_tb_installed

  log "Pronto. Suba a stack com: docker compose up -d --wait"
}

main "$@"
