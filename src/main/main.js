import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, Tray } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config-store.js';
import { HistoryStore } from './history-store.js';
import { MonitorService } from './monitor-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererPath = path.join(__dirname, '..', 'renderer');
const preloadPath = path.join(__dirname, 'preload.cjs');

let mainWindow;
let overlayWindow;
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

const PAWNIO_SETUP_SHA256 = 'a3a46226c5e2824f4cdd42be0eecbabfc672c86f7889710f5ab1e6ad385b47a0';
const quotePowerShell = (value) => `'${String(value).replace(/'/g, "''")}'`;

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

const createTray = () => {
  if (tray && !tray.isDestroyed()) return;
  const trayIcon = appIcon.resize({ width: 32, height: 32 });
  tray = new Tray(trayIcon.isEmpty() ? appIcon : trayIcon);
  tray.setToolTip('Monitor Tool · 硬件状态监控');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开监控面板', click: showMainWindow },
    { type: 'separator' },
    { label: '退出 Monitor Tool', click: () => app.quit() }
  ]));
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
  overlayWindow.setPosition(Math.round(x), Math.round(y), false);
};

const sendTo = (window, channel, payload) => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
};

const broadcastSettings = () => {
  sendTo(mainWindow, 'settings:changed', config);
  sendTo(overlayWindow, 'settings:changed', config);
};

const applyOverlayConfiguration = () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const { overlay } = config;
  overlayWindow.setAlwaysOnTop(overlay.alwaysOnTop, 'floating');
  overlayWindow.setOpacity(overlay.opacity);
  overlayWindow.setIgnoreMouseEvents(overlay.locked, { forward: true });
  overlayWindow.setContentSize(overlayWidthFor(overlay), overlayWindow.getContentBounds().height);
  const contentBounds = overlayWindow.getContentBounds();
  resetOverlayShape(contentBounds.width, contentBounds.height);
  if (overlay.visible) overlayWindow.showInactive();
  else overlayWindow.hide();
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
    console.error(`Main renderer stopped: ${details.reason}`);
  });
  mainWindow.on('close', (event) => {
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
    mainWindow = null;
  });
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
      config = await configStore.save({ ...config, overlay: { ...config.overlay, bounds: { x: savedX, y: savedY } } });
      shouldPersistManualOverlayMove = false;
      broadcastSettings();
    }, 450);
  });
};

const persistConfig = async (draft) => {
  // 历史记录由独立页面保存，实时监控设置不能覆盖它的开关和保留时长。
  config = await configStore.save({ ...draft, history: config.history });
  hasManualOverlayPosition = Boolean(config.overlay.bounds);
  nativeTheme.themeSource = config.theme;
  applyMainWindowTheme();
  monitorService.setRefreshInterval(config.refreshMs);
  monitorService.setLhmEnabled(config.sensors.lhmEnabled);
  monitorService.setLhmMode(config.sensors.lhmMode);
  monitorService.setNetworkUnit(config.network.unit);
  monitorService.setSelectedMetrics(config.overlay.metrics);
  monitorService.setHistorySettings(config.history);
  monitorService.setAlertPolicy(config.alerts);
  historyStore.setSettings(config.history);
  applyOverlayConfiguration();
  broadcastSettings();
  return config;
};

const registerIpc = () => {
  ipcMain.handle('monitor:get-snapshot', () => monitorService.getSnapshot());
  ipcMain.handle('settings:get', () => config);
  ipcMain.handle('settings:save', (_event, draft) => persistConfig(draft));
  ipcMain.handle('history:get', () => historyStore.getView());
  ipcMain.handle('history:save-settings', async (_event, draft) => {
    config = await configStore.save({ ...config, history: draft });
    historyStore.setSettings(config.history);
    monitorService.setHistorySettings(config.history);
    sendTo(mainWindow, 'history:settings-changed', historyStore.getSettings());
    return historyStore.getView();
  });
  ipcMain.handle('history:clear', async () => {
    await historyStore.clear();
    sendTo(mainWindow, 'history:changed', null);
    return historyStore.getView();
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
    overlayWindow.setContentSize(safeWidth, safeHeight);
    resetOverlayShape(safeWidth, safeHeight);
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
  historyStore = new HistoryStore(app.getPath('userData'), config.history);
  void historyStore.prune();
  appIcon = await loadAppIcon();
  createTray();
  hasManualOverlayPosition = Boolean(config.overlay.bounds);
  nativeTheme.themeSource = config.theme;
  nativeTheme.on('updated', () => {
    if (config?.theme === 'system') applyMainWindowTheme();
  });
  monitorService = new MonitorService({
    refreshMs: config.refreshMs,
    lhmEnabled: config.sensors.lhmEnabled,
    lhmMode: config.sensors.lhmMode,
    networkUnit: config.network.unit,
    alerts: config.alerts,
    lhmDirectory: lhmRuntimeDirectory(),
    selectedMetrics: config.overlay.metrics,
    historyEnabled: config.history.enabled,
    historyMetrics: config.history.metricIds
  });
  monitorService.setSelectedMetrics(config.overlay.metrics);
  monitorService.setHistorySettings(config.history);
  monitorService.on('snapshot', (snapshot) => {
    sendTo(mainWindow, 'monitor:update', snapshot);
    sendTo(overlayWindow, 'monitor:update', snapshot);
    void historyStore.recordSnapshot(snapshot).then((recorded) => {
      if (recorded) sendTo(mainWindow, 'history:changed', null);
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
  createMainWindow();
  createOverlayWindow();
  monitorService.start();

  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && (isQuitting || !config?.behavior?.minimizeToTray)) app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  tray?.destroy();
  monitorService?.stop();
});
