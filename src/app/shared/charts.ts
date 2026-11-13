import { ChangeDetectionStrategy, Component, Input, computed, signal } from '@angular/core';

export interface DonutSlice {
  label: string;
  value: number;
}

const DONUT_COLORS = ['#4f46e5', '#0ea5e9', '#14b8a6', '#f59e0b', '#e11d48', '#8b5cf6', '#64748b', '#22c55e'];

/** Donut chart with a legend that lists every value as text, so colour is never the only cue. */
@Component({
  selector: 'ph-donut-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="donut" [attr.aria-label]="ariaLabel">
      <svg viewBox="0 0 120 120" role="img" [attr.aria-label]="ariaLabel">
        <circle cx="60" cy="60" r="44" fill="none" stroke="var(--ph-surface-muted)" stroke-width="16" />
        @for (s of arcs(); track s.label) {
          <circle
            class="arc"
            cx="60" cy="60" r="44" fill="none"
            [attr.stroke]="s.color"
            stroke-width="16"
            [attr.stroke-dasharray]="s.dash + ' ' + (circumference - s.dash)"
            [attr.stroke-dashoffset]="-s.offset"
            transform="rotate(-90 60 60)"
          ><title>{{ s.label }}: {{ s.value }}</title></circle>
        }
        <text x="60" y="58" text-anchor="middle" class="total">{{ total() }}</text>
        <text x="60" y="74" text-anchor="middle" class="caption">{{ centerLabel }}</text>
      </svg>
      <figcaption>
        <ul class="legend">
          @for (s of arcs(); track s.label) {
            <li><span class="dot" [style.background]="s.color" aria-hidden="true"></span><span class="lbl">{{ s.label }}</span><span class="val">{{ s.value }} · {{ s.pct }}%</span></li>
          }
        </ul>
      </figcaption>
    </figure>
  `,
  styles: [
    `
      .donut { margin: 0; display: grid; grid-template-columns: 150px 1fr; gap: 18px; align-items: center; }
      svg { width: 150px; height: 150px; }
      .arc { transition: stroke-width 160ms; animation: ph-fade-in 700ms var(--ph-ease) both; }
      .arc:hover { stroke-width: 19; }
      .total { font-size: 22px; font-weight: 700; fill: var(--ph-text); }
      .caption { font-size: 9px; fill: var(--ph-text-muted); text-transform: uppercase; letter-spacing: 0.08em; }
      .legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
      .legend li { display: grid; grid-template-columns: 10px 1fr auto; gap: 10px; align-items: center; font-size: 13px; }
      .dot { width: 10px; height: 10px; border-radius: 3px; }
      .val { color: var(--ph-text-muted); font-variant-numeric: tabular-nums; }
      @media (max-width: 480px) { .donut { grid-template-columns: 1fr; justify-items: center; } .legend { width: 100%; } }
    `,
  ],
})
export class DonutChart {
  @Input({ required: true }) ariaLabel = '';
  @Input() centerLabel = 'Total';
  private readonly data = signal<DonutSlice[]>([]);
  @Input({ required: true }) set slices(v: DonutSlice[]) {
    this.data.set((v ?? []).filter((s) => s.value > 0));
  }
  readonly circumference = 2 * Math.PI * 44;
  readonly total = computed(() => this.data().reduce((s, d) => s + d.value, 0));
  readonly arcs = computed(() => {
    const total = this.total() || 1;
    let offset = 0;
    return this.data().map((d, i) => {
      const dash = (d.value / total) * this.circumference;
      const arc = { ...d, color: DONUT_COLORS[i % DONUT_COLORS.length], dash, offset, pct: Math.round((d.value / total) * 100) };
      offset += dash;
      return arc;
    });
  });
}

export interface BarDatum {
  label: string;
  value: number;
  /** Optional second value rendered as a stacked segment. */
  secondary?: number;
}

/**
 * Lightweight SVG column chart. No charting library: a few hundred bytes of markup per chart keeps the bundle small.
 * Every bar exposes its value as text (aria and <title>), so the chart is readable without colour.
 */
@Component({
  selector: 'ph-bar-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (data.length === 0) {
      <p class="muted">No data for this period yet.</p>
    } @else {
      <figure class="chart" [attr.aria-label]="ariaLabel">
        <svg [attr.viewBox]="'0 0 ' + width + ' ' + height" role="img" [attr.aria-label]="ariaLabel" preserveAspectRatio="none">
          @for (bar of bars(); track bar.label; let i = $index) {
            <g class="bar" [style.animation-delay.ms]="i * 30">
              <title>{{ bar.label }}: {{ bar.text }}</title>
              <rect [attr.x]="bar.x" [attr.y]="bar.y" [attr.width]="bar.w" [attr.height]="bar.h" rx="4" class="bar-primary"></rect>
              @if (bar.h2 > 0) {
                <rect [attr.x]="bar.x" [attr.y]="bar.y2" [attr.width]="bar.w" [attr.height]="bar.h2" rx="4" class="bar-secondary"></rect>
              }
            </g>
          }
          <line x1="0" [attr.y1]="height - 1" [attr.x2]="width" [attr.y2]="height - 1" class="axis"></line>
        </svg>
        <figcaption class="labels">
          @for (d of data; track d.label; let i = $index) {
            <span [class.hide]="i % labelEvery() !== 0">{{ d.label }}</span>
          }
        </figcaption>
      </figure>
    }
  `,
  styles: [
    `
      .chart { margin: 0; }
      svg { width: 100%; height: 180px; display: block; }
      .bar { transform-box: fill-box; transform-origin: 50% 100%; animation: ph-grow-y 640ms var(--ph-ease) both; }
      .bar:hover rect { filter: brightness(1.12); }
      .bar-primary { fill: var(--ph-primary); }
      .bar-secondary { fill: var(--ph-warning); opacity: 0.85; }
      .axis { stroke: var(--ph-border); stroke-width: 1; vector-effect: non-scaling-stroke; }
      .labels { display: flex; justify-content: space-between; gap: 2px; margin: 6px 0 0; font-size: 11px; color: var(--ph-text-muted); overflow: hidden; }
      .labels span { flex: 1; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .labels span.hide { visibility: hidden; }
      .muted { color: var(--ph-text-muted); }
    `,
  ],
})
export class BarChart {
  @Input({ required: true }) ariaLabel = '';
  @Input() valueFormat: (n: number) => string = (n) => String(n);
  @Input({ required: true }) set values(v: BarDatum[]) {
    this.data = v ?? [];
    this.recompute();
  }
  data: BarDatum[] = [];
  readonly width = 600;
  readonly height = 180;
  private readonly tick = signal(0);

  readonly bars = computed(() => {
    this.tick();
    return this.layout;
  });
  labelEvery = () => Math.max(1, Math.ceil(this.data.length / 8));

  private layout: { label: string; text: string; x: number; y: number; w: number; h: number; y2: number; h2: number }[] = [];

  private recompute() {
    const max = Math.max(1, ...this.data.map((d) => d.value + (d.secondary ?? 0)));
    const gap = 4;
    const slot = this.data.length ? this.width / this.data.length : this.width;
    // Cap the bar width so a short series (one or two months) does not stretch into a block.
    const w = Math.min(64, Math.max(2, slot - gap));
    const usable = this.height - 6;
    this.layout = this.data.map((d, i) => {
      const h = (d.value / max) * usable;
      const h2 = ((d.secondary ?? 0) / max) * usable;
      const x = i * slot + (slot - w) / 2;
      return {
        label: d.label,
        text: this.valueFormat(d.value + (d.secondary ?? 0)),
        x,
        w,
        h,
        y: this.height - 1 - h - h2,
        h2,
        y2: this.height - 1 - h2,
      };
    });
    this.tick.update((n) => n + 1);
  }
}
