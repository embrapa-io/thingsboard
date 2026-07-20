#!/usr/bin/env bash
set -eo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
CERT_DIR="$ROOT_DIR/certs"
DNS_NAMES="$(printenv MQTT_CERT_DNS_NAMES || true)"
IP_ADDRESSES="$(printenv MQTT_CERT_IP_ADDRESSES || true)"
VALID_DAYS="$(printenv MQTT_CERT_VALID_DAYS || true)"
FORCE_GENERATION="$(printenv MQTT_CERT_FORCE || true)"

if [ -z "$DNS_NAMES" ]; then DNS_NAMES="localhost,thingsboard"; fi
if [ -z "$IP_ADDRESSES" ]; then IP_ADDRESSES="127.0.0.1"; fi
if [ -z "$VALID_DAYS" ]; then VALID_DAYS="825"; fi
if [ -z "$FORCE_GENERATION" ]; then FORCE_GENERATION="false"; fi

CONFIG_FILE="$CERT_DIR/.server-openssl.cnf"
TEMPORARY_FILES="$CONFIG_FILE $CERT_DIR/server.csr $CERT_DIR/ca.srl"
GENERATED_FILES="$CERT_DIR/ca.pem $CERT_DIR/ca_key.pem $CERT_DIR/server.pem $CERT_DIR/server_key.pem"

cleanup() {
  for path in $TEMPORARY_FILES; do
    if [ -f "$path" ]; then rm -f "$path"; fi
  done
}

openssl_docker() {
  docker run --rm --volume "$CERT_DIR:/certs" alpine/openssl "$@"
}

trap cleanup EXIT
mkdir -p "$CERT_DIR"
umask 077

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker não foi encontrado." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "O Docker não está disponível." >&2
  exit 1
fi

existing=false
for path in $GENERATED_FILES; do
  if [ -e "$path" ]; then existing=true; fi
done

if [ "$existing" = "true" ] && [ "$FORCE_GENERATION" != "true" ]; then
  echo "Já existem certificados. Use MQTT_CERT_FORCE=true somente se deseja substituí-los." >&2
  exit 1
fi

if [ "$FORCE_GENERATION" = "true" ]; then
  for path in $GENERATED_FILES $TEMPORARY_FILES; do
    if [ -f "$path" ]; then rm -f "$path"; fi
  done
fi

cat > "$CONFIG_FILE" <<EOF
[req]
prompt = no
distinguished_name = distinguished_name
req_extensions = v3_req

[distinguished_name]
CN = ThingsBoard Development MQTT Server
O = Embrapa IO Development

[v3_req]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
EOF

index=1
for name in $(echo "$DNS_NAMES" | tr ',' ' '); do
  if ! echo "$name" | grep -Eq '^[A-Za-z0-9.-]+$'; then
    echo "Nome DNS inválido: $name" >&2
    exit 1
  fi
  echo "DNS.$index = $name" >> "$CONFIG_FILE"
  index=$((index + 1))
done

index=1
for address in $(echo "$IP_ADDRESSES" | tr ',' ' '); do
  echo "IP.$index = $address" >> "$CONFIG_FILE"
  index=$((index + 1))
done

openssl_docker genrsa -out /certs/ca_key.pem 4096
openssl_docker req -x509 -new -sha256 -key /certs/ca_key.pem -days "$VALID_DAYS" -subj "/CN=Embrapa IO Development MQTT CA/O=Embrapa IO Development" -out /certs/ca.pem
openssl_docker genrsa -out /certs/server_key.pem 2048
openssl_docker req -new -sha256 -key /certs/server_key.pem -config /certs/.server-openssl.cnf -out /certs/server.csr
openssl_docker x509 -req -sha256 -in /certs/server.csr -CA /certs/ca.pem -CAkey /certs/ca_key.pem -CAcreateserial -days "$VALID_DAYS" -extfile /certs/.server-openssl.cnf -extensions v3_req -out /certs/server.pem
openssl_docker verify -CAfile /certs/ca.pem /certs/server.pem

chmod 600 "$CERT_DIR/ca_key.pem" "$CERT_DIR/server_key.pem"
chmod 644 "$CERT_DIR/ca.pem" "$CERT_DIR/server.pem"

echo "Certificados MQTTS de desenvolvimento gerados com sucesso."
echo "Diretório: $CERT_DIR"
echo "DNS: $DNS_NAMES"
echo "IPs: $IP_ADDRESSES"
