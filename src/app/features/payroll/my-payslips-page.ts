import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Title } from '@angular/platform-browser';
import { Api } from '../../core/api';
import { StateView, StatusBadge } from '../../shared/ui';
import { formatPaise, monthName } from '../../shared/format';
import { type MyPayslip, PayslipPdf } from './payslip.models';

@Component({
  selector: 'ph-my-payslips',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonModule, MatIconModule, StateView, StatusBadge],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>My payslips</h1>
          <p>Only finalized payroll appears here. Open a payslip, print it, or download it as a PDF.</p>
        </div>
      </header>
      <section class="card">
        <ph-state [state]="state()" (retry)="load()" title="Payslips could not be loaded">
          <div class="table-wrap">
            <table class="data">
              <caption class="sr-only">Finalized payslips</caption>
              <thead><tr><th scope="col">Period</th><th scope="col" class="num">Gross</th><th scope="col" class="num">Deductions</th><th scope="col" class="num">Net pay</th><th scope="col">Payment</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                @for (p of items(); track p.id) {
                  <tr>
                    <td>{{ monthName(p.period.month) }} {{ p.period.year }}</td>
                    <td class="num">{{ paise(p.grossPaise) }}</td>
                    <td class="num">{{ paise(p.deductionsPaise) }}</td>
                    <td class="num"><strong>{{ paise(p.netPaise) }}</strong></td>
                    <td><ph-status-badge [label]="p.paymentStatus === 'PAID' ? 'Paid' : 'Payment pending'" [tone]="p.paymentStatus === 'PAID' ? 'ok' : 'neutral'" /></td>
                    <td class="row-actions"><a mat-button [routerLink]="['/payslips', p.id]">View<span class="sr-only"> payslip for {{ monthName(p.period.month) }} {{ p.period.year }}</span></a><button mat-icon-button type="button" (click)="pdf.download(p.id, p.period)" [attr.aria-label]="'Download PDF for ' + monthName(p.period.month) + ' ' + p.period.year"><mat-icon>download</mat-icon></button></td>
                  </tr>
                } @empty {
                  <tr><td colspan="6" class="muted">No finalized payslips yet.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </ph-state>
      </section>
    </div>
  `,
  styles: [`.row-actions { white-space: nowrap; text-align: right; } .muted { color: var(--ph-text-muted); } .num { text-align: right; } .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }`],
})
export class MyPayslipsPage implements OnInit {
  private readonly api = inject(Api);
  private readonly title = inject(Title);
  readonly paise = formatPaise;
  readonly monthName = monthName;
  readonly pdf = inject(PayslipPdf);
  readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  readonly items = signal<MyPayslip[]>([]);

  ngOnInit() {
    this.title.setTitle('My payslips | PeopleHub');
    void this.load();
  }

  async load() {
    this.state.set('loading');
    try {
      this.items.set((await this.api.get<{ items: MyPayslip[] }>('/payroll/payslips/mine')).items);
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }
}

