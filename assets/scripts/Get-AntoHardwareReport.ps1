#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only hardware report for the ANTO-LTG driver source finder.

.DESCRIPTION
  Prints (or saves) a small JSON document with the computer maker, model, motherboard, Windows build
  and architecture, and the name and hardware IDs of each device that Windows knows about.

  It does NOT collect serial numbers, the host name, user names, IP addresses, installed programs or
  files. It does not install, change or upload anything. Read it before you run it; it is short.

.PARAMETER OutFile
  Optional path to save the JSON to instead of printing it.

.EXAMPLE
  .\Get-AntoHardwareReport.ps1 | Set-Clipboard
  Then paste the result into "Identify hardware from hardware IDs" on the Drivers page.
#>
[CmdletBinding()]
param([string]$OutFile)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$cs = Get-CimInstance -ClassName Win32_ComputerSystem
$bb = Get-CimInstance -ClassName Win32_BaseBoard
$os = Get-CimInstance -ClassName Win32_OperatingSystem

$devices = @(
    Get-CimInstance -ClassName Win32_PnPEntity |
        Where-Object { $_.HardwareID } |
        Select-Object -First 600 |
        ForEach-Object {
            [pscustomobject]@{
                name         = [string]$_.Name
                problem_code = [int]$_.ConfigManagerErrorCode
                hardware_ids = @($_.HardwareID | Select-Object -First 6)
            }
        }
)

$report = [ordered]@{
    format         = 'anto-ltg.hardware-report'
    format_version = 1
    manufacturer   = [string]$cs.Manufacturer
    model          = [string]$cs.Model
    baseboard      = ('{0} {1}' -f $bb.Manufacturer, $bb.Product).Trim()
    os             = [ordered]@{ caption = [string]$os.Caption; build = [int]$os.BuildNumber; arch = $env:PROCESSOR_ARCHITECTURE }
    devices        = $devices
}
$json = $report | ConvertTo-Json -Depth 6

if ($OutFile) {
    Set-Content -LiteralPath $OutFile -Value $json -Encoding UTF8
    Write-Host ('Saved to ' + $OutFile)
} else {
    $json
}
