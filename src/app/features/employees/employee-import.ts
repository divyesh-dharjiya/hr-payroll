import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Title } from '@angular/platform-browser';
import { Api, ApiError } from '../../core/api';
import { Notify } from '../../core/notify';
import { StatusBadge } from '../../shared/ui';
import { csvEscape } from '../../shared/format';
import { saveFile } from '../../shared/download';

const TEMPLATE_HEADERS = [
  'employeeCode',
  'firstName',
  'lastName',
  'workEmail',
  'joiningDate',
  'departmentName',
  'designationTitle',
  'employmentType',
  'managerEmail',
  'phone',
];
const MAX_ROWS = 1000;

interface RowResult {
  row: number;
  valid: boolean;
  errors: { field: string; message: string }[];
  employeeCode?: string;
}
interface ImportResponse {
  committed: boolean;
  summary: { total: number; valid: number; invalid: number; created?: number };
  rows: RowResult[];
}

/** Minimal RFC-4180 CSV parser: handles quoted fields, escaped quotes and CRLF line endings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

@Component({
  selector: 'ph-employee-import',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonModule, MatIconModule, StatusBadge],
  template: `
    <div class="page">
      <nav class="crumbs" aria-label="Breadcrumb"><a routerLink="/employees">Employees</a> / <span>Import</span></nav>
      <header class="page-header">
        <div>
          <h1>Import employees from CSV</h1>
          <p>Each row is validated first. Nothing is saved until every row is valid, and duplicate work emails or codes are rejected.</p>
        </div>
        <button mat-stroked-button type="button" (click)="downloadTemplate()"><mat-icon>description</mat-icon> Download template</button>
      </header>

      <section class="card">
        <h2 class="card-title">1. Choose a file</h2>
        <p class="muted">Columns: {{ headers.join(', ') }}. Department and designation names must already exist. Up to {{ maxRows }} rows.</p>
        <label class="file">
          <span class="visually-hidden">Choose CSV file</span>
          <input type="file" accept=".csv,text/csv" (change)="onFile($event)" aria-describedby="file-hint" />
        </label>
        <p id="file-hint" class="muted small">{{ fileName() ? 'Selected: ' + fileName() : 'No file selected.' }}</p>
        @if (rowCount() > 0) {
          <p class="muted small">{{ rowCount() }} data row(s) read.</p>
        }
        <div class="toolbar">
          <button mat-flat-button color="primary" type="button" [disabled]="rowCount() === 0 || checking()" (click)="validate()">
            {{ checking() ? 'Checking…' : 'Validate rows' }}
          </button>
        </div>
      </section>

      @if (result(); as r) {
        <section class="card" aria-labelledby="result-title">
          <h2 id="result-title" class="card-title">2. Review</h2>
          <p role="status">
            <strong>{{ r.summary.valid }}</strong> valid, <strong>{{ r.summary.invalid }}</strong> with errors, out of {{ r.summary.total }} rows.
          </p>
          @if (r.summary.invalid > 0) {
            <div class="table-wrap">
              <table class="data">
                <caption class="sr-only">Rows that need fixing</caption>
                <thead><tr><th scope="col">Row</th><th scope="col">Status</th><th scope="col">Problems</th></tr></thead>
                <tbody>
                  @for (row of invalidRows(); track row.row) {
                    <tr>
                      <td>{{ row.row }}</td>
                      <td><ph-status-badge label="Fix needed" tone="bad" /></td>
                      <td>
                        <ul class="problems">
                          @for (e of row.errors; track e.field + e.message) {
                            <li><strong>{{ e.field }}:</strong> {{ e.message }}</li>
                          }
                        </ul>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="ok"><mat-icon aria-hidden="true">check_circle</mat-icon> All rows are valid and ready to import.</p>
          }
          <div class="toolbar end">
            <button mat-flat-button color="primary" type="button" [disabled]="r.summary.invalid > 0 || committing()" (click)="commit()">
              {{ committing() ? 'Importing…' : 'Import ' + r.summary.valid + ' employees' }}
            </button>
          </div>
        </section>
      }

      @if (committed(); as c) {
        <section class="card" role="status">
          <h2 class="card-title">Import complete</h2>
          <p>{{ c.created }} employees were created. Sign-in accounts were not created for imported rows; add them from each profile when needed.</p>
          <a mat-stroked-button routerLink="/employees">Back to employees</a>
        </section>
      }
    </div>
  `,
  styles: [
    `
      .crumbs { font-size: 13px; color: var(--ph-text-muted); }
      .crumbs a { color: var(--ph-primary); text-decoration: none; }
      .muted { color: var(--ph-text-muted); }
      .small { font-size: 12px; }
      .file { display: block; margin: 12px 0 6px; }
      .file input { font: inherit; }
      .end { justify-content: flex-end; }
      .problems { margin: 0; padding-left: 18px; }
      .ok { display: flex; align-items: center; gap: 8px; color: var(--ph-success); font-weight: 600; }
      .visually-hidden, .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    `,
  ],
})
export class EmployeeImport {
  private readonly api = inject(Api);
  private readonly notify = inject(Notify);
  private readonly title = inject(Title);

  readonly headers = TEMPLATE_HEADERS;
  readonly maxRows = MAX_ROWS;
  readonly fileName = signal('');
  readonly rows = signal<Record<string, string>[]>([]);
  readonly rowCount = computed(() => this.rows().length);
  readonly checking = signal(false);
  readonly committing = signal(false);
  readonly result = signal<ImportResponse | null>(null);
  readonly committed = signal<{ created: number } | null>(null);
  readonly invalidRows = computed(() => this.result()?.rows.filter((r) => !r.valid) ?? []);

  constructor() {
    this.title.setTitle('Import employees | PeopleHub');
  }

  async onFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    this.result.set(null);
    this.committed.set(null);
    if (!file) return;
    this.fileName.set(file.name);
    const text = await file.text();
    const table = parseCsv(text);
    if (table.length < 2) {
      this.rows.set([]);
      this.notify.error('The file needs a header row and at least one data row.');
      return;
    }
    if (table.length - 1 > MAX_ROWS) {
      this.rows.set([]);
      this.notify.error(`Import at most ${MAX_ROWS} rows at a time.`);
      return;
    }
    const header = table[0].map((h) => h.trim());
    const data = table.slice(1).map((cells) => {
      const obj: Record<string, string> = {};
      header.forEach((h, i) => {
        const key = TEMPLATE_HEADERS.find((t) => t.toLowerCase() === h.replace(/\s+/g, '').toLowerCase()) ?? h;
        obj[key] = (cells[i] ?? '').trim();
      });
      return obj;
    });
    this.rows.set(data);
  }

  async validate() {
    this.checking.set(true);
    try {
      this.result.set(await this.api.post<ImportResponse>('/employees/import', { rows: this.rows(), commit: false }));
    } catch (err) {
      this.notify.error(err instanceof ApiError ? err.message : 'Validation failed.');
    } finally {
      this.checking.set(false);
    }
  }

  async commit() {
    this.committing.set(true);
    try {
      const res = await this.api.post<ImportResponse>('/employees/import', { rows: this.rows(), commit: true });
      this.committed.set({ created: res.summary.created ?? 0 });
      this.notify.success(`${res.summary.created ?? 0} employees imported.`);
    } catch (err) {
      this.notify.error(err instanceof ApiError ? err.message : 'Import failed. Nothing was saved.');
      await this.validate();
    } finally {
      this.committing.set(false);
    }
  }

  downloadTemplate() {
    const example = ['EMP-9001', 'Asha', 'Rao', 'asha.rao@lotus-demo.example', '2026-11-02', 'Engineering', 'Software Engineer', 'FULL_TIME', '', '+91 99999 00001']
      .map(csvEscape)
      .join(',');
    saveFile('employee-import-template.csv', [TEMPLATE_HEADERS.map(csvEscape).join(','), example].join('\n'));
  }
}
