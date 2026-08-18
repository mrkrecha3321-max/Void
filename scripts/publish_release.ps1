[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Version
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) {
    throw $Message
}

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Fail "Brakuje programu '$Name'."
    }
}

function Resolve-GitHubCli {
    $Command = Get-Command gh -ErrorAction SilentlyContinue
    if ($Command) {
        return $Command.Source
    }
    $InstalledPath = Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'
    if (Test-Path -LiteralPath $InstalledPath) {
        return $InstalledPath
    }
    Fail "Brakuje programu 'gh' (GitHub CLI)."
}

function Run([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        Fail "Polecenie nie powiodlo sie: $Program $($Arguments -join ' ')"
    }
}

try {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    Set-Location $RepoRoot

    Require-Command git
    Require-Command node
    Require-Command npm
    $Gh = Resolve-GitHubCli

    if ([string]::IsNullOrWhiteSpace($Version)) {
        $CurrentVersion = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
        Write-Host "Aktualna wersja: $CurrentVersion"
        $Version = Read-Host 'Podaj nowa wersje (np. 0.2.2)'
    }

    $Version = $Version.Trim() -replace '^[vV]', ''
    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        Fail 'Wersja musi miec format X.Y.Z, np. 0.2.2.'
    }
    $Tag = "v$Version"

    $Branch = (& git branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0 -or $Branch -ne 'main') {
        Fail "Publikacja jest dozwolona tylko z galezi main. Obecna galaz: $Branch"
    }

    if (@(& git status --porcelain).Count -ne 0) {
        Fail 'Repozytorium zawiera niezapisane zmiany. Najpierw je zatwierdz albo odloz.'
    }

    Run git @('fetch', 'origin', 'main', '--tags')
    $LocalHead = (& git rev-parse 'HEAD').Trim()
    $RemoteHead = (& git rev-parse 'origin/main').Trim()
    if ($LocalHead -ne $RemoteHead) {
        Fail 'Lokalny main nie jest identyczny z origin/main. Zsynchronizuj repozytorium.'
    }

    & git rev-parse --verify --quiet "refs/tags/$Tag" *> $null
    if ($LASTEXITCODE -eq 0) {
        Fail "Tag $Tag juz istnieje. Uzyj kolejnego numeru wersji."
    }

    Run $Gh @('auth', 'status')
    $Repo = (& $Gh repo view --json nameWithOwner --jq '.nameWithOwner').Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Repo)) {
        Fail 'Nie udalo sie ustalic repozytorium GitHub.'
    }

    $RequiredSecrets = @(
        'VOID_ANDROID_KEYSTORE_BASE64',
        'VOID_ANDROID_KEYSTORE_PASSWORD',
        'VOID_ANDROID_KEY_ALIAS',
        'VOID_ANDROID_KEY_PASSWORD',
        'VOID_ANDROID_CERT_SHA256'
    )
    $SecretJson = (& $Gh secret list --repo $Repo --app actions --json name | Out-String)
    if ($LASTEXITCODE -ne 0) {
        Fail 'Nie udalo sie sprawdzic GitHub Actions Secrets.'
    }
    $ExistingSecrets = @($SecretJson | ConvertFrom-Json | ForEach-Object { $_.name })
    $MissingSecrets = @($RequiredSecrets | Where-Object { $_ -notin $ExistingSecrets })
    if ($MissingSecrets.Count -gt 0) {
        Fail "Brakuje GitHub Actions Secrets: $($MissingSecrets -join ', ')"
    }

    Write-Host "`nUstawiam wersje $Version..."
    Run node @('scripts/bump_version.cjs', $Version)

    Write-Host "`nSprawdzam frontend i testy..."
    Run npm @('ci', '--prefer-offline', '--no-audit', '--no-fund')
    Run npm @('run', 'build')
    Run npm @('run', 'test:contract-model')

    Write-Host "`nTworze commit i tag $Tag..."
    Run git @('add', '--', 'package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json')
    Run git @('commit', '-m', "Release $Tag")
    Run git @('push', 'origin', 'HEAD:main')
    Run git @('tag', $Tag)
    Run git @('push', 'origin', $Tag)

    Write-Host "`nCzekam na GitHub Actions..."
    $Run = $null
    for ($Attempt = 0; $Attempt -lt 20 -and -not $Run; $Attempt++) {
        Start-Sleep -Seconds 3
        $RunJson = (& $Gh run list --repo $Repo --workflow 'release.yml' --event push --branch $Tag --limit 1 --json databaseId,headSha,url | Out-String)
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($RunJson)) {
            $Run = @($RunJson | ConvertFrom-Json)[0]
        }
    }
    if (-not $Run) {
        Fail 'Tag wyslano, ale nie znaleziono uruchomienia workflow release.yml.'
    }

    Run $Gh @('run', 'watch', [string]$Run.databaseId, '--repo', $Repo, '--exit-status')
    Run $Gh @('release', 'view', $Tag, '--repo', $Repo, '--json', 'url')

    Write-Host "`n[OK] Release $Tag zostal opublikowany."
}
catch {
    Write-Host "`n[BLAD] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
