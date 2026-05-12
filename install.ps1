param(
    [ValidateSet('Interactive', 'Install', 'Restore', 'Build', 'Start', 'Status')]
    [string]$Action = 'Interactive',

    [ValidateSet('auto', 'real', 'dev', 'dummy', 'custom')]
    [string]$Target = 'auto',

    [string]$UnityHubPath,

    [string[]]$Plugins,

    [switch]$KeepOpen,

    [string]$ElevatedOutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $PSCommandPath
$nodeScript = Join-Path $scriptRoot 'src\unifyhub.mjs'
$script:InstallerShouldPause = $KeepOpen.IsPresent -or $Action -eq 'Interactive'
$script:InstallerPaused = $false
$script:InstallerLogPath = $null
$script:ElevatedCaptureStarted = $false

if (-not [string]::IsNullOrWhiteSpace($ElevatedOutputPath)) {
    try {
        $script:InstallerShouldPause = $false
        $outputDirectory = Split-Path -Parent $ElevatedOutputPath
        if ($outputDirectory) {
            New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
        }
        Start-Transcript -LiteralPath $ElevatedOutputPath -Force | Out-Null
        $script:ElevatedCaptureStarted = $true
    }
    catch {
        Write-Host "Could not start elevated output capture: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Show-InstallerFailure {
    param(
        [object]$ErrorRecord,
        [string]$ActionName,
        [object]$Selection
    )

    $logPath = $null
    try {
        $logPath = Write-InstallerCrashLog -ErrorRecord $ErrorRecord -ActionName $ActionName -Selection $Selection
    }
    catch {
        $logPath = $null
    }

    $message = if ($ErrorRecord -and $ErrorRecord.Exception) {
        $ErrorRecord.Exception.Message
    }
    elseif ($ErrorRecord) {
        [string]$ErrorRecord
    }
    else {
        'Unknown error'
    }

    Write-Host ''
    Write-Host "UnifyHub error: $message" -ForegroundColor Red
    if ($logPath) {
        Write-Host "Crash log: $logPath" -ForegroundColor DarkGray
    }

    Pause-Installer -Force -Message 'Press Enter to close.'
}

function Test-NodeAvailable {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js 22 or newer is required. Install Node.js, then run this installer again.'
    }
}

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-InstallerLogPath {
    if (-not $script:InstallerLogPath) {
        $appDataRoot = [Environment]::GetFolderPath('ApplicationData')
        if ([string]::IsNullOrWhiteSpace($appDataRoot)) {
            $appDataRoot = $scriptRoot
        }

        $logDirectory = Join-Path $appDataRoot 'UnifyHub\logs'
        $script:InstallerLogPath = Join-Path $logDirectory ('install-{0:yyyyMMdd-HHmmss}.log' -f (Get-Date))
    }

    return $script:InstallerLogPath
}

function Get-ElevatedOutputPath {
    $appDataRoot = [Environment]::GetFolderPath('ApplicationData')
    if ([string]::IsNullOrWhiteSpace($appDataRoot)) {
        $appDataRoot = $scriptRoot
    }

    $logDirectory = Join-Path $appDataRoot 'UnifyHub\logs'
    return Join-Path $logDirectory ('elevated-{0:yyyyMMdd-HHmmss}.log' -f (Get-Date))
}

function Get-ElevatedWorkerPath {
    $appDataRoot = [Environment]::GetFolderPath('ApplicationData')
    if ([string]::IsNullOrWhiteSpace($appDataRoot)) {
        $appDataRoot = $scriptRoot
    }

    $logDirectory = Join-Path $appDataRoot 'UnifyHub\logs'
    return Join-Path $logDirectory ('elevated-worker-{0:yyyyMMdd-HHmmss}.ps1' -f (Get-Date))
}

function ConvertTo-PowerShellSingleQuotedString {
    param([string]$Value)

    return "'{0}'" -f ($Value -replace "'", "''")
}

function Stop-ElevatedOutputCapture {
    if (-not $script:ElevatedCaptureStarted) {
        return
    }

    try {
        Stop-Transcript | Out-Null
    }
    catch {
    }
    finally {
        $script:ElevatedCaptureStarted = $false
    }
}

function Write-ElevatedInstallerOutput {
    param(
        [string]$OutputPath,
        [int]$StartIndex = 0,
        [switch]$ShowLog
    )

    if ([string]::IsNullOrWhiteSpace($OutputPath) -or -not (Test-Path -LiteralPath $OutputPath)) {
        return $StartIndex
    }

    $skipPatterns = @(
        '^\*+$',
        '^Windows PowerShell transcript',
        '^Start time:',
        '^End time:',
        '^Username:',
        '^RunAs User:',
        '^Configuration Name:',
        '^Machine:',
        '^Host Application:',
        '^Process ID:',
        '^PSVersion:',
        '^PSEdition:',
        '^PSCompatibleVersions:',
        '^BuildVersion:',
        '^CLRVersion:',
        '^WSManStackVersion:',
        '^PSRemotingProtocolVersion:',
        '^SerializationVersion:',
        '^Transcript started',
        '^Transcript stopped'
    )

    $lines = @(Get-Content -LiteralPath $OutputPath)
    $printedAny = $false
    for ($lineIndex = $StartIndex; $lineIndex -lt $lines.Count; $lineIndex += 1) {
        $line = $lines[$lineIndex]
        $shouldSkip = $false
        foreach ($pattern in $skipPatterns) {
            if ($line -match $pattern) {
                $shouldSkip = $true
                break
            }
        }

        if ($shouldSkip) {
            continue
        }

        Write-Host $line
        $printedAny = $true
    }

    if ($printedAny) {
        Write-Host ''
    }

    if ($ShowLog) {
        Write-Host "Log: $OutputPath" -ForegroundColor DarkGray
    }

    return $lines.Count
}

function Format-ProcessArgumentList {
    param([string[]]$Arguments)

    return ($Arguments | ForEach-Object {
        if ($_ -match '[\s"]') {
            '"{0}"' -f ($_ -replace '"', '\"')
        }
        else {
            $_
        }
    }) -join ' '
}

function Write-InstallerCrashLog {
    param(
        [System.Management.Automation.ErrorRecord]$ErrorRecord,
        [string]$ActionName,
        [object]$Selection
    )

    $logPath = Get-InstallerLogPath
    $logDirectory = Split-Path -Parent $logPath
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

    $targetName = ''
    $targetPath = ''
    $cliTarget = ''
    if ($Selection) {
        $targetName = $Selection.DisplayName
        $targetPath = $Selection.RootPath
        $cliTarget = $Selection.CliTarget
    }

    $message = $ErrorRecord.Exception.Message
    $exceptionType = $ErrorRecord.Exception.GetType().FullName
    $stackTrace = $ErrorRecord.ScriptStackTrace
    if ($ErrorRecord.InvocationInfo) {
        $position = $ErrorRecord.InvocationInfo.PositionMessage
    }
    else {
        $position = ''
    }
    $errorText = $ErrorRecord | Format-List * -Force | Out-String

    $content = @(
        '=== UnifyHub Installer Crash ===',
        ('Timestamp: {0}' -f (Get-Date -Format o)),
        ('Action: {0}' -f $ActionName),
        ('KeepOpen: {0}' -f $script:InstallerShouldPause),
        ('Target: {0}' -f $targetName),
        ('RootPath: {0}' -f $targetPath),
        ('CliTarget: {0}' -f $cliTarget),
        ('ErrorType: {0}' -f $exceptionType),
        ('Message: {0}' -f $message),
        '',
        'Position:',
        $position,
        '',
        'ScriptStackTrace:',
        $stackTrace,
        '',
        'ErrorRecord:',
        $errorText
    ) -join [Environment]::NewLine

    Set-Content -LiteralPath $logPath -Value $content -Encoding UTF8
    return $logPath
}

function Pause-Installer {
    param(
        [string]$Message = 'Press Enter to close.',
        [switch]$Force
    )

    if ($script:ElevatedCaptureStarted -or (-not $Force -and -not $script:InstallerShouldPause) -or $script:InstallerPaused) {
        return
    }

    $script:InstallerPaused = $true
    Write-Host ''
    Read-Host $Message | Out-Null
}

function Set-ProcessEnvironmentValue {
    param(
        [string]$Name,
        [string]$Value
    )

    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

function Invoke-UnifyHubCommand {
    param(
        [string[]]$Arguments,
        [hashtable]$Environment
    )

    $savedEnvironment = @{}
    if ($Environment) {
        foreach ($entry in $Environment.GetEnumerator()) {
            $savedEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
            Set-ProcessEnvironmentValue -Name $entry.Key -Value $entry.Value
        }
    }

    try {
        & node $nodeScript @Arguments 2>&1 | ForEach-Object {
            Write-Host $_
        }
        if ($LASTEXITCODE -ne 0) {
            throw "UnifyHub command failed: $($Arguments -join ' ')"
        }
    }
    finally {
        if ($Environment) {
            foreach ($entry in $Environment.GetEnumerator()) {
                Set-ProcessEnvironmentValue -Name $entry.Key -Value $savedEnvironment[$entry.Key]
            }
        }
    }
}

function Invoke-UnifyHubJson {
    param(
        [string[]]$Arguments,
        [hashtable]$Environment
    )

    $savedEnvironment = @{}
    if ($Environment) {
        foreach ($entry in $Environment.GetEnumerator()) {
            $savedEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
            Set-ProcessEnvironmentValue -Name $entry.Key -Value $entry.Value
        }
    }

    try {
        $output = & node $nodeScript @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "UnifyHub command failed: $($Arguments -join ' ')"
        }

        $jsonText = [string]::Join([Environment]::NewLine, @($output))
        if ([string]::IsNullOrWhiteSpace($jsonText)) {
            return $null
        }

        return $jsonText | ConvertFrom-Json
    }
    finally {
        if ($Environment) {
            foreach ($entry in $Environment.GetEnumerator()) {
                Set-ProcessEnvironmentValue -Name $entry.Key -Value $savedEnvironment[$entry.Key]
            }
        }
    }
}

function Write-InstallerHeader {
    param(
        [string]$Title,
        [string[]]$Lines
    )

    Clear-Host
    Write-Host $Title -ForegroundColor White
    foreach ($line in $Lines) {
        Write-Host $line -ForegroundColor DarkGray
    }
    Write-Host ''
}

function Read-MenuChoice {
    param(
        [string]$Title,
        [string]$Prompt,
        [string[]]$Options
    )

    if (-not $Options -or $Options.Count -eq 0) {
        throw 'Menu options are required.'
    }

    $index = 0
    while ($true) {
        Write-InstallerHeader -Title $Title -Lines @(
            $Prompt,
            'Use the arrow keys to move and Enter to confirm. Press Esc to go back.'
        )

        for ($optionIndex = 0; $optionIndex -lt $Options.Count; $optionIndex += 1) {
            if ($optionIndex -eq $index) {
                Write-Host ('> {0}' -f $Options[$optionIndex]) -ForegroundColor Cyan
            }
            else {
                Write-Host ('  {0}' -f $Options[$optionIndex])
            }
        }

        $key = [Console]::ReadKey($true)
        switch ($key.Key) {
            'UpArrow' {
                if ($index -le 0) {
                    $index = $Options.Count - 1
                }
                else {
                    $index -= 1
                }
            }
            'DownArrow' {
                if ($index -ge $Options.Count - 1) {
                    $index = 0
                }
                else {
                    $index += 1
                }
            }
            'Enter' { return $index }
            'Escape' { return -1 }
        }
    }
}

function Get-InstallerInventory {
    $previousValue = [Environment]::GetEnvironmentVariable('UNIFYHUB_DEV', 'Process')
    Set-ProcessEnvironmentValue -Name 'UNIFYHUB_DEV' -Value '1'
    try {
        return Invoke-UnifyHubJson -Arguments @('list', '--json')
    }
    finally {
        Set-ProcessEnvironmentValue -Name 'UNIFYHUB_DEV' -Value $previousValue
    }
}

function Get-FriendlyTargetLabel {
    param([object]$TargetInfo)

    if ($TargetInfo.kind -eq 'development') {
        return 'Development copy - {0}' -f $TargetInfo.rootPath
    }

    if ($TargetInfo.rootPath -like 'C:\Program Files\Unity Hub*') {
        return 'Stable Unity Hub - {0}' -f $TargetInfo.rootPath
    }

    if ($TargetInfo.rootPath -like 'C:\Program Files (x86)\Unity Hub*') {
        return 'Stable Unity Hub (x86) - {0}' -f $TargetInfo.rootPath
    }

    return 'Unity Hub - {0}' -f $TargetInfo.rootPath
}

function Get-InstalledTargets {
    $inventory = Get-InstallerInventory
    $targets = @()

    foreach ($property in $inventory.targets.PSObject.Properties) {
        $targetInfo = $property.Value
        if (-not $targetInfo.rootPath) {
            continue
        }

        $priority = 1
        if ($targetInfo.kind -eq 'development') {
            $priority = 2
        }
        elseif ($targetInfo.rootPath -like 'C:\Program Files\Unity Hub*') {
            $priority = 0
        }

        $targets += [pscustomobject]@{
            Key = $property.Name
            CliTarget = $property.Name
            DisplayName = Get-FriendlyTargetLabel -TargetInfo $targetInfo
            RootPath = $targetInfo.rootPath
            ExePath = $targetInfo.exePath
            AsarPath = $targetInfo.asarPath
            Kind = $targetInfo.kind
            Priority = $priority
            Environment = @{}
        }
    }

    return @($targets | Sort-Object Priority, DisplayName)
}

function Get-DevelopmentTarget {
    $devRoot = Join-Path $scriptRoot 'UnityHubDummyTarget\Unity Hub'
    return [pscustomobject]@{
        Key = 'dev'
        CliTarget = 'dev'
        DisplayName = 'Development copy - {0}' -f $devRoot
        RootPath = $devRoot
        ExePath = Join-Path $devRoot 'Unity Hub.exe'
        AsarPath = Join-Path $devRoot 'resources\app.asar'
        Kind = 'development'
        Environment = @{}
    }
}

function Resolve-CustomTarget {
    while ($true) {
        Write-InstallerHeader -Title 'Custom location' -Lines @(
            'Paste the folder that contains Unity Hub.exe, or paste the Unity Hub.exe path itself.',
            'Leave the field empty to go back.'
        )

        $inputPath = Read-Host 'Path'
        if ([string]::IsNullOrWhiteSpace($inputPath)) {
            return $null
        }

        $candidate = $inputPath.Trim().Trim('"')
        try {
            $rootPath = $null
            if (Test-Path -LiteralPath $candidate -PathType Container) {
                $rootPath = (Resolve-Path -LiteralPath $candidate).Path
            }
            elseif ((Test-Path -LiteralPath $candidate -PathType Leaf) -and ([System.IO.Path]::GetFileName($candidate) -ieq 'Unity Hub.exe')) {
                $rootPath = Split-Path -Parent (Resolve-Path -LiteralPath $candidate).Path
            }
            else {
                throw 'Select the Unity Hub folder or the Unity Hub.exe file.'
            }

            $exePath = Join-Path $rootPath 'Unity Hub.exe'
            $asarPath = Join-Path $rootPath 'resources\app.asar'
            if (-not (Test-Path -LiteralPath $exePath)) {
                throw "Unity Hub.exe was not found in: $rootPath"
            }
            if (-not (Test-Path -LiteralPath $asarPath)) {
                throw "resources\app.asar was not found in: $rootPath"
            }

            return [pscustomobject]@{
                Key = 'auto'
                CliTarget = 'auto'
                DisplayName = 'Custom Unity Hub - {0}' -f $rootPath
                RootPath = $rootPath
                ExePath = $exePath
                AsarPath = $asarPath
                Kind = 'custom'
                Environment = @{
                    UNITY_HUB_ROOT = $rootPath
                    UNITY_HUB_PATH = $rootPath
                }
            }
        }
        catch {
            Write-Host ''
            Write-Host $_.Exception.Message -ForegroundColor Red
            Read-Host 'Press Enter to try again' | Out-Null
        }
    }
}

function Select-InteractiveTarget {
    $targets = @((Get-InstalledTargets))
    $targetCount = $targets.Count

    if ($targetCount -eq 0) {
        while ($true) {
            $choice = Read-MenuChoice -Title 'Select the Unity Hub to patch' -Prompt 'No installed Unity Hub targets were found. Choose how to continue.' -Options @(
                'Custom location',
                'Back to action selection'
            )

            if ($choice -lt 0 -or $choice -eq 1) {
                return 'BackAction'
            }

            $customTarget = Resolve-CustomTarget
            if ($null -ne $customTarget) {
                return $customTarget
            }
        }
    }

    while ($true) {
        $options = @($targets | ForEach-Object { $_.DisplayName })
        $options += 'Custom location'
        $options += 'Back to action selection'

        $prompt = if ($targetCount -eq 1) {
            'One Unity Hub installation was found. Choose it, pick Custom location, or go back.'
        }
        else {
            'Choose which Unity Hub installation you want to change.'
        }

        $choice = Read-MenuChoice -Title 'Select the Unity Hub to patch' -Prompt $prompt -Options $options
        if ($choice -lt 0 -or $choice -eq ($options.Count - 1)) {
            return 'BackAction'
        }

        if ($choice -eq $targetCount) {
            $customTarget = Resolve-CustomTarget
            if ($null -eq $customTarget) {
                continue
            }

            return $customTarget
        }

        return $targets[$choice]
    }
}

function Resolve-TargetSelection {
    param(
        [string]$TargetName,
        [string]$CustomPath
    )

    switch ($TargetName.ToLowerInvariant()) {
        'custom' {
            if ([string]::IsNullOrWhiteSpace($CustomPath)) {
                throw 'Custom targets need -UnityHubPath.'
            }
            return Resolve-CustomTargetFromPath -Path $CustomPath
        }
        'dev' {
            return Get-DevelopmentTarget
        }
        'dummy' {
            return Get-DevelopmentTarget
        }
        'real' {
            return Get-TargetByKey -TargetKey 'auto'
        }
        default {
            return Get-TargetByKey -TargetKey 'auto'
        }
    }
}

function Get-TargetByKey {
    param([string]$TargetKey)

    $targets = Get-InstalledTargets
    $target = $targets | Where-Object { $_.Key -eq $TargetKey } | Select-Object -First 1
    if ($null -eq $target) {
        throw "Unity Hub target not found: $TargetKey"
    }

    return $target
}

function Resolve-CustomTargetFromPath {
    param([string]$Path)

    $candidate = $Path.Trim().Trim('"')
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        throw 'Custom path cannot be empty.'
    }

    $rootPath = $null
    if (Test-Path -LiteralPath $candidate -PathType Container) {
        $rootPath = (Resolve-Path -LiteralPath $candidate).Path
    }
    elseif ((Test-Path -LiteralPath $candidate -PathType Leaf) -and ([System.IO.Path]::GetFileName($candidate) -ieq 'Unity Hub.exe')) {
        $rootPath = Split-Path -Parent (Resolve-Path -LiteralPath $candidate).Path
    }
    else {
        throw 'Select the Unity Hub folder or the Unity Hub.exe file.'
    }

    $exePath = Join-Path $rootPath 'Unity Hub.exe'
    $asarPath = Join-Path $rootPath 'resources\app.asar'
    if (-not (Test-Path -LiteralPath $exePath)) {
        throw "Unity Hub.exe was not found in: $rootPath"
    }
    if (-not (Test-Path -LiteralPath $asarPath)) {
        throw "resources\app.asar was not found in: $rootPath"
    }

    return [pscustomobject]@{
        Key = 'auto'
        CliTarget = 'auto'
        DisplayName = 'Custom Unity Hub - {0}' -f $rootPath
        RootPath = $rootPath
        ExePath = $exePath
        AsarPath = $asarPath
        Kind = 'custom'
        Environment = @{
            UNITY_HUB_ROOT = $rootPath
            UNITY_HUB_PATH = $rootPath
        }
    }
}

function Stop-MatchingUnityHubProcesses {
    param([string]$RootPath)

    $normalizedRoot = [System.IO.Path]::GetFullPath($RootPath).TrimEnd('\\')
    $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq 'Unity Hub.exe' -and
            $_.ExecutablePath -and
            ([System.IO.Path]::GetFullPath($_.ExecutablePath).TrimEnd('\\')).StartsWith($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)
        }

    foreach ($process in $processes) {
        try {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
        }
        catch {
            Write-Host "WARN  Could not close Unity Hub process $($process.ProcessId)." -ForegroundColor Yellow
        }
    }
}

function Test-TargetWritable {
    param([string]$RootPath)

    $resourcesPath = Join-Path $RootPath 'resources'
    if (-not (Test-Path -LiteralPath $resourcesPath)) {
        return $false
    }

    $probePath = Join-Path $resourcesPath ('.unifyhub-write-test-{0}.tmp' -f ([Guid]::NewGuid().ToString('N')))
    try {
        Set-Content -LiteralPath $probePath -Value 'ok' -NoNewline -Encoding Ascii
        Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
        return $true
    }
    catch {
        Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
        return $false
    }
}

function Start-ElevatedInstaller {
    param(
        [string]$ActionName,
        [object]$Selection
    )

    $outputPath = Get-ElevatedOutputPath
    $workerPath = Get-ElevatedWorkerPath
    $outputDirectory = Split-Path -Parent $outputPath
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

    $scriptArguments = @(
        '-Action',
        $ActionName,
        '-Target',
        $(if ($Selection.Kind -eq 'custom') { 'custom' } else { $Selection.CliTarget })
    )

    if ($Selection.Kind -eq 'custom') {
        $scriptArguments += @('-UnityHubPath', $Selection.RootPath)
    }

    if ($Plugins -and $Plugins.Count -gt 0) {
        $scriptArguments += @('-Plugins', ($Plugins -join ','))
    }

    $scriptArgumentText = Format-ProcessArgumentList -Arguments $scriptArguments
    $quotedScriptPath = ConvertTo-PowerShellSingleQuotedString -Value $PSCommandPath
    $quotedScriptRoot = ConvertTo-PowerShellSingleQuotedString -Value $scriptRoot
    $quotedOutputPath = ConvertTo-PowerShellSingleQuotedString -Value $outputPath

    $workerContent = @"
`$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $quotedScriptRoot
try {
    & $quotedScriptPath $scriptArgumentText *>&1 | Tee-Object -FilePath $quotedOutputPath -Append | Out-Null
    `$exitCode = if (`$null -ne `$LASTEXITCODE) { `$LASTEXITCODE } else { 0 }
}
catch {
    `$_.Exception.Message | Tee-Object -FilePath $quotedOutputPath -Append | Out-Null
    `$exitCode = 1
}
exit `$exitCode
"@

    Set-Content -LiteralPath $workerPath -Value $workerContent -Encoding UTF8

    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $workerPath
    )

    $argumentText = Format-ProcessArgumentList -Arguments $arguments

    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -PassThru -WorkingDirectory $scriptRoot -ArgumentList $argumentText
    Write-Host 'INFO  Waiting for administrator task...'

    $printedLineCount = 0
    while (-not $process.HasExited) {
        $printedLineCount = Write-ElevatedInstallerOutput -OutputPath $outputPath -StartIndex $printedLineCount
        $process.Refresh()
        if (-not $process.HasExited) {
            Start-Sleep -Milliseconds 50
        }
    }

    $process.WaitForExit()
    $printedLineCount = Write-ElevatedInstallerOutput -OutputPath $outputPath -StartIndex $printedLineCount -ShowLog
    Remove-Item -LiteralPath $workerPath -Force -ErrorAction SilentlyContinue

    if (-not (Test-Path -LiteralPath $outputPath)) {
        throw "Elevated installer produced no output. Log path: $outputPath"
    }

    if ($process.ExitCode -ne 0) {
        throw "Elevated installer failed. Log: $outputPath"
    }
}

function Get-EnabledPluginsFromStatus {
    param([object]$Selection)

    $status = Invoke-UnifyHubJson -Arguments @('status', '--json', '--target', $Selection.CliTarget) -Environment $Selection.Environment
    $enabledPlugins = @()
    if ($status.plugins) {
        $enabledPlugins = @($status.plugins | Where-Object { $_.enabled } | Select-Object -ExpandProperty id)
    }

    return [pscustomobject]@{
        Status = $status
        EnabledPlugins = $enabledPlugins
    }
}

function Get-ActionTitle {
    param([string]$ActionName)

    switch ($ActionName) {
        'Install' { return 'Install or repair UnifyHub' }
        'Restore' { return 'Restore original Unity Hub' }
        'Build' { return 'Build patched file only' }
        'Start' { return 'Start Unity Hub' }
        'Status' { return 'Show status' }
        default { return $ActionName }
    }
}

function Show-ActionSummary {
    param(
        [string]$ActionName,
        [object]$Selection,
        [object]$EnabledInfo
    )

    $title = Get-ActionTitle -ActionName $ActionName
    Write-InstallerHeader -Title 'UnifyHub Installer' -Lines @(
        $title,
        'Review the target before continuing.'
    )

    Write-Host ('Target:  {0}' -f $Selection.DisplayName)
    Write-Host ('Path:    {0}' -f $Selection.RootPath)
    if ($EnabledInfo.Status) {
        if ($EnabledInfo.Status.exists.asar) {
            Write-Host 'ASAR:    found'
        }
        else {
            Write-Host 'ASAR:    missing'
        }

        if ($EnabledInfo.Status.exists.backup) {
            Write-Host 'Backup:  found'
        }
        else {
            Write-Host 'Backup:  missing'
        }
    }

    if ($EnabledInfo.EnabledPlugins -and $EnabledInfo.EnabledPlugins.Count -gt 0) {
        Write-Host ('Plugins: {0}' -f ($EnabledInfo.EnabledPlugins -join ', '))
    }
    else {
        Write-Host 'Plugins: none'
    }

    Write-Host ''
}

function Select-ActionDecision {
    param(
        [string]$ActionName,
        [object]$Selection,
        [object]$EnabledInfo
    )

    Show-ActionSummary -ActionName $ActionName -Selection $Selection -EnabledInfo $EnabledInfo

    $choice = Read-MenuChoice -Title 'Confirm action' -Prompt 'What should happen next?' -Options @(
        'Run now',
        'Cancel'
    )

    switch ($choice) {
        0 { return 'Proceed' }
        default { return 'Cancel' }
    }
}

function Invoke-InstallerAction {
    param(
        [string]$ActionName,
        [object]$Selection,
        [switch]$Interactive
    )

    $environment = $Selection.Environment
    if ($null -eq $environment) {
        $environment = @{}
    }

    if ($Interactive) {
        $summary = Get-EnabledPluginsFromStatus -Selection $Selection
        if ($ActionName -eq 'Status') {
            Show-ActionSummary -ActionName $ActionName -Selection $Selection -EnabledInfo $summary
        }
    }

    if ($ActionName -in @('Install', 'Restore')) {
        Stop-MatchingUnityHubProcesses -RootPath $Selection.RootPath

        if (-not (Test-TargetWritable -RootPath $Selection.RootPath)) {
            if (-not (Test-Administrator)) {
                Write-Host ''
                Write-Host 'This Unity Hub install is protected by Windows.' -ForegroundColor Yellow
                Write-Host 'Windows will ask for permission, then the result will return here.' -ForegroundColor Yellow
                Write-Host ''
                Start-ElevatedInstaller -ActionName $ActionName -Selection $Selection
                return $false
            }
        }
    }

    switch ($ActionName) {
        'Install' {
            Write-Host 'INFO  Patching Unity Hub...'
            $arguments = @('apply', '--target', $Selection.CliTarget)
            if ($Plugins -and $Plugins.Count -gt 0) {
                $arguments += @('--plugins', ($Plugins -join ','))
            }
            Invoke-UnifyHubCommand -Arguments $arguments -Environment $environment
            Write-Host 'OK    Success!'
        }
        'Restore' {
            Write-Host 'INFO  Restoring original Unity Hub...'
            Invoke-UnifyHubCommand -Arguments @('restore', '--target', $Selection.CliTarget) -Environment $environment
            Write-Host 'OK    Success!'
        }
        'Build' {
            Write-Host 'INFO  Building patched file only...'
            $arguments = @('build', '--target', $Selection.CliTarget)
            if ($Plugins -and $Plugins.Count -gt 0) {
                $arguments += @('--plugins', ($Plugins -join ','))
            }
            Invoke-UnifyHubCommand -Arguments $arguments -Environment $environment
            Write-Host 'OK    Build complete.'
        }
        'Start' {
            Write-Host 'INFO  Starting Unity Hub...'
            Invoke-UnifyHubCommand -Arguments @('start', '--target', $Selection.CliTarget) -Environment $environment
            Write-Host 'OK    Unity Hub started.'
        }
        'Status' {
            Invoke-UnifyHubCommand -Arguments @('status', '--target', $Selection.CliTarget) -Environment $environment
        }
        default {
            throw "Unknown action: $ActionName"
        }
    }

    return $true
}

function Invoke-InteractiveInstaller {
    while ($true) {
        $actionChoice = Read-MenuChoice -Title 'UnifyHub Installer' -Prompt 'What would you like to do?' -Options @(
            'Install or repair UnifyHub',
            'Restore original Unity Hub',
            'Build patched file only',
            'Start Unity Hub',
            'Show status',
            'Quit'
        )

        if ($actionChoice -lt 0 -or $actionChoice -eq 5) {
            return
        }

        $actionName = switch ($actionChoice) {
            0 { 'Install' }
            1 { 'Restore' }
            2 { 'Build' }
            3 { 'Start' }
            4 { 'Status' }
        }

        if ($actionName -eq 'Status') {
            while ($true) {
                $selection = Select-InteractiveTarget
                if ($selection -eq 'BackAction') {
                    break
                }

                if ($null -eq $selection) {
                    continue
                }

                try {
                    Invoke-InstallerAction -ActionName $actionName -Selection $selection | Out-Null
                }
                catch {
                    Show-InstallerFailure -ErrorRecord $_ -ActionName $actionName -Selection $selection
                    return
                }

                Pause-Installer -Message 'Press Enter to close.'
                return
            }

            continue
        }

        while ($true) {
            $selection = Select-InteractiveTarget
            if ($selection -eq 'BackAction') {
                break
            }

            if ($null -eq $selection) {
                continue
            }

            $summary = Get-EnabledPluginsFromStatus -Selection $selection
            $decision = Select-ActionDecision -ActionName $actionName -Selection $selection -EnabledInfo $summary

            if ($decision -ne 'Proceed') {
                continue
            }

            try {
                $completed = Invoke-InstallerAction -ActionName $actionName -Selection $selection -Interactive
            }
            catch {
                Show-InstallerFailure -ErrorRecord $_ -ActionName $actionName -Selection $selection
                return
            }

            if ($completed -eq $false) {
                Pause-Installer -Message 'Press Enter to close this window.'
                return
            }

            if ($actionName -in @('Install', 'Restore')) {
                Write-Host 'INFO  Starting Unity Hub...'
                Invoke-UnifyHubCommand -Arguments @('start', '--target', $selection.CliTarget) -Environment $selection.Environment
                Write-Host 'OK    Unity Hub started.'
                $script:InstallerShouldPause = $false
                return
            }

            Pause-Installer -Message 'Press Enter to close.'
            return
        }
    }
}

Test-NodeAvailable

$selection = $null

try {
    if ($Action -eq 'Interactive') {
        Invoke-InteractiveInstaller
        Pause-Installer
        Stop-ElevatedOutputCapture
        return
    }

    $selection = Resolve-TargetSelection -TargetName $Target -CustomPath $UnityHubPath
    Invoke-InstallerAction -ActionName $Action -Selection $selection | Out-Null

    if ($Action -in @('Install', 'Restore')) {
        Write-Host 'INFO  Starting Unity Hub...'
        Invoke-UnifyHubCommand -Arguments @('start', '--target', $selection.CliTarget) -Environment $selection.Environment
        Write-Host 'OK    Unity Hub started.'
    }

    Pause-Installer
    Stop-ElevatedOutputCapture
}
catch {
    Show-InstallerFailure -ErrorRecord $_ -ActionName $Action -Selection $selection
    Stop-ElevatedOutputCapture
    exit 1
}
