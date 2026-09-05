using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using LibreHardwareMonitor.Hardware;
using LibreHardwareMonitor.PawnIo;

public sealed class UpdateVisitor : IVisitor
{
    public void VisitComputer(IComputer computer)
    {
        computer.Traverse(this);
    }

    public void VisitHardware(IHardware hardware)
    {
        hardware.Update();
        foreach (IHardware subHardware in hardware.SubHardware)
            subHardware.Accept(this);
    }

    public void VisitSensor(ISensor sensor) { }
    public void VisitParameter(IParameter parameter) { }
}

public sealed class SensorRecord
{
    public string hardwareType { get; set; }
    public string hardwareName { get; set; }
    public string parentHardwareType { get; set; }
    public string parentHardwareName { get; set; }
    public string sensorType { get; set; }
    public string name { get; set; }
    public string identifier { get; set; }
    public float? value { get; set; }
    public float? min { get; set; }
    public float? max { get; set; }
}

public static class MonitorLhmBridge
{
    private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };

    public static void Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        var pipeName = ArgumentValue(args, "--pipe");
        if (!String.IsNullOrWhiteSpace(pipeName))
        {
            using (var pipe = CreateUserPipe(pipeName))
            {
                pipe.WaitForConnection();
                using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true))
                using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true) { AutoFlush = true })
                    Run(reader, writer);
            }
            return;
        }

        Run(Console.In, Console.Out);
    }

    private static NamedPipeServerStream CreateUserPipe(string pipeName)
    {
        // UAC 后的桥接器与未提权的 Electron 主进程属于同一 Windows 用户，
        // 但默认 ACL 可能阻止中等完整性级别的客户端连接。仅授予当前用户访问。
        var security = new PipeSecurity();
        var currentUser = WindowsIdentity.GetCurrent().User;
        if (currentUser != null)
            security.SetAccessRule(new PipeAccessRule(currentUser, PipeAccessRights.FullControl, AccessControlType.Allow));
        security.SetAccessRuleProtection(true, false);
        return new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.None,
            0,
            0,
            security);
    }

    private static void Run(TextReader input, TextWriter output)
    {
        Computer computer = null;
        try
        {
            computer = new Computer
            {
                IsCpuEnabled = true,
                IsGpuEnabled = true,
                IsMemoryEnabled = true,
                IsMotherboardEnabled = true,
                IsControllerEnabled = true,
                IsNetworkEnabled = true,
                IsStorageEnabled = true,
                IsPowerMonitorEnabled = true
            };
            computer.Open();
            output.WriteLine(Serializer.Serialize(new
            {
                kind = "ready",
                version = "2",
                lhmVersion = typeof(Computer).Assembly.GetName().Version.ToString(),
                pawnIoInstalled = PawnIo.IsInstalled,
                pawnIoVersion = PawnIo.Version == null ? null : PawnIo.Version.ToString()
            }));

            string command;
            while ((command = input.ReadLine()) != null)
            {
                command = command.Trim();
                if (String.Equals(command, "quit", StringComparison.OrdinalIgnoreCase))
                    break;
                if (!String.Equals(command, "sample", StringComparison.OrdinalIgnoreCase))
                    continue;

                computer.Accept(new UpdateVisitor());
                output.WriteLine(Serializer.Serialize(new { kind = "snapshot", sensors = CollectSensors(computer) }));
            }
        }
        catch (Exception error)
        {
            output.WriteLine(Serializer.Serialize(new { kind = "error", message = error.Message }));
        }
        finally
        {
            if (computer != null)
                computer.Close();
        }
    }

    private static List<SensorRecord> CollectSensors(Computer computer)
    {
        var result = new List<SensorRecord>();
        foreach (IHardware hardware in computer.Hardware)
            AppendHardware(hardware, result, null);
        return result;
    }

    private static void AppendHardware(IHardware hardware, List<SensorRecord> target, IHardware parent)
    {
        foreach (ISensor sensor in hardware.Sensors)
        {
            target.Add(new SensorRecord
            {
                hardwareType = hardware.HardwareType.ToString(),
                hardwareName = hardware.Name,
                parentHardwareType = parent == null ? null : parent.HardwareType.ToString(),
                parentHardwareName = parent == null ? null : parent.Name,
                sensorType = sensor.SensorType.ToString(),
                name = sensor.Name,
                identifier = sensor.Identifier.ToString(),
                value = sensor.Value,
                min = sensor.Min,
                max = sensor.Max
            });
        }
        foreach (IHardware subHardware in hardware.SubHardware)
            AppendHardware(subHardware, target, hardware);
    }

    private static string ArgumentValue(string[] args, string name)
    {
        for (var index = 0; index < args.Length - 1; index++)
            if (String.Equals(args[index], name, StringComparison.OrdinalIgnoreCase))
                return args[index + 1];
        return null;
    }
}
