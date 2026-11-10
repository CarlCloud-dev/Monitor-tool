using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// A passive native child owned by this helper, never an Electron HWND reparented
// across processes. Its composition follows the taskbar through Start transitions.
static class TaskbarHost {
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; public POINT(int a, int b) { x=a; y=b; } }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; public SIZE(int a, int b) { cx=a; cy=b; } }
    [StructLayout(LayoutKind.Sequential, Pack=1)] struct BLEND { public byte op, flags, alpha, format; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT rect);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int mode);
    [DllImport("user32.dll", SetLastError=true)] static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dc, ref POINT dst, ref SIZE size, IntPtr source, ref POINT origin, uint key, ref BLEND blend, uint flags);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint command);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    delegate void WindowEvent(IntPtr hook, uint kind, IntPtr window, int objectId, int childId, uint thread, uint time);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WindowEvent callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly object WriteLock = new object();
    static void Write(object data) { lock (WriteLock) { try { Console.WriteLine(Json.Serialize(data)); Console.Out.Flush(); } catch (IOException) { Application.Exit(); } } }
    public sealed class TextRun {
        public string text { get; set; } public string color { get; set; } public bool bold { get; set; }
        public string kind { get; set; } public float gapBefore { get; set; } public float gapAfter { get; set; }
    }
    public sealed class Command {
        public string kind { get; set; } public TextRun[] runs { get; set; } public bool dark { get; set; }
        public long shell { get; set; } public int x { get; set; } public int y { get; set; } public int width { get; set; } public int height { get; set; }
    }
    sealed class HostWindow : NativeWindow, IDisposable {
        IntPtr shell;
        Command content = new Command { runs = new TextRun[0], dark = true };
        Command placement;
        readonly object queueLock = new object();
        Command pendingContent, pendingPlacement;
        bool pendingHide;
        float scale = 1;
        int desiredWidth;
        bool shown;
        IntPtr foregroundHook, reorderHook;
        WindowEvent onWindowEvent;
        void EnsureFront() {
            if (shown && Handle != IntPtr.Zero && GetWindow(Handle, 3) != IntPtr.Zero)
                SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, 0x1 | 0x2 | 0x10 | 0x200);
        }
        void ReleaseHooks() {
            if (foregroundHook != IntPtr.Zero) UnhookWinEvent(foregroundHook);
            if (reorderHook != IntPtr.Zero) UnhookWinEvent(reorderHook);
            foregroundHook = IntPtr.Zero; reorderHook = IntPtr.Zero;
        }
        public void Receive(Command command) {
            lock (queueLock) {
                if (command.kind == "content") pendingContent = command;
                else if (command.kind == "place") { pendingPlacement = command; pendingHide = false; }
                else if (command.kind == "hide") { pendingHide = true; pendingPlacement = null; }
            }
            PostMessage(Handle, 0x8001, IntPtr.Zero, IntPtr.Zero);
        }
        public void Maintain() {
            var current = FindWindow("Shell_TrayWnd", null);
            if (current == IntPtr.Zero) { Hide(); return; }
            if (Handle != IntPtr.Zero && IsWindow(Handle) && current == shell) {
                float currentScale = Math.Max(1, GetDpiForWindow(shell)) / 96f;
                if (currentScale != scale) { scale = currentScale; Measure(); Paint(); }
                EnsureFront(); return;
            }
            if (Handle != IntPtr.Zero) DestroyHandle();
            ReleaseHooks();
            shell = current;
            // Match the taskbar's DPI context on this helper thread before window
            // creation. No SetParent, shell writes, DLL injection or Explorer hooks.
            SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(shell));
            scale = Math.Max(1, GetDpiForWindow(shell)) / 96f;
            CreateHandle(new CreateParams { Caption = "Monitor Tool Taskbar", Parent = shell,
                Style = 0x40000000, ExStyle = 0x80000 | 0x20 | 0x8000000,
                X = 0, Y = 0, Width = 1, Height = 1 });
            shown = false; placement = null;
            onWindowEvent = (hook, kind, window, objectId, childId, thread, time) => {
                if (kind == 3 || (window == shell && objectId == 0)) EnsureFront();
            };
            uint shellPid; GetWindowThreadProcessId(shell, out shellPid);
            // Out-of-context events run on this UI thread's Application.Run loop.
            // Raise only our child among siblings; never activate/reorder the shell.
            foregroundHook = SetWinEventHook(3, 3, IntPtr.Zero, onWindowEvent, 0, 0, 2);
            reorderHook = SetWinEventHook(0x8004, 0x8004, IntPtr.Zero, onWindowEvent, shellPid, 0, 2);
            Measure();
            Write(new { kind = "ready", shell = shell.ToInt64(), window = Handle.ToInt64() });
        }
        void Hide() { if (shown && Handle != IntPtr.Zero) ShowWindow(Handle, 0); shown = false; }
        static StringFormat TextFormat() {
            var format = (StringFormat)StringFormat.GenericTypographic.Clone();
            format.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces | StringFormatFlags.NoWrap;
            return format;
        }
        float RunWidth(Graphics graphics, TextRun run, Font font, StringFormat format) {
            return (run.gapBefore + run.gapAfter) * scale + (run.kind == "groupSeparator" ? scale : graphics.MeasureString(run.text ?? "", font, Int32.MaxValue, format).Width);
        }
        int MeasureWidth() {
            float width = 24 * scale;
            using (var image = new Bitmap(1, 1)) using (var graphics = Graphics.FromImage(image)) {
                graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                using (var format = TextFormat()) foreach (var run in content.runs ?? new TextRun[0]) using (var font = FontFor(run))
                    width += RunWidth(graphics, run, font, format);
            }
            return Math.Max(70, (int)Math.Ceiling(width));
        }
        void Measure() {
            int next = MeasureWidth();
            if (next != desiredWidth) { desiredWidth = next; Write(new { kind = "size", width = desiredWidth, height = (int)Math.Round(40 * scale) }); }
        }
        Font FontFor(TextRun run) {
            string family = run.kind == "label" ? "Microsoft YaHei UI" : run.kind == "value" ? "Segoe UI Semibold" : "Segoe UI";
            return new Font(family, (run.kind == "label" ? 12 : run.kind == "itemSeparator" ? 11 : 13) * scale, run.bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel);
        }
        Bitmap RenderBitmap(int width, int height) {
            var image = new Bitmap(width, height, PixelFormat.Format32bppPArgb);
            using (var graphics = Graphics.FromImage(image)) {
                graphics.Clear(Color.Transparent); graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                float inset = 3 * scale, radius = Math.Min(8 * scale, height / 2f - inset);
                using (var outline = new GraphicsPath()) {
                    var rect = new RectangleF(0.5f, inset, width - 1, height - inset * 2);
                    float d = Math.Max(1, radius * 2);
                    outline.AddArc(rect.Left, rect.Top, d, d, 180, 90); outline.AddArc(rect.Right-d, rect.Top, d, d, 270, 90);
                    outline.AddArc(rect.Right-d, rect.Bottom-d, d, d, 0, 90); outline.AddArc(rect.Left, rect.Bottom-d, d, d, 90, 90); outline.CloseFigure();
                    using (var background = new SolidBrush(content.dark ? Color.FromArgb(230, 28, 33, 40) : Color.FromArgb(235, 244, 247, 250))) graphics.FillPath(background, outline);
                    using (var border = new Pen(content.dark ? Color.FromArgb(30, 255, 255, 255) : Color.FromArgb(24, 0, 0, 0))) graphics.DrawPath(border, outline);
                }
                float x = 12 * scale;
                using (var format = TextFormat()) foreach (var run in content.runs ?? new TextRun[0]) using (var font = FontFor(run)) {
                    Color color; try { color = ColorTranslator.FromHtml(run.color); } catch { color = content.dark ? Color.White : Color.Black; }
                    float advance = RunWidth(graphics, run, font, format);
                    x += run.gapBefore * scale;
                    if (run.kind == "groupSeparator") {
                        using (var pen = new Pen(color, scale)) graphics.DrawLine(pen, x, height / 2f - 7 * scale, x, height / 2f + 7 * scale);
                    } else {
                        using (var brush = new SolidBrush(color)) graphics.DrawString(run.text ?? "", font, brush, x, (height - font.GetHeight(graphics)) / 2f, format);
                    }
                    x += advance - run.gapBefore * scale;
                }
            }
            return image;
        }
        public void ExportPreview(Command command, string file, float dpiScale) {
            content = command; scale = dpiScale;
            using (var image = RenderBitmap(MeasureWidth(), (int)Math.Round(40 * scale))) image.Save(file, ImageFormat.Png);
        }
        void Paint() {
            if (placement == null || placement.shell != shell.ToInt64() || !IsWindowVisible(shell)) { Hide(); return; }
            RECT bar; if (!GetWindowRect(shell, out bar)) { Hide(); return; }
            int width = Math.Max(1, Math.Min(placement.width, bar.right - bar.left));
            int height = Math.Max(1, Math.Min(placement.height, bar.bottom - bar.top));
            // Never accept a placement outside this taskbar (stale display/Explorer).
            if (placement.x < bar.left || placement.x + width > bar.right || placement.y < bar.top || placement.y + height > bar.bottom) { Hide(); return; }
            using (var image = RenderBitmap(width, height)) {
                IntPtr screen = GetDC(IntPtr.Zero), memory = CreateCompatibleDC(screen), bitmap = image.GetHbitmap(Color.FromArgb(0)), previous = SelectObject(memory, bitmap);
                try {
                    var destination = new POINT(placement.x - bar.left, placement.y - bar.top); var origin = new POINT(0, 0); var size = new SIZE(width, height);
                    var blend = new BLEND { op = 0, alpha = 255, format = 1 };
                    if (!UpdateLayeredWindow(Handle, screen, ref destination, ref size, memory, ref origin, 0, ref blend, 2)) {
                        Write(new { kind = "error", code = Marshal.GetLastWin32Error() }); return;
                    }
                    if (!shown) { ShowWindow(Handle, 4); shown = true; }
                    EnsureFront();
                } finally { SelectObject(memory, previous); DeleteObject(bitmap); DeleteDC(memory); ReleaseDC(IntPtr.Zero, screen); }
            }
        }
        protected override void WndProc(ref Message message) {
            if (message.Msg == 0x8001) {
                bool measure = false;
                lock (queueLock) {
                    if (pendingContent != null) { content = pendingContent; pendingContent = null; measure = true; }
                    if (pendingPlacement != null) { placement = pendingPlacement; pendingPlacement = null; }
                    if (pendingHide) { placement = null; pendingHide = false; }
                }
                if (measure) Measure(); Paint(); return;
            }
            if (message.Msg == 0x84) { message.Result = new IntPtr(-1); return; }
            if (message.Msg == 0x21) { message.Result = new IntPtr(3); return; }
            base.WndProc(ref message);
        }
        public void Dispose() { ReleaseHooks(); Hide(); if (Handle != IntPtr.Zero) DestroyHandle(); GC.KeepAlive(onWindowEvent); }
    }
    internal static void Preview(string[] args) {
        var command = Json.Deserialize<Command>(File.ReadAllText(args[1], System.Text.Encoding.UTF8));
        float dpiScale = args.Length > 3 ? Single.Parse(args[3], System.Globalization.CultureInfo.InvariantCulture) : 1;
        using (var host = new HostWindow()) host.ExportPreview(command, args[2], dpiScale);
    }
    internal static void Run(string[] args) {
        int parentId; if (args.Length < 2 || !Int32.TryParse(args[1], out parentId)) return;
        using (var host = new HostWindow()) using (var timer = new System.Windows.Forms.Timer()) {
            var parent = Process.GetProcessById(parentId); host.Maintain();
            var input = new Thread(() => {
                var inputJson = new JavaScriptSerializer();
                try { string line; while ((line = Console.ReadLine()) != null) { var command = inputJson.Deserialize<Command>(line); if (command == null) continue; if (command.kind == "quit") break; host.Receive(command); } }
                catch (IOException) {} catch (ArgumentException error) { Write(new { kind = "error", message = error.Message }); }
                Application.Exit();
            }); input.IsBackground = true; input.Start();
            timer.Interval = 1000; timer.Tick += (sender, eventArgs) => { if (parent.HasExited) Application.Exit(); else host.Maintain(); };
            timer.Start(); Application.Run(); parent.Dispose();
        }
    }
}
