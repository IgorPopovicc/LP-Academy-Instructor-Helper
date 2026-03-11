import { Injectable, computed, signal } from '@angular/core';

const EXTENSION_INSTALL_URL = 'https://chromewebstore.google.com/search/Udemy%20Q%26A%20Extractor';
const DISMISS_STORAGE_KEY = 'udemy_qa_extension_prompt_dismissed_until';
const DISMISS_TTL_MS = 12 * 60 * 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 1800;
const HANDSHAKE_RETRY_DELAY_MS = 180;

const PROTOCOL_VERSION = 1;
const APP_SOURCE = 'UDEMY_QA_HELPER_APP';
const EXTENSION_SOURCE = 'UDEMY_QA_HELPER_EXTENSION';
const EXTENSION_PING = 'UDEMY_QA_EXTENSION_PING';
const EXTENSION_PONG = 'UDEMY_QA_EXTENSION_PONG';

const MARKER_ATTR = 'data-udemy-qa-extension-ready';
const MARKER_VERSION_ATTR = 'data-udemy-qa-extension-version';
const BRIDGE_GLOBAL = '__UDEMY_QA_EXTENSION_BRIDGE__';

type ExtensionStatus = 'checking' | 'installed' | 'missing' | 'unsupported';

interface BrowserSupportInfo {
  name: string;
  supported: boolean;
  chromiumBased: boolean;
}

interface ExtensionPingMessage {
  source: typeof APP_SOURCE;
  type: typeof EXTENSION_PING;
  protocolVersion: number;
  requestId: string;
  ts: number;
}

interface ExtensionPongMessage {
  source: typeof EXTENSION_SOURCE;
  type: typeof EXTENSION_PONG;
  protocolVersion: number;
  requestId: string;
  installed: true;
  version?: string;
  ts?: number;
}

export interface ExtensionPromptState {
  status: ExtensionStatus;
  browserName: string;
  supportedBrowser: boolean;
  extensionVersion: string | null;
  showPrompt: boolean;
  canInstall: boolean;
  installUrl: string;
  title: string;
  message: string;
  dismissedUntil: number;
}

@Injectable({ providedIn: 'root' })
export class ExtensionRequirementService {
  private readonly status = signal<ExtensionStatus>('checking');
  private readonly extensionVersion = signal<string | null>(null);
  private readonly browser = signal<BrowserSupportInfo>(this.detectBrowser());
  private readonly dismissedUntil = signal<number>(this.readDismissedUntil());

  private initialized = false;
  private activeCheckCleanup: (() => void) | null = null;
  private dismissalTimer: number | null = null;

  readonly uiState = computed<ExtensionPromptState>(() => {
    const status = this.status();
    const browser = this.browser();
    const dismissedUntil = this.dismissedUntil();
    const dismissed = this.isDismissed(dismissedUntil);

    let title = '';
    let message = '';
    let canInstall = false;
    let showPrompt = false;

    if (status === 'missing') {
      title = 'Extension Required';
      message =
        'Install the Udemy Q&A Extractor extension to scan course questions and keep this inbox in sync.';
      canInstall = browser.supported;
      showPrompt = !dismissed;
    } else if (status === 'unsupported') {
      title = 'Browser Not Supported';
      message = `${browser.name} currently cannot use this extension flow. Please use a Chromium-based browser such as Chrome, Brave, or Edge.`;
      canInstall = false;
      showPrompt = !dismissed;
    }

    return {
      status,
      browserName: browser.name,
      supportedBrowser: browser.supported,
      extensionVersion: this.extensionVersion(),
      showPrompt,
      canInstall,
      installUrl: EXTENSION_INSTALL_URL,
      title,
      message,
      dismissedUntil
    };
  });

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (!this.isBrowserRuntime()) {
      this.status.set('unsupported');
      return;
    }

    this.scheduleDismissalWakeup();
    this.checkExtension();
  }

  checkExtension(): void {
    if (!this.isBrowserRuntime()) {
      this.status.set('unsupported');
      return;
    }

    this.browser.set(this.detectBrowser());
    if (!this.browser().supported) {
      this.cleanupActiveCheck();
      this.status.set('unsupported');
      return;
    }

    const markerBeforeHandshake = this.readExtensionMarker();
    if (markerBeforeHandshake.installed) {
      this.cleanupActiveCheck();
      this.status.set('installed');
      this.extensionVersion.set(markerBeforeHandshake.version || null);
      this.clearDismissal();
      return;
    }

    this.runHandshake();
  }

  dismissPrompt(): void {
    if (!this.isBrowserRuntime()) return;

    const until = Date.now() + DISMISS_TTL_MS;
    this.dismissedUntil.set(until);

    try {
      localStorage.setItem(DISMISS_STORAGE_KEY, String(until));
    } catch {
      // ignore localStorage write failures
    }

    this.scheduleDismissalWakeup();
  }

  openInstallPage(): void {
    if (!this.isBrowserRuntime() || !this.browser().supported) return;
    window.open(EXTENSION_INSTALL_URL, '_blank', 'noopener,noreferrer');
  }

  private runHandshake(): void {
    this.cleanupActiveCheck();
    this.status.set('checking');

    const requestId = this.createRequestId();
    let settled = false;

    const finalize = (nextStatus: ExtensionStatus, version?: string) => {
      if (settled) return;
      settled = true;

      this.cleanupActiveCheck();
      this.status.set(nextStatus);
      this.extensionVersion.set(version || null);

      if (nextStatus === 'installed') {
        this.clearDismissal();
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (!this.isValidPongMessage(event, requestId)) return;
      const payload = event.data as ExtensionPongMessage;
      finalize('installed', payload.version);
    };

    const timeoutId = window.setTimeout(() => {
      const markerAfterTimeout = this.readExtensionMarker();
      if (markerAfterTimeout.installed) {
        finalize('installed', markerAfterTimeout.version);
      } else {
        finalize('missing');
      }
    }, HANDSHAKE_TIMEOUT_MS);

    const retryPingId = window.setTimeout(() => this.postPing(requestId), HANDSHAKE_RETRY_DELAY_MS);

    window.addEventListener('message', onMessage);
    this.postPing(requestId);

    this.activeCheckCleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timeoutId);
      window.clearTimeout(retryPingId);
      this.activeCheckCleanup = null;
    };
  }

  private postPing(requestId: string): void {
    const ping: ExtensionPingMessage = {
      source: APP_SOURCE,
      type: EXTENSION_PING,
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      ts: Date.now()
    };

    window.postMessage(ping, window.location.origin);
  }

  private isValidPongMessage(event: MessageEvent, requestId: string): boolean {
    if (event.source !== window) return false;
    if (event.origin !== window.location.origin) return false;

    const data = event?.data;
    if (!data || typeof data !== 'object') return false;

    const payload = data as Partial<ExtensionPongMessage>;

    if (payload.source !== EXTENSION_SOURCE) return false;
    if (payload.type !== EXTENSION_PONG) return false;
    if (payload.protocolVersion !== PROTOCOL_VERSION) return false;
    if (payload.requestId !== requestId) return false;
    if (payload.installed !== true) return false;
    if (payload.version !== undefined && typeof payload.version !== 'string') return false;

    return true;
  }

  private readExtensionMarker(): { installed: boolean; version?: string } {
    if (!this.isBrowserRuntime()) return { installed: false };

    const root = document.documentElement;
    const hasDomMarker = root.getAttribute(MARKER_ATTR) === '1';
    const domVersion = root.getAttribute(MARKER_VERSION_ATTR) || undefined;

    const winMarker = (window as unknown as Record<string, unknown>)[BRIDGE_GLOBAL];
    const hasWindowMarker =
      !!winMarker &&
      typeof winMarker === 'object' &&
      (winMarker as { installed?: unknown }).installed === true;

    const winVersion =
      hasWindowMarker && typeof (winMarker as { version?: unknown }).version === 'string'
        ? (winMarker as { version: string }).version
        : undefined;

    return {
      installed: hasDomMarker || hasWindowMarker,
      version: winVersion || domVersion
    };
  }

  private detectBrowser(): BrowserSupportInfo {
    if (!this.isBrowserRuntime()) {
      return { name: 'Unknown', supported: false, chromiumBased: false };
    }

    const ua = window.navigator.userAgent || '';

    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isFirefox = /Firefox\//.test(ua);
    const isEdge = /Edg\//.test(ua);
    const isOpera = /OPR\//.test(ua);
    const isVivaldi = /Vivaldi\//.test(ua);
    const isBrave = !!(window.navigator as Navigator & { brave?: unknown }).brave;
    const hasChromeToken = /Chrome\//.test(ua) || /Chromium\//.test(ua);
    const isSafari = /Safari\//.test(ua) && !hasChromeToken && !isEdge && !isOpera && !isVivaldi;

    const chromiumBased =
      !isIOS &&
      !isFirefox &&
      !isSafari &&
      (hasChromeToken || isEdge || isOpera || isVivaldi || isBrave);

    let name = 'Unsupported browser';
    if (isBrave) name = 'Brave';
    else if (isEdge) name = 'Microsoft Edge';
    else if (isOpera) name = 'Opera';
    else if (isVivaldi) name = 'Vivaldi';
    else if (hasChromeToken) name = 'Google Chrome';
    else if (isFirefox) name = 'Firefox';
    else if (isSafari) name = 'Safari';

    return {
      name,
      supported: chromiumBased,
      chromiumBased
    };
  }

  private readDismissedUntil(): number {
    if (!this.isBrowserRuntime()) return 0;

    try {
      const raw = localStorage.getItem(DISMISS_STORAGE_KEY);
      if (!raw) return 0;

      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        localStorage.removeItem(DISMISS_STORAGE_KEY);
        return 0;
      }

      return parsed;
    } catch {
      return 0;
    }
  }

  private clearDismissal(): void {
    this.dismissedUntil.set(0);

    try {
      localStorage.removeItem(DISMISS_STORAGE_KEY);
    } catch {
      // ignore localStorage failures
    }

    if (this.dismissalTimer !== null) {
      window.clearTimeout(this.dismissalTimer);
      this.dismissalTimer = null;
    }
  }

  private scheduleDismissalWakeup(): void {
    if (!this.isBrowserRuntime()) return;

    if (this.dismissalTimer !== null) {
      window.clearTimeout(this.dismissalTimer);
      this.dismissalTimer = null;
    }

    const until = this.dismissedUntil();
    const remaining = until - Date.now();
    if (remaining <= 0) return;

    this.dismissalTimer = window.setTimeout(() => {
      this.dismissalTimer = null;
      this.dismissedUntil.set(this.readDismissedUntil());
      if (this.status() === 'missing' || this.status() === 'unsupported') {
        this.checkExtension();
      }
    }, remaining + 20);
  }

  private isDismissed(until: number): boolean {
    return Number.isFinite(until) && until > Date.now();
  }

  private cleanupActiveCheck(): void {
    this.activeCheckCleanup?.();
    this.activeCheckCleanup = null;
  }

  private createRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  private isBrowserRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
  }
}
