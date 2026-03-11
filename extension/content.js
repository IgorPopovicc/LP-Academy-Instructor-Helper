// === content.js ===
(function () {
  console.log('[Extractor] content.js injected on', location.href);

  const STORAGE_KEYS = {
    all: 'udemyAll',
    unanswered: 'udemyPureUnanswered',
    needsHelp: 'udemyNeedsHelp',
    updatedAt: 'udemyLastUpdated',
    scanStatus: 'udemyScanStatus'
  };

  function injectSniffer() {
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('injected-sniffer.js');
      s.async = false;
      (document.head || document.documentElement).appendChild(s);
      s.onload = () => s.remove();
      console.log('[Extractor] injected-sniffer.js injected');
    } catch (e) {
      console.warn('[Extractor] failed to inject sniffer', e);
    }
  }

  injectSniffer();

  const byKey = new Map();
  const unansweredKeys = new Set();
  const needsHelpKeys = new Set();
  let persistTimer = null;

  function keyOf(item) {
    const id = item?.id ?? item?.question_id ?? item?.discussion_id;
    if (id !== undefined && id !== null && String(id).trim()) {
      return `id:${String(id).trim()}`;
    }

    const link = item?.link || item?.permalink || item?.learning_url;
    if (link && String(link).trim()) {
      return `link:${String(link).trim()}`;
    }

    const fallback = [
      String(item?.title || '').trim().toLowerCase(),
      String(item?.author || '').trim().toLowerCase(),
      String(item?.courseInfo?.id || item?.courseId || item?.course || '').trim().toLowerCase(),
      String(item?.created_at || item?.time || item?.last_activity_time || '').trim().toLowerCase()
    ].join('|');

    return `fallback:${fallback}`;
  }

  function deepMerge(base, incoming) {
    if (
      base &&
      incoming &&
      typeof base === 'object' &&
      typeof incoming === 'object' &&
      !Array.isArray(base) &&
      !Array.isArray(incoming)
    ) {
      for (const [key, value] of Object.entries(incoming)) {
        if (value === undefined) continue;

        if (
          base[key] &&
          value &&
          typeof base[key] === 'object' &&
          typeof value === 'object' &&
          !Array.isArray(base[key]) &&
          !Array.isArray(value)
        ) {
          base[key] = deepMerge(base[key], value);
        } else {
          base[key] = value;
        }
      }
      return base;
    }

    return incoming ?? base;
  }

  function stripInternalFields(value) {
    if (Array.isArray(value)) {
      return value.map(stripInternalFields);
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('_')) continue;
      out[key] = stripInternalFields(item);
    }
    return out;
  }

  function classifyDiscussion(item) {
    const replies = Number(item?.num_replies || 0);
    const hasInstructorReply = item?.has_instructor_reply === true;
    const hasTopAnswer = item?.has_top_answer === true || item?.is_featured === true;

    return {
      num_replies: replies,
      has_instructor_reply: hasInstructorReply,
      has_top_answer: hasTopAnswer,
      pure_unanswered: replies === 0,
      needs_help: replies > 0 && !hasInstructorReply && !hasTopAnswer,
      answered: replies > 0 || hasInstructorReply
    };
  }

  function normalizeDiscussion(item) {
    const clean = stripInternalFields(item);
    return {
      ...clean,
      ...classifyDiscussion(clean),
      type: 'discussion'
    };
  }

  function updateMembership(key, item) {
    if (item.pure_unanswered === true) {
      unansweredKeys.add(key);
    } else {
      unansweredKeys.delete(key);
    }

    if (item.needs_help === true) {
      needsHelpKeys.add(key);
    } else {
      needsHelpKeys.delete(key);
    }
  }

  function absorb(items) {
    if (!Array.isArray(items) || !items.length) return;

    let changed = false;

    for (const raw of items) {
      if (!raw || raw.type !== 'discussion') continue;

      const key = keyOf(raw);
      if (!key) continue;

      const existing = byKey.get(key);
      const merged = existing ? deepMerge(existing, raw) : raw;
      const normalized = normalizeDiscussion(merged);

      byKey.set(key, normalized);
      updateMembership(key, normalized);
      changed = true;
    }

    if (changed) {
      schedulePersist();
    }
  }

  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist();
    }, 180);
  }

  function materialize(set) {
    const out = [];
    for (const key of set) {
      const item = byKey.get(key);
      if (item) out.push(item);
    }
    return out;
  }

  function persist() {
    const allDiscussions = [...byKey.values()];
    const pureUnanswered = materialize(unansweredKeys);
    const needsHelp = materialize(needsHelpKeys);

    const payload = {
      [STORAGE_KEYS.all]: allDiscussions,
      [STORAGE_KEYS.unanswered]: pureUnanswered,
      [STORAGE_KEYS.needsHelp]: needsHelp,
      [STORAGE_KEYS.updatedAt]: new Date().toISOString()
    };

    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) {
        console.warn('[Extractor] chrome.runtime not ready, skip persist');
        return;
      }

      chrome.storage.local.set(payload, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.warn('[Extractor] storage.set error:', err.message || err);
          return;
        }

        console.log(
          `[Extractor] saved: all=${allDiscussions.length}, pureUnanswered=${pureUnanswered.length}, needsHelp=${needsHelp.length} (at ${payload[STORAGE_KEYS.updatedAt]})`
        );
      });
    } catch (e) {
      console.warn('[Extractor] persist failed:', e);
    }
  }

  function setScanStatus(scanPayload) {
    const status = {
      ...scanPayload,
      updatedAt: new Date().toISOString()
    };

    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
      chrome.storage.local.set({ [STORAGE_KEYS.scanStatus]: status });
    } catch (e) {
      console.warn('[Extractor] failed to persist scan status', e);
    }
  }

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function makeTimestamp() {
    const d = new Date();
    const Y = d.getFullYear();
    const M = pad(d.getMonth() + 1);
    const D = pad(d.getDate());
    const h = pad(d.getHours());
    const m = pad(d.getMinutes());
    return `${Y}-${M}-${D} ${h}:${m}`;
  }

  function downloadJson(data, { suffix } = {}) {
    const list = Array.isArray(data) ? data : [];
    const ts = makeTimestamp().replace(' ', '_').replace(':', '-');
    const kind = suffix || 'all';
    const name = `udemy_qa_${ts}_${kind}.json`;

    const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function handleDownload({ mode }) {
    const storage = await chrome.storage.local.get([
      STORAGE_KEYS.all,
      STORAGE_KEYS.unanswered,
      STORAGE_KEYS.needsHelp
    ]);

    if (mode === 'unanswered') {
      downloadJson(storage[STORAGE_KEYS.unanswered] || [], { suffix: 'unanswered' });
      return;
    }

    if (mode === 'needsHelp') {
      downloadJson(storage[STORAGE_KEYS.needsHelp] || [], { suffix: 'needsHelp' });
      return;
    }

    downloadJson(storage[STORAGE_KEYS.all] || [], { suffix: 'all' });
  }

  function onWindowMessage(ev) {
    if (ev.source !== window) return;

    const d = ev?.data;
    if (!d || typeof d !== 'object') return;

    if (d.type === 'UDEMY_QA_DATA' && Array.isArray(d.items)) {
      console.log(`[Extractor] captured ${d.items.length} from ${d.from || 'n/a'} (${d.url || 'n/a'})`);
      absorb(d.items);
      return;
    }

    if (d.type === 'UDEMY_QA_COLLECTED_RESPONSE' && Array.isArray(d.items)) {
      console.log(`[Extractor] collected dump: ${d.items.length} items from sniffer`);
      absorb(d.items);
      return;
    }

    if (d.type === 'UDEMY_QA_SCAN_STATUS') {
      setScanStatus({
        status: d.status || 'unknown',
        mode: d.mode || null,
        runId: d.runId,
        count: Number.isFinite(Number(d.count)) ? Number(d.count) : undefined,
        error: d.error || undefined,
        sourceTs: d.ts || undefined
      });

      if (d.status && d.status !== 'running') {
        if (persistTimer) {
          clearTimeout(persistTimer);
          persistTimer = null;
        }
        persist();
      }
    }
  }

  window.addEventListener('message', onWindowMessage);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'UDEMY_QA_DOWNLOAD') {
      handleDownload({ mode: msg.mode })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    if (msg.type === 'UDEMY_QA_CLEAR_MEMORY') {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }

      byKey.clear();
      unansweredKeys.clear();
      needsHelpKeys.clear();

      window.postMessage({ type: 'UDEMY_QA_CLEAR_BUFFER' }, '*');

      chrome.storage.local.set(
        {
          [STORAGE_KEYS.all]: [],
          [STORAGE_KEYS.unanswered]: [],
          [STORAGE_KEYS.needsHelp]: [],
          [STORAGE_KEYS.updatedAt]: '',
          [STORAGE_KEYS.scanStatus]: {
            status: 'idle',
            updatedAt: new Date().toISOString()
          }
        },
        () => {
          console.log('[Extractor] local memory cleared');
          sendResponse({ ok: true });
        }
      );
      return true;
    }
  });
})();
