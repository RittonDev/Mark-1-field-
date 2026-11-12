<#
.SYNOPSIS
  Pré-visualização ao vivo: web (Next.js) e app dos técnicos (Expo) recarregam sozinhos a cada alteração.

.DESCRIPTION
  Sobe dois containers de desenvolvimento e, a cada -IntervalSeconds, copia para dentro deles
  os arquivos alterados em frontend/ e mobile/ (o Docker Desktop desta máquina não monta pastas
  do drive D:, por isso a cópia). O Next e o Metro percebem a mudança e recarregam a página/app.

    Web (analistas e gestores) : http://localhost:3001
    App (técnicos) no celular  : Expo Go -> exp://<IP da rede>:8081 (ou o QR code)
    App no navegador           : http://localhost:8081 (quando o app tiver suporte web)

  Mudou package.json/package-lock.json? O script roda npm install no container e o reinicia.
  A API (localhost:8000) continua vindo do docker compose.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\dev-preview.ps1
  powershell -ExecutionPolicy Bypass -File scripts\dev-preview.ps1 -NoMobile
  powershell -ExecutionPolicy Bypass -File scripts\dev-preview.ps1 -Stop     # volta para o web de produção
#>
param(
    [int]$IntervalSeconds = 2,
    [string]$LanIp,
    [switch]$NoWeb,
    [switch]$NoMobile,
    [switch]$Stop
)

$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Log([string]$msg, [string]$color = "Gray") {
    Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg) -ForegroundColor $color
}

function Exists([string]$name) {
    $id = & docker.exe ps -aq --filter "name=^$name$" 2>$null
    return [bool]$id
}

if ($Stop) {
    & docker.exe rm -f mc-web-dev mc-expo 2>$null | Out-Null
    & docker.exe compose start web 2>$null | Out-Null
    Log "Pré-visualização desligada; web de produção de volta em http://localhost:3001" "Green"
    exit 0
}

if (-not $LanIp) {
    # IPv4 da interface com gateway padrão (Wi-Fi ou cabo), que é o que o celular enxerga.
    $LanIp = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" } |
        Select-Object -First 1).IPv4Address.IPAddress
}

$targets = @()
if (-not $NoWeb) {
    $targets += [pscustomobject]@{
        Name = "web"; Container = "mc-web-dev"; Source = Join-Path $repo "frontend"; Port = 3001
        Create = @(
            "create", "--name", "mc-web-dev", "-p", "3001:3001",
            "-v", "maxxchamados_fe_nm:/app/node_modules", "-w", "/app",
            "-e", "NEXT_PUBLIC_API_URL=http://localhost:8000/api/v1",
            "-e", "NEXT_PUBLIC_WS_URL=ws://localhost:8000/api/v1/ws",
            "-e", "WATCHPACK_POLLING=true", "-e", "NEXT_TELEMETRY_DISABLED=1",
            "node:22-alpine", "sh", "-c", "npm install --no-audit --no-fund && npm run dev -- -H 0.0.0.0"
        )
    }
}
if (-not $NoMobile) {
    $targets += [pscustomobject]@{
        Name = "app"; Container = "mc-expo"; Source = Join-Path $repo "mobile"; Port = 8081
        Create = @(
            "create", "-it", "--name", "mc-expo", "-p", "8081:8081",
            "-v", "maxxchamados_mobile_nm:/app/node_modules", "-w", "/app",
            "-e", "REACT_NATIVE_PACKAGER_HOSTNAME=$LanIp", "-e", "EXPO_NO_TELEMETRY=1",
            "node:22-alpine", "sh", "-c", "npm ci --no-audit --no-fund && npx expo start --lan --port 8081"
        )
    }
}

$skip = '\\(node_modules|\.next|\.expo|dist|web-build|android|ios)(\\|$)'

function Changed-Files($target, [datetime]$since) {
    Get-ChildItem -LiteralPath $target.Source -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch $skip -and $_.LastWriteTime -gt $since }
}

foreach ($t in $targets) {
    if ($t.Name -eq "web") { & docker.exe compose stop web 2>$null | Out-Null }
    if (-not (Exists $t.Container)) {
        Log "Criando $($t.Container)..." "Cyan"
        & docker.exe @($t.Create) | Out-Null
    }
    # Cópia completa ao ligar: pega o que mudou enquanto a sincronização estava desligada.
    & docker.exe cp "$($t.Source)\." "$($t.Container):/app"
    & docker.exe start $t.Container | Out-Null
}

Log "Pré-visualização ao vivo ligada (Ctrl+C para parar a sincronização; os containers continuam)." "Green"
if (-not $NoWeb) { Log "  Web (analistas e gestores): http://localhost:3001" "Green" }
if (-not $NoMobile) {
    Log "  App no celular (Expo Go):   exp://$($LanIp):8081   (ou leia o QR code abaixo)" "Green"
    Log "  App no navegador:           http://localhost:8081" "Green"
    Start-Sleep -Seconds 2
    # Reimprime o QR code que o Expo gerou (fica no log do container).
    $qr = & docker.exe logs mc-expo 2>&1 | Where-Object { $_ -match '^[\s▄▀█]+$' -and $_.Trim() } | Select-Object -Last 14
    if ($qr) { $qr | ForEach-Object { Write-Host $_ } }
}

$last = Get-Date
while ($true) {
    Start-Sleep -Seconds $IntervalSeconds
    $now = Get-Date
    foreach ($t in $targets) {
        $files = @(Changed-Files $t $last)
        if ($files.Count -eq 0) { continue }
        $reinstall = $false
        foreach ($f in $files) {
            $rel = $f.FullName.Substring($t.Source.Length + 1) -replace '\\', '/'
            $dir = [System.IO.Path]::GetDirectoryName($rel) -replace '\\', '/'
            if ($dir) { & docker.exe exec $t.Container mkdir -p "/app/$dir" 2>$null | Out-Null }
            & docker.exe cp $f.FullName "$($t.Container):/app/$rel" 2>$null
            if ($rel -in @("package.json", "package-lock.json")) { $reinstall = $true }
        }
        $names = ($files | Select-Object -First 3 | ForEach-Object { $_.Name }) -join ", "
        if ($files.Count -gt 3) { $names += " e mais $($files.Count - 3)" }
        Log "$($t.Name): $($files.Count) arquivo(s) atualizado(s) - $names" "Cyan"
        if ($reinstall) {
            Log "$($t.Name): dependências mudaram; reinstalando e reiniciando $($t.Container)..." "Yellow"
            & docker.exe restart $t.Container | Out-Null
        }
    }
    $last = $now
}
