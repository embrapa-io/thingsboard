[CmdletBinding()]
param(
  [string[]] $DnsName = @('localhost', 'thingsboard'),
  [string[]] $IpAddress = @('127.0.0.1'),
  [ValidateRange(1, 3650)]
  [int] $ValidDays = 825,
  [switch] $Force
)

$ErrorActionPreference = 'Stop'

$certificateDirectory = Join-Path $PSScriptRoot 'certs'
$configurationPath = Join-Path $certificateDirectory '.server-openssl.cnf'
$temporaryFiles = @(
  $configurationPath,
  (Join-Path $certificateDirectory 'server.csr'),
  (Join-Path $certificateDirectory 'ca.srl')
)
$generatedFiles = @(
  (Join-Path $certificateDirectory 'ca.pem'),
  (Join-Path $certificateDirectory 'ca_key.pem'),
  (Join-Path $certificateDirectory 'server.pem'),
  (Join-Path $certificateDirectory 'server_key.pem')
)

function Assert-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker não foi encontrado. Instale ou inicie o Docker antes de gerar os certificados.'
  }

  & docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'O Docker não está disponível. Confirme se o Docker Desktop está em execução.'
  }
}

function Invoke-OpenSsl {
  param(
    [Parameter(Mandatory = $true)]
    [string[]] $OpenSslArguments
  )

  & docker run --rm --volume ($certificateDirectory + ':/certs') alpine/openssl @OpenSslArguments
  if ($LASTEXITCODE -ne 0) {
    throw 'Falha ao executar OpenSSL no container.'
  }
}

function Assert-Names {
  if ($DnsName.Count -eq 0 -and $IpAddress.Count -eq 0) {
    throw 'Informe ao menos um nome DNS ou endereço IP para o certificado.'
  }

  foreach ($name in $DnsName) {
    if ([string]::IsNullOrWhiteSpace($name) -or $name -notmatch '^[A-Za-z0-9.-]+$') {
      throw ('Nome DNS inválido: ' + $name)
    }
  }

  foreach ($address in $IpAddress) {
    $parsedAddress = $null
    if (-not [System.Net.IPAddress]::TryParse($address, [ref] $parsedAddress)) {
      throw ('Endereço IP inválido: ' + $address)
    }
  }
}

function Protect-PrivateKeys {
  if ($env:OS -ne 'Windows_NT') {
    return
  }

  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  foreach ($filename in @('ca_key.pem', 'server_key.pem')) {
    $path = Join-Path $certificateDirectory $filename
    & icacls $path /inheritance:r /grant:r ($identity + ':(F)') | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw ('Não foi possível restringir as permissões de ' + $filename)
    }
  }
}

function Enable-DockerDesktopServerKeyRead {
  if ($env:OS -ne 'Windows_NT') {
    return
  }

  & docker run --rm --user 0 --volume ($certificateDirectory + ':/certs') --entrypoint chmod alpine/openssl 644 /certs/server_key.pem
  if ($LASTEXITCODE -ne 0) {
    throw 'Não foi possível tornar a chave do servidor legível para o usuário interno do ThingsBoard.'
  }
}

New-Item -ItemType Directory -Path $certificateDirectory -Force | Out-Null
Assert-Docker
Assert-Names

$existingFiles = @($generatedFiles | Where-Object { Test-Path -LiteralPath $_ })
if ($existingFiles.Count -gt 0 -and -not $Force) {
  throw 'Já existem certificados. Use -Force somente se deseja substituí-los.'
}

if ($Force) {
  foreach ($path in $generatedFiles + $temporaryFiles) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
    }
  }
}

$sanLines = [System.Collections.Generic.List[string]]::new()
for ($index = 0; $index -lt $DnsName.Count; $index++) {
  $sanLines.Add(('DNS.' + ($index + 1) + ' = ' + $DnsName[$index]))
}
for ($index = 0; $index -lt $IpAddress.Count; $index++) {
  $sanLines.Add(('IP.' + ($index + 1) + ' = ' + $IpAddress[$index]))
}

$configuration = @"
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
$($sanLines -join [Environment]::NewLine)
"@

try {
  Set-Content -LiteralPath $configurationPath -Value $configuration -Encoding ascii

  Invoke-OpenSsl -OpenSslArguments @('genrsa', '-out', '/certs/ca_key.pem', '4096')
  Invoke-OpenSsl -OpenSslArguments @('req', '-x509', '-new', '-sha256', '-key', '/certs/ca_key.pem', '-days', [string] $ValidDays, '-subj', '/CN=Embrapa IO Development MQTT CA/O=Embrapa IO Development', '-out', '/certs/ca.pem')
  Invoke-OpenSsl -OpenSslArguments @('genrsa', '-out', '/certs/server_key.pem', '2048')
  Invoke-OpenSsl -OpenSslArguments @('req', '-new', '-sha256', '-key', '/certs/server_key.pem', '-config', '/certs/.server-openssl.cnf', '-out', '/certs/server.csr')
  Invoke-OpenSsl -OpenSslArguments @('x509', '-req', '-sha256', '-in', '/certs/server.csr', '-CA', '/certs/ca.pem', '-CAkey', '/certs/ca_key.pem', '-CAcreateserial', '-days', [string] $ValidDays, '-extfile', '/certs/.server-openssl.cnf', '-extensions', 'v3_req', '-out', '/certs/server.pem')
  Invoke-OpenSsl -OpenSslArguments @('verify', '-CAfile', '/certs/ca.pem', '/certs/server.pem')

  Protect-PrivateKeys
  Enable-DockerDesktopServerKeyRead

  Write-Output 'Certificados MQTTS de desenvolvimento gerados com sucesso.'
  Write-Output ('Diretório: ' + $certificateDirectory)
  Write-Output ('DNS: ' + ($DnsName -join ', '))
  Write-Output ('IPs: ' + ($IpAddress -join ', '))
} finally {
  foreach ($path in $temporaryFiles) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
    }
  }
}
