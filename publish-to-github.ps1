# ============================================================
# Publish the Bright Data MCP server as a NEW PUBLIC GitHub repo
# Run in PowerShell:
#   cd C:\Code\brightdata-mcp
#   powershell -ExecutionPolicy Bypass -File .\publish-to-github.ps1
# ============================================================

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# Make sure the test screenshot isn't published (remove this line if you want it in)
if (-not (Select-String -Path ".gitignore" -Pattern "session-screenshot.png" -Quiet)) {
  Add-Content ".gitignore" "session-screenshot.png"
}

Write-Host "==> Initializing git repo..."
if (-not (Test-Path ".git")) { git init -b main | Out-Null }

if (-not (git config user.email)) { git config user.email "Andy@estopinan.com" }
if (-not (git config user.name))  { git config user.name  "Andrew" }

git add -A
git commit -m "Initial commit: Bright Data MCP server" | Out-Null

Write-Host "==> Creating PUBLIC GitHub repo 'brightdata-mcp' and pushing..."
$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($gh) {
  gh repo create brightdata-mcp --public --source . --remote origin --push
  Write-Host ""
  Write-Host "Done. https://github.com/AndrewEstopinan/brightdata-mcp"
} else {
  Write-Host ""
  Write-Host "GitHub CLI (gh) not found. Finish one of these ways:"
  Write-Host ""
  Write-Host "OPTION A - install gh, then re-run this script:"
  Write-Host "   winget install --id GitHub.cli ; gh auth login"
  Write-Host ""
  Write-Host "OPTION B - create an EMPTY PUBLIC repo named 'brightdata-mcp'"
  Write-Host "   at https://github.com/new, then run:"
  Write-Host "     git remote add origin https://github.com/AndrewEstopinan/brightdata-mcp.git"
  Write-Host "     git push -u origin main"
}
