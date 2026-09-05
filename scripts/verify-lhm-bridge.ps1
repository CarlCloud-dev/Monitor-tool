param(
  [string]$BridgePath = (Join-Path $PSScriptRoot '..\resources\lhm\MonitorLhmBridge.exe')
)

$ErrorActionPreference = 'Stop'
$resolvedBridgePath = (Resolve-Path -LiteralPath $BridgePath).Path
$lines = @('sample', 'quit') | & $resolvedBridgePath 2>&1
$messages = foreach ($line in $lines) {
  try { $line | ConvertFrom-Json -ErrorAction Stop } catch { }
}

$errorMessage = $messages | Where-Object { $_.kind -eq 'error' } | Select-Object -ExpandProperty message -First 1
if ($errorMessage) {
  Write-Error "Libre Hardware Monitor bridge failed: $errorMessage"
  exit 1
}

$snapshot = $messages | Where-Object { $_.kind -eq 'snapshot' } | Select-Object -Last 1
if (-not $snapshot) {
  Write-Error 'Libre Hardware Monitor bridge did not return a sensor snapshot.'
  exit 1
}

$sensors = @($snapshot.sensors)
[pscustomobject]@{
  SensorCount = $sensors.Count
  HardwareTypes = ($sensors.hardwareType | Sort-Object -Unique) -join ', '
  TemperatureSensors = @($sensors | Where-Object { $_.sensorType -eq 'Temperature' -and $null -ne $_.value }).Count
  FanSensors = @($sensors | Where-Object { $_.sensorType -eq 'Fan' -and $null -ne $_.value }).Count
  PowerSensors = @($sensors | Where-Object { $_.sensorType -eq 'Power' -and $null -ne $_.value }).Count
}
