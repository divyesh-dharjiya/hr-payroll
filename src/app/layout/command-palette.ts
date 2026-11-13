import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Avatar } from '../shared/avatar';

export interface PaletteLink {
  label: string;
  icon: string;
  link: string;
  group: string;
}

interface Result {
  kind: 'page' | 'person';
  label: string;
  sub: string;
  icon: string;
  link: string;
  photoUrl?: string | null;
}

/** Quick search (Ctrl/Cmd + K): jump to any page you can access, or find a colleague in your scope. */
@Component({
  selector: 'ph-command-palette',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDialogModule, MatIconModule, Avatar],
  template: `
    <div class="palette" role="combobox" aria-haspopup="listbox" [attr.aria-expanded]="results().length > 0">
      <div class="search">
        <mat-icon aria-hidden="true">search</mat-icon>
        <input
          #input
          cdkFocusInitial
          type="search"
          [value]="query()"
          (input)="onInput($any($event.target).value)"
          (keydown)="onKey($event)"
          placeholder="Search pages and people…"
          aria-label="Search pages and people"
          aria-controls="palette-results"
          [attr.aria-activedescendant]="results().length ? 'pr-' + active() : null"
        />
        <kbd>Esc</kbd>
      </div>
      <ul id="palette-results" role="listbox" class="results">
        @for (r of results(); track r.link + r.label; let i = $index) {
          <li
            [id]="'pr-' + i"
            role="option"
            [attr.aria-selected]="i === active()"
            [class.active]="i === active()"
            (mouseenter)="active.set(i)"
            (click)="go(r)"
          >
            @if (r.kind === 'person') {
              <ph-avatar [name]="r.label" [photoUrl]="r.photoUrl" [size]="30" />
            } @else {
              <span class="ico" aria-hidden="true"><mat-icon>{{ r.icon }}</mat-icon></span>
            }
            <span class="txt"><span class="lbl">{{ r.label }}</span><span class="sub">{{ r.sub }}</span></span>
            <mat-icon class="enter" aria-hidden="true">keyboard_return</mat-icon>
          </li>
        } @empty {
          <li class="none" role="presentation">No matches for "{{ query() }}"</li>
        }
      </ul>
      <div class="foot muted"><span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span></div>
    </div>
  `,
  styles: [
    `
      .palette { width: 100%; display: flex; flex-direction: column; overflow: hidden; }
      .search { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--ph-border); }
      .search input { flex: 1; border: 0; outline: 0; background: transparent; font: inherit; font-size: 16px; color: var(--ph-text); }
      .search mat-icon { color: var(--ph-text-muted); }
      kbd { font-family: inherit; font-size: 11px; padding: 2px 6px; border-radius: 6px; border: 1px solid var(--ph-border); background: var(--ph-surface-muted); color: var(--ph-text-muted); margin-right: 4px; }
      .results { list-style: none; margin: 0; padding: 6px; max-height: 52vh; overflow-y: auto; }
      .results li { display: grid; grid-template-columns: 30px 1fr 20px; gap: 12px; align-items: center; padding: 9px 10px; border-radius: 10px; cursor: pointer; }
      .results li.active { background: var(--ph-primary-soft); }
      .results li.none { display: block; color: var(--ph-text-muted); cursor: default; padding: 18px; text-align: center; }
      .ico { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; background: var(--ph-surface-muted); color: var(--ph-primary); }
      .ico mat-icon { font-size: 18px; width: 18px; height: 18px; }
      .txt { display: flex; flex-direction: column; min-width: 0; }
      .lbl { font-weight: 600; }
      .sub { font-size: 12px; color: var(--ph-text-muted); }
      .enter { opacity: 0; font-size: 18px; color: var(--ph-primary); }
      li.active .enter { opacity: 1; }
      .foot { display: flex; gap: 16px; padding: 10px 16px; border-top: 1px solid var(--ph-border); font-size: 12px; }
      .muted { color: var(--ph-text-muted); }
    `,
  ],
})
export class CommandPalette {
  private readonly data = inject<{ links: PaletteLink[] }>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<CommandPalette>);
  private readonly router = inject(Router);
  private readonly api = inject(Api);
  private readonly auth = inject(Auth);

  readonly query = signal('');
  readonly people = signal<Result[]>([]);
  readonly active = signal(0);
  private timer: ReturnType<typeof setTimeout> | undefined;

  readonly results = computed<Result[]>(() => {
    const q = this.query().trim().toLowerCase();
    const pages: Result[] = this.data.links
      .filter((l) => !q || l.label.toLowerCase().includes(q) || l.group.toLowerCase().includes(q))
      .map((l) => ({ kind: 'page', label: l.label, sub: l.group, icon: l.icon, link: l.link }));
    return [...pages, ...this.people()].slice(0, 12);
  });

  onInput(value: string) {
    this.query.set(value);
    this.active.set(0);
    clearTimeout(this.timer);
    if (!this.auth.has('employees:read') || value.trim().length < 2) {
      this.people.set([]);
      return;
    }
    this.timer = setTimeout(async () => {
      try {
        const res = await this.api.get<{ items: { id: string; name: string; employeeCode: string; photoUrl: string | null; designation: { title: string } }[] }>(
          '/employees/',
          { q: value.trim(), pageSize: 6 },
        );
        this.people.set(
          res.items.map((e) => ({ kind: 'person', label: e.name, sub: `${e.employeeCode} · ${e.designation.title}`, icon: 'person', link: `/employees/${e.id}`, photoUrl: e.photoUrl })),
        );
      } catch {
        this.people.set([]);
      }
    }, 200);
  }

  onKey(e: KeyboardEvent) {
    const n = this.results().length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.active.set(n ? (this.active() + 1) % n : 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.active.set(n ? (this.active() - 1 + n) % n : 0);
    } else if (e.key === 'Enter') {
      const r = this.results()[this.active()];
      if (r) this.go(r);
    }
  }

  go(r: Result) {
    this.ref.close();
    void this.router.navigateByUrl(r.link);
  }
}
