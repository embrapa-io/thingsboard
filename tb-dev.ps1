<#
.SYNOPSIS
Liga e desliga o ThingsBoard da Central de desenvolvimento para poupar o limite
de 30 dias do modo de não produção da 4.4.

.DESCRIPTION
Sem chave do License Portal, o servidor soma o tempo em que está ligado em
tb_cluster.non_production_uptime_ms (a cada 5 min; intervalos maiores que
10 min, como o tempo parado, não contam) e se encerra ao chegar a 30 dias.
Este script só LÊ esse contador, nunca o altera.

Só o serviço `thingsboard` consome o limite; banco, Kafka, Nginx e Grafana podem
ficar no ar. Cada `ligar` abre uma sessão com prazo, e a tarefa agendada
(`instalar`) para o servidor quando o prazo vence.

  .\tb-dev.ps1 ligar [-Horas 3]     sobe a stack e abre uma sessão de N horas
  .\tb-dev.ps1 estender [-Horas 1]  soma N horas ao prazo da sessão
  .\tb-dev.ps1 desligar [-Tudo]     para o servidor (ou a stack inteira)
  .\tb-dev.ps1 status               estado, prazo e saldo dos 30 dias
  .\tb-dev.ps1 verificar            usado pela tarefa: para o servidor se o prazo venceu
  .\tb-dev.ps1 instalar             agenda o `verificar` a cada 15 min (usuário atual)
  .\tb-dev.ps1 remover              remove a tarefa agendada
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('ligar', 'estender', 'desligar', 'status', 'verificar', 'instalar', 'remover')]
  [string]$Acao = 'status',
  [double]$Horas = 3,
  [switch]$Tudo
)

$ErrorActionPreference = 'Stop'
$Projeto = $PSScriptRoot
$Estado = Join-Path $env:LOCALAPPDATA 'tb-dev'
$ArquivoPrazo = Join-Path $Estado 'prazo.txt'
$ArquivoLog = Join-Path $Estado 'tb-dev.log'
$NomeTarefa = 'ThingsBoard dev - desligar ao fim da sessao'
$LimiteMs = 30 * 24 * 3600 * 1000.0

New-Item -ItemType Directory -Force -Path $Estado | Out-Null

function Registrar([string]$Mensagem) {
  Add-Content -Path $ArquivoLog -Value ('{0:yyyy-MM-dd HH:mm} {1}' -f (Get-Date), $Mensagem)
}

function Compose {
  Push-Location $Projeto
  try { & docker compose @args } finally { Pop-Location }
}

function EstaLigado {
  $servicos = Compose ps --status running --services 2>$null
  return ($servicos -contains 'thingsboard')
}

function UsoMs {
  $sql = 'psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-thingsboard}" -tAc "select non_production_uptime_ms from tb_cluster"'
  $valor = Compose exec -T db sh -c $sql 2>$null
  if ($LASTEXITCODE -eq 0 -and "$valor".Trim()) { return [double]"$valor".Trim() }
  return $null
}

function LerPrazo {
  if (-not (Test-Path $ArquivoPrazo)) { return $null }
  return [datetime]::Parse((Get-Content $ArquivoPrazo -Raw).Trim(), $null, [Globalization.DateTimeStyles]::RoundtripKind)
}

function GravarPrazo([datetime]$Fim) {
  Set-Content -Path $ArquivoPrazo -Value $Fim.ToString('o')
}

function Desligar([string]$Motivo) {
  if ($Tudo) { Compose stop | Out-Null } else { Compose stop thingsboard | Out-Null }
  Remove-Item $ArquivoPrazo -ErrorAction SilentlyContinue
  Registrar "desligado ($Motivo)"
}

function MostrarStatus {
  $ligado = EstaLigado
  $prazo = LerPrazo
  Write-Output ('Servidor: {0}' -f ($(if ($ligado) { 'LIGADO (consumindo o limite)' } else { 'parado' })))
  if ($ligado -and $prazo) { Write-Output ('Prazo da sessão: {0:dd/MM HH:mm} (faltam {1:N0} min)' -f $prazo, ($prazo - (Get-Date)).TotalMinutes) }
  $uso = UsoMs
  if ($null -eq $uso) {
    Write-Output 'Uso acumulado: indisponível (banco parado?)'
  } else {
    $restante = [Math]::Max($LimiteMs - $uso, 0)
    Write-Output ('Uso acumulado: {0:N1} h de 720 h ({1:N1}%) | restam {2:N1} dias' -f ($uso / 3600000), ($uso / $LimiteMs * 100), ($restante / 86400000))
  }
}

switch ($Acao) {
  'ligar' {
    Compose up -d | Out-Null
    GravarPrazo ((Get-Date).AddHours($Horas))
    Registrar "ligado por $Horas h"
    MostrarStatus
  }
  'estender' {
    $base = LerPrazo
    if (-not $base -or $base -lt (Get-Date)) { $base = Get-Date }
    GravarPrazo ($base.AddHours($Horas))
    Registrar "sessão estendida em $Horas h"
    MostrarStatus
  }
  'desligar' {
    Desligar 'manual'
    MostrarStatus
  }
  'status' {
    MostrarStatus
  }
  'verificar' {
    if (-not (EstaLigado)) { Remove-Item $ArquivoPrazo -ErrorAction SilentlyContinue; break }
    $prazo = LerPrazo
    if (-not $prazo) {
      # Ligado fora do script (ex.: docker compose up): abre uma sessão com o prazo padrão
      GravarPrazo ((Get-Date).AddHours($Horas))
      Registrar "ligado fora do script; prazo de $Horas h a partir de agora"
    } elseif ((Get-Date) -gt $prazo) {
      Desligar 'prazo da sessão vencido'
    }
  }
  'instalar' {
    $acaoTarefa = New-ScheduledTaskAction -Execute 'powershell.exe' `
      -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" verificar' -f $PSCommandPath)
    $gatilho = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
    $config = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $NomeTarefa -Action $acaoTarefa -Trigger $gatilho -Settings $config `
      -Description 'Para o ThingsBoard de desenvolvimento quando o prazo da sessão do tb-dev.ps1 vence.' -Force | Out-Null
    Write-Output "Tarefa '$NomeTarefa' agendada a cada 15 min. Log: $ArquivoLog"
  }
  'remover' {
    Unregister-ScheduledTask -TaskName $NomeTarefa -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Tarefa '$NomeTarefa' removida."
  }
}
