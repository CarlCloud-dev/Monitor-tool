using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;
using System.Windows;
using System.Windows.Automation;

// Read taskbar geometry; the native display runs separately in --host mode.
static class TaskbarProbe {
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT rect);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint command);
    delegate bool EnumWindowProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowProc callback, IntPtr param);
    static readonly object OutputLock = new object();
    static long LastOutputTicks = DateTime.UtcNow.Ticks;
    static long LastUiScanTicks = DateTime.UtcNow.Ticks;
    static void WriteLine(string text) {
        lock (OutputLock) {
            Console.WriteLine(text);
            Console.Out.Flush();
            Interlocked.Exchange(ref LastOutputTicks, DateTime.UtcNow.Ticks);
        }
    }
    static void WriteUnavailableGeometry(IntPtr handle, IntPtr target, bool restartProbe = false) {
        RECT bounds;
        if (handle == IntPtr.Zero || !IsWindowVisible(handle) || !GetWindowRect(handle, out bounds)) { WriteLine("null"); return; }
        WriteLine("{\"shell\":" + handle.ToInt64() + ",\"left\":" + bounds.left + ",\"top\":" + bounds.top + ",\"right\":" + bounds.right + ",\"bottom\":" + bounds.bottom + ",\"attached\":" + (target != IntPtr.Zero && GetWindow(target, 4) == handle ? "true" : "false") + ",\"controlsAvailable\":false,\"restartProbe\":" + (restartProbe ? "true" : "false") + ",\"blocked\":[]}");
    }
    [STAThread] static void Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length >= 3 && args[0] == "--preview") { TaskbarHost.Preview(args); return; }
        if (args.Length > 0 && args[0] == "--host") { TaskbarHost.Run(args); return; }
        long windowId; uint expectedPid = 0;
        var target = args.Length > 1 && Int64.TryParse(args[0], out windowId) && UInt32.TryParse(args[1], out expectedPid) ? new IntPtr(windowId) : IntPtr.Zero;
        if (target == IntPtr.Zero) expectedPid = 0;
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        // Some Windows 11 taskbar UIA queries block while Start is open.
        // Keep emitting native bounds so the client can retain its last safe layout.
        var heartbeat = new Thread(() => {
            while (true) {
                Thread.Sleep(3000);
                if (DateTime.UtcNow.Ticks - Interlocked.Read(ref LastOutputTicks) > TimeSpan.FromSeconds(4).Ticks)
                    WriteUnavailableGeometry(FindWindow("Shell_TrayWnd", null), target,
                        DateTime.UtcNow.Ticks - Interlocked.Read(ref LastUiScanTicks) > TimeSpan.FromSeconds(20).Ticks);
            }
        });
        heartbeat.IsBackground = true;
        heartbeat.Start();
        while (true) {
            IntPtr handle = IntPtr.Zero;
            try {
                handle = FindWindow("Shell_TrayWnd", null);
                RECT bounds;
                if (handle == IntPtr.Zero || !IsWindowVisible(handle) || !GetWindowRect(handle, out bounds)) { WriteLine("null"); }
                else {
                    var root = AutomationElement.FromHandle(handle);
                    var interactive = new OrCondition(
                        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
                        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ComboBox),
                        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem),
                        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.CheckBox),
                        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Hyperlink),
                        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Image));
                    var nodes = root.FindAll(TreeScope.Descendants, interactive);
                    var blocked = new List<string>();
                    for (int i = 0; i < nodes.Count && i < 250; i++) {
                        try {
                            var current = nodes[i].Current;
                            var r = current.BoundingRectangle;
                            if (current.IsOffscreen || r.IsEmpty || r.Width < 4 || r.Height < 4 || r.Width > bounds.right - bounds.left || r.Bottom <= bounds.top || r.Top >= bounds.bottom || r.Top < bounds.top - 2 || r.Bottom > bounds.bottom + 2) continue;
                            blocked.Add("[" + (int)r.Left + "," + (int)r.Right + "]");
                        } catch (ElementNotAvailableException) { }
                    }
                    bool controlsAvailable = blocked.Count > 0;
                    // Some taskbar widgets (including music controls) are owned
                    // top-level windows, not children in the taskbar UIA tree.
                    EnumWindows((window, unused) => {
                        RECT widget;
                        if (window == target || !IsWindowVisible(window) || GetWindow(window, 4) != handle || !GetWindowRect(window, out widget)) return true;
                        if (widget.right <= bounds.left || widget.left >= bounds.right || widget.bottom <= bounds.top || widget.top >= bounds.bottom || widget.right - widget.left < 4 || widget.top < bounds.top - 2 || widget.bottom > bounds.bottom + 2) return true;
                        blocked.Add("[" + widget.left + "," + widget.right + "]");
                        return true;
                    }, IntPtr.Zero);
                    WriteLine("{\"shell\":" + handle.ToInt64() + ",\"left\":" + bounds.left + ",\"top\":" + bounds.top + ",\"right\":" + bounds.right + ",\"bottom\":" + bounds.bottom + ",\"attached\":" + (target != IntPtr.Zero && GetWindow(target, 4) == handle ? "true" : "false") + ",\"controlsAvailable\":" + (controlsAvailable ? "true" : "false") + ",\"blocked\":[" + String.Join(",", blocked.ToArray()) + "]}");
                }
            } catch { WriteUnavailableGeometry(handle, target); }
            Interlocked.Exchange(ref LastUiScanTicks, DateTime.UtcNow.Ticks);
            Thread.Sleep(3000);
        }
    }
}
