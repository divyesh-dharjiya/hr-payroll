import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Avatar } from './avatar';

/**
 * Illustrative product preview built from HTML and CSS (no screenshots), used on the landing and sign-in pages.
 * The figures are sample values for illustration and are labelled as such for assistive technology.
 */
@Component({
  selector: 'ph-product-mockup',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, Avatar],
  template: `
    <div class="stage" [class.compact]="compact" role="img" aria-label="Illustration of the PeopleHub dashboard with sample figures">
      <div class="window" aria-hidden="true">
        <div class="chrome"><span></span><span></span><span></span><div class="url">app.peoplehub · Dashboard</div></div>
        <div class="body">
          <aside class="side">
            <div class="logo"></div>
            @for (i of [1, 2, 3, 4, 5, 6]; track i) { <div class="nav" [class.on]="i === 1"></div> }
          </aside>
          <section class="main">
            <div class="hello"><div class="l1"></div><div class="l2"></div></div>
            <div class="kpis">
              <div class="kpi"><span class="k-lbl">Present today</span><span class="k-val">18</span><span class="k-bar ok"></span></div>
              <div class="kpi"><span class="k-lbl">On leave</span><span class="k-val">2</span><span class="k-bar info"></span></div>
              <div class="kpi"><span class="k-lbl">Payroll</span><span class="k-val">₹16.4L</span><span class="k-bar warn"></span></div>
            </div>
            <div class="row">
              <div class="chart">
                <div class="c-title"></div>
                <div class="bars">
                  @for (h of bars; track $index) { <span [style.height.%]="h" [style.animation-delay.ms]="$index * 60"></span> }
                </div>
              </div>
              <div class="people">
                <div class="c-title"></div>
                @for (p of people; track p) {
                  <div class="person"><ph-avatar [name]="p" [size]="22" /><span class="pl"></span><span class="pill"></span></div>
                }
              </div>
            </div>
          </section>
        </div>
      </div>

      <div class="float f1" aria-hidden="true">
        <span class="fi ok"><mat-icon>task_alt</mat-icon></span>
        <span><strong>Payroll finalized</strong><small>August · 21 payslips ready</small></span>
      </div>
      <div class="float f2" aria-hidden="true">
        <ph-avatar name="Ananya Iyer" [size]="30" />
        <span><strong>Leave approved</strong><small>2 days · Casual leave</small></span>
      </div>
      <div class="float f3" aria-hidden="true">
        <span class="fi info"><mat-icon>schedule</mat-icon></span>
        <span><strong>Checked in 09:28</strong><small>On time · Head office</small></span>
      </div>
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .stage { position: relative; padding: 28px 24px 36px; perspective: 1400px; }
      .window { background: var(--ph-surface); border: 1px solid var(--ph-border); border-radius: 16px; box-shadow: var(--ph-shadow-lg); overflow: hidden; transform: rotateX(4deg) rotateY(-8deg); transform-origin: center; animation: ph-scale-in 700ms var(--ph-ease) both; }
      .chrome { display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--ph-border); background: var(--ph-surface-muted); }
      .chrome > span { width: 9px; height: 9px; border-radius: 50%; background: #f97066; }
      .chrome > span:nth-child(2) { background: #fdb022; }
      .chrome > span:nth-child(3) { background: #47cd89; }
      .url { margin-left: 10px; font-size: 10.5px; color: var(--ph-text-subtle); background: var(--ph-surface); border: 1px solid var(--ph-border); border-radius: 6px; padding: 2px 10px; }
      .body { display: grid; grid-template-columns: 54px 1fr; min-height: 260px; }
      .side { border-right: 1px solid var(--ph-border); padding: 12px 10px; display: flex; flex-direction: column; gap: 9px; align-items: center; }
      .side .logo { width: 26px; height: 26px; border-radius: 8px; background: var(--ph-gradient-brand); margin-bottom: 6px; }
      .side .nav { width: 26px; height: 8px; border-radius: 4px; background: var(--ph-border); }
      .side .nav.on { background: var(--ph-primary); }
      .main { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
      .hello .l1 { width: 46%; height: 11px; border-radius: 6px; background: var(--ph-text); opacity: 0.85; }
      .hello .l2 { width: 30%; height: 8px; border-radius: 6px; background: var(--ph-border-strong); margin-top: 7px; }
      .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      .kpi { border: 1px solid var(--ph-border); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 3px; background: var(--ph-surface); }
      .k-lbl { font-size: 9.5px; color: var(--ph-text-subtle); }
      .k-val { font-size: 15px; font-weight: 750; letter-spacing: -0.02em; }
      .k-bar { height: 4px; border-radius: 3px; width: 70%; transform-origin: left; animation: ph-grow-x 900ms var(--ph-ease) both 300ms; }
      .k-bar.ok { background: var(--ph-success); }
      .k-bar.info { background: var(--ph-accent); width: 40%; }
      .k-bar.warn { background: var(--ph-primary); width: 85%; }
      .row { display: grid; grid-template-columns: 1.4fr 1fr; gap: 8px; }
      .chart, .people { border: 1px solid var(--ph-border); border-radius: 10px; padding: 10px; }
      .c-title { width: 50%; height: 7px; border-radius: 4px; background: var(--ph-border-strong); margin-bottom: 10px; }
      .bars { height: 82px; display: flex; align-items: flex-end; gap: 5px; }
      .bars span { flex: 1; border-radius: 4px 4px 2px 2px; background: linear-gradient(180deg, var(--ph-primary), color-mix(in srgb, var(--ph-primary) 55%, var(--ph-accent))); transform-origin: bottom; animation: ph-grow-y 800ms var(--ph-ease) both; }
      .person { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
      .pl { flex: 1; height: 6px; border-radius: 4px; background: var(--ph-border-strong); }
      .pill { width: 22px; height: 9px; border-radius: 6px; background: var(--ph-success-soft); border: 1px solid var(--ph-success); opacity: 0.7; }
      .float { position: absolute; display: flex; gap: 10px; align-items: center; padding: 10px 14px 10px 10px; border-radius: 14px; background: var(--ph-surface-raised); border: 1px solid var(--ph-border); box-shadow: var(--ph-shadow-md); animation: ph-fade-up 600ms var(--ph-ease) both, ph-float 6s ease-in-out infinite; font-size: 12px; }
      .float strong { display: block; font-size: 12.5px; }
      .float small { display: block; color: var(--ph-text-muted); font-size: 11px; }
      .fi { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; }
      .fi mat-icon { font-size: 17px; width: 17px; height: 17px; }
      .fi.ok { background: var(--ph-success-soft); color: var(--ph-success); }
      .fi.info { background: var(--ph-info-soft); color: var(--ph-info); }
      .f1 { top: 2px; right: 0; animation-delay: 400ms, 0s; }
      .f2 { bottom: 6px; left: 0; animation-delay: 650ms, 1.2s; }
      .f3 { bottom: 70px; right: -6px; animation-delay: 900ms, 2.4s; }
      .compact .f3 { display: none; }
      @media (max-width: 640px) {
        .window { transform: none; }
        .f3 { display: none; }
        .float { position: static; margin-top: 10px; animation: ph-fade-up 600ms var(--ph-ease) both; }
      }
    `,
  ],
})
export class ProductMockup {
  @Input() compact = false;
  readonly bars = [42, 58, 51, 72, 66, 84, 77, 91, 69, 88];
  readonly people = ['Vikram Singh', 'Sneha Patil', 'Karthik Reddy', 'Meera Joshi'];
}
