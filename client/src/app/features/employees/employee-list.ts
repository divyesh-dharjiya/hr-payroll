import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, type PageEvent } from '@angular/material/paginator';
import { MatSelectModule } from '@angular/material/select';
import { Title } from '@angular/platform-browser';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { Notify } from '../../core/notify';
import type { Paged } from '../../core/models';
import { StateView, StatusBadge, type Tone } from '../../shared/ui';
import { formatDate } from '../../shared/format';
import { Avatar } from '../../shared/avatar';

interface EmployeeRow {
  id: string;
  employeeCode: string;
  name: string;
  workEmail: string;
  phone: string | null;
  photoUrl: string | null;
  status: 'ACTIVE' | 'ON_NOTICE' | 'EXITED';
  employmentType: string;
  joiningDate: string;
  department: { id: string; name: string };
  designation: { id: string; title: string };
  manager: { id: string; name: string } | null;
}

type SortKey = 'name' | 'code' | 'joiningDate' | 'department';

const STATUS: Record<string, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Active', tone: 'ok' },
  ON_NOTICE: { label: 'On notice', tone: 'warn' },
  EXITED: { label: 'Exited', tone: 'neutral' },
};

@Component({
  selector: 'ph-employee-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatPaginatorModule,
    MatSelectModule,
    StateView,
    StatusBadge,
    Avatar,
  ],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Employees</h1>
          <p>{{ auth.isHr() ? 'Everyone in the company' : 'Your direct reports' }}</p>
        </div>
        <div class="toolbar">
          @if (auth.has('employees:export')) {
            <button mat-stroked-button type="button" (click)="exportCsv()" [disabled]="exporting()">
              <mat-icon>download</mat-icon> Export CSV
            </button>
          }
          @if (auth.has('employees:write')) {
            <a mat-stroked-button routerLink="/employees/import"><mat-icon>upload_file</mat-icon> Import</a>
            <a mat-flat-button color="primary" routerLink="/employees/new"><mat-icon>person_add</mat-icon> Add employee</a>
          }
        </div>
      </header>

      <section class="card filters" aria-label="Filter employees">
        <mat-form-field appearance="outline" class="search">
          <mat-label>Search by name, code or email</mat-label>
          <mat-icon matPrefix aria-hidden="true">search</mat-icon>
          <input matInput type="search" [ngModel]="query()" (ngModelChange)="onSearch($event)" aria-label="Search employees" />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Department</mat-label>
          <mat-select [ngModel]="departmentId()" (ngModelChange)="setFilter('departmentId', $event)">
            <mat-option value="">All departments</mat-option>
            @for (d of departments(); track d.id) {
              <mat-option [value]="d.id">{{ d.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Status</mat-label>
          <mat-select [ngModel]="status()" (ngModelChange)="setFilter('status', $event)">
            <mat-option value="">Any status</mat-option>
            <mat-option value="ACTIVE">Active</mat-option>
            <mat-option value="ON_NOTICE">On notice</mat-option>
            <mat-option value="EXITED">Exited</mat-option>
          </mat-select>
        </mat-form-field>
      </section>

      <ph-state
        [state]="state()"
        (retry)="load()"
        title="Employees could not be loaded"
        message="Check your connection and try again."
      >
        @if (result(); as r) {
          @if (r.items.length === 0) {
            <ph-state state="empty" icon="person_search" title="No employees match these filters" message="Try a different search or clear the filters.">
              <button empty-action mat-stroked-button type="button" (click)="clearFilters()">Clear filters</button>
            </ph-state>
          } @else {
            <div class="table-wrap">
              <table class="data" aria-describedby="emp-count">
                <caption class="sr-only">Employee directory, sortable columns</caption>
                <thead>
                  <tr>
                    <th scope="col" [attr.aria-sort]="ariaSort('code')"><button type="button" class="sort" (click)="sortBy('code')">Code<mat-icon aria-hidden="true">{{ sortIcon('code') }}</mat-icon></button></th>
                    <th scope="col" [attr.aria-sort]="ariaSort('name')"><button type="button" class="sort" (click)="sortBy('name')">Name<mat-icon aria-hidden="true">{{ sortIcon('name') }}</mat-icon></button></th>
                    <th scope="col" [attr.aria-sort]="ariaSort('department')"><button type="button" class="sort" (click)="sortBy('department')">Department<mat-icon aria-hidden="true">{{ sortIcon('department') }}</mat-icon></button></th>
                    <th scope="col">Designation</th>
                    <th scope="col">Manager</th>
                    <th scope="col" [attr.aria-sort]="ariaSort('joiningDate')"><button type="button" class="sort" (click)="sortBy('joiningDate')">Joined<mat-icon aria-hidden="true">{{ sortIcon('joiningDate') }}</mat-icon></button></th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  @for (e of r.items; track e.id) {
                    <tr>
                      <td>{{ e.employeeCode }}</td>
                      <td>
                        <span class="person">
                          <ph-avatar [name]="e.name" [photoUrl]="e.photoUrl" [size]="36" />
                          <span><a class="name-link" [routerLink]="['/employees', e.id]">{{ e.name }}</a><span class="muted small">{{ e.workEmail }}</span></span>
                        </span>
                      </td>
                      <td>{{ e.department.name }}</td>
                      <td>{{ e.designation.title }}</td>
                      <td>{{ e.manager?.name ?? '—' }}</td>
                      <td>{{ formatDate(e.joiningDate) }}</td>
                      <td><ph-status-badge [label]="statusOf(e.status).label" [tone]="statusOf(e.status).tone" /></td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <mat-paginator
              [length]="r.total"
              [pageIndex]="r.page - 1"
              [pageSize]="r.pageSize"
              [pageSizeOptions]="[10, 20, 50]"
              (page)="onPage($event)"
              aria-label="Choose page of employees"
              showFirstLastButtons
            />
            <p id="emp-count" class="sr-only" aria-live="polite">{{ r.total }} employees</p>
          }
        }
      </ph-state>
    </div>
  `,
  styles: [
    `
      .filters { display: grid; grid-template-columns: minmax(240px, 2fr) repeat(2, minmax(160px, 1fr)); gap: 12px; padding: 16px; }
      .filters mat-form-field { margin: 0; }
      .sort { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; font: inherit; color: inherit; }
      .sort:focus-visible { outline: 2px solid var(--ph-primary); outline-offset: 2px; border-radius: 4px; }
      .sort mat-icon { font-size: 16px; width: 16px; height: 16px; }
      .person { display: flex; gap: 12px; align-items: center; }
      .person > span { display: flex; flex-direction: column; }
      .name-link { color: var(--ph-text); font-weight: 600; text-decoration: none; }
      .name-link:hover { color: var(--ph-primary); text-decoration: underline; }
      .muted { color: var(--ph-text-muted); }
      .small { font-size: 12px; }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
      @media (max-width: 900px) { .filters { grid-template-columns: 1fr 1fr; } .search { grid-column: 1 / -1; } }
      @media (max-width: 560px) { .filters { grid-template-columns: 1fr; } }
    `,
  ],
})
export class EmployeeList implements OnInit {
  readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly notify = inject(Notify);
  private readonly title = inject(Title);

  readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  readonly result = signal<Paged<EmployeeRow> | null>(null);
  readonly departments = signal<{ id: string; name: string }[]>([]);
  readonly exporting = signal(false);

  readonly query = signal('');
  readonly departmentId = signal('');
  readonly status = signal('');
  readonly sort = signal<SortKey>('name');
  readonly dir = signal<'asc' | 'desc'>('asc');
  readonly page = signal(1);
  readonly pageSize = signal(20);

  readonly statusOf = (s: EmployeeRow['status']) => STATUS[s] ?? { label: s, tone: 'neutral' as Tone };
  readonly formatDate = formatDate;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  readonly params = computed(() => ({
    q: this.query(),
    departmentId: this.departmentId(),
    status: this.status(),
    sort: this.sort(),
    dir: this.dir(),
    page: this.page(),
    pageSize: this.pageSize(),
  }));

  async ngOnInit() {
    this.title.setTitle('Employees | PeopleHub');
    if (this.auth.has('employees:read')) {
      const meta = await this.notify.run(() => this.api.get<{ departments: { id: string; name: string }[] }>('/employees/meta'));
      this.departments.set(meta?.departments ?? []);
    }
    await this.load();
  }

  onSearch(value: string) {
    this.query.set(value);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page.set(1);
      void this.load();
    }, 300);
  }

  setFilter(key: 'departmentId' | 'status', value: string) {
    if (key === 'departmentId') this.departmentId.set(value);
    else this.status.set(value);
    this.page.set(1);
    void this.load();
  }

  clearFilters() {
    this.query.set('');
    this.departmentId.set('');
    this.status.set('');
    this.page.set(1);
    void this.load();
  }

  sortBy(key: SortKey) {
    if (this.sort() === key) this.dir.set(this.dir() === 'asc' ? 'desc' : 'asc');
    else {
      this.sort.set(key);
      this.dir.set('asc');
    }
    void this.load();
  }

  sortIcon(key: SortKey) {
    if (this.sort() !== key) return 'unfold_more';
    return this.dir() === 'asc' ? 'arrow_upward' : 'arrow_downward';
  }

  ariaSort(key: SortKey) {
    if (this.sort() !== key) return 'none';
    return this.dir() === 'asc' ? 'ascending' : 'descending';
  }

  onPage(e: PageEvent) {
    this.page.set(e.pageIndex + 1);
    this.pageSize.set(e.pageSize);
    void this.load();
  }

  async load() {
    this.state.set('loading');
    try {
      const p = this.params();
      const data = await this.api.get<Paged<EmployeeRow>>('/employees/', {
        q: p.q || undefined,
        departmentId: p.departmentId || undefined,
        status: p.status || undefined,
        sort: p.sort,
        dir: p.dir,
        page: p.page,
        pageSize: p.pageSize,
      });
      this.result.set(data);
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  async exportCsv() {
    this.exporting.set(true);
    const p = this.params();
    const csv = await this.notify.run(() =>
      this.api.downloadText('/employees/export.csv', { q: p.q, departmentId: p.departmentId, status: p.status, sort: p.sort, dir: p.dir }),
      'Export ready. The file contains no bank or PAN data.',
    );
    this.exporting.set(false);
    if (csv) saveFile('employees.csv', csv);
  }
}

/** Downloads text content as a file via a temporary object URL. */
export function saveFile(name: string, content: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
