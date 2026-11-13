import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'ph-theme';

/**
 * Light / dark theme. The preference is a per-browser convenience kept in localStorage; when storage is unavailable
 * (private mode, blocked site data) the app simply follows the operating system setting.
 */
@Injectable({ providedIn: 'root' })
export class Theme {
  private readonly doc = inject(DOCUMENT);
  private readonly media = this.doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
  private readonly systemDark = signal(this.media?.matches ?? false);

  readonly preference = signal<ThemePreference>(this.readPreference());
  readonly isDark = computed(() => (this.preference() === 'system' ? this.systemDark() : this.preference() === 'dark'));

  constructor() {
    this.media?.addEventListener?.('change', (e) => {
      this.systemDark.set(e.matches);
      this.apply();
    });
    this.apply();
  }

  toggle() {
    this.set(this.isDark() ? 'light' : 'dark');
  }

  set(pref: ThemePreference) {
    this.preference.set(pref);
    try {
      this.doc.defaultView?.localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      // Storage unavailable: the choice lasts for this page only.
    }
    this.apply();
  }

  private apply() {
    const dark = this.isDark();
    // Colours cross-fade through CSS transitions on themed surfaces.
    this.doc.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    this.doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b0d14' : '#4f46e5');
  }

  private readPreference(): ThemePreference {
    try {
      const v = this.doc.defaultView?.localStorage.getItem(STORAGE_KEY);
      return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
    } catch {
      return 'system';
    }
  }
}
