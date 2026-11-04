# ============================================================================
#  G-Panel Windows installer
#  Works on regular Windows 10/11 and Windows Server.
#  Run from the repo root in PowerShell:
#     powershell -ExecutionPolicy Bypass -File install-windows.ps1
#  Optional: -InstallDir "F:\gpanel"   (default: a "gpanel" folder on the
#  drive the installer is run from — that drive becomes the storage for all
#  sites, backups and the database)
#
#  Installs:
#    - the panel itself (Node.js API + built web UI)
#    - a panel-owned nginx-for-Windows + PHP-CGI stack (downloaded officially)
#  MySQL/MariaDB: uses an existing local server (Laragon, XAMPP, MySQL
#  installer) automatically. Cloudflared is one-click from the panel UI.
# ============================================================================
param(
    [string]$InstallDir = ''
)
$ErrorActionPreference = 'Stop'

$Repo = $PSScriptRoot

# Storage follows the installation: default to a "gpanel" folder on the drive
# the panel is being installed from (e.g. running from F:\g-panel -> F:\gpanel).
if (-not $InstallDir) {
    $drive = (Split-Path $Repo -Qualifier)   # e.g. 'F:'
    $InstallDir = "$drive\gpanel"
}
$GPanelHome = $InstallDir
$Port       = if ($env:GPANEL_PORT) { $env:GPANEL_PORT } else { '2083' }

function Log($m)    { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Info($m)   { Write-Host "    $m" -ForegroundColor DarkCyan }
function Fail($m)   { Write-Error $m; exit 1 }

# ----------------------------------------------------------------------------
Log "Checking requirements"
# ----------------------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "Node.js 22+ is required." -ForegroundColor Yellow
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Info "Installing Node.js LTS via winget…"
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements | Out-Null
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
    } else {
        Fail "Install Node.js 22+ from https://nodejs.org and re-run this script."
    }
}
$nodeVer = (node -v)
Info "node $nodeVer"
$major = [int]($nodeVer -replace 'v','' -replace '\..*','')
if ($major -lt 22) { Fail "Node.js 22+ required (found $nodeVer)" }

# ----------------------------------------------------------------------------
Log "Installing panel source -> $GPanelHome"
# ----------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $GPanelHome | Out-Null
robocopy "$Repo\server" "$GPanelHome\server" /MIR /XD node_modules .devdata /NFL /NDL /NJH /NJS | Out-Null
robocopy "$Repo\web" "$GPanelHome\web" /MIR /XD node_modules dist .devdata /NFL /NDL /NJH /NJS | Out-Null
Copy-Item "$Repo\package.json" "$GPanelHome\" -Force

Info "installing backend dependencies…"
Push-Location "$GPanelHome\server"; npm install --no-audit --no-fund --omit=dev --loglevel=error | Out-Null; Pop-Location
Info "building web UI…"
Push-Location "$GPanelHome\web";    npm install --no-audit --no-fund --loglevel=error | Out-Null; npm run build | Out-Null; Pop-Location

# ----------------------------------------------------------------------------
Log "Downloading web stack (nginx + PHP, official builds)"
# ----------------------------------------------------------------------------
$stack = "$GPanelHome\stack"
New-Item -ItemType Directory -Force -Path $stack | Out-Null

$nginxDir = "$stack\nginx"
if (-not (Test-Path "$nginxDir\nginx.exe")) {
    $nginxVer = '1.26.3'
    $zip = "$env:TEMP\nginx-$nginxVer.zip"
    Info "downloading nginx $nginxVer for Windows…"
    Invoke-WebRequest "https://nginx.org/download/nginx-$nginxVer.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip "$env:TEMP\nginx-extract" -Force
    Move-Item "$env:TEMP\nginx-extract\nginx-$nginxVer" $nginxDir -Force
    Remove-Item "$env:TEMP\nginx-extract" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
}
Info "nginx ready"

$phpDir = "$stack\php"
if (-not (Test-Path "$phpDir\php-cgi.exe")) {
    $phpVer = '8.3.14'
    $zip = "$env:TEMP\php-$phpVer.zip"
    $phpUrl = "https://windows.php.net/downloads/releases/php-$phpVer-nts-Win32-vs16-x64.zip"
    Info "downloading PHP $phpVer (NTS, FastCGI)…"
    try {
        Invoke-WebRequest $phpUrl -OutFile $zip -UseBasicParsing
    } catch {
        # release naming moves to archives/ once superseded
        $phpUrl = "https://windows.php.net/downloads/releases/archives/php-$phpVer-ntss-Win32-vs16-x64.zip"
        Invoke-WebRequest $phpUrl -OutFile $zip -UseBasicParsing
    }
    Expand-Archive $zip "$phpDir" -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    # minimal php.ini for FastCGI + phpMyAdmin
    $ini = @"
extension_dir = "ext"
extension=curl
extension=mbstring
extension=openssl
extension=mysqli
extension=pdo_mysql
extension=pdo_sqlite
extension=fileinfo
extension=gd
extension=exif
session.save_path = "$stack\php\sessions"
upload_max_filesize = 512M
post_max_size = 512M
memory_limit = 256M
"@
    New-Item -ItemType Directory -Force -Path "$stack\php\sessions" | Out-Null
    Set-Content "$phpDir\php.ini" $ini
}
Info "PHP (php-cgi) ready"

if (-not (Get-Command mysql -ErrorAction SilentlyContinue) -and -not (Test-NetConnection -ComputerName 127.0.0.1 -Port 3306 -InformationLevel Quiet -WarningAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "  NOTE: no local MySQL detected on :3306." -ForegroundColor Yellow
    Write-Host "  Install MySQL / MariaDB (e.g. via Laragon, XAMPP or mysql.com) —" -ForegroundColor Yellow
    Write-Host "  the panel picks it up automatically on next start." -ForegroundColor Yellow
}

# ----------------------------------------------------------------------------
Log "Firewall rule for the panel (port $Port)"
# ----------------------------------------------------------------------------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($admin) {
    netsh advfirewall firewall delete rule name="GPanel Panel" 2>$null | Out-Null
    netsh advfirewall firewall add rule name="GPanel Panel" dir=in action=allow protocol=tcp localport=$Port | Out-Null
    Info "port $Port open for LAN access"
} else {
    Info "skipped (not elevated) — run as Administrator to open port $Port on the LAN"
}

# ----------------------------------------------------------------------------
Log "Creating start shortcut + scheduled task"
# ----------------------------------------------------------------------------
$bat = @"
@echo off
title G-Panel
cd /d "$GPanelHome\server"
set GPANEL_HOME=$GPanelHome
set GPANEL_PORT=$Port
set NODE_ENV=production
node src/index.js
pause
"@
Set-Content "$GPanelHome\start-gpanel.bat" $bat

if ($admin) {
    $action  = New-ScheduledTaskAction -Execute "$GPanelHome\start-gpanel.bat"
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName "GPanel" -Action $action -Trigger $trigger -Force | Out-Null
    Info "scheduled task 'GPanel' registered (starts at logon)"
}

# ----------------------------------------------------------------------------
Log "Starting the panel"
# ----------------------------------------------------------------------------
$env:GPANEL_HOME = $GPanelHome
$env:GPANEL_PORT = $Port
$env:NODE_ENV    = 'production'
Start-Process -FilePath 'node' -ArgumentList 'src/index.js' -WorkingDirectory "$GPanelHome\server" -WindowStyle Minimized
Start-Sleep 4

$ok = Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $ok) { Fail "Panel did not start — check C:\gpanel\data for logs" }

Write-Host ""
Write-Host "  G-Panel is installed on Windows" -ForegroundColor Green
Write-Host "  Panel:    http://127.0.0.1:$Port  (and http://<your-lan-ip>:$Port)"
Write-Host "  Login:    admin  /  first-run password printed by the server once"
Write-Host "            (reset: node $GPanelHome\server\src\cli.js reset-admin-password)"
Write-Host ""
Write-Host "  Next:     open the panel -> Cloudflare -> one-click install to put"
Write-Host "            your sites online with a free tunnel (HTTPS at the edge)."
Write-Host ""
