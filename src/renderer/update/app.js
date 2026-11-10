import { UpdateView } from '../shared/update-ui.js';

const view = new UpdateView(document.querySelector('#update-dialog'));
const applyTheme = (config) => { document.documentElement.dataset.theme = config?.theme ?? 'system'; };
window.monitorApi.onSettingsChanged(applyTheme);
window.monitorApi.getSettings().then(applyTheme).catch(() => {});
void view.init();
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && view.state?.status !== 'installing') window.monitorApi.closeUpdateDialog();
});
