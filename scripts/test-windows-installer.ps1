param(
    [Parameter(Mandatory)][string]$Installer,
    [string]$ProductName = 'IfaceForge',
    [string]$Version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).version
)

$ErrorActionPreference = 'Stop'
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('ifg-installer-' + [guid]::NewGuid())
$install = Join-Path $root "$ProductName 验收"
$exe = Join-Path $install "$ProductName.exe"
$uninstaller = Join-Path $install "Uninstall $ProductName.exe"
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs', 'Create')) "$ProductName.lnk"
$desktop = Join-Path ([Environment]::GetFolderPath('DesktopDirectory', 'Create')) "$ProductName.lnk"
$shell = New-Object -ComObject WScript.Shell
$explorer = New-Object -ComObject Shell.Application
$bin = Join-Path $install 'bin'
$launcher = Join-Path $bin 'ifg.cmd'
$legacy = Join-Path $env:LOCALAPPDATA "Programs\$ProductName CLI"
$legacyLauncher = Join-Path $legacy 'ifg.cmd'
$legacyFiles = @('ifg.cmd', 'package.json', 'dist/cli/main.js', 'runtime/node.exe')
$legacyFolders = @('dist/cli', 'dist', 'runtime')
$sentinel = '%LOCALAPPDATA%\IfgInstallerPathTest-' + [guid]::NewGuid().ToString('N')

function Get-UserPath {
    [string]$environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}

function Invoke-Terminal([string]$Command) {
    $original = $env:Path
    $encoding = [Console]::OutputEncoding
    try {
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User')
        [Console]::OutputEncoding = [Text.Encoding]::UTF8
        $output = & "$env:WINDIR\System32\cmd.exe" /d /c "chcp 65001 >nul & $Command"
        if ($LASTEXITCODE -ne 0) { throw "Terminal command failed: $Command" }
        $output
    } finally {
        [Console]::OutputEncoding = $encoding
        $env:Path = $original
    }
}

function Assert-Cli([bool]$LegacyPresent) {
    $userEntries = (Get-UserPath).Split(';')
    if ($userEntries[0] -ine $bin -or @($userEntries | Where-Object { $_ -ieq $bin }).Count -ne 1 -or
        $userEntries -notcontains $sentinel -or $userEntries -contains $legacy) {
        throw 'PATH must contain one managed CLI directory and retain unrelated entries.'
    }
    $resolved = Invoke-Terminal 'where ifg' | Select-Object -First 1
    if ((Get-CanonicalPath $resolved) -ine (Get-CanonicalPath $launcher)) {
        throw "ifg resolves to '$resolved', expected '$launcher'."
    }
    $cli = Invoke-Terminal 'ifg --version --json' | ConvertFrom-Json
    $product = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
    if (!$cli.ok -or $cli.data.version -ne $Version -or $product -notin @($Version, "$Version.0")) {
        throw "Desktop '$product' and CLI '$($cli.data.version)' must match '$Version'."
    }
    if ($LegacyPresent -and !(Test-Path -LiteralPath $legacyLauncher -PathType Leaf)) {
        throw 'The independent CLI files should be preserved.'
    }
    Write-Output "Verified fresh terminal resolution and matching desktop/CLI version $Version. Legacy present $LegacyPresent."
}

function Get-CanonicalPath([string]$Path) {
    if (!$Path -or !(Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    & node -e 'process.stdout.write(require("node:fs").realpathSync.native(process.argv[1]))' $Path
    if ($LASTEXITCODE -ne 0) { throw "Cannot resolve $Path." }
}

function Assert-Shortcut([string]$Path, [bool]$Expected) {
    if ((Test-Path -LiteralPath $Path -PathType Leaf) -ne $Expected) {
        throw "Unexpected shortcut state at $Path. Expected presence $Expected."
    }
    if ($Expected) {
        $target = $shell.CreateShortcut($Path).TargetPath
        $expectedPath = Get-CanonicalPath $exe
        if ((Get-CanonicalPath $target) -ine $expectedPath) {
            $folder = $explorer.NameSpace((Split-Path -LiteralPath $Path))
            $link = $folder.ParseName((Split-Path -Leaf $Path))
            $parsingPath = $link.ExtendedProperty('System.Link.TargetParsingPath')
            if ((Get-CanonicalPath $parsingPath) -ine $expectedPath) {
                throw "Shortcut at $Path targets '$target' (shell path '$parsingPath'), expected '$exe'."
            }
        }
    }
}

function Invoke-Installer([string]$Options, [int]$ExpectedExit = 0) {
    $arguments = "/S /currentuser $Options /D=$install"
    $process = Start-Process -FilePath $Installer -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne $ExpectedExit) {
        throw "Installer exited $($process.ExitCode) for '$Options'. Expected $ExpectedExit."
    }
}

if ((Test-Path -LiteralPath $startMenu) -or (Test-Path -LiteralPath $desktop)) {
    throw 'Run the shortcut test with an unused product name in this Windows profile.'
}
$installedApp = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object DisplayName -EQ $ProductName
if ($installedApp) { throw 'Run the shortcut test with an uninstalled product in this Windows profile.' }
if (Test-Path -LiteralPath $legacy) { throw 'Run the installer test in a profile without this independent CLI.' }

$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$environment = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$original = Get-UserPath
$hadPath = $environment.GetValueNames() -contains 'Path'
$valueKind = if ($hadPath) { $environment.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
$testPath = (@($original, $sentinel) | Where-Object { $_ }) -join ';'
$legacyCreated = $false
try {
    $environment.SetValue('Path', $testPath, $valueKind)
    Invoke-Installer '/DESKTOP=bad' 2
    if (Test-Path -LiteralPath $exe) { throw 'Invalid shortcut argument installed the application.' }
    $cases = @(
        @{ Options = ''; StartMenu = $true; Desktop = $false },
        @{ Options = '/DESKTOP=1'; StartMenu = $true; Desktop = $true },
        @{ Options = '/STARTMENU=0 /DESKTOP=1'; StartMenu = $false; Desktop = $true },
        @{ Options = '/STARTMENU=0 /DESKTOP=0'; StartMenu = $false; Desktop = $false },
        @{ Options = '/STARTMENU=1 /DESKTOP=1'; StartMenu = $true; Desktop = $true }
    )
    for ($index = 0; $index -lt $cases.Length; $index++) {
        $case = $cases[$index]
        if ($index -eq 1) {
            # Model a separately installed older CLI that currently wins on PATH.
            $null = New-Item -Path (Join-Path $legacy 'dist/cli') -ItemType Directory -Force
            $legacyCreated = $true
            $null = New-Item -Path (Join-Path $legacy 'runtime') -ItemType Directory
            Copy-Item -LiteralPath $node -Destination (Join-Path $legacy 'runtime/node.exe')
            [IO.File]::WriteAllLines($legacyLauncher, @('@echo off', '"%~dp0runtime\node.exe" "%~dp0dist\cli\main.js" %*'))
            [IO.File]::WriteAllText((Join-Path $legacy 'package.json'), '{"name":"ifaceforge","version":"0.3.0-preview.2"}')
            [IO.File]::WriteAllText((Join-Path $legacy 'dist/cli/main.js'), 'console.log(JSON.stringify({ok:true,data:{version:"0.3.0-preview.2"}}))')
            $environment.SetValue('Path', "$legacy;$(Get-UserPath)", $valueKind)
            $previous = Invoke-Terminal 'ifg --version --json' | ConvertFrom-Json
            if ($previous.data.version -ne '0.3.0-preview.2') { throw 'The older CLI test fixture must resolve before upgrading.' }
        }
        Invoke-Installer $case.Options
        if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'The requested install path has no application.' }
        Assert-Shortcut $startMenu $case.StartMenu
        Assert-Shortcut $desktop $case.Desktop
        Assert-Cli $legacyCreated
        Write-Output "Verified shortcuts. Start menu $($case.StartMenu), desktop $($case.Desktop)."
    }
    $originalData = $env:IFG_DATA_HOME
    try {
        $env:IFG_DATA_HOME = Join-Path $root 'cli-data'
        $guide = Invoke-Terminal 'ifg guide cli --json' | ConvertFrom-Json
        if (!$guide.ok -or !$guide.data.commands.items) { throw 'The installed CLI did not return its guide.' }
        $preferences = Invoke-Terminal 'ifg preferences get --json' | ConvertFrom-Json
        if (!$preferences.ok) { throw 'The installed CLI could not start the workspace service.' }
    } finally {
        try { Invoke-Terminal 'ifg service stop --json' | Out-Null } finally { $env:IFG_DATA_HOME = $originalData }
    }
} finally {
    try {
        if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
            $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
            if ($process.ExitCode -ne 0 -or (Test-Path -LiteralPath $exe)) { throw 'Test uninstallation failed.' }
            Assert-Shortcut $startMenu $false
            Assert-Shortcut $desktop $false
            if ((Get-UserPath) -cne $testPath) { throw 'Uninstall must remove only the managed CLI PATH entry.' }
        }
    } finally {
        if ($hadPath) { $environment.SetValue('Path', $original, $valueKind) } else { $environment.DeleteValue('Path', $false) }
        $environment.Dispose()
        if ($legacyCreated) {
            foreach ($file in $legacyFiles) {
                $path = Join-Path $legacy $file
                if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path }
            }
            foreach ($folder in $legacyFolders) {
                $path = Join-Path $legacy $folder
                if ((Test-Path -LiteralPath $path) -and !(Get-ChildItem -LiteralPath $path -Force)) { Remove-Item -LiteralPath $path }
            }
            if (!(Get-ChildItem -LiteralPath $legacy -Force)) { Remove-Item -LiteralPath $legacy }
        }
        if (Test-Path -LiteralPath $root) {
            $resolvedRoot = (Resolve-Path -LiteralPath $root).Path
            if ($resolvedRoot -ine $root -or (Split-Path -Parent $resolvedRoot) -ine [IO.Path]::GetTempPath().TrimEnd('\')) {
                throw 'The test data path must be inside the Windows temporary directory.'
            }
            Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
        }
    }
}
Write-Output 'Verified invalid arguments, CLI and workspace service, requested installation path, and cleanup on uninstall.'
