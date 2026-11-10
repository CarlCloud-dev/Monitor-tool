const { monitorApi } = window;
const busyStatuses = new Set(['checking', 'downloading', 'verifying', 'installing']);
const sizeLabel = (bytes) => Number.isFinite(bytes) && bytes > 0 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : '';

export class UpdateView {
  constructor(root) {
    this.root = root;
    this.popup = root.dataset.updateVariant === 'dialog';
    this.state = null;
    this.actionBusy = false;
    this.root.addEventListener('click', (event) => { void this.handleClick(event); });
    this.unsubscribe = monitorApi.onUpdateState((state) => this.render(state));
  }

  text(selector, value) {
    for (const node of this.root.querySelectorAll(selector)) if (node.textContent !== value) node.textContent = value;
  }

  async init() {
    try { this.render(await monitorApi.getUpdateState()); }
    catch { this.text('[data-update-message]', '暂时无法读取版本信息，请重新打开主界面'); }
  }

  render(state) {
    if (!state || this.state && state.revision < this.state.revision) return;
    this.state = state;
    const busy = busyStatuses.has(state.status);
    const downloading = ['downloading', 'verifying'].includes(state.status);
    this.root.dataset.updateStatus = state.status;
    this.text('[data-update-current]', `v${state.currentVersion}`);
    this.text('[data-update-latest]', state.latest ? `v${state.latest.version}` : '等待发布');
    this.text('[data-update-message]', state.message);
    const modes = { installed: '安装版', portable: '便携版', development: '开发环境' };
    this.text('[data-update-mode]', `${modes[state.mode] ?? ''} · ${state.arch ?? 'x64'}`);
    this.text('[data-update-checked]', state.checkedAt ? `上次检查：${new Date(state.checkedAt).toLocaleString('zh-CN')}` : '启动时自动检查，也可随时手动检查');
    this.text('[data-update-notes]', state.latest?.notes || '此版本暂未填写更新说明。');
    this.text('[data-update-size]', state.latest?.size ? `安装包约 ${sizeLabel(state.latest.size)}` : 'Windows Setup 安装包');
    this.text('[data-update-guidance]', state.canInstall
      ? '点击“下载并安装”后，应用会下载并检查安装包，随后退出并启动安装器。'
      : state.mode === 'portable' ? '便携版不自动覆盖。此通道提供 Setup 安装包，也可从 GitHub 获取便携包。' : '开发环境请手动检查，不自动联网或执行安装；启动检查开关在打包后生效。');
    this.text('[data-update-source]', `更新来源：${state.source}`);
    const title = downloading ? '正在准备新版本' : state.status === 'installing' ? '即将完成更新' : state.updateAvailable ? '有新版本可用' : '应用更新';
    this.text('[data-update-title]', title);
    for (const button of this.root.querySelectorAll('[data-update-action="check"]')) {
      button.disabled = busy || this.actionBusy;
      button.textContent = state.status === 'checking' ? '正在检查…' : '检查更新';
    }
    for (const button of this.root.querySelectorAll('[data-update-action="show"]')) {
      button.hidden = !state.updateAvailable;
      button.disabled = state.status === 'installing';
      button.textContent = downloading ? '查看下载进度' : '查看更新';
    }
    const primary = this.root.querySelector('[data-update-primary]');
    if (primary) {
      primary.disabled = busy || this.actionBusy;
      primary.textContent = downloading ? (state.status === 'verifying' ? '正在检查…' : '正在下载…')
        : state.status === 'installing' ? '正在启动安装器…'
          : !state.updateAvailable ? '重新检查' : state.canInstall ? '下载并安装' : '手动下载';
    }
    const cancel = this.root.querySelector('[data-update-dismiss]');
    if (cancel) {
      cancel.dataset.updateAction = downloading ? 'cancel' : 'close';
      cancel.textContent = downloading ? '取消下载' : '暂不更新';
      cancel.disabled = state.status === 'installing';
    }
    for (const button of this.root.querySelectorAll('[data-update-action="manual"]')) {
      button.disabled = downloading || state.status === 'installing' || state.status === 'unpublished';
      button.title = state.status === 'unpublished' ? '更新通道暂无已发布安装包' : '';
      if (this.popup) button.hidden = !state.canInstall || !state.updateAvailable;
    }
    const progressWrap = this.root.querySelector('[data-update-progress-wrap]');
    if (progressWrap) {
      progressWrap.hidden = !downloading && state.status !== 'installing';
      const progress = progressWrap.querySelector('progress');
      if (Number.isFinite(state.percent)) progress.value = state.percent;
      else progress.removeAttribute('value');
      this.text('[data-update-progress-label]', state.status === 'verifying' ? '下载完成，正在检查安装包'
        : `${sizeLabel(state.downloadedBytes) || '0 MB'}${state.totalBytes ? ` / ${sizeLabel(state.totalBytes)}` : ''}${Number.isFinite(state.percent) ? ` · ${Math.floor(state.percent)}%` : ''}`);
    }
  }

  async handleClick(event) {
    const button = event.target.closest('button[data-update-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.updateAction;
    if (action === 'close') { monitorApi.closeUpdateDialog(); return; }
    if (action === 'cancel') {
      try { await monitorApi.cancelUpdateDownload(); }
      catch { this.text('[data-update-message]', '取消操作未完成，请关闭更新窗口'); }
      return;
    }
    if (this.actionBusy) return;
    this.actionBusy = true;
    this.render(this.state);
    try {
      if (action === 'check') this.render(await monitorApi.checkForUpdates());
      else if (action === 'show') this.render(await monitorApi.showUpdateDialog());
      else if (action === 'manual') this.render(await monitorApi.manualDownloadUpdate());
      else if (action === 'primary') {
        if (!this.state?.updateAvailable) this.render(await monitorApi.checkForUpdates());
        else if (this.state.canInstall) this.render(await monitorApi.downloadUpdate());
        else this.render(await monitorApi.manualDownloadUpdate());
      }
    } catch {
      this.text('[data-update-message]', '操作未能完成，请重试或选择手动下载');
    } finally {
      this.actionBusy = false;
      this.render(this.state);
    }
  }
}
