// === popup.js ===
const $ = (sel) => document.querySelector(sel);

const STORAGE_KEYS = {
  all: 'udemyAll',
  unanswered: 'udemyPureUnanswered',
  needsHelp: 'udemyNeedsHelp',
  updatedAt: 'udemyLastUpdated',
  scanStatus: 'udemyScanStatus'
};

const SCAN_RUNNING = 'running';
const DASHBOARD_URL = chrome.runtime.getManifest().homepage_url || 'http://localhost:4200';

const toast = $('#toast');
const statAll = $('#stat-all');
const statPure = $('#stat-unanswered');
const statNeeds = $('#stat-needs');
const statUpd = $('#stat-upd');

const btnStop = $('#stop-scan');
const btnClear = $('#clear-storage');
const btnScanUnanswered = $('#scan-unanswered');
const btnScanNeedsHelp = $('#scan-needshelp');
const btnExportUnanswered = $('#export-unanswered');
const btnExportNeedsHelp = $('#export-needshelp');

const UI_STATE = {
  running: false,
  hasData: false
};

function applyUiState() {
  btnStop.disabled = !UI_STATE.running;
  btnClear.disabled = UI_STATE.running || !UI_STATE.hasData;
  btnScanUnanswered.disabled = UI_STATE.running;
  btnScanNeedsHelp.disabled = UI_STATE.running;
  btnExportUnanswered.disabled = UI_STATE.running || !UI_STATE.hasData;
  btnExportNeedsHelp.disabled = UI_STATE.running || !UI_STATE.hasData;
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function withActiveTab(fn) {
  const tab = await getActiveTab();
  if (!tab?.id) {
    throw new Error('No active tab found.');
  }

  return fn(tab);
}

function fmtTime(iso) {
  if (!iso) return '—';

  try {
    const d = new Date(iso);
    const Y = d.getFullYear();
    const M = String(d.getMonth() + 1).padStart(2, '0');
    const D = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${Y}-${M}-${D} ${h}:${m}`;
  } catch {
    return '—';
  }
}

function readRunningFromScanStatus(scanStatus) {
  return scanStatus?.status === SCAN_RUNNING;
}

async function refreshStats() {
  try {
    const {
      [STORAGE_KEYS.all]: udemyAll = [],
      [STORAGE_KEYS.unanswered]: udemyPureUnanswered = [],
      [STORAGE_KEYS.needsHelp]: udemyNeedsHelp = [],
      [STORAGE_KEYS.updatedAt]: udemyLastUpdated = '',
      [STORAGE_KEYS.scanStatus]: scanStatus = null
    } = await chrome.storage.local.get([
      STORAGE_KEYS.all,
      STORAGE_KEYS.unanswered,
      STORAGE_KEYS.needsHelp,
      STORAGE_KEYS.updatedAt,
      STORAGE_KEYS.scanStatus
    ]);

    statAll.textContent = `All: ${udemyAll.length}`;
    statPure.textContent = `Unanswered: ${udemyPureUnanswered.length}`;
    statNeeds.textContent = `Needs help: ${udemyNeedsHelp.length}`;

    const statusLabel = readRunningFromScanStatus(scanStatus) ? 'Scanning…' : fmtTime(udemyLastUpdated);
    statUpd.textContent = `Last: ${statusLabel}`;

    UI_STATE.running = readRunningFromScanStatus(scanStatus);
    UI_STATE.hasData =
      udemyAll.length > 0 || udemyPureUnanswered.length > 0 || udemyNeedsHelp.length > 0;

    applyUiState();
  } catch (e) {
    console.warn('[Popup] refreshStats error', e);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (
    changes[STORAGE_KEYS.all] ||
    changes[STORAGE_KEYS.unanswered] ||
    changes[STORAGE_KEYS.needsHelp] ||
    changes[STORAGE_KEYS.updatedAt] ||
    changes[STORAGE_KEYS.scanStatus]
  ) {
    refreshStats();
  }
});

async function resetAndStartScan(mode) {
  UI_STATE.running = true;
  applyUiState();

  try {
    await withActiveTab(async (tab) => {
      if (!/^https:\/\/www\.udemy\.com\//.test(tab.url || '')) {
        throw new Error('Open an Udemy tab first.');
      }

      await chrome.tabs.sendMessage(tab.id, { type: 'UDEMY_QA_CLEAR_MEMORY' });

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (scanMode) => {
          window.postMessage({ type: 'UDEMY_QA_FULLSCAN', mode: scanMode }, '*');
        },
        args: [mode]
      });

      await refreshStats();
    });

    showToast(`Scan (${mode}) started.`);
  } catch (e) {
    UI_STATE.running = false;
    applyUiState();
    showToast(String(e?.message || e || 'Unable to start scan.'));
  }
}

btnScanUnanswered.onclick = () => resetAndStartScan('unanswered');
btnScanNeedsHelp.onclick = () => resetAndStartScan('needsHelp');

$('#open-dashboard').onclick = () => {
  chrome.tabs.create({ url: DASHBOARD_URL });
};

$('#open-udemy').onclick = () => {
  chrome.tabs.create({ url: 'https://www.udemy.com/instructor/communication/qa/' });
};

btnExportUnanswered.onclick = async () => {
  try {
    await withActiveTab(async (tab) => {
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: 'UDEMY_QA_DOWNLOAD',
        mode: 'unanswered'
      });
      showToast(res?.ok ? 'Exported unanswered.' : 'Export failed.');
    });
  } catch {
    showToast('Export failed. Open Udemy tab first.');
  }
};

btnExportNeedsHelp.onclick = async () => {
  try {
    await withActiveTab(async (tab) => {
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: 'UDEMY_QA_DOWNLOAD',
        mode: 'needsHelp'
      });
      showToast(res?.ok ? 'Exported needs help.' : 'Export failed.');
    });
  } catch {
    showToast('Export failed. Open Udemy tab first.');
  }
};

btnStop.onclick = async () => {
  try {
    await withActiveTab(async (tab) => {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.postMessage({ type: 'UDEMY_QA_STOP_SCAN' }, '*')
      });
    });
  } catch {
    showToast('Stop failed. Open Udemy tab first.');
    return;
  }

  await refreshStats();
  showToast('Scan stopped.');
};

btnClear.onclick = async () => {
  try {
    await withActiveTab(async (tab) => {
      await chrome.tabs.sendMessage(tab.id, { type: 'UDEMY_QA_CLEAR_MEMORY' });
    });
  } catch {
    showToast('Clear failed. Open Udemy tab first.');
    return;
  }

  await refreshStats();
  showToast('Local data cleared.');
};

refreshStats();
applyUiState();
