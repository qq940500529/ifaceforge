param(
    [Parameter(Mandatory)][ValidateSet('install', 'uninstall')][string]$Action,
    [Parameter(Mandatory)][ValidateSet('CurrentUser', 'all')][string]$Scope,
    [Parameter(Mandatory)][string]$InstallDirectory,
    [Parameter(Mandatory)][string]$AppId,
    [Parameter(Mandatory)][string]$ProductName
)

$ErrorActionPreference = 'Stop'

function Normalize-Entry([string]$Entry) {
    [Environment]::ExpandEnvironmentVariables($Entry.Trim().Trim('"')).TrimEnd('\', '/')
}

function Test-LegacyLauncher([string]$Directory) {
    $manifest = Join-Path $Directory 'package.json'
    $launcher = Join-Path $Directory 'ifg.cmd'
    if (!(Test-Path -LiteralPath $manifest -PathType Leaf) -or !(Test-Path -LiteralPath $launcher -PathType Leaf)) {
        return $false
    }
    try {
        $package = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $false
    }
    $wrapper = [IO.File]::ReadAllText($launcher).Trim().Replace("`r`n", "`n")
    return $package.name -eq 'ifaceforge' -and
        $wrapper -ceq ('@echo off' + "`n" + '"%~dp0runtime\node.exe" "%~dp0dist\cli\main.js" %*')
}

$stateName = "Software\$AppId\CLI"
$entry = Join-Path $InstallDirectory 'bin'
$normalized = Normalize-Entry $entry
$hive = if ($Scope -eq 'all') { [Microsoft.Win32.Registry]::LocalMachine } else { [Microsoft.Win32.Registry]::CurrentUser }
$key = if ($Scope -eq 'all') { 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment' } else { 'Environment' }
$environment = $hive.CreateSubKey($key)
$state = $hive.OpenSubKey($stateName)
$ownsEntry = $false
try {
    $previous = if ($null -ne $state) { [string]$state.GetValue('OwnedPath', '') } else { '' }
    $original = [string]$environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $entries = if ($original.Length) { @($original.Split(';')) } else { @() }
    $kind = if ($environment.GetValueNames() -contains 'Path') {
        $environment.GetValueKind('Path')
    } else {
        [Microsoft.Win32.RegistryValueKind]::ExpandString
    }
    if ($Action -eq 'uninstall') {
        if (!$previous -or (Normalize-Entry $previous) -ine $normalized) { return }
        $updated = ($entries | Where-Object { (Normalize-Entry $_) -ine $normalized }) -join ';'
    } else {
        if ($entry.Contains(';') -or !(Test-Path -LiteralPath (Join-Path $entry 'ifg.cmd') -PathType Leaf)) {
            throw 'The CLI directory cannot be registered on PATH.'
        }
        $legacy = Join-Path $env:LOCALAPPDATA "Programs\$ProductName CLI"
        $removeLegacy = $Scope -eq 'CurrentUser' -and (Test-LegacyLauncher $legacy)
        $legacyEntry = Normalize-Entry $legacy
        $previousEntry = Normalize-Entry $previous
        $alreadyPresent = @($entries | Where-Object { (Normalize-Entry $_) -ieq $normalized }).Count -gt 0
        $remaining = @($entries | Where-Object {
            $current = Normalize-Entry $_
            $current -ine $normalized -and (!$previousEntry -or $current -ine $previousEntry) -and
                (!$removeLegacy -or $current -ine $legacyEntry)
        })
        $updated = (@($entry) + $remaining) -join ';'
        $ownsEntry = !$alreadyPresent -or $previousEntry -ieq $normalized
    }
    if ($updated -cne $original) {
        if ($updated.Length) {
            $environment.SetValue('Path', $updated, $kind)
        } else {
            $environment.DeleteValue('Path', $false)
        }
    }
    if ($ownsEntry) {
        $writable = $hive.CreateSubKey($stateName)
        try { $writable.SetValue('OwnedPath', $entry) } finally { $writable.Dispose() }
    } else {
        $hive.DeleteSubKey($stateName, $false)
    }
} finally {
    if ($null -ne $state) { $state.Dispose() }
    $environment.Dispose()
}
