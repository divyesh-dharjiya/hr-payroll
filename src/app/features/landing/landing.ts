import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Meta, Title } from '@angular/platform-browser';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Auth } from '../../core/auth';
import { Theme } from '../../core/theme';
import { Avatar } from '../../shared/avatar';
import { ProductMockup } from '../../shared/product-mockup';

const FEATURES = [
  { icon: 'groups', title: 'Employee records', text: 'Directory, reporting lines, onboarding and offboarding, CSV import with duplicate checks, and profile photos.' },
  { icon: 'schedule', title: 'Attendance', text: 'Punch in and out, shift and grace rules, late and overtime tracking, and correction approvals.' },
  { icon: 'event_available', title: 'Leave', text: 'Casual, sick, earned and unpaid leave with accrual, half days, overlap checks and team calendars.' },
  { icon: 'payments', title: 'Payroll', text: 'Configurable earnings and deductions, loss of pay, adjustments and a four-step approval workflow.' },
  { icon: 'receipt_long', title: 'Payslips', text: 'Print-ready payslips with earnings, deductions, paid days and year-to-date totals for every employee.' },
  { icon: 'insights', title: 'Reports', text: 'Headcount, absenteeism, leave utilisation and payroll cost with filters and CSV export.' },
  { icon: 'notifications', title: 'Notifications', text: 'Managers hear about requests to review; employees hear about decisions and new payslips.' },
  { icon: 'verified_user', title: 'Security', text: 'Role-based access on every request, masked bank and PAN data, and an audit trail of sensitive actions.' },
];

const STEPS = [
  { key: 'Draft', text: 'Pay is calculated from attendance, approved leave, salary structures and adjustments.' },
  { key: 'Validated', text: 'Blocking issues such as missing salaries or negative net pay are caught before anyone approves.' },
  { key: 'Approved', text: 'A different person approves the run. The creator cannot approve their own payroll.' },
  { key: 'Finalized', text: 'The run is locked with a snapshot of every calculation. Payments are then recorded separately.' },
];

const ROLES = [
  { name: 'Super Admin', person: 'Aarav Kapoor', text: 'Company settings, statutory rules, every module and the full audit trail.' },
  { name: 'HR Admin', person: 'Priya Sharma', text: 'People records, payroll runs, leave policies, reports and sensitive data on request.' },
  { name: 'Manager', person: 'Arjun Mehta', text: 'Their team only: attendance, leave approvals, corrections and upcoming absences.' },
  { name: 'Employee', person: 'Vikram Singh', text: 'Check in, request leave, see balances and download their own payslips.' },
];

const FAQ = [
  { q: 'Is payroll compliant out of the box?', a: 'PeopleHub ships with configurable PF, ESI, professional tax and TDS settings rather than fixed statutory rates. Confirm every rate, ceiling and eligibility rule with a qualified professional before running live payroll.' },
  { q: 'Does finalizing payroll pay employees?', a: 'No. Finalizing locks the calculation. The bank transfer file is generated for your bank, and each payment is recorded with its reference once it has actually been made.' },
  { q: 'Who can see salaries and bank details?', a: 'Only HR and Super Admin roles. Bank account and PAN values are masked by default, and every reveal is written to the audit log.' },
  { q: 'Does check-in verify location?', a: 'No. Check-in records the time of the punch. It does not verify where the person is or who they are.' },
];

@Component({
  selector: 'ph-landing',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonModule, MatIconModule, Avatar, ProductMockup],
  template: `
    <header class="nav-bar">
      <div class="wrap nav-inner">
        <a class="brand" routerLink="/" aria-label="PeopleHub home">
          <span class="logo" aria-hidden="true"><svg viewBox="0 0 32 32" width="20" height="20"><path d="M8 24V8h9a6 6 0 0 1 0 12h-5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="23.5" cy="23.5" r="2.5" fill="#a5f3fc"/></svg></span>
          PeopleHub
        </a>
        <nav class="links" aria-label="Page sections">
          <a href="#features">Features</a>
          <a href="#payroll">Payroll</a>
          <a href="#roles">Roles</a>
          <a href="#security">Security</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div class="actions">
          <button mat-icon-button type="button" (click)="theme.toggle()" [attr.aria-label]="theme.isDark() ? 'Switch to light theme' : 'Switch to dark theme'">
            <mat-icon>{{ theme.isDark() ? 'light_mode' : 'dark_mode' }}</mat-icon>
          </button>
          @if (auth.isSignedIn()) {
            <a mat-flat-button color="primary" routerLink="/dashboard">Open dashboard</a>
          } @else {
            <a mat-button routerLink="/login" class="hide-sm">Sign in</a>
            <a mat-flat-button color="primary" routerLink="/login">Try the live demo</a>
          }
        </div>
      </div>
    </header>

    <main id="main">
      <section class="hero">
        <div class="glow" aria-hidden="true"></div>
        <div class="wrap hero-grid">
          <div class="hero-copy stagger">
            <span class="eyebrow"><mat-icon aria-hidden="true">auto_awesome</mat-icon> HR and payroll for Indian SMEs</span>
            <h1>People, attendance and payroll in one <span class="grad">calm, connected</span> workspace.</h1>
            <p class="lead">PeopleHub replaces spreadsheets and email threads with one system your HR team, managers and employees actually enjoy using. Every number on screen comes from your records.</p>
            <div class="cta">
              <a mat-flat-button color="primary" routerLink="/login" class="big">Explore the demo <mat-icon iconPositionEnd>arrow_forward</mat-icon></a>
              <a mat-stroked-button href="#features" class="big">See what's inside</a>
            </div>
            <ul class="ticks">
              <li><mat-icon aria-hidden="true">check_circle</mat-icon> Four roles, permissions checked on every request</li>
              <li><mat-icon aria-hidden="true">check_circle</mat-icon> Rupee-accurate payroll with approval workflow</li>
              <li><mat-icon aria-hidden="true">check_circle</mat-icon> Works on phones, tablets and desktops</li>
            </ul>
          </div>
          <ph-product-mockup class="hero-visual" />
        </div>
      </section>

      <section class="facts" aria-label="Product facts">
        <div class="wrap facts-grid">
          <div><strong>4</strong><span>role-based workspaces</span></div>
          <div><strong>4-step</strong><span>payroll approval workflow</span></div>
          <div><strong>No server</strong><span>runs entirely in the browser</span></div>
          <div><strong>Audit trail</strong><span>for payroll, pay data and access</span></div>
        </div>
      </section>

      <section id="features" class="section">
        <div class="wrap">
          <div class="section-head">
            <span class="eyebrow">Everything in one place</span>
            <h2>From joining day to payslip</h2>
            <p>Each module shares the same people, calendar and rules, so leave flows into attendance and attendance flows into pay.</p>
          </div>
          <div class="features">
            @for (f of features; track f.title) {
              <article class="feature card interactive">
                <span class="f-icon" aria-hidden="true"><mat-icon>{{ f.icon }}</mat-icon></span>
                <h3>{{ f.title }}</h3>
                <p>{{ f.text }}</p>
              </article>
            }
          </div>
        </div>
      </section>

      <section id="payroll" class="section tinted">
        <div class="wrap split">
          <div class="section-head left">
            <span class="eyebrow">Payroll you can trust</span>
            <h2>Every run is checked, approved and locked</h2>
            <p>Money is calculated in exact paise with a documented rounding policy. Loss of pay comes from attendance and approved unpaid leave, and nothing is assumed: PF, ESI and tax apply only where you configure them.</p>
            <a mat-stroked-button routerLink="/login">Walk through a payroll run</a>
          </div>
          <ol class="steps">
            @for (s of steps; track s.key; let i = $index) {
              <li class="step card">
                <span class="step-num">{{ i + 1 }}</span>
                <div><h3>{{ s.key }}</h3><p>{{ s.text }}</p></div>
              </li>
            }
          </ol>
        </div>
      </section>

      <section id="roles" class="section">
        <div class="wrap">
          <div class="section-head">
            <span class="eyebrow">Built for every role</span>
            <h2>Everyone sees exactly what they need</h2>
            <p>Managers see their team, employees see themselves, and HR sees the company. The API checks it on every request.</p>
          </div>
          <div class="roles">
            @for (r of roles; track r.name) {
              <article class="role card interactive">
                <ph-avatar [name]="r.person" [size]="56" [ring]="true" />
                <h3>{{ r.name }}</h3>
                <p>{{ r.text }}</p>
              </article>
            }
          </div>
        </div>
      </section>

      <section id="security" class="section tinted">
        <div class="wrap split">
          <div class="section-head left">
            <span class="eyebrow">Security and privacy</span>
            <h2>Sensitive data stays sensitive</h2>
            <p>Designed around least privilege, with protections that don't depend on hiding buttons.</p>
          </div>
          <ul class="sec-list">
            <li><mat-icon aria-hidden="true">lock</mat-icon><div><strong>Masked identifiers</strong><span>Bank accounts and PAN show only their last four characters; a full reveal is audited.</span></div></li>
            <li><mat-icon aria-hidden="true">admin_panel_settings</mat-icon><div><strong>Permissions in the API</strong><span>Every endpoint checks role and record scope, not just the menu.</span></div></li>
            <li><mat-icon aria-hidden="true">history</mat-icon><div><strong>Audit trail</strong><span>Who changed what and when, without ever storing passwords or full bank numbers.</span></div></li>
            <li><mat-icon aria-hidden="true">password</mat-icon><div><strong>Account protection</strong><span>Salted password hashes, lockout after repeated failures and single-use reset links.</span></div></li>
          </ul>
        </div>
      </section>

      <section id="faq" class="section">
        <div class="wrap narrow">
          <div class="section-head">
            <span class="eyebrow">Questions</span>
            <h2>Straight answers</h2>
          </div>
          @for (f of faq; track f.q) {
            <details class="faq card">
              <summary>{{ f.q }}<mat-icon aria-hidden="true">expand_more</mat-icon></summary>
              <p>{{ f.a }}</p>
            </details>
          }
        </div>
      </section>

      <section class="section">
        <div class="wrap">
          <div class="cta-band">
            <div>
              <h2>See it with real workflows</h2>
              <p>The demo company has 22 fictional employees, two months of attendance and a finalized payroll. Pick a role and sign in with one click.</p>
            </div>
            <a mat-flat-button routerLink="/login" class="big light">Open the demo <mat-icon iconPositionEnd>arrow_forward</mat-icon></a>
          </div>
        </div>
      </section>
    </main>

    <footer class="footer">
      <div class="wrap foot-inner">
        <span>© {{ year }} PeopleHub. Demo build with fictional data.</span>
        <span class="muted">Statutory rates are configurable and should be verified by a qualified professional.</span>
      </div>
    </footer>
  `,
  styles: [
    `
      :host { display: block; background: var(--ph-bg); min-height: 100vh; }
      .wrap { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
      .narrow { max-width: 820px; }
      .nav-bar { position: sticky; top: 0; z-index: 10; background: color-mix(in srgb, var(--ph-bg) 80%, transparent); backdrop-filter: saturate(160%) blur(12px); border-bottom: 1px solid var(--ph-border); }
      .nav-inner { height: 68px; display: flex; align-items: center; gap: 24px; }
      .brand { display: flex; align-items: center; gap: 10px; font-weight: 750; font-size: 17px; letter-spacing: -0.02em; color: var(--ph-text); text-decoration: none; }
      .logo { width: 34px; height: 34px; border-radius: 10px; background: var(--ph-gradient-brand); display: grid; place-items: center; }
      .links { display: flex; gap: 22px; margin-left: 12px; flex: 1; }
      .links a { color: var(--ph-text-muted); text-decoration: none; font-weight: 550; }
      .links a:hover { color: var(--ph-text); }
      .actions { display: flex; gap: 8px; align-items: center; margin-left: auto; }

      .hero { position: relative; overflow: hidden; padding: 64px 0 40px; }
      .glow { position: absolute; inset: -20% -10% auto; height: 620px; background: radial-gradient(closest-side, rgba(99, 102, 241, 0.22), transparent 70%), radial-gradient(closest-side at 80% 30%, rgba(14, 165, 233, 0.16), transparent 70%); pointer-events: none; }
      .hero-grid { position: relative; display: grid; grid-template-columns: 1.05fr 1fr; gap: 40px; align-items: center; }
      h1 { font-size: clamp(34px, 5vw, 56px); line-height: 1.05; letter-spacing: -0.04em; margin: 16px 0; font-weight: 800; }
      .grad { background: var(--ph-gradient-text); -webkit-background-clip: text; background-clip: text; color: transparent; }
      .lead { font-size: 18px; color: var(--ph-text-muted); max-width: 560px; margin: 0; }
      .eyebrow mat-icon { font-size: 16px; width: 16px; height: 16px; }
      .cta { display: flex; gap: 12px; flex-wrap: wrap; margin: 28px 0 22px; }
      .big { height: 48px !important; padding: 0 22px !important; font-size: 15px !important; border-radius: 12px !important; }
      .ticks { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; color: var(--ph-text-muted); }
      .ticks li { display: flex; gap: 8px; align-items: center; }
      .ticks mat-icon { color: var(--ph-success); font-size: 20px; width: 20px; height: 20px; }

      .facts { border-block: 1px solid var(--ph-border); background: var(--ph-surface); }
      .facts-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; padding-top: 26px; padding-bottom: 26px; }
      .facts-grid div { display: flex; flex-direction: column; gap: 2px; }
      .facts-grid strong { font-size: 26px; letter-spacing: -0.03em; background: var(--ph-gradient-text); -webkit-background-clip: text; background-clip: text; color: transparent; }
      .facts-grid span { color: var(--ph-text-muted); }

      .section { padding: 88px 0; }
      .tinted { background: var(--ph-gradient-soft); border-block: 1px solid var(--ph-border); }
      .section-head { text-align: center; max-width: 680px; margin: 0 auto 44px; }
      .section-head.left { text-align: left; margin: 0; }
      .section-head h2, .cta-band h2 { font-size: clamp(26px, 3.4vw, 38px); letter-spacing: -0.03em; margin: 10px 0 12px; line-height: 1.15; }
      .section-head p { color: var(--ph-text-muted); font-size: 16px; margin: 0 0 18px; }

      .features { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
      .feature h3, .role h3, .step h3 { margin: 14px 0 6px; font-size: 16px; letter-spacing: -0.01em; }
      .feature p, .role p, .step p { margin: 0; color: var(--ph-text-muted); }
      .f-icon { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: var(--ph-primary-soft); color: var(--ph-primary); }

      .split { display: grid; grid-template-columns: 1fr 1.1fr; gap: 48px; align-items: center; }
      .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; position: relative; }
      .step { display: grid; grid-template-columns: 44px 1fr; gap: 14px; align-items: start; }
      .step h3 { margin-top: 2px; }
      .step-num { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-weight: 750; color: #fff; background: var(--ph-gradient-brand); box-shadow: 0 8px 18px -8px rgba(79, 70, 229, 0.7); }

      .roles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
      .role { text-align: left; }

      .sec-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
      .sec-list li { display: grid; grid-template-columns: 40px 1fr; gap: 14px; padding: 16px; border-radius: var(--ph-radius); background: var(--ph-surface); border: 1px solid var(--ph-border); }
      .sec-list mat-icon { color: var(--ph-primary); background: var(--ph-primary-soft); border-radius: 10px; width: 40px; height: 40px; display: grid; place-items: center; font-size: 22px; line-height: 40px; text-align: center; }
      .sec-list strong { display: block; }
      .sec-list span { color: var(--ph-text-muted); }

      .faq { margin-bottom: 12px; padding: 0; }
      .faq summary { list-style: none; cursor: pointer; padding: 18px 20px; font-weight: 650; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
      .faq summary::-webkit-details-marker { display: none; }
      .faq summary mat-icon { transition: transform var(--ph-dur) var(--ph-ease); }
      .faq[open] summary mat-icon { transform: rotate(180deg); }
      .faq p { margin: 0; padding: 0 20px 18px; color: var(--ph-text-muted); }

      .cta-band { display: flex; justify-content: space-between; align-items: center; gap: 24px; flex-wrap: wrap; padding: 44px; border-radius: 24px; background: var(--ph-gradient-brand); color: #fff; box-shadow: var(--ph-shadow-lg); }
      .cta-band h2 { margin-top: 0; }
      .cta-band p { margin: 0; opacity: 0.9; max-width: 560px; }
      .light { background: #fff !important; color: #3730a3 !important; }

      .footer { border-top: 1px solid var(--ph-border); padding: 26px 0; color: var(--ph-text-muted); font-size: 13px; }
      .foot-inner { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
      .muted { color: var(--ph-text-subtle); }

      @media (max-width: 1080px) {
        .features, .roles { grid-template-columns: repeat(2, 1fr); }
        .links { display: none; }
      }
      @media (max-width: 860px) {
        .hero-grid, .split { grid-template-columns: 1fr; }
        .facts-grid { grid-template-columns: repeat(2, 1fr); }
        .hero { padding-top: 40px; }
      }
      @media (max-width: 560px) {
        .wrap { padding: 0 16px; }
        .features, .roles { grid-template-columns: 1fr; }
        .section { padding: 60px 0; }
        .cta-band { padding: 28px; }
        .hide-sm { display: none !important; }
      }
    `,
  ],
})
export class LandingPage implements OnInit {
  readonly auth = inject(Auth);
  readonly theme = inject(Theme);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly doc = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  readonly features = FEATURES;
  readonly steps = STEPS;
  readonly roles = ROLES;
  readonly faq = FAQ;
  readonly year = new Date().getFullYear();

  ngOnInit() {
    void this.auth.load().catch(() => null);
    const description =
      'PeopleHub is an HR and payroll platform for small and medium Indian companies: employees, attendance, leave, payroll with approvals, payslips, reports and audit trails.';
    this.title.setTitle('PeopleHub | HR, attendance, leave and payroll software for Indian SMEs');
    this.meta.updateTag({ name: 'description', content: description });
    // The public page is indexable; the signed-in app stays noindex (set in index.html).
    this.meta.updateTag({ name: 'robots', content: 'index, follow' });
    this.meta.updateTag({ property: 'og:title', content: 'PeopleHub: HR and payroll for Indian SMEs' });
    this.meta.updateTag({ property: 'og:description', content: description });
    this.meta.updateTag({ property: 'og:type', content: 'website' });
    this.meta.updateTag({ name: 'twitter:card', content: 'summary' });

    // Structured data for search engines. Describes the product only; no ratings or reviews are claimed.
    const script = this.doc.createElement('script');
    script.type = 'application/ld+json';
    script.text = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'PeopleHub',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      description,
      featureList: FEATURES.map((f) => f.title),
    });
    this.doc.head.appendChild(script);

    this.destroyRef.onDestroy(() => {
      script.remove();
      this.meta.updateTag({ name: 'robots', content: 'noindex, nofollow' });
    });
  }
}
