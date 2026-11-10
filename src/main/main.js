import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, screen, shell, Tray } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config-store.js';
import { HistoryStore } from './history-store.js';
import { MonitorService } from './monitor-service.js';
import { UpdateService } from './update-service.js';
import { createUpdateFetcher } from './update-network.js';
import { TaskbarMonitor } from './taskbar-monitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererPath = path.join(__dirname, '..', 'renderer');
const preloadPath = path.join(__dirname, 'preload.cjs');

let mainWindow;
let overlayWindow;
let taskbarMonitor;
let overlayTopmostTimer;
let overlayTaskbarTimer;
let updateWindow;
let updateService;
let tray;
let appIcon = nativeImage.createEmpty();
let isQuitting = false;
let configStore;
let config;
let monitorService;
let positionSaveTimer;
let shouldPersistManualOverlayMove = false;
let hasManualOverlayPosition = false;
let historyStore;
let configWriteQueue = Promise.resolve();

// Compose drafts only when their turn starts, so history and monitor settings
// cannot overwrite each other with an older snapshot or race on the same temp file.
const updateConfig = (makeDraft) => {
  const write = async () => {
    config = await configStore.save(makeDraft(config));
    return config;
  };
  const pending = configWriteQueue.then(write, write);
  configWriteQueue = pending.catch(() => {});
  return pending;
};

const PAWNIO_SETUP_SHA256 = 'a3a46226c5e2824f4cdd42be0eecbabfc672c86f7889710f5ab1e6ad385b47a0';
const AUTO_START_ARGUMENT = '--monitor-tool-autostart';
const PROJECT_REPOSITORY_URL = 'https://github.com/CarlCloud-dev/Monitor-tool';
const APPROVED_EXTERNAL_LINKS = new Set([
  PROJECT_REPOSITORY_URL,
  'https://www.carl.top',
  'https://www.carl.top/tip'
]);
const quotePowerShell = (value) => `'${String(value).replace(/'/g, "''")}'`;

const openApprovedExternalLink = (value) => {
  try {
    const url = new URL(value);
    if (!APPROVED_EXTERNAL_LINKS.has(url.href.replace(/\/+$/, ''))) return false;
    void shell.openExternal(url.href).catch((error) => console.warn('Unable to open project link:', error.message));
    return true;
  } catch {
    return false;
  }
};

const loginItemArguments = () => app.isPackaged
  ? [AUTO_START_ARGUMENT]
  : [app.getAppPath(), AUTO_START_ARGUMENT];

const syncLaunchAtLogin = (enabled) => {
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings({
    openAtLogin: enabled === true,
    path: process.execPath,
    args: loginItemArguments()
  });
};

// The launch marker describes this run, even if a stale Windows startup entry
// launched after the user had already disabled startup in their saved settings.
const startedAtLogin = () => process.argv.includes(AUTO_START_ARGUMENT);

const titleBarPalette = (theme = config?.theme ?? 'system') => {
  const light = theme === 'light' || (theme === 'system' && !nativeTheme.shouldUseDarkColors);
  return light
    ? { color: '#e2e9e3', symbolColor: '#142218', height: 42 }
    : { color: '#181e22', symbolColor: '#eff5f0', height: 42 };
};

const applyMainWindowTheme = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const palette = titleBarPalette();
  mainWindow.setBackgroundColor(palette.color);
  mainWindow.setTitleBarOverlay(palette);
};

const loadAppIcon = async () => {
  const rasterPath = path.join(rendererPath, 'assets', 'logo-mark-256.png');
  const icoPath = path.join(rendererPath, 'assets', 'logo-mark.ico');
  const rasterIcon = nativeImage.createFromPath(rasterPath);
  if (!rasterIcon.isEmpty()) return rasterIcon;
  const icoIcon = nativeImage.createFromPath(icoPath);
  return icoIcon.isEmpty() ? nativeImage.createEmpty() : icoIcon;
};

const showMainWindow = () => {
  monitorService?.setLightweightMode(false);
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

const syncMonitoringMode = () => {
  const mainIsActive = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized();
  monitorService?.setLightweightMode(config?.behavior?.lightweightMode !== false && !mainIsActive);
};

const updateTrayMenu = () => {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开监控面板', click: showMainWindow },
    {
      label: '显示桌面浮窗',
      type: 'checkbox',
      checked: config?.overlay?.visible === true,
      click: () => {
        void persistConfig({
          ...config,
          overlay: { ...config.overlay, visible: !config.overlay.visible }
        });
      }
    },
    {
      label: '显示任务栏监控',
      type: 'checkbox',
      checked: config?.taskbar?.visible === true,
      click: () => {
        void persistConfig({
          ...config,
          taskbar: { ...config.taskbar, visible: !config.taskbar.visible }
        });
      }
    },
    { type: 'separator' },
    { label: '退出 Monitor Tool', click: () => app.quit() }
  ]));
};

const createTray = () => {
  if (tray && !tray.isDestroyed()) return;
  const trayIcon = appIcon.resize({ width: 32, height: 32 });
  tray = new Tray(trayIcon.isEmpty() ? appIcon : trayIcon);
  tray.setToolTip('Monitor Tool · 硬件状态监控');
  updateTrayMenu();
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
};

const lhmRuntimeDirectory = () => app.isPackaged
  ? path.join(process.resourcesPath, 'lhm')
  : path.join(app.getAppPath(), 'resources', 'lhm');

const installPawnIo = async () => {
  const installerPath = path.join(lhmRuntimeDirectory(), 'PawnIO_setup.exe');
  let installerBytes;
  try {
    installerBytes = await readFile(installerPath);
  } catch {
    throw new Error('未找到内置的 PawnIO 安装组件。');
  }

  const checksum = createHash('sha256').update(installerBytes).digest('hex');
  if (checksum !== PAWNIO_SETUP_SHA256) {
    throw new Error('内置驱动安装组件校验失败，已取消安装。');
  }

  await new Promise((resolve, reject) => {
    const command = `$process = Start-Process -FilePath ${quotePowerShell(installerPath)} -ArgumentList '-install' -Verb RunAs -Wait -PassThru; exit $process.ExitCode`;
    const launcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let errorText = '';
    launcher.stderr.setEncoding('utf8');
    launcher.stderr.on('data', (chunk) => { errorText = `${errorText}${chunk}`.slice(-700); });
    launcher.once('error', (error) => reject(error));
    launcher.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorText.trim() || '驱动安装已取消或未完成。'));
    });
  });

  monitorService.restartLhmBridge();
  return { message: '驱动安装器已完成，正在重新连接硬件传感器…' };
};

const overlayEdgeGutterFor = (overlay) => overlay.mode === 'top' ? 2 : 0;

const overlayWidthFor = (overlay) => {
  const selectedCount = Math.max(1, overlay.metrics?.length ?? 1);
  const detailedColumns = Math.min(selectedCount, 12);
  const baseWidth = overlay.mode === 'side'
    ? overlay.sideColumns === 2 ? 400 : 230
    : overlay.topStyle === 'detailed' ? detailedColumns * 118 + 10 : 1_800;
  return Math.round(baseWidth * overlay.scale) + overlayEdgeGutterFor(overlay);
};

const overlayInitialHeightFor = (overlay) => {
  const baseHeight = overlay.mode === 'side'
    ? overlay.sideColumns === 2 ? 270 : 420
    : overlay.topStyle === 'detailed' ? 82 : 48;
  return Math.round(baseHeight * overlay.scale);
};

const defaultOverlayPosition = (overlay, overlayWidth, overlayHeight) => {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;
  if (overlay.mode === 'side') {
    return {
      x: overlay.sidePosition === 'left' ? x : x + width - overlayWidth,
      y: y + Math.round((height - overlayHeight) / 2)
    };
  }
  return {
    x: x + Math.round((width - overlayWidth) / 2),
    y
  };
};

const initialOverlayBounds = () => {
  const overlayWidth = overlayWidthFor(config.overlay);
  const overlayHeight = overlayInitialHeightFor(config.overlay);
  const saved = config.overlay.bounds;
  const fallback = defaultOverlayPosition(config.overlay, overlayWidth, overlayHeight);
  return {
    x: saved?.x ?? fallback.x,
    y: saved?.y ?? fallback.y,
    width: overlayWidth,
    height: overlayHeight
  };
};

const resetOverlayShape = (width, height) => {
  if (!overlayWindow || overlayWindow.isDestroyed() || process.platform !== 'win32') return;
  try {
    // Chromium draws rounded corners with anti-aliasing; a rectangular native shape avoids stepped edges.
    overlayWindow.setShape([{ x: 0, y: 0, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }]);
  } catch (error) {
    console.warn(`Overlay shape update failed: ${error.message}`);
  }
};

const placeOverlay = (x, y) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const nextX = Math.round(x);
  const nextY = Math.round(y);
  const [currentX, currentY] = overlayWindow.getPosition();
  if (nextX !== currentX || nextY !== currentY) overlayWindow.setPosition(nextX, nextY, false);
};

const sendTo = (window, channel, payload) => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
};

const broadcastSettings = () => {
  sendTo(mainWindow, 'settings:changed', config);
  sendTo(overlayWindow, 'settings:changed', config);
  taskbarMonitor?.send('settings:changed', config);
  sendTo(updateWindow, 'settings:changed', config);
};

const showUpdateWindow = () => {
  if (isQuitting || !updateService) return;
  if (updateWindow && !updateWindow.isDestroyed()) {
    if (updateWindow.isMinimized()) updateWindow.restore();
    updateWindow.show();
    updateWindow.focus();
    return;
  }
  const parent = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized() ? mainWindow : undefined;
  updateWindow = new BrowserWindow({
    width: 520, height: Math.min(560, screen.getPrimaryDisplay().workAreaSize.height - 48),
    minWidth: 440, minHeight: 400, show: false, resizable: false, frame: false,
    title: 'Monitor Tool · 应用更新', icon: appIcon,
    backgroundColor: titleBarPalette().color,
    ...(parent ? { parent, modal: true } : {}),
    webPreferences: { preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  updateWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  updateWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  updateWindow.once('ready-to-show', () => updateWindow?.show());
  updateWindow.on('close', () => {
    if (!isQuitting) { updateService?.cancelDownload(); updateService?.cancelCheck(); }
  });
  updateWindow.on('closed', () => { updateWindow = null; });
  updateWindow.loadFile(path.join(rendererPath, 'update', 'index.html'));
};

const restoreOverlayTaskbar = () => {
  if (process.platform !== 'win32' || isQuitting || !overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
  // Explorer can recreate buttons for unowned windows after it restarts.
  // Electron's Windows implementation uses ITaskbarList::DeleteTab each time.
  overlayWindow.setSkipTaskbar(true);
};

const syncOverlayTaskbar = () => {
  clearInterval(overlayTaskbarTimer);
  overlayTaskbarTimer = null;
  if (process.platform !== 'win32' || isQuitting || !overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
  restoreOverlayTaskbar();
  overlayTaskbarTimer = setInterval(restoreOverlayTaskbar, 15000);
  overlayTaskbarTimer.unref();
};

const restoreOverlayTopmost = () => {
  if (isQuitting || !config?.overlay.visible || !config.overlay.alwaysOnTop || !overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible() || overlayWindow.isMinimized()) return;
  // A competing topmost window can cover us even while isAlwaysOnTop() is true.
  // Reassert the native level and z-order without activating/focusing the window.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.moveTop();
};

const syncOverlayTopmost = () => {
  clearInterval(overlayTopmostTimer);
  overlayTopmostTimer = null;
  if (isQuitting || !config?.overlay.visible || !config.overlay.alwaysOnTop || !overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
  restoreOverlayTopmost();
  // Native calls only: no foreground-process polling or renderer refresh.
  overlayTopmostTimer = setInterval(restoreOverlayTopmost, 3000);
  overlayTopmostTimer.unref();
};

const applyOverlayConfiguration = () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const { overlay } = config;
  overlayWindow.setAlwaysOnTop(overlay.alwaysOnTop, 'screen-saver');
  // Background alpha is rendered in CSS; native opacity would fade text too.
  overlayWindow.setOpacity(1);
  overlayWindow.setIgnoreMouseEvents(overlay.locked, { forward: true });
  overlayWindow.setContentSize(overlayWidthFor(overlay), overlayWindow.getContentBounds().height);
  const contentBounds = overlayWindow.getContentBounds();
  resetOverlayShape(contentBounds.width, contentBounds.height);
  if (overlay.visible) overlayWindow.showInactive();
  else overlayWindow.hide();
  syncOverlayTopmost();
  syncOverlayTaskbar();
};

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 1000,
    minHeight: 680,
    show: true,
    title: 'Monitor Tool',
    icon: appIcon,
    backgroundColor: titleBarPalette().color,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarPalette(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`Main window failed to load (${errorCode}): ${errorDescription}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    historyStore?.setCacheActive(false);
    console.error(`Main renderer stopped: ${details.reason}`);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openApprovedExternalLink(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file:')) return;
    event.preventDefault();
    openApprovedExternalLink(url);
  });
  mainWindow.on('close', (event) => {
    historyStore?.setCacheActive(false);
    if (!isQuitting && config?.behavior?.minimizeToTray) {
      event.preventDefault();
      if (config.behavior.lightweightMode !== false) {
        // 主界面只在设置/历史曲线需要时存在；浮窗、托盘和采集服务继续运行。
        mainWindow.destroy();
        monitorService?.setLightweightMode(true);
      } else {
        mainWindow.hide();
      }
    }
  });
  mainWindow.on('closed', () => {
    historyStore?.setCacheActive(false);
    mainWindow = null;
    syncMonitoringMode();
  });
  mainWindow.on('hide', () => {
    historyStore?.setCacheActive(false);
    syncMonitoringMode();
  });
  mainWindow.on('minimize', () => {
    historyStore?.setCacheActive(false);
    syncMonitoringMode();
  });
  mainWindow.on('restore', syncMonitoringMode);
  mainWindow.on('show', syncMonitoringMode);
  mainWindow.loadFile(path.join(rendererPath, 'main', 'index.html'));
};

const createOverlayWindow = () => {
  overlayWindow = new BrowserWindow({
    ...initialOverlayBounds(),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    useContentSize: true,
    alwaysOnTop: config.overlay.alwaysOnTop,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.on('show', syncOverlayTopmost);
  overlayWindow.on('hide', syncOverlayTopmost);
  overlayWindow.on('show', syncOverlayTaskbar);
  overlayWindow.on('hide', syncOverlayTaskbar);
  overlayWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      restoreOverlayTaskbar();
    }
  });
  overlayWindow.on('closed', () => {
    clearInterval(overlayTopmostTimer);
    overlayTopmostTimer = null;
    clearInterval(overlayTaskbarTimer);
    overlayTaskbarTimer = null;
  });
  overlayWindow.loadFile(path.join(rendererPath, 'overlay', 'index.html'));
  overlayWindow.once('ready-to-show', () => {
    applyOverlayConfiguration();
    sendTo(overlayWindow, 'monitor:update', monitorService.getSnapshot());
    sendTo(overlayWindow, 'settings:changed', config);
  });

  overlayWindow.on('will-move', () => {
    hasManualOverlayPosition = true;
    shouldPersistManualOverlayMove = true;
  });

  overlayWindow.on('move', () => {
    if (!shouldPersistManualOverlayMove) return;
    clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(async () => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      const [savedX, savedY] = overlayWindow.getPosition();
      await updateConfig((current) => ({ ...current, overlay: { ...current.overlay, bounds: { x: savedX, y: savedY } } }));
      shouldPersistManualOverlayMove = false;
      broadcastSettings();
    }, 450);
  });
};

const persistConfig = async (draft) => {
  // 历史记录由独立页面保存，实时监控设置不能覆盖它的开关和保留时长。
  await updateConfig((current) => ({ ...draft, history: current.history }));
  try {
    syncLaunchAtLogin(config.behavior.launchAtLogin);
  } catch (error) {
    // The setting is retained; Windows can block registry edits through policy.
    console.warn('Unable to update Windows startup registration:', error.message);
  }
  hasManualOverlayPosition = Boolean(config.overlay.bounds);
  nativeTheme.themeSource = config.theme;
  applyMainWindowTheme();
  if (updateWindow && !updateWindow.isDestroyed()) updateWindow.setBackgroundColor(titleBarPalette().color);
  if (config.updates.checkOnStartup === false) updateService?.disablePendingStartupCheck();
  monitorService.setRefreshInterval(config.refreshMs);
  monitorService.setLhmEnabled(config.sensors.lhmEnabled);
  monitorService.setLhmMode(config.sensors.lhmMode);
  monitorService.setNetworkUnit(config.network.unit);
  monitorService.setSelectedMetrics(config.overlay.metrics);
  monitorService.setOverlayVisible(config.overlay.visible || config.taskbar.visible);
  monitorService.setHistorySettings(config.history);
  monitorService.setAlertPolicy(config.alerts);
  historyStore.setSettings(config.history);
  syncMonitoringMode();
  applyOverlayConfiguration();
  taskbarMonitor?.update(config);
  broadcastSettings();
  updateTrayMenu();
  return config;
};

const registerIpc = () => {
  const trustedUpdateSender = (event) => [mainWindow, updateWindow].some((window) => window && !window.isDestroyed() && window.webContents === event.sender);
  const updateAction = (action) => async (event) => {
    if (!trustedUpdateSender(event)) throw new Error('无效的更新请求');
    return action();
  };
  ipcMain.handle('updates:get-state', updateAction(() => updateService.getState()));
  ipcMain.handle('updates:check', updateAction(() => updateService.check()));
  ipcMain.handle('updates:show', updateAction(() => { showUpdateWindow(); return updateService.getState(); }));
  ipcMain.handle('updates:download', updateAction(() => updateService.downloadAndInstall()));
  ipcMain.handle('updates:cancel', updateAction(() => { updateService.cancelDownload(); return updateService.getState(); }));
  ipcMain.handle('updates:manual-download', updateAction(() => updateService.manualDownload()));
  ipcMain.on('updates:close', (event) => { if (updateWindow?.webContents === event.sender) updateWindow.close(); });
  ipcMain.handle('monitor:get-snapshot', () => monitorService.getSnapshot());
  ipcMain.handle('settings:get', () => config);
  ipcMain.handle('settings:save', (_event, draft) => persistConfig(draft));
  ipcMain.on('history:active', (event, active) => {
    if (event.sender === mainWindow?.webContents) {
      historyStore.setCacheActive(active === true && mainWindow.isVisible());
    }
  });
  ipcMain.handle('history:get', (_event, query) => historyStore.getView(query));
  ipcMain.handle('history:save-settings', async (_event, draft) => {
    await updateConfig((current) => ({ ...current, history: draft }));
    historyStore.setSettings(config.history);
    monitorService.setHistorySettings(config.history);
    sendTo(mainWindow, 'history:settings-changed', historyStore.getSettings());
    // Saving settings does not wait for reading/parsing the history files.
    return historyStore.getSettings();
  });
  ipcMain.handle('history:clear', async () => {
    await historyStore.clear();
    sendTo(mainWindow, 'history:changed', null);
    return { cleared: true };
  });
  ipcMain.handle('support:install-pawnio', () => installPawnIo());
  ipcMain.handle('overlay:reset-position', async () => {
    const next = await persistConfig({ ...config, overlay: { ...config.overlay, bounds: null } });
    const bounds = initialOverlayBounds();
    hasManualOverlayPosition = false;
    placeOverlay(bounds.x, bounds.y);
    return next;
  });
  ipcMain.on('overlay:resize', (_event, size) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const requestedWidth = Number(size?.width);
    const requestedHeight = Number(size?.height);
    const maxWidth = config.overlay.mode === 'top'
      ? 1_800 + overlayEdgeGutterFor(config.overlay)
      : Math.round(400 * config.overlay.scale);
    const safeWidth = Math.max(1, Math.min(maxWidth, Math.round(requestedWidth || overlayWidthFor(config.overlay))));
    const safeHeight = Math.max(1, Math.min(800, Math.round(requestedHeight || overlayInitialHeightFor(config.overlay))));
    const bounds = overlayWindow.getContentBounds();
    if (bounds.width !== safeWidth || bounds.height !== safeHeight) {
      overlayWindow.setContentSize(safeWidth, safeHeight);
      resetOverlayShape(safeWidth, safeHeight);
    }
    if (!config.overlay.bounds && !hasManualOverlayPosition) {
      const position = defaultOverlayPosition(config.overlay, safeWidth, safeHeight);
      placeOverlay(position.x, position.y);
    }
  });
};

app.whenReady().then(async () => {
  app.setAppUserModelId('com.local.monitor-tool');
  configStore = new ConfigStore(app.getPath('userData'));
  config = await configStore.load();
  try {
    syncLaunchAtLogin(config.behavior.launchAtLogin);
  } catch (error) {
    console.warn('Unable to synchronize Windows startup registration:', error.message);
  }
  historyStore = new HistoryStore(app.getPath('userData'), config.history);
  void historyStore.prune();
  appIcon = await loadAppIcon();
  createTray();
  hasManualOverlayPosition = Boolean(config.overlay.bounds);
  nativeTheme.themeSource = config.theme;
  nativeTheme.on('updated', () => {
    if (config?.theme === 'system') {
      applyMainWindowTheme();
      if (updateWindow && !updateWindow.isDestroyed()) updateWindow.setBackgroundColor(titleBarPalette().color);
    }
  });
  updateService = new UpdateService({
    version: app.getVersion(), isPackaged: app.isPackaged,
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR),
    cacheDirectory: path.join(app.getPath('temp'), 'MonitorTool-updates'),
    fetcher: createUpdateFetcher(),
    openExternal: (url) => shell.openExternal(url), quit: () => app.quit()
  });
  updateService.on('change', (state) => {
    sendTo(mainWindow, 'updates:state', state);
    sendTo(updateWindow, 'updates:state', state);
  });
  updateService.on('diagnostic', (entry) => {
    void appendFile(path.join(app.getPath('userData'), 'update-diagnostics.jsonl'), JSON.stringify(entry) + '\n', 'utf8').catch(() => {});
  });
  updateService.on('available', showUpdateWindow);
  monitorService = new MonitorService({
    refreshMs: config.refreshMs,
    lhmEnabled: config.sensors.lhmEnabled,
    lhmMode: config.sensors.lhmMode,
    networkUnit: config.network.unit,
    alerts: config.alerts,
    lhmDirectory: lhmRuntimeDirectory(),
    selectedMetrics: config.overlay.metrics,
    overlayVisible: config.overlay.visible || config.taskbar.visible,
    historyEnabled: config.history.enabled,
    historyMetrics: config.history.metricIds
  });
  monitorService.setSelectedMetrics(config.overlay.metrics);
  monitorService.setHistorySettings(config.history);
  monitorService.on('snapshot', (snapshot) => {
    if (mainWindow?.isVisible() && !mainWindow.isMinimized()) sendTo(mainWindow, 'monitor:update', snapshot);
    if (overlayWindow?.isVisible()) sendTo(overlayWindow, 'monitor:update', { ...snapshot, history: [] });
    taskbarMonitor?.send('monitor:update', { ...snapshot, history: [] });
    void historyStore.recordSnapshot(snapshot).then((recorded) => {
      if (recorded && mainWindow?.isVisible() && !mainWindow.isMinimized()) sendTo(mainWindow, 'history:changed', null);
    });
  });
  monitorService.on('error', (error) => {
    console.warn('Monitor sampling failed:', error.message);
  });
  monitorService.on('alert', (alert) => {
    if (!config.alerts.enabled || !Notification.isSupported()) return;
    new Notification({
      title: 'Monitor · 温度提醒',
      body: `${alert.label} ${alert.value.toFixed(0)}°C，已超过 ${alert.threshold}°C 阈值。`
    }).show();
  });

  registerIpc();
  // A login launch stays lightweight: overlay and tray are ready, while the
  // main panel is created on demand from the tray.
  if (!startedAtLogin()) createMainWindow();
  createOverlayWindow();
  const taskbarProbeSource = await readFile(path.join(__dirname, '..', 'taskbar', 'TaskbarProbe.cs'));
  const taskbarHostSource = await readFile(path.join(__dirname, '..', 'taskbar', 'TaskbarHost.cs'));
  const taskbarManifest = await readFile(path.join(__dirname, '..', 'taskbar', 'TaskbarProbe.manifest'));
  const taskbarProbeName = `TaskbarProbe-${createHash('sha256').update(taskbarProbeSource).update(taskbarHostSource).update(taskbarManifest).digest('hex').slice(0, 16)}.exe`;
  taskbarMonitor = new TaskbarMonitor({
    probe: app.isPackaged ? path.join(process.resourcesPath, 'taskbar', 'TaskbarProbe.exe') : path.join(__dirname, '..', '..', 'resources', 'taskbar', taskbarProbeName),
    snapshot: () => monitorService.getSnapshot()
  });
  taskbarMonitor.update(config);
  powerMonitor.on('resume', restoreOverlayTopmost);
  powerMonitor.on('unlock-screen', restoreOverlayTopmost);
  powerMonitor.on('resume', restoreOverlayTaskbar);
  powerMonitor.on('unlock-screen', restoreOverlayTaskbar);
  screen.on('display-metrics-changed', restoreOverlayTopmost);
  screen.on('display-metrics-changed', restoreOverlayTaskbar);
  syncMonitoringMode();
  monitorService.start();
  updateService.scheduleStartupCheck(config.updates.checkOnStartup);

  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && (isQuitting || !config?.behavior?.minimizeToTray)) app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  clearInterval(overlayTopmostTimer);
  clearInterval(overlayTaskbarTimer);
  taskbarMonitor?.stop();
  historyStore?.setCacheActive(false);
  tray?.destroy();
  monitorService?.stop();
  updateService?.stop();
});
