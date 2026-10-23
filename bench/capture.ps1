#requires -Version 7
<#
.SYNOPSIS
Capture Wormhole traffic for Wireshark.

.DESCRIPTION
Uses dumpcap from Wireshark/Npcap. Run PowerShell as Administrator.
List interfaces first with: dumpcap -D
The loopback interface is usually named "Adapter for loopback traffic capture"
or "Loopback".

.EXAMPLE
./bench/capture.ps1 -Interface "Adapter for loopback traffic capture" -Seconds 20
#>
param(
  [string]$Interface = "Adapter for loopback traffic capture",
  [int]$Seconds = 20,
  [string]$Out = "bench/results/wormhole.pcap",
  [string]$Filter = "tcp port 4443 or tcp port 8080 or (tcp portrange 15000-15099)"
)

$dumpcap = (Get-Command dumpcap -ErrorAction SilentlyContinue).Source
if (-not $dumpcap) {
  $candidate = "C:\Program Files\Wireshark\dumpcap.exe"
  if (Test-Path $candidate) { $dumpcap = $candidate }
}
if (-not $dumpcap) {
  Write-Error "dumpcap not found. Install Wireshark/Npcap or add dumpcap to PATH."
  exit 1
}

New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
Write-Host "Capturing $Seconds seconds on '$Interface' -> $Out"
& $dumpcap -i $Interface -f $Filter -a "duration:$Seconds" -w $Out
Write-Host "Done. Open $Out in Wireshark."
