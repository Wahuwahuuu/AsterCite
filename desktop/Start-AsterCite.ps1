param([switch]$Headless, [switch]$NoBrowser, [switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$appRoot = Split-Path -Parent $PSScriptRoot
$nodePath = Join-Path $appRoot '.runtime\node\node.exe'
$pythonPath = Join-Path $appRoot '.runtime\python\python.exe'
$previousKey = $env:PIPAPER_API_KEY
$mutex = $null
$ownsMutex = $false

try {
    Set-Location -LiteralPath $appRoot
    if (-not [Environment]::Is64BitOperatingSystem) { throw '需要 Windows x64。' }
    if (-not (Test-Path -LiteralPath $nodePath) -or -not (Test-Path -LiteralPath $pythonPath)) {
        throw '请使用 Windows 安装包安装 AsterCite；源码安装方法见 docs/windows.md。'
    }
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $identity = [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($appRoot.ToLowerInvariant()))).Replace('-', '')
    $algorithm.Dispose()
    $mutex = [System.Threading.Mutex]::new($false, ('Local\AsterCite-' + $identity))
    try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'AsterCite 已经在运行。请回到之前的服务窗口或浏览器页面。' }

    Write-Host 'AsterCite | 本地论文问答' -ForegroundColor Cyan
    Write-Host '正在准备论文与检索环境…'
    & $pythonPath -u (Join-Path $PSScriptRoot 'prepare.py')
    if ($LASTEXITCODE -ne 0) { throw '准备未完成。请检查网络与磁盘空间后重新启动，已有下载会保留。' }
    if ($PrepareOnly) { exit 0 }

    if (-not $env:PIPAPER_API_KEY) { $env:PIPAPER_API_KEY = [Environment]::GetEnvironmentVariable('PIPAPER_API_KEY', 'User') }
    if (-not $Headless) {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [System.Windows.Forms.Application]::EnableVisualStyles()
        $saved = $null
        $configPath = Join-Path $appRoot 'configs\model.local.json'
        if (Test-Path -LiteralPath $configPath) { try { $saved = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {} }
        $form = [System.Windows.Forms.Form]::new()
        $form.Text = 'AsterCite — 启动本地问答'
        $form.ClientSize = [Drawing.Size]::new(590, 526)
        $form.StartPosition = 'CenterScreen'
        $form.FormBorderStyle = 'FixedDialog'
        $form.MaximizeBox = $false
        $form.Font = [Drawing.Font]::new('Microsoft YaHei UI', 9)
        function LabelAt($text, $y) {
            $label = [Windows.Forms.Label]::new(); $label.Text = $text
            $label.Location = [Drawing.Point]::new(24, $y); $label.Size = [Drawing.Size]::new(535, 23)
            $form.Controls.Add($label)
        }
        function TextAt($y, $text) {
            $box = [Windows.Forms.TextBox]::new(); $box.Location = [Drawing.Point]::new(24, $y)
            $box.Size = [Drawing.Size]::new(535, 27); $box.Text = $text; $form.Controls.Add($box); return $box
        }
        LabelAt '模型服务地址（支持工具调用的 Chat Completions 接口）' 20
        $urlBox = TextAt 46 $(if ($saved) { $saved.model.base_url } else { '' })
        LabelAt '模型名称' 84
        $modelBox = TextAt 110 $(if ($saved) { $saved.model.model_id } else { '' })
        LabelAt '本次密钥（已设置 PIPAPER_API_KEY 时可留空，不保存到文件）' 148
        $keyBox = TextAt 174 ''; $keyBox.UseSystemPasswordChar = $true
        LabelAt '兼容方式                         推理强度' 214
        $protocol = [Windows.Forms.ComboBox]::new(); $protocol.DropDownStyle = 'DropDownList'
        $protocol.Location = [Drawing.Point]::new(24, 240); $protocol.Size = [Drawing.Size]::new(240, 27)
        [void]$protocol.Items.AddRange(@('通用 OpenAI 兼容', '智谱 Z.ai'))
        $protocol.SelectedIndex = $(if ($saved -and $saved.model.compat.thinkingFormat -eq 'zai') { 1 } else { 0 })
        $form.Controls.Add($protocol)
        $thinking = [Windows.Forms.ComboBox]::new(); $thinking.DropDownStyle = 'DropDownList'
        $thinking.Location = [Drawing.Point]::new(289, 240); $thinking.Size = [Drawing.Size]::new(270, 27)
        [void]$thinking.Items.AddRange(@('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'))
        $thinking.SelectedItem = $(if ($saved) { [string]$saved.model.thinking_level } else { 'off' })
        if ($thinking.SelectedIndex -lt 0) { $thinking.SelectedIndex = 0 }; $form.Controls.Add($thinking)
        $protocol.Add_SelectedIndexChanged({ if ($protocol.SelectedIndex -eq 1 -and $thinking.SelectedItem -eq 'off') { $thinking.SelectedItem = 'low' } })
        LabelAt '上下文容量（tokens）             最大输出（tokens）' 280
        $context = [Windows.Forms.NumericUpDown]::new(); $context.Minimum = 8192; $context.Maximum = 2000000
        $context.Value = 32768
        if ($saved -and $saved.model.context_window -ge 8192 -and $saved.model.context_window -le 2000000) { $context.Value = $saved.model.context_window }
        $context.Location = [Drawing.Point]::new(24, 306); $context.Size = [Drawing.Size]::new(240, 27); $form.Controls.Add($context)
        $output = [Windows.Forms.NumericUpDown]::new(); $output.Minimum = 256; $output.Maximum = 32768
        $output.Value = 4096
        if ($saved -and $saved.model.max_output_tokens -ge 256 -and $saved.model.max_output_tokens -le 32768) { $output.Value = $saved.model.max_output_tokens }
        $output.Location = [Drawing.Point]::new(289, 306); $output.Size = [Drawing.Size]::new(270, 27); $form.Controls.Add($output)
        LabelAt '论文检索在本机运行；问题与检索片段会发送给你选择的模型服务。' 350
        LabelAt '服务就绪后会自动打开浏览器，可自由提问、追问并查看原文引用。' 377
        $errorLabel = [Windows.Forms.Label]::new(); $errorLabel.ForeColor = [Drawing.Color]::Firebrick
        $errorLabel.Location = [Drawing.Point]::new(24, 405); $errorLabel.Size = [Drawing.Size]::new(535, 42); $form.Controls.Add($errorLabel)
        $start = [Windows.Forms.Button]::new(); $start.Text = '启动问答'
        $start.Location = [Drawing.Point]::new(409, 463); $start.Size = [Drawing.Size]::new(150, 38); $form.Controls.Add($start)
        $start.Add_Click({
            try {
                if ($keyBox.Text.Trim()) { $env:PIPAPER_API_KEY = $keyBox.Text.Trim() }
                if (-not $env:PIPAPER_API_KEY) { $errorLabel.Text = '请填写本次使用的模型密钥。'; return }
                $modelSettings = @{base_url=$urlBox.Text;model_id=$modelBox.Text;context_window=[int]$context.Value;max_output_tokens=[int]$output.Value;
                    protocol=$(if ($protocol.SelectedIndex -eq 1) { 'zai' } else { 'openai' });thinking_level=[string]$thinking.SelectedItem} | ConvertTo-Json -Compress
                $message = $modelSettings | & $nodePath (Join-Path $PSScriptRoot 'local-app.ts') --configure 2>&1
                if ($LASTEXITCODE -ne 0) { $errorLabel.Text = [string]($message -join ' '); return }
                $form.DialogResult = [Windows.Forms.DialogResult]::OK; $form.Close()
            } catch { $errorLabel.Text = '模型设置无法保存，请检查填写内容与安装目录权限。' }
        })
        $form.AcceptButton = $start
        $result = $form.ShowDialog()
        $keyBox.Clear(); $form.Dispose()
        if ($result -ne [Windows.Forms.DialogResult]::OK) { exit 0 }
    }
    if (-not $env:PIPAPER_API_KEY) { throw '请设置 PIPAPER_API_KEY 后启动。' }
    $launchArgs = @((Join-Path $PSScriptRoot 'local-app.ts'))
    if ($NoBrowser) { $launchArgs += '--no-browser' }
    & $nodePath @launchArgs
    if ($LASTEXITCODE -ne 0) { throw '本地服务未能启动，见上方提示。' }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    $env:PIPAPER_API_KEY = $previousKey
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
