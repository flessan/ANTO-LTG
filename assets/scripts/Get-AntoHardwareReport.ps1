#Requires -Version 2.0
<#
.SYNOPSIS
  Read-only hardware report for the ANTO-LTG driver source finder.

.DESCRIPTION
  Prints (or saves) a small JSON document with the computer maker, model, motherboard, Windows build
  and architecture, and the name and hardware IDs of each device that Windows knows about.

  It does NOT collect serial numbers, the host name, user names, IP addresses, installed programs or
  files. It does not install, change or upload anything. Read it before you run it; it is short.

  Works on Windows 7, 8, 8.1, 10 and 11 with PowerShell 2.0 or later. It uses WMI (Get-WmiObject), which
  every one of those versions has, and writes the JSON itself, because ConvertTo-Json needs PowerShell 3.

.PARAMETER OutFile
  Optional path to save the JSON to instead of printing it.

.EXAMPLE
  .\Get-AntoHardwareReport.ps1 | Set-Clipboard
  Then paste the result into "Identify hardware from hardware IDs" on the Drivers page.
  (Set-Clipboard needs PowerShell 5 or later. On older systems use -OutFile and open the file instead.)
#>
[CmdletBinding()]
param([string]$OutFile)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# JSON writer for hashtables, arrays, strings, numbers and booleans (PowerShell 2.0 has no ConvertTo-Json).
function ConvertTo-AntoJsonString([string]$Text) {
    $q = [string][char]34
    $bs = [string][char]92
    $t = $Text.Replace($bs, $bs + $bs).Replace($q, $bs + $q)
    $t = $t.Replace([string][char]9, $bs + 't').Replace([string][char]10, $bs + 'n').Replace([string][char]13, $bs + 'r')
    return $q + $t + $q
}

function ConvertTo-AntoJson($Value, [int]$Depth = 0) {
    $pad = '  ' * ($Depth + 1)
    $close = '  ' * $Depth
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double]) { return [string]$Value }
    if ($Value -is [string]) { return (ConvertTo-AntoJsonString $Value) }
    if ($Value -is [System.Collections.IDictionary]) {
        $parts = @()
        foreach ($key in $Value.Keys) { $parts += ($pad + (ConvertTo-AntoJsonString ([string]$key)) + ': ' + (ConvertTo-AntoJson $Value[$key] ($Depth + 1))) }
        if ($parts.Count -eq 0) { return '{}' }
        return ('{' + [char]10 + ($parts -join (',' + [char]10)) + [char]10 + $close + '}')
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @()
        foreach ($item in $Value) { $items += ($pad + (ConvertTo-AntoJson $item ($Depth + 1))) }
        if ($items.Count -eq 0) { return '[]' }
        return ('[' + [char]10 + ($items -join (',' + [char]10)) + [char]10 + $close + ']')
    }
    return (ConvertTo-AntoJsonString ([string]$Value))
}

$cs = Get-WmiObject -Class Win32_ComputerSystem
$bb = Get-WmiObject -Class Win32_BaseBoard
$os = Get-WmiObject -Class Win32_OperatingSystem

$devices = @()
$pnp = @(Get-WmiObject -Class Win32_PnPEntity | Where-Object { $_.HardwareID })
foreach ($d in ($pnp | Select-Object -First 600)) {
    $devices += @{
        name         = [string]$d.Name
        problem_code = [int]$d.ConfigManagerErrorCode
        hardware_ids = @(@($d.HardwareID) | Select-Object -First 6 | ForEach-Object { [string]$_ })
    }
}

$report = @{
    format         = 'anto-ltg.hardware-report'
    format_version = 1
    manufacturer   = [string]$cs.Manufacturer
    model          = [string]$cs.Model
    baseboard      = ('{0} {1}' -f $bb.Manufacturer, $bb.Product).Trim()
    os             = @{ caption = [string]$os.Caption; build = [int]$os.BuildNumber; arch = [string]$env:PROCESSOR_ARCHITECTURE }
    devices        = $devices
}
$json = ConvertTo-AntoJson $report

if ($OutFile) {
    $target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)
    [System.IO.File]::WriteAllText($target, ($json + [char]13 + [char]10), (New-Object System.Text.UTF8Encoding($true)))
    Write-Host ('Saved to ' + $OutFile)
} else {
    $json
}
