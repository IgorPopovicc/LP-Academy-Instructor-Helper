// === app-bridge.js ===
(function () {
  const PROTOCOL_VERSION = 1;
  const APP_SOURCE = 'UDEMY_QA_HELPER_APP';
  const EXTENSION_SOURCE = 'UDEMY_QA_HELPER_EXTENSION';
  const EXTENSION_PING = 'UDEMY_QA_EXTENSION_PING';
  const EXTENSION_PONG = 'UDEMY_QA_EXTENSION_PONG';
  const MARKER_ATTR = 'data-udemy-qa-extension-ready';
  const VERSION_ATTR = 'data-udemy-qa-extension-version';

  const version = chrome?.runtime?.getManifest?.().version || '';

  // Secondary detection marker used by the web app as a fallback signal.
  window.__UDEMY_QA_EXTENSION_BRIDGE__ = { installed: true, version };
  if (document?.documentElement) {
    document.documentElement.setAttribute(MARKER_ATTR, '1');
    if (version) {
      document.documentElement.setAttribute(VERSION_ATTR, version);
    }
  }

  function isValidPing(data) {
    return !!(
      data &&
      typeof data === 'object' &&
      data.source === APP_SOURCE &&
      data.type === EXTENSION_PING &&
      data.protocolVersion === PROTOCOL_VERSION &&
      typeof data.requestId === 'string' &&
      data.requestId.trim().length > 0
    );
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    const data = event?.data;
    if (!isValidPing(data)) return;

    window.postMessage(
      {
        source: EXTENSION_SOURCE,
        type: EXTENSION_PONG,
        protocolVersion: PROTOCOL_VERSION,
        requestId: data.requestId,
        installed: true,
        version,
        ts: Date.now()
      },
      window.location.origin
    );
  });
})();
