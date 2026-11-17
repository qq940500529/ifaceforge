param(
    [Parameter(Mandatory)][string]$Installer,
    [string]$ProductName = 'IfaceForge'
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

function Assert-Shortcut([string]$Path, [bool]$Expected) {
    if ((Test-Path -LiteralPath $Path -PathType Leaf) -ne $Expected) {
        throw "Unexpected shortcut state at $Path. Expected presence $Expected."
    }
    if ($Expected -and $shell.CreateShortcut($Path).TargetPath -ine $exe) {
        throw "Shortcut at $Path does not target the installed application."
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

try {
    Invoke-Installer '/DESKTOP=bad' 2
    if (Test-Path -LiteralPath $exe) { throw 'Invalid shortcut argument installed the application.' }
    $cases = @(
        @{ Options = ''; StartMenu = $true; Desktop = $false },
        @{ Options = '/DESKTOP=1'; StartMenu = $true; Desktop = $true },
        @{ Options = '/STARTMENU=0 /DESKTOP=1'; StartMenu = $false; Desktop = $true },
        @{ Options = '/STARTMENU=0 /DESKTOP=0'; StartMenu = $false; Desktop = $false },
        @{ Options = '/STARTMENU=1 /DESKTOP=1'; StartMenu = $true; Desktop = $true }
    )
    foreach ($case in $cases) {
        Invoke-Installer $case.Options
        if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'The requested install path has no application.' }
        Assert-Shortcut $startMenu $case.StartMenu
        Assert-Shortcut $desktop $case.Desktop
        Write-Output "Verified shortcuts. Start menu $($case.StartMenu), desktop $($case.Desktop)."
    }
} finally {
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
        $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
        if ($process.ExitCode -ne 0 -or (Test-Path -LiteralPath $exe)) { throw 'Test uninstallation failed.' }
        Assert-Shortcut $startMenu $false
        Assert-Shortcut $desktop $false
    }
    if ((Test-Path -LiteralPath $root) -and !(Get-ChildItem -LiteralPath $root -Force)) {
        Remove-Item -LiteralPath $root
    }
}
Write-Output 'Verified invalid arguments, the requested installation path, and shortcut removal on uninstall.'
