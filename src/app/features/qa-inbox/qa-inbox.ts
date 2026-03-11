import { ChangeDetectionStrategy, Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { QaItem } from '../../models/qa-item.model';
import { QaDataService } from '../../services/qa-data.service';

type CourseOpt = { id: string; title: string; url?: string };
type ViewMode = 'default' | 'hidden' | 'important';
type LocalItemState = Pick<QaItem, 'is_hidden' | 'is_important' | 'tags'>;

@Component({
  selector: 'app-qa-inbox',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './qa-inbox.html',
  styleUrls: ['./qa-inbox.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class QaInbox {
  items: QaItem[] = [];
  filteredItems: QaItem[] = [];
  courseOptions: CourseOpt[] = [];

  q = '';
  courseFilter = '';
  showUnansweredOnly = false;
  showPopularOnly = false;
  viewMode: ViewMode = 'default';
  sortOrder: 'asc' | 'desc' = 'asc';

  unansweredCount = 0;
  importError = '';

  private searchCache = new WeakMap<QaItem, string>();
  private timeCache = new Map<string, string>();
  private readonly htmlStripperEl =
    typeof document !== 'undefined' ? document.createElement('div') : null;
  private readonly timeFormatter = new Intl.DateTimeFormat('sr-Latn-RS', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  constructor(private store: QaDataService) {
    this.items = this.prepareItems(this.store.getAll());
    this.refreshDerived();
  }

  trackItem(_index: number, item: QaItem): string {
    return this.identityOf(item);
  }

  courseLabel(i: QaItem): string {
    return i.courseInfo?.title || i.course || (i.courseInfo?.id ? `Course #${i.courseInfo.id}` : 'n/a');
  }

  displayTime(i: QaItem): string {
    const raw = (i.last_activity_time || i.time || i.created_at) as string | undefined;

    if (typeof raw === 'string' && /ago|minute|hour|day|week|month|year|yesterday|just now/i.test(raw)) {
      return raw;
    }

    const ms = i.timestamp ?? this.parseIsoOrRelative(raw);
    if (!ms) return '';

    const cacheKey = `${this.identityOf(i)}|${ms}`;
    const cached = this.timeCache.get(cacheKey);
    if (cached) return cached;

    const formatted = this.timeFormatter.format(new Date(ms));
    this.timeCache.set(cacheKey, formatted);
    return formatted;
  }

  onFiltersChanged(): void {
    this.recomputeFiltered();
  }

  toggleSort(): void {
    this.sortOrder = this.sortOrder === 'desc' ? 'asc' : 'desc';
    this.recomputeFiltered();
  }

  onImport(ev: Event): void {
    this.importError = '';
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result) || '[]');
        const raw = Array.isArray(parsed)
          ? parsed
          : Array.isArray((parsed as { items?: unknown[] }).items)
            ? (parsed as { items: unknown[] }).items
            : [];

        const onlyQuestions = raw.filter((x: any) => !x?.type || x.type === 'discussion');
        this.items = this.prepareItems(onlyQuestions);
        this.refreshDerived();
        this.persist();
      } catch {
        this.importError = 'Invalid JSON format. Please export again from the extension and retry.';
      }
    };

    reader.readAsText(file);
    input.value = '';
  }

  tag(i: QaItem, t: string): void {
    this.patchItem(i, (current) => ({
      ...current,
      tags: Array.from(new Set([...(current.tags || []), t]))
    }));
  }

  toggleHidden(i: QaItem): void {
    this.patchItem(i, (current) => ({
      ...current,
      is_hidden: !this.isHidden(current)
    }));
  }

  toggleImportant(i: QaItem): void {
    this.patchItem(i, (current) => ({
      ...current,
      is_important: !this.isImportant(current)
    }));
  }

  isHidden(i: QaItem): boolean {
    return i.is_hidden === true;
  }

  isImportant(i: QaItem): boolean {
    return i.is_important === true;
  }

  snippetText(i: QaItem): string {
    const body = this.cleanText(i.body);
    if (body) return body;

    const title = this.cleanText(i.title);
    return title || '(no details available)';
  }

  isBodyFallback(i: QaItem): boolean {
    return !this.cleanText(i.body);
  }

  clearAll(): void {
    if (!confirm('Are you sure you want to delete all questions?')) return;

    this.items = [];
    this.filteredItems = [];
    this.courseOptions = [];
    this.unansweredCount = 0;
    this.searchCache = new WeakMap<QaItem, string>();
    this.timeCache.clear();
    this.store.clear();
  }

  exportCsv(): void {
    const rows = [
      [
        'id',
        'title',
        'author',
        'course_id',
        'course_title',
        'num_replies',
        'num_upvotes',
        'answered',
        'has_instructor_reply',
        'link'
      ],
      ...this.items.map((i) => [
        i.id,
        i.title,
        i.author,
        i.courseInfo?.id,
        i.courseInfo?.title,
        i.num_replies,
        i.num_upvotes,
        i.answered,
        i.has_instructor_reply,
        i.link
      ])
    ];

    const csv = rows
      .map((row) => row.map((cell) => this.escapeCsvCell(cell)).join(','))
      .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'udemy-questions.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  private patchItem(target: QaItem, patcher: (item: QaItem) => QaItem): void {
    const targetId = this.identityOf(target);
    let changed = false;

    this.items = this.items.map((item) => {
      if (this.identityOf(item) !== targetId) return item;
      changed = true;
      return patcher(item);
    });

    if (!changed) return;

    this.searchCache = new WeakMap<QaItem, string>();
    this.timeCache.clear();
    this.refreshDerived();
    this.persist();
  }

  private persist(): void {
    this.store.setAll(this.items);
  }

  private refreshDerived(): void {
    this.unansweredCount = this.items.reduce((acc, item) => acc + (item.answered ? 0 : 1), 0);
    this.courseOptions = this.buildCourseOptions(this.items);

    if (this.courseFilter && !this.courseOptions.some((c) => c.id === this.courseFilter)) {
      this.courseFilter = '';
    }

    this.recomputeFiltered();
  }

  private recomputeFiltered(): void {
    this.filteredItems = this.filterAndSort(this.items);
  }

  private filterAndSort(items: QaItem[]): QaItem[] {
    const query = this.q.trim().toLowerCase();
    const filtered: QaItem[] = [];

    for (const item of items) {
      if (!this.matchesViewMode(item)) continue;

      const courseId = item.courseInfo?.id ? String(item.courseInfo.id) : '';
      const matchesCourse = !this.courseFilter || courseId === this.courseFilter;
      if (!matchesCourse) continue;

      if (this.showUnansweredOnly && item.answered) continue;
      if (this.showPopularOnly && (item.num_upvotes || 0) < 1) continue;

      if (query) {
        const blob = this.searchBlob(item);
        if (!blob.includes(query)) continue;
      }

      filtered.push(item);
    }

    return filtered.sort((a, b) => {
      const priorityDiff = this.priorityOf(a) - this.priorityOf(b);
      if (priorityDiff !== 0) return priorityDiff;

      const ta = a.timestamp || 0;
      const tb = b.timestamp || 0;
      return this.sortOrder === 'desc' ? tb - ta : ta - tb;
    });
  }

  private priorityOf(i: QaItem): number {
    if (!i.answered) return 0;
    if (!i.has_instructor_reply) return 1;
    return 2;
  }

  private matchesViewMode(item: QaItem): boolean {
    const hidden = this.isHidden(item);
    const important = this.isImportant(item);

    if (this.viewMode === 'hidden') return hidden;
    if (this.viewMode === 'important') return important;
    return !hidden;
  }

  private buildCourseOptions(items: QaItem[]): CourseOpt[] {
    const bag = new Map<string, CourseOpt>();

    for (const i of items) {
      const id = i.courseInfo?.id ? String(i.courseInfo.id) : '';
      if (!id) continue;

      if (!bag.has(id)) {
        bag.set(id, {
          id,
          title: i.courseInfo?.title || i.course || `Course #${id}`,
          url: i.courseInfo?.url
        });
      }
    }

    return Array.from(bag.values()).sort((a, b) => a.title.localeCompare(b.title));
  }

  private searchBlob(i: QaItem): string {
    const cached = this.searchCache.get(i);
    if (cached) return cached;

    const blob = [i.title, i.course, i.author, i.courseInfo?.title, i.body]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    this.searchCache.set(i, blob);
    return blob;
  }

  private identityOf(i: Partial<QaItem>): string {
    const id = i.id === undefined || i.id === null ? '' : String(i.id).trim();
    if (id) return `id:${id}`;

    const link = (i.link || i.permalink || i.learning_url || '').trim();
    if (link) return `link:${link}`;

    const fallback = [
      (i.title || '').trim().toLowerCase(),
      (i.author || '').trim().toLowerCase(),
      String(i.courseInfo?.id || i.course || '').trim().toLowerCase(),
      String(i.created_at || i.time || i.last_activity_time || '').trim().toLowerCase()
    ].join('|');

    return `fallback:${fallback}`;
  }

  private prepareItems(raw: any[]): QaItem[] {
    this.searchCache = new WeakMap<QaItem, string>();
    this.timeCache.clear();

    const previousState = this.buildLocalStateMap(this.items);
    const normalized = this.postEnrichCourses(raw.map((item) => this.normalizeOne(item)));
    const withLocalState = normalized.map((item) => this.applyLocalState(item, previousState));

    return this.enhance(withLocalState);
  }

  private normalizeOne(i: any): QaItem {
    const bodyPlain = this.stripHtml(i?.body);
    const numReplies = Number(i?.num_replies || 0);
    const hasInstr = !!i?.has_instructor_reply;
    const hasTopAnswer = !!i?.has_top_answer || !!i?.is_featured;
    const isHidden = this.toBoolFlag(i?.is_hidden);
    const isImportant = this.toBoolFlag(i?.is_important);

    const title = this.buildTitle(i?.title, bodyPlain);
    const link = this.toAbs(i?.link) || this.toAbs(i?.permalink) || '';

    return {
      ...i,
      title,
      link,
      body: bodyPlain,
      course: i?.courseInfo?.title || i?.course || '',
      courseInfo: {
        ...(i?.courseInfo || {}),
        id: i?.courseInfo?.id || i?.courseId,
        title: i?.courseInfo?.title || i?.courseTitle,
        url: this.toAbs(i?.courseInfo?.url)
      },
      num_replies: numReplies,
      num_upvotes: Number(i?.num_upvotes || 0),
      has_instructor_reply: hasInstr,
      has_top_answer: hasTopAnswer,
      answered: numReplies > 0 || hasInstr,
      pure_unanswered: numReplies === 0,
      needs_help: numReplies > 0 && !hasInstr && !hasTopAnswer,
      is_hidden: isHidden,
      is_important: isImportant,
      timestamp: this.parseIsoOrRelative(i?.created_at || i?.time || i?.last_activity_time)
    };
  }

  private enhance(arr: QaItem[]): QaItem[] {
    return arr.map((item) => ({
      ...item,
      timestamp:
        item.timestamp ?? this.parseIsoOrRelative(item.created_at || item.time || item.last_activity_time)
    }));
  }

  private postEnrichCourses(items: QaItem[]): QaItem[] {
    const map = new Map<string, { title?: string; url?: string }>();

    for (const item of items) {
      const id = item.courseInfo?.id ? String(item.courseInfo.id) : '';
      if (!id || map.has(id)) continue;

      map.set(id, {
        title: item.courseInfo?.title || item.course,
        url: this.toAbs(item.courseInfo?.url)
      });
    }

    return items.map((item) => {
      const cid = item.courseInfo?.id ? String(item.courseInfo.id) : '';
      const meta = cid ? map.get(cid) : undefined;

      if (!meta) return item;

      return {
        ...item,
        course: meta.title || item.course,
        courseInfo: { ...item.courseInfo, title: meta.title, url: meta.url }
      };
    });
  }

  private buildTitle(rawTitle?: string, body?: string): string {
    if (rawTitle && rawTitle.trim()) return rawTitle.trim();

    const bodyText = (body || '').trim().replace(/\s+/g, ' ');
    if (!bodyText) return '(no title)';

    return bodyText.length > 120 ? `${bodyText.slice(0, 117)}…` : bodyText;
  }

  private stripHtml(html?: string): string {
    if (!html) return '';

    if (!this.htmlStripperEl) {
      return String(html)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    this.htmlStripperEl.innerHTML = html;
    const text = (this.htmlStripperEl.textContent || this.htmlStripperEl.innerText || '').trim();
    this.htmlStripperEl.textContent = '';
    return text;
  }

  private toAbs(url?: string): string | undefined {
    if (!url) return undefined;
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith('/')) return `https://www.udemy.com${url}`;
    return url;
  }

  private parseIsoOrRelative(raw?: string): number {
    if (!raw) return 0;

    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;

    const s = raw.trim().toLowerCase();
    if (!s) return 0;

    if (s === 'now' || s === 'just now') return Date.now();
    if (s === 'yesterday') return Date.now() - 86400000;

    const m = s.match(/^(\d+)\s+([a-z]+)(?:\s+ago)?$/i);
    if (!m) return 0;

    const value = Number(m[1]);
    if (!Number.isFinite(value)) return 0;

    const unit = m[2].toLowerCase();
    const multipliers: Record<string, number> = {
      s: 1000,
      sec: 1000,
      second: 1000,
      seconds: 1000,
      m: 60000,
      min: 60000,
      mins: 60000,
      minute: 60000,
      minutes: 60000,
      h: 3600000,
      hr: 3600000,
      hour: 3600000,
      hours: 3600000,
      d: 86400000,
      day: 86400000,
      days: 86400000,
      w: 604800000,
      week: 604800000,
      weeks: 604800000,
      month: 2629800000,
      months: 2629800000,
      y: 31557600000,
      year: 31557600000,
      years: 31557600000
    };

    const mul = multipliers[unit];
    return mul ? Date.now() - value * mul : 0;
  }

  private cleanText(value?: string): string {
    return (value || '').trim();
  }

  private buildLocalStateMap(items: QaItem[]): Map<string, LocalItemState> {
    const map = new Map<string, LocalItemState>();

    for (const item of items) {
      map.set(this.identityOf(item), {
        is_hidden: this.isHidden(item),
        is_important: this.isImportant(item),
        tags: item.tags
      });
    }

    return map;
  }

  private applyLocalState(item: QaItem, stateMap: Map<string, LocalItemState>): QaItem {
    const localState = stateMap.get(this.identityOf(item));
    if (!localState) return item;

    return {
      ...item,
      is_hidden: localState.is_hidden ?? item.is_hidden,
      is_important: localState.is_important ?? item.is_important,
      tags: localState.tags ?? item.tags
    };
  }

  private toBoolFlag(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;

    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return false;
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }

  private escapeCsvCell(value: unknown): string {
    const s = value === undefined || value === null ? '' : String(value);
    if (!/[",\n]/.test(s)) return s;

    return `"${s.replace(/"/g, '""')}"`;
  }
}
