param(
    [Parameter(Mandatory = $true)]
    [string]$RepoUrl
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is not installed or is not available in PATH."
}

if (-not (Test-Path ".git")) {
    git init
}

git add .

$hasCommit = $true
git rev-parse --verify HEAD 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    $hasCommit = $false
}

$changes = git status --porcelain
if ($changes) {
    if ($hasCommit) {
        git commit -m "Prepare GiftShell for GitHub and Render"
    } else {
        git commit -m "Initial GiftShell bot"
    }
}

git branch -M main

$remote = git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0) {
    git remote set-url origin $RepoUrl
} else {
    git remote add origin $RepoUrl
}

git push -u origin main

Write-Host "Done. Repository pushed to $RepoUrl" -ForegroundColor Green
