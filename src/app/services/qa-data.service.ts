import { Injectable } from '@angular/core';
import { QaItem } from '../models/qa-item.model';

@Injectable({ providedIn: 'root' })
export class QaDataService {
  private readonly key = 'udemy_unanswered_v1';

  getAll(): QaItem[] {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  setAll(items: QaItem[]): void {
    localStorage.setItem(this.key, JSON.stringify(items));
  }

  merge(items: QaItem[]): QaItem[] {
    const map = new Map<string, QaItem>();

    for (const current of this.getAll()) {
      map.set(this.keyOf(current), current);
    }

    for (const incoming of items) {
      const key = this.keyOf(incoming);
      const existing = map.get(key);

      if (existing) {
        map.set(key, this.deepMerge(existing, incoming));
      } else {
        map.set(key, incoming);
      }
    }

    const all = [...map.values()];
    this.setAll(all);
    return all;
  }

  clear(): void {
    localStorage.removeItem(this.key);
  }

  private keyOf(item: Partial<QaItem>): string {
    const id = item.id === undefined || item.id === null ? '' : String(item.id).trim();
    if (id) return `id:${id}`;

    const link = (item.link || item.permalink || item.learning_url || '').trim();
    if (link) return `link:${link}`;

    const fallback = [
      (item.title || '').trim().toLowerCase(),
      (item.author || '').trim().toLowerCase(),
      String(item.courseInfo?.id || item.course || '').trim().toLowerCase(),
      String(item.created_at || item.time || item.last_activity_time || '').trim().toLowerCase()
    ].join('|');

    return `fallback:${fallback}`;
  }

  private deepMerge<T>(base: T, incoming: Partial<T>): T {
    if (!this.isPlainObject(base) || !this.isPlainObject(incoming)) {
      return (incoming as T) ?? base;
    }

    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };

    for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
      if (value === undefined) continue;

      const current = out[key];
      if (this.isPlainObject(current) && this.isPlainObject(value)) {
        out[key] = this.deepMerge(current, value);
      } else {
        out[key] = value;
      }
    }

    return out as T;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
}
