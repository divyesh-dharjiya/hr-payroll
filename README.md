# PeopleHub: HR, Attendance, Leave and Payroll

PeopleHub is an HR and payroll system for small and medium Indian companies. It is built as a separated **Angular** frontend and an **Express + Prisma + PostgreSQL** API. Every permission is enforced on the server. The frontend only shapes navigation.

> Demo data only. The seeded company, employees and figures are fictional. Bank and PAN values are synthetic. Payroll rates and tax values must be verified with a qualified professional before real use.

```
HR Payrol/
├─ client/   Angular 20 (standalone components, signals, Angular Material), lazy-loaded routes
├─ server/   Express 5 + TypeScript, Prisma 6, PostgreSQL, Zod validation, RBAC
└─ .claude/  preview launch configuration (optional)
```

## 1. Prerequisites

| Tool | Version used | Notes |
|---|---|---|
| Node.js | 24.x | npm 11 |
| PostgreSQL | 14+ (tested with 18) | Use your own install, or Docker (`postgres:16`) |

## 2. Setup (first time)

Run these in order. Replace the placeholder values in `server/.env`.

**Server**

```bash
cd server
npm install
```

Create `server/.env` from the example (PowerShell: `Copy-Item .env.example .env`):

```bash
cp .env.example .env
```

Fill in:

- `DATABASE_URL`: your PostgreSQL connection string.
- `JWT_SECRET`: at least 32 random characters.
- `DATA_ENCRYPTION_KEY`: 64 hex characters (32 bytes), used to encrypt bank and PAN values.
- `SEED_DEMO_PASSWORD`: the password for the development demo accounts (10+ characters).

Generate random secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then create the schema and demo data:

```bash
npx prisma migrate deploy
npm run seed
npm run dev
```

The API starts on `http://localhost:4000`.

**No PostgreSQL installed?** A local development database can run without a system install:

```bash
npm run db:dev        # starts PostgreSQL on localhost:5433 (see DEV_PG_PORT)
```

Set `DATABASE_URL=postgresql://peoplehub:peoplehub_dev_only@localhost:5433/peoplehub?schema=public` for it. This helper is for development only.

**Client**

```bash
cd client
npm install
npm start
```

Open `http://localhost:4200`. The dev server proxies `/api` to the API, so cookies stay same-origin.

## 3. Demo accounts (development only)

All accounts use the password in `SEED_DEMO_PASSWORD`.

**One-click demo sign-in.** With `DEMO_MODE=true` in `server/.env`, the sign-in page shows a card for each role. Choosing one types that account's email and password into the form and signs in. The password comes from the server at runtime, never from the frontend bundle. The `/api/auth/demo-accounts` endpoint returns 404 unless demo mode is on, and it is always off when `NODE_ENV=production`. Keep `DEMO_MODE=false` anywhere real data exists.

| Role | Email | What it can do |
|---|---|---|
| Super Admin | `superadmin@lotus-demo.example` | Everything, including organization identity |
| HR Admin | `hr@lotus-demo.example` | Employees, sensitive data, attendance, leave, payroll, settings |
| Manager | `manager@lotus-demo.example` | Direct reports only: attendance, leave approvals, corrections |
| Employee | `employee@lotus-demo.example` | Own profile, attendance, leave, payslips |

The sign-in page shows these as quick-fill buttons in development builds only.

## 3a. What's in the product

- **Public landing page** at `/`: product overview, workflow, roles, security, and FAQ. It is indexable, with metadata and structured data. Signed-in pages stay `noindex`.
- **Role dashboards** with animated KPIs, attendance and payroll charts, a department donut, celebrations, tasks and announcements.
- **Reports** (`/reports`): headcount, joiners and exits, attendance rate, absenteeism by department, late arrivals, overtime, leave use, and payroll cost with component breakdown and reconciliation. Each section has a CSV export, and the page is print-friendly.
- **Notifications:** in-app bell for leave requests and decisions, correction reviews, payroll approvals, and new payslips.
- **Quick search** (Ctrl/Cmd + K): jump to pages and find colleagues within your scope.
- **Profile photos:** HR can upload for anyone, employees for themselves. Images are resized and stripped of metadata in the browser, and checked again on the server.
- **Light and dark themes** (follows the system by default), animations that respect reduced motion, and responsive layouts from phone to desktop.

## 4. Scripts

| Location | Command | Purpose |
|---|---|---|
| server | `npm run dev` | API with reload |
| server | `npm run build` / `npm start` | Compile and run production build |
| server | `npm run seed` | Reset and reseed demo data (refuses in production) |
| server | `npm test` | Unit tests (payroll, attendance, leave rules) and authorization integration tests |
| server | `npx prisma migrate dev` | Create a new migration after editing `prisma/schema.prisma` |
| client | `npm start` | Dev server on port 4200 |
| client | `npm run build` | Production build (budgets enforced) |

## 5. Architecture

**Server** (`server/src`)

- `config/`: environment validation (fails fast on missing or weak secrets).
- `lib/`: errors, Prisma client, money (integer paise, half-up rounding), time zones, field encryption, audit log, mailer boundary.
- `security/permissions.ts`: the role-to-permission matrix, checked on every route.
- `middleware/auth.ts`: JWT in an HttpOnly cookie. The user is re-read on every request, and `tokenVersion` revokes sessions on logout and password change.
- `modules/<feature>/`: `*.rules.ts` (pure business rules), `*.service.ts` (persistence and scope), `*.routes.ts` (validation and HTTP).

**Client** (`client/src/app`)

- `core/`: API client with one error shape, session state, guards, notifications. Success toasts appear only after the server confirms.
- `shared/`: state views (loading, empty, error with retry), confirmation dialogs, status badges, SVG charts, formatters.
- `layout/`: responsive shell. The sidebar becomes a drawer on handsets.
- `features/`: one folder per area. Routes are lazy-loaded.

## 6. Security model

- Authentication: bcrypt (cost 12) password hashes, generic login errors, per-IP rate limiting, and a 15-minute lock after 5 failed attempts.
- Sessions: HttpOnly, SameSite=Lax cookie, 8-hour JWT, revoked by `tokenVersion`.
- Password reset: random single-use token, stored only as a SHA-256 hash, valid 30 minutes. The response never reveals whether an account exists.
- Authorization: role permissions plus record scope (HR: all; Manager: direct reports; Employee: self). Out-of-scope records return 404 rather than 403, so their existence isn't leaked.
- Restricted data: bank account and PAN are AES-256-GCM encrypted at rest and masked by default. Viewing them is an explicit, audited action. Exports and the bank transfer file never include PAN.
- Audit: sensitive actions are logged with actor, action, record and a redacted change summary. Passwords, tokens and full bank values are never logged.
- Input: all input is validated with Zod. Errors use one format: `{ "error": { "code", "message", "details?" } }`.
- CSRF: cookies are SameSite=Lax, state-changing requests must be JSON, and CORS is limited to `CLIENT_ORIGIN`.
- Headers: Helmet with a restrictive Content-Security-Policy.

## 6a. Attendance rules (punch in / punch out)

- **Toggle in the header.** One switch punches in or out. A day can have any number of sessions. The header shows a live total for the day.
- **Total hours** are the sum of all sessions. Gaps between sessions count as breaks.
- **Unpaid break.** If a day spans more than `breakDeductionAfterMinutes` but the punched breaks are shorter than `standardBreakMinutes`, the shortfall is deducted. Someone who never punches out for lunch is treated the same as someone who does. The card says when this happens.
- **Late, overtime, half day.** Late is measured from the first punch-in. Overtime is counted hours beyond the scheduled shift. A day is a half day when counted hours are under half the shift, judged only after the shift has ended.
- **Holidays and weekly offs.** The toggle is replaced by a label, and the server rejects punch-ins on those days. An already open session can still be closed.
- **Safeguards.**
  - A second punch within 60 seconds is rejected as a double tap.
  - A database index allows only one open session per employee.
  - A session left open for more than 16 hours is closed automatically at that day's shift end and marked "auto-closed". The employee can then request a correction.
- **Corrections.** With both times, the day is replaced by one session. With one time, the first punch-in or last punch-out is adjusted.

## 7. Payroll rules

- Money is stored as integer paise. Percentages use basis points with BigInt intermediates and half-up rounding.
- Workflow: **Draft → Validated → Approved → Finalized**. The creator cannot approve or finalize their own run.
- Finalization is a conditional database update, so it cannot run twice. Each entry keeps a snapshot of its inputs and results.
- Payment is tracked separately. Finalizing a run does not mean the salary was paid. Payment is recorded per employee with a bank reference.
- Loss of pay: absent and unpaid-leave days, half days, and days before joining or after exit. Working-day counting excludes weekly offs and holidays.
- PF, ESI, professional tax and TDS are explicit per-employee or per-organization settings. No statutory slabs are hardcoded. The engine records the rule used on each payslip.

Rules that need professional verification before real use: PF wage ceiling handling (EPS/EDLI split not modelled), ESI eligibility, professional tax by state, TDS, and overtime pay.

## 8. API overview

All endpoints are under `/api`. Responses are JSON. Errors follow the format in section 6.

| Area | Method and path | Permission |
|---|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | Public / session |
| Auth | `POST /auth/forgot-password`, `POST /auth/reset-password` | Public (rate limited) |
| Dashboard | `GET /dashboard`, `GET /dashboard/announcements` | Session (view depends on role) |
| Employees | `GET /employees/`, `POST /employees/`, `GET /employees/meta` | `employees:read` / `employees:write` |
| Employees | `GET /employees/:id`, `PATCH /employees/:id`, `POST /employees/:id/offboard` | Scoped / `employees:write` |
| Employees | `PUT /employees/:id/bank-details`, `GET /employees/:id/sensitive` | `employees:sensitive` (audited) |
| Employees | `POST /employees/:id/salary`, `GET /employees/:id/salary-history` | `payroll:manage` / `payroll:read` |
| Employees | `GET /employees/export.csv`, `POST /employees/import` | `employees:export` / `employees:write` |
| Attendance | `GET /attendance/today`, `POST /attendance/check-in`, `POST /attendance/check-out` | Own employee profile |
| Attendance | `GET /attendance/calendar`, `GET /attendance/summary`, `GET /attendance/` | Scoped |
| Attendance | `POST /attendance/corrections`, `GET /attendance/corrections`, `POST /attendance/corrections/:id/review` | Own / manager scope / HR |
| Leave | `GET /leave/types`, `POST /leave/types`, `PATCH /leave/types/:id` | Read: session / write: `leave:manage` |
| Leave | `GET /leave/balances`, `GET /leave/requests`, `POST /leave/requests` | Scoped / own |
| Leave | `POST /leave/requests/:id/decision`, `POST /leave/requests/:id/cancel`, `POST /leave/requests/:id/cancellation-decision` | Manager scope / own / manager scope |
| Leave | `GET /leave/calendar` | Scoped |
| Payroll | `GET/POST /payroll/runs`, `GET /payroll/runs/:id` | `payroll:read` / `payroll:manage` |
| Payroll | `POST /payroll/runs/:id/recalculate`, `/validate`, `/reopen` | `payroll:manage` |
| Payroll | `POST /payroll/runs/:id/approve`, `/finalize` | `payroll:approve` (separation of duties) |
| Payroll | `GET /payroll/runs/:id/bank-export.csv` | `payroll:bank-export` (audited) |
| Payroll | `POST /payroll/entries/:entryId/payment` | `payroll:manage` (finalized runs only) |
| Payroll | `GET/POST /payroll/adjustments`, `GET /payroll/reports/summary` | `payroll:read` / `payroll:manage` |
| Payroll | `GET /payroll/payslips/mine`, `GET /payroll/payslips/:entryId` | Own (HR scoped) |
| Org | `GET/PATCH /org/profile` | Read: session / write: `org:manage` (identity: Super Admin) |
| Org | `GET/POST/DELETE /org/departments`, `/org/designations` | `org:manage` (delete blocked while in use) |
| Org | `GET/POST/DELETE /org/holidays`, `GET/POST/DELETE /org/announcements` | `org:manage` (read: session, targeted) |
| Org | `GET /org/audit-logs` | `audit:read` |
| Reports | `GET /reports/overview?from&to&departmentId`, `GET /reports/export.csv?type=headcount|attendance|leave|payroll` | `reports:read` |
| Notifications | `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` | Own notifications only |
| Photos | `PUT/DELETE /employees/:id/photo`, `GET /files/photos/:name` | HR or self / same organization |
| Demo | `GET /auth/demo-accounts` | Only when `DEMO_MODE=true` outside production |

Health check: `GET /api/health`.

## 9. Testing

```bash
cd server
npm test
```

- Unit tests: attendance rules (grace periods, late minutes, break deduction, overtime, half days), leave rules (working-day counting, accrual, balances, overlaps), and payroll calculation (proration, PF/ESI ceilings, overtime, adjustments, negative net pay, rounding).
- Integration tests: authentication, role scoping, restricted-data access, payslip ownership, separation of duties, validation errors, and content-type protection. These run against the seeded development database, so run `npm run seed` first.

Not yet covered by automated tests: frontend unit tests, end-to-end browser tests, and finalization concurrency tests.

## 10. Known limitations

These are intentional gaps in this release. Each is a planned item, not something hidden.

- **Overtime pay** is disabled by default (`overtimeMultiplierBps = 0`). The overtime approval workflow is not built, and the spec pays approved overtime only.
- **Payslip PDF:** payslips are print-ready HTML. Use the browser's "Save as PDF". Server-side PDF generation is not implemented.
- **Email:** `lib/mailer.ts` is a boundary. In development it logs messages to the console. Production refuses to send until a provider is configured.
- **Payment:** the bank transfer file is generated, but payment status is recorded manually. There is no bank API integration.
- **Statutory calculations** are configurable and documented, but not verified for current rules. See section 7.
- **Not yet built:** employee document uploads (profile photos are supported), email delivery of notifications (they are in-app only), reversal of finalized payroll (corrections should be handled as adjustments in a new run), multiple shifts (one organization shift today), and break tracking (breaks are derived, not recorded).
- **Reports** cover at most 186 days per request, to keep the calculation fast.
- **Avatars:** people without an uploaded photo get a generated illustrated portrait. The demo uses no photos of real people.
- **Check-in** records server time but does not verify location or identity.
- **Multi-tenant:** every table is scoped by `organizationId`, but the UI and seed run one company.

## 11. Environment variables

See `server/.env.example`. Secrets are read from the environment only. Nothing secret is committed. `server/.env` is git-ignored.
