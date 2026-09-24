# Проброс портов радио из WSL2 в локальную сеть (Windows 10, NAT-режим WSL).
# Запускать из PowerShell ОТ АДМИНИСТРАТОРА после каждого перезапуска WSL/ПК
# (IP у WSL при перезагрузке меняется).
#
#   powershell -ExecutionPolicy Bypass -File "\\wsl$\Ubuntu-24.04\home\kekw\dev\online-radio\scripts\refresh-portproxy.ps1"
#
# После выполнения радио доступно из локалки:
#   веб-UI:  http://<IP-этого-ПК>:3000   (пароль — ADMIN_PASSWORD из .env)
#   стрим:   http://<IP-этого-ПК>:8000/radio.mp3

$ErrorActionPreference = 'Continue'

# --- проверка админа ---
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Нужны права администратора — запустите PowerShell от админа.' -ForegroundColor Red
    exit 1
}

# --- текущий IP WSL-дистрибутива с радио ---
$wslIp = (wsl -d Ubuntu-24.04 hostname -I).Trim().Split(' ')[0]
if (-not $wslIp) {
    Write-Host 'Не получил IP WSL. Проверьте, что WSL запущен (docker compose ps).' -ForegroundColor Red
    exit 1
}
Write-Host "IP WSL: $wslIp" -ForegroundColor Cyan

$services = [ordered]@{
    3000 = 'Radio Web UI 3000'
    8000 = 'Radio Stream 8000'
}

foreach ($port in $services.Keys) {
    $name = $services[$port]

    # правило брандмауэра (пересоздаём, чтобы было идемпотентно)
    netsh advfirewall firewall delete rule name="$name" | Out-Null
    netsh advfirewall firewall add rule name="$name" dir=in action=allow protocol=TCP localport=$port | Out-Null

    # проброс порта: LAN -> Windows:port -> WSL:port
    netsh interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 | Out-Null
    netsh interface portproxy add v4tov4 listenport=$port listenaddress=0.0.0.0 connectport=$port connectaddress=$wslIp | Out-Null

    Write-Host "Порт $port ($name) -> ${wslIp}:$port" -ForegroundColor Green
}

Write-Host ''
Write-Host '=== Активные пробросы ===' -ForegroundColor Cyan
netsh interface portproxy show v4tov4
