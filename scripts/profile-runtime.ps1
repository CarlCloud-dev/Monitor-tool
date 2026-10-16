param(
    [ValidateRange(5, 120)][int]$DurationSeconds = 20,
    [int]$RootProcessId = 0
)

$ErrorActionPreference = 'Stop'
# Reading each new child's parent through CIM is slow enough to miss most of
# the short-lived PowerShell jobs we are measuring. Read its PID directly.
if (-not ('MonitorRuntimeNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MonitorRuntimeNative {
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicInfo { public IntPtr Reserved1, Peb, Reserved2, Reserved3, Id, Parent; }
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr handle, int type, out BasicInfo info, int length, out int returned);
    public static int ParentId(int id) {
        var handle = OpenProcess(0x1000, false, id);
        if (handle == IntPtr.Zero) return 0;
        try {
            BasicInfo info; int returned;
            return NtQueryInformationProcess(handle, 0, out info, Marshal.SizeOf(typeof(BasicInfo)), out returned) == 0 ? info.Parent.ToInt32() : 0;
        } finally { CloseHandle(handle); }
    }
}
'@
}
$logicalProcessors = [Environment]::ProcessorCount
$names = @('MonitorTool', 'MonitorLhmBridge', 'MonitorLhmElevatedBridge', 'powershell', 'nvidia-smi', 'conhost', 'WmiPrvSE')
if ($RootProcessId -gt 0) { $names += (Get-Process -Id $RootProcessId).ProcessName }
$known = @{}
$records = @{}
$started = [DateTime]::UtcNow
$clock = [Diagnostics.Stopwatch]::StartNew()
$baselineComplete = $false

function Observe-Processes {
    Get-Process -Name $names -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $process = $_
            $processIdValue = $process.Id
            $key = "$processIdValue/$($process.StartTime.Ticks)"
            if (-not $records.ContainsKey($key)) {
                $parentId = [MonitorRuntimeNative]::ParentId($processIdValue)
                $belongs = ($RootProcessId -eq 0 -and $process.ProcessName -in @('MonitorTool', 'MonitorLhmBridge', 'MonitorLhmElevatedBridge')) -or $processIdValue -eq $RootProcessId -or ($known.ContainsKey($parentId) -and $known[$parentId])
                $known[$processIdValue] = $belongs
                $records[$key] = [pscustomobject]@{
                    Name = $process.ProcessName
                    Id = $processIdValue
                    ParentId = $parentId
                    Monitor = $belongs
                    New = $process.StartTime.ToUniversalTime() -ge $started
                    Initial = if ($baselineComplete -and $process.StartTime.ToUniversalTime() -ge $started) { 0.0 } else { $process.TotalProcessorTime.TotalMilliseconds }
                    Last = $process.TotalProcessorTime.TotalMilliseconds
                }
            } else {
                $records[$key].Last = $process.TotalProcessorTime.TotalMilliseconds
            }
        } catch { }
    }
}

if ($RootProcessId -gt 0) { $known[$RootProcessId] = $true }
Observe-Processes
$baselineComplete = $true
$started = [DateTime]::UtcNow
$clock.Restart()
while ($clock.Elapsed.TotalSeconds -lt $DurationSeconds) {
    Start-Sleep -Milliseconds 150
    Observe-Processes
}
$elapsed = $clock.Elapsed.TotalMilliseconds
$rows = @($records.Values | ForEach-Object {
    [pscustomobject]@{
        Name = $_.Name
        Id = $_.Id
        ParentId = $_.ParentId
        Monitor = $_.Monitor
        New = $_.New
        CpuMs = [math]::Max(0, $_.Last - $_.Initial)
    }
})
$monitorRows = @($rows | Where-Object Monitor)
[pscustomobject]@{
    DurationSeconds = [math]::Round($elapsed / 1000, 2)
    LogicalProcessors = $logicalProcessors
    MonitorCpuPercent = [math]::Round(100 * ($monitorRows | Measure-Object CpuMs -Sum).Sum / $elapsed / $logicalProcessors, 3)
    NewMonitorProcessesObserved = @($monitorRows | Where-Object New).Count
    Groups = @($rows | Where-Object { $_.Monitor -or $_.Name -eq 'WmiPrvSE' } | Group-Object Name,Monitor | ForEach-Object {
        [pscustomobject]@{
            Name = $_.Group[0].Name
            Monitor = $_.Group[0].Monitor
            Processes = $_.Count
            New = @($_.Group | Where-Object New).Count
            CpuPercent = [math]::Round(100 * ($_.Group | Measure-Object CpuMs -Sum).Sum / $elapsed / $logicalProcessors, 3)
        }
    } | Sort-Object CpuPercent -Descending)
    Note = 'Polling includes observed child CPU. Very short-lived processes and CPU after the final observation may be missed. WMI provider work is shared and not attributed to Monitor Tool.'
} | ConvertTo-Json -Depth 4
