import { Component, Inject, PLATFORM_ID } from '@angular/core';
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { QaInbox } from './features/qa-inbox/qa-inbox';
import { ExtensionRequirementService } from './services/extension-requirement.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  imports: [
    RouterOutlet,
    QaInbox
  ],
  styleUrls: ['./app.scss']
})
export class App{
  constructor(
    @Inject(PLATFORM_ID) private pid: Object,
    @Inject(DOCUMENT) private doc: Document,
    private extensionRequirement: ExtensionRequirementService
  ) {}

  get extensionPrompt() {
    return this.extensionRequirement.uiState;
  }

  ngOnInit() {
    if (!isPlatformBrowser(this.pid)) return;
    const saved = localStorage.getItem('qa_theme');
    if (saved === 'dark') document.documentElement.classList.add('dark');
    this.syncSeoUrls();
    this.extensionRequirement.initialize();
  }

  toggleTheme() {
    if (!isPlatformBrowser(this.pid)) return;
    const el = document.documentElement;
    el.classList.toggle('dark');
    localStorage.setItem('qa_theme', el.classList.contains('dark') ? 'dark' : 'light');
  }

  openExtensionInstall() {
    this.extensionRequirement.openInstallPage();
  }

  dismissExtensionPrompt() {
    this.extensionRequirement.dismissPrompt();
  }

  recheckExtension() {
    this.extensionRequirement.checkExtension();
  }

  private syncSeoUrls() {
    const canonical = this.doc.querySelector('link[rel="canonical"]');
    if (canonical) {
      canonical.setAttribute('href', `${location.origin}${location.pathname}`);
    }

    const ogUrl = this.doc.querySelector('meta[property="og:url"]');
    if (ogUrl) {
      ogUrl.setAttribute('content', `${location.origin}${location.pathname}`);
    }
  }
}
