# 提示词管理器 启动脚本（由「启动提示词管理器.bat」调用）
# 逻辑：若后端已在运行 → 直接打开页面；否则先启动后端，等待就绪后再打开页面。
$base = $PSScriptRoot
if (-not $base) { $base = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$portFile = Join-Path $base 'port.txt'

function Get-Port {
    if (Test-Path $portFile) {
        $p = (Get-Content $portFile -Raw -ErrorAction SilentlyContinue).Trim()
        if ($p -match '^\d+$') { return $p }
    }
    return $null
}
function Test-Up([string]$p) {
    if (-not $p) { return $false }
    try {
        $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$p/" -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

# 1) 已在运行 → 直接打开
$port = Get-Port
if (Test-Up $port) {
    Start-Process "http://127.0.0.1:$port/"
    exit 0
}

# 2) 未运行 → 启动后端（可见窗口，关闭它即退出程序）
Start-Process -FilePath 'python' -ArgumentList "`"$base\app.py`"" -WorkingDirectory $base

# 3) 等待后端就绪（最多约 20 秒）
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $port = Get-Port
    if (Test-Up $port) {
        Start-Process "http://127.0.0.1:$port/"
        exit 0
    }
}

Write-Host ""
Write-Host "提示词管理器启动失败或超时，请确认已安装 Python（可在命令行输入 python --version 检查）。"
Read-Host "按回车关闭"
exit 1
