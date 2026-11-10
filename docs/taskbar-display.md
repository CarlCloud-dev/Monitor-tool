# Windows 11 任务栏显示

任务栏监控采用独立原生子窗口绘制。Electron 主进程将选中的指标、格式化文字、主题颜色和告警颜色发给 `TaskbarProbe.exe --host <main-pid>`；主窗口和桌面浮窗继续使用 Electron。

## 原生绘制

`TaskbarHost.cs` 在自己的进程和 UI 线程中创建 `WS_CHILD | WS_EX_LAYERED` 窗口，创建时父窗口即为 `Shell_TrayWnd`。窗口不激活、不接受鼠标输入。通过 GDI+ 生成预乘透明度位图，再用 `UpdateLayeredWindow` 一次提交文字、圆角底色和边框。

子窗口的目标位置使用相对父任务栏的物理像素坐标。主进程从探测器得到屏幕物理坐标，在绘制前减去任务栏原点，避免把任务栏的纵坐标重复加两次。窗口创建线程先匹配任务栏的 DPI awareness context，字体、间距和高度按任务栏 DPI 缩放。资源 manifest 声明 Windows 10 兼容性，这是分层子窗口正常创建所需的兼容性声明。

原生显示不调用跨进程 SetParent，不把 Electron 窗口改成 Explorer 子窗口，也不修改 Explorer 的代码、窗口过程或样式。显示时将自己的子窗口放在同级任务栏内容窗口之前；通过当前 UI 消息循环接收进程外前台切换和任务栏重排事件，仅在必要时调整自己的子窗口层级。任务栏不存在、布局明确不可用或用户关闭功能时隐藏/退出。父任务栏重建后由显示进程创建自己的新子窗口，并请求主进程重发内容和布局；此流程未通过故意重启用户 Explorer 来验收。

## 布局查询

不带参数的 `TaskbarProbe.exe` 仅查询主任务栏的几何、UI Automation 按钮区域和任务栏内的其他组件。它与显示进程分开，查询阻塞时可以只重启探测器。任务栏句柄及边界没变而控件树暂时为空时沿用最后有效布局；显式无任务栏时隐藏。探测器异常退出最多保留旧布局 8 秒，反复启动失败不会延长该期限。

只在内容或位置变化时向显示进程发消息，避免重复绘制。关闭任务栏显示时同时结束显示与探测两个辅助进程。

## 检查

```powershell
node scripts/build-taskbar-probe.cjs
node scripts/test-taskbar-layout.mjs
node scripts/test-taskbar-monitor.mjs
node scripts/test-taskbar-native.mjs
```

实际验证须分别覆盖鼠标点击开始按钮展开/收起、开始菜单展开后点击任务栏空白处收起，以及左/中/右位置、深浅主题、缩放和功能开关。源码回归测试覆盖探测与显示进程分离、探测器重启、连续重试的有限宽限期、无效消息、明确任务栏消失、显示进程重启、资源清理和文字颜色格式。

2026-11-10 本机验证：最终原生测试条位于任务栏内容层前方。用户使用鼠标重复开始按钮展开/收起，以及展开后点击任务栏空白处收起，确认可见、没有再闪烁或消失。真实辅助进程测试另外覆盖 UTF-8 中文、缺测横杠、温度、GB 和网络箭头的消息解析与宽度计算；此验证不等于所有 Windows 11 版本、多屏、DPI 和主题组合均已验收。

参考：[TrafficMonitor 的原生任务栏窗口](https://github.com/zhongyang219/TrafficMonitor/blob/master/TrafficMonitor/TaskBarDlg.cpp)、[Windows 子窗口及分层窗口](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features)、[跨进程 SetParent 的 DPI 行为](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent)。代码按本项目需求编写，未复制 TrafficMonitor 的实现。
