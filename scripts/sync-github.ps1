<#
.SYNOPSIS
  Sincroniza esta pasta com o GitHub continuamente (commit + push automáticos e pull das mudanças remotas).

.DESCRIPTION
  A cada -IntervalSeconds:
    1. Se o GitHub tiver commits novos, faz `git pull --rebase --autostash`.
    2. Se houver arquivos alterados localmente e eles ficarem estáveis por um ciclo
       (para não commitar no meio de um salvamento), faz commit e push.
  Para no primeiro conflito, sem forçar nada. Recusa commitar arquivos que parecem segredo.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\sync-github.ps1
  powershell -ExecutionPolicy Bypass -File scripts\sync-github.ps1 -IntervalSeconds 10
  powershell -ExecutionPolicy Bypass -File scripts\sync-github.ps1 -Once
#>
param(
    [int]$IntervalSeconds = 20,
    [string]$Branch = "main",
    [switch]$Once
)

$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# Padrões que nunca devem ir para o repositório (ele é público).
$blocked = @('(^|/)\.env$', '(^|/)\.env\.[^/]*local$', '\.pem$', '\.key$', '\.p12$', '\.pfx$', '(^|/)id_rsa')
$maxFileMB = 50

function Log([string]$msg, [string]$color = "Gray") {
    Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg) -ForegroundColor $color
}

function Run-Git([string[]]$gitArgs) {
    $out = & git.exe @gitArgs 2>&1 | ForEach-Object { "$_" }
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = ($out -join "`n") }
}

function Pull-Remote {
    $fetch = Run-Git @("fetch", "--quiet", "origin", $Branch)
    if ($fetch.Code -ne 0) { Log "fetch falhou: $($fetch.Out)" "Yellow"; return $true }
    $behind = (Run-Git @("rev-list", "--count", "HEAD..origin/$Branch")).Out.Trim()
    if ($behind -eq "0") { return $true }
    Log "GitHub tem $behind commit(s) novo(s); atualizando..." "Cyan"
    $pull = Run-Git @("pull", "--rebase", "--autostash", "origin", $Branch)
    if ($pull.Code -ne 0) {
        Log "Conflito ao atualizar. Resolva manualmente (git status) e rode o script de novo." "Red"
        Log $pull.Out "Red"
        return $false
    }
    Log "Atualizado com o GitHub." "Green"
    return $true
}

function Commit-And-Push {
    $null = Run-Git @("add", "-A")
    $staged = (Run-Git @("diff", "--cached", "--name-only")).Out -split "`n" | Where-Object { $_ }
    if (-not $staged) { return $true }

    foreach ($file in $staged) {
        foreach ($pattern in $blocked) {
            if ($file -match $pattern) {
                $null = Run-Git @("reset", "--quiet")
                Log "BLOQUEADO: '$file' parece segredo. Adicione ao .gitignore. Nada foi enviado." "Red"
                return $false
            }
        }
        if ((Test-Path -LiteralPath $file) -and ((Get-Item -LiteralPath $file).Length / 1MB) -gt $maxFileMB) {
            $null = Run-Git @("reset", "--quiet")
            Log "BLOQUEADO: '$file' tem mais de $maxFileMB MB. Nada foi enviado." "Red"
            return $false
        }
    }

    $summary = ($staged | Select-Object -First 3) -join ", "
    if ($staged.Count -gt 3) { $summary += " e mais $($staged.Count - 3)" }
    $message = "Sync automático: $summary"
    $commit = Run-Git @("commit", "--quiet", "-m", $message)
    if ($commit.Code -ne 0) { Log "commit falhou: $($commit.Out)" "Red"; return $false }

    $push = Run-Git @("push", "--quiet", "origin", $Branch)
    if ($push.Code -ne 0) {
        Log "push recusado; trazendo mudanças do GitHub e tentando de novo..." "Yellow"
        if (-not (Pull-Remote)) { return $false }
        $push = Run-Git @("push", "--quiet", "origin", $Branch)
        if ($push.Code -ne 0) { Log "push falhou: $($push.Out)" "Red"; return $false }
    }
    Log ("Enviado ao GitHub: {0} arquivo(s) - {1}" -f $staged.Count, $summary) "Green"
    return $true
}

$current = (Run-Git @("rev-parse", "--abbrev-ref", "HEAD")).Out.Trim()
if ($current -ne $Branch) {
    Log "A pasta está na branch '$current', não em '$Branch'. Abortando." "Red"
    exit 1
}
Log "Sincronizando $repo <-> origin/$Branch a cada $IntervalSeconds s (Ctrl+C para parar)." "Cyan"

$lastStatus = $null
while ($true) {
    if (-not (Pull-Remote)) { exit 1 }

    $status = (Run-Git @("status", "--porcelain")).Out
    if ($status) {
        # Só commita quando o conjunto de alterações não mudou desde o último ciclo.
        if ($Once -or $status -eq $lastStatus) {
            if (-not (Commit-And-Push)) { exit 1 }
            $lastStatus = $null
        } else {
            $lastStatus = $status
        }
    } else {
        $lastStatus = $null
    }

    if ($Once) { break }
    Start-Sleep -Seconds $IntervalSeconds
}
