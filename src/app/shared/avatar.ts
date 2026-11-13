import { ChangeDetectionStrategy, Component, Input, computed, signal } from '@angular/core';

// ---------------------------------------------------------------------------------------------------------------
// Avatar: shows the uploaded profile photo when there is one, otherwise an illustrated portrait generated from the
// person's name. The illustration is deterministic (same name, same portrait) and depicts no real person, which
// keeps demo data free of real people's photos.
// ---------------------------------------------------------------------------------------------------------------

const BACKGROUNDS: [string, string][] = [
  ['#c7d2fe', '#a5b4fc'],
  ['#bae6fd', '#7dd3fc'],
  ['#bbf7d0', '#86efac'],
  ['#fde68a', '#fcd34d'],
  ['#fecdd3', '#fda4af'],
  ['#ddd6fe', '#c4b5fd'],
  ['#fed7aa', '#fdba74'],
  ['#a7f3d0', '#6ee7b7'],
];
const SKIN = ['#f3d2b8', '#e8b994', '#d49a73', '#b97a52', '#9a5f3c', '#7b4a2e'];
const HAIR = ['#1b1512', '#2b1d16', '#3a271c', '#4a3122', '#5b3a26', '#24201f'];
const SHIRTS = ['#4f46e5', '#0ea5e9', '#14b8a6', '#f97316', '#e11d48', '#7c3aed', '#0f766e', '#334155'];

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Portrait {
  id: string;
  bg: [string, string];
  skin: string;
  hair: string;
  shirt: string;
  style: number;
  glasses: boolean;
}

function portraitFor(name: string): Portrait {
  const h = hash(name || 'PeopleHub');
  return {
    id: `pa${h.toString(36)}`,
    bg: BACKGROUNDS[h % BACKGROUNDS.length],
    skin: SKIN[(h >>> 3) % SKIN.length],
    hair: HAIR[(h >>> 6) % HAIR.length],
    shirt: SHIRTS[(h >>> 9) % SHIRTS.length],
    style: (h >>> 12) % 5,
    glasses: ((h >>> 15) % 4) === 0,
  };
}

@Component({
  selector: 'ph-avatar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="avatar" [style.width.px]="size" [style.height.px]="size" [class.ring]="ring">
      @if (photo() && !failed()) {
        <img [src]="photo()" [alt]="alt || name" [width]="size" [height]="size" loading="lazy" decoding="async" (error)="failed.set(true)" />
      } @else {
        <svg viewBox="0 0 64 64" [attr.width]="size" [attr.height]="size" role="img" [attr.aria-label]="alt || name">
          <defs>
            <linearGradient [attr.id]="p().id + 'bg'" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" [attr.stop-color]="p().bg[0]" />
              <stop offset="1" [attr.stop-color]="p().bg[1]" />
            </linearGradient>
            <clipPath [attr.id]="p().id + 'clip'"><circle cx="32" cy="32" r="32" /></clipPath>
          </defs>
          <g [attr.clip-path]="'url(#' + p().id + 'clip)'">
            <rect width="64" height="64" [attr.fill]="'url(#' + p().id + 'bg)'" />
            @if (p().style === 2) {
              <!-- long hair behind the shoulders -->
              <path d="M14 30c0-12 8-20 18-20s18 8 18 20v22H14z" [attr.fill]="p().hair" />
            }
            <!-- shoulders and shirt -->
            <path d="M8 64c2-12 11-18 24-18s22 6 24 18z" [attr.fill]="p().shirt" />
            <path d="M26 46h12l-6 7z" fill="#ffffff" opacity="0.85" />
            <!-- neck -->
            <rect x="27" y="38" width="10" height="9" rx="4" [attr.fill]="p().skin" />
            <!-- face -->
            <ellipse cx="32" cy="29" rx="11" ry="12.5" [attr.fill]="p().skin" />
            <!-- ears -->
            <ellipse cx="21" cy="30" rx="2" ry="3" [attr.fill]="p().skin" />
            <ellipse cx="43" cy="30" rx="2" ry="3" [attr.fill]="p().skin" />
            <!-- hair styles -->
            @switch (p().style) {
              @case (0) { <path d="M20.5 26c0-8 5-13 11.5-13S43.5 18 43.5 26c-3-4-7-6-11.5-6s-8.5 2-11.5 6z" [attr.fill]="p().hair" /> }
              @case (1) { <path d="M20 27c-1-9 5-15 12-15 8 0 13 6 12 14-2-5-6-7-9-7-1 3-6 5-15 8z" [attr.fill]="p().hair" /> }
              @case (2) { <path d="M20 29c-1-10 5-17 12-17s13 7 12 17c-2-6-6-9-12-9s-10 3-12 9z" [attr.fill]="p().hair" /> }
              @case (3) {
                <circle cx="32" cy="11" r="5" [attr.fill]="p().hair" />
                <path d="M20.5 27c0-8 5-13 11.5-13S43.5 19 43.5 27c-3-4-7-6-11.5-6s-8.5 2-11.5 6z" [attr.fill]="p().hair" />
              }
              @default {
                <path d="M20 26c-1-2 0-6 2-8 1-3 5-5 8-5 2-1 6-1 8 1 3 1 6 4 6 9 0 2-1 3-1 4-2-3-5-5-7-5-3 1-6 1-9 0-3 0-6 2-7 4z" [attr.fill]="p().hair" />
              }
            }
            <!-- eyes, brows and smile -->
            <ellipse cx="27.5" cy="30" rx="1.3" ry="1.6" fill="#1f2937" />
            <ellipse cx="36.5" cy="30" rx="1.3" ry="1.6" fill="#1f2937" />
            <path d="M25.5 26.6q2-1.2 4 0M34.5 26.6q2-1.2 4 0" stroke="#1f2937" stroke-width="0.9" stroke-linecap="round" fill="none" opacity="0.6" />
            <path d="M28.5 35q3.5 2.6 7 0" stroke="#7a3b2e" stroke-width="1.3" stroke-linecap="round" fill="none" />
            @if (p().glasses) {
              <g fill="none" stroke="#1f2937" stroke-width="0.9" opacity="0.85">
                <rect x="23.5" y="27.2" width="8" height="5.6" rx="2.4" />
                <rect x="32.5" y="27.2" width="8" height="5.6" rx="2.4" />
                <path d="M31.5 29.5h1" />
              </g>
            }
          </g>
        </svg>
      }
    </span>
  `,
  styles: [
    `
      :host { display: inline-flex; flex: none; }
      .avatar { display: inline-flex; border-radius: 50%; overflow: hidden; background: var(--ph-surface-muted); }
      .avatar.ring { box-shadow: 0 0 0 2px var(--ph-surface), 0 0 0 4px var(--ph-primary-ring); }
      img, svg { display: block; width: 100%; height: 100%; object-fit: cover; }
    `,
  ],
})
export class Avatar {
  private readonly nameSig = signal('');
  readonly photo = signal<string | null>(null);
  readonly failed = signal(false);
  readonly p = computed(() => portraitFor(this.nameSig()));

  @Input() size = 40;
  @Input() alt = '';
  @Input() ring = false;
  @Input({ required: true }) set name(value: string) {
    this.nameSig.set(value ?? '');
  }
  get name() {
    return this.nameSig();
  }
  @Input() set photoUrl(value: string | null | undefined) {
    this.photo.set(value || null);
    this.failed.set(false);
  }
}
