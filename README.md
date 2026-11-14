# PeopleHub: HR, Attendance, Leave and Payroll

**Live demo:** https://hr-payroll-brown.vercel.app

PeopleHub is an HR and payroll app for small and medium Indian companies. It is a single **Angular 20** project: no server, no database to install. Its API runs inside the browser and keeps the data in IndexedDB, so `npm start` is all it takes.

> Demo data only. The seeded company, employees and figures are fictional. Bank and PAN values are synthetic. Payroll rates and tax values must be verified with a qualified professional before real use.

## 1. Run it

Requirements: Node.js 20 or newer (tested with Node 24, npm 11).

```bash
npm install
npm start          # http://localhost:4200
```

The first visit builds a demo company in the browser (22 employees, about six months of attendance, four payroll runs). All dates are relative to today, so the data never looks stale. The sign-in page has one-click cards for each role and a **Reset demo data** link.

| Role | Email | What it can do |
|---|---|---|
| Super Admin | `superadmin@lotus-demo.example` | Everything, including organization identity |
| HR Admin | `hr@lotus-demo.example` | Employees, sensitive data, attendance, leave, payroll, settings |
| Manager | `manager@lotus-demo.example` | Direct reports only: attendance, leave approvals, corrections |
| Employee | `employee@lotus-demo.example` | Own profile, attendance, leave, payslips |

All demo accounts use the password `PeopleHub@2026` (set in `src/app/local-api/db/seed.ts`).

## 2. Scripts

| Command | Purpose |
|---|---|
| `npm start` | Development server on http://localhost:4200 |
| `npm run build` | Production build in `dist/peoplehub/browser` (budgets enforced) |
| `npm test` | Unit and API tests (Vitest, runs in Node, no browser needed) |
| `npm run typecheck` | Type-check the app and the tests |
| `npm run icons` | Rebuild the Material Symbols font subset after adding icons |

The production build is a static site: upload `dist/peoplehub/browser` to any static host (Netlify, Vercel, GitHub Pages, S3). Configure the host to serve `index.html` for unknown paths, so deep links such as `/payroll` work.

## 3. Project structure

```
HR Payrol/
├─ src/
│  ├─ index.html, main.ts, styles.scss
│  └─ app/
│     ├─ app.config.ts, app.routes.ts   Providers and lazy-loaded routes
│     ├─ core/          API client, session state, guards, toasts, theme, local-api interceptor
│     ├─ layout/        Responsive shell, command palette (Ctrl/Cmd + K), notifications, punch toggle
│     ├─ shared/        State views, dialogs, badges, SVG charts, avatars, formatters, file download
│     ├─ features/      One folder per area: landing, auth, dashboard, employees, attendance,
│     │                 leave, payroll, reports, admin
│     └─ local-api/     The app's API, running in the browser (see below)
│        ├─ index.ts    Runtime: routing, sessions, one transaction per request, saving
│        ├─ http/       Express-style router and permission guards
│        ├─ db/         Schema (row types), tables, IndexedDB storage, demo seed
│        ├─ lib/        Time zones, money (integer paise), CSV, hashing, audit log, notifications
│        ├─ security/   Role-to-permission matrix and sessions
│        └─ modules/    auth, employees, attendance, leave, payroll, org, reports, dashboard,
│                       notifications. Each has *.routes.ts, *.service.ts and pure *.rules.ts
├─ public/              Favicon and the icon font subset
├─ scripts/             Icon font subsetting
├─ angular.json, package.json, tsconfig*.json, vitest.config.ts
└─ README.md
```

## 4. How the data works

- **Screens call an API, as before.** Components call `/api/...` through Angular's `HttpClient`. The interceptor in `core/local-api.interceptor.ts` answers those calls with `local-api`, loaded on the first request in its own chunk, so the landing page stays small.
- **Storage.** Tables live in memory and are saved to IndexedDB after every change. Another open tab picks up the change on its next request.
- **Transactions.** Requests run one at a time, and each runs as a transaction: if a request fails, nothing it changed is kept.
- **Rules live in the API.** Role permissions and record scope (HR: everyone, Manager: direct reports, Employee: self) are checked on every request, not only in the menus.
- **Moving to a real server later.** Serve the same endpoints from a backend and remove the interceptor from `app.config.ts`. The screens do not change, and the code in `local-api/modules` maps closely to a server's route, service and rules layers.

## 5. What's in the product

- **Public landing page** at `/`: product overview, workflow, roles, security and FAQ.
- **Role dashboards** with KPIs, attendance and payroll charts, a department donut, celebrations, tasks and announcements.
- **Employees:** directory with search, filters and sorting, profiles, onboarding and offboarding, CSV import (validated before saving) and export, profile photos, salary structures.
- **Attendance:** punch in and out any number of times a day, monthly calendar, corrections, and overtime approval.
- **Leave:** casual, sick, earned and unpaid leave with accrual, half days, overlap checks, cancellations and a team calendar.
- **Payroll:** Draft → Validated → Approved → Finalized, adjustments, payslips (print or PDF), payment recording and a bank transfer file.
- **Reports** (`/reports`): headcount, joiners and exits, attendance rate, absenteeism, late arrivals, overtime, leave use and payroll cost with reconciliation. Each section exports CSV.
- **Notifications** for requests, decisions, payroll approvals and new payslips. **Audit log** of sensitive actions.
- Light and dark themes, reduced-motion support, and layouts from phone to desktop.

## 6. Security model

This build keeps every rule of the original server, applied inside the browser:

- **Passwords** are salted, iterated SHA-256 hashes. Five failed sign-ins lock an account for 15 minutes, and error messages never reveal whether an account exists.
- **Sessions** last 8 hours. Signing out or resetting a password changes the user's token version, which ends their sessions in every tab.
- **Password reset** uses a random single-use token stored only as a hash, valid for 30 minutes. There is no mail server, so reset and welcome links are printed to the browser console (`lib/mailer.ts` is the place to plug in a mail API).
- **Restricted data:** bank account and PAN numbers are masked in every view. Revealing them is a separate, audited request, and exports never include PAN.
- **Audit trail:** sensitive actions are logged with the actor, action, record and a redacted change summary.

Know the limits: all data sits in the browser's storage, so anyone with access to that browser profile can read it. This is right for a demo, a prototype or a single-device deployment. A multi-user production deployment needs a server and database (see section 4).

## 7. Attendance rules

- **Toggle in the header.** One switch punches in or out. A day can have any number of sessions, and the header shows a live total.
- **Total hours** are the sum of all sessions. Gaps between sessions count as breaks.
- **Unpaid break.** If a day spans more than `breakDeductionAfterMinutes` but the punched breaks are shorter than `standardBreakMinutes`, the shortfall is deducted.
- **Late, overtime, half day.** Late is measured from the first punch-in. Overtime is counted hours beyond the scheduled shift. A day is a half day when counted hours are under half the shift, judged only after the shift has ended.
- **Holidays and weekly offs.** Punching in is not offered on those days; an open session can still be closed.
- **Safeguards.** A second punch within 60 seconds is rejected as a double tap. Only one session can be open at a time. A session left open for more than 16 hours is closed at that day's shift end and marked "auto-closed".
- **Corrections.** With both times, the day is replaced by one session. With one time, the first punch-in or last punch-out moves.
- **Overtime** of 30 minutes or more becomes a claim. A manager or HR approves all or part of it, or rejects it; payroll pays approved minutes only.

## 8. Payroll rules

- Money is stored as integer paise. Percentages use basis points with BigInt intermediates and half-up rounding.
- Workflow: **Draft → Validated → Approved → Finalized**. The creator cannot approve or finalize their own run.
- Each entry keeps a snapshot of its inputs and results. Finalizing does not mean salary was paid: payment is recorded per employee with a bank reference.
- Loss of pay: absent and unpaid-leave days, half days, and days before joining or after exit. Working days exclude weekly offs and holidays.
- PF, ESI, professional tax and TDS are explicit per-employee or per-organization settings. No statutory slabs are hardcoded.

Rules that need professional verification before real use: PF wage ceiling handling (EPS/EDLI split not modelled), ESI eligibility, professional tax by state, TDS and overtime pay.

## 9. API overview

All endpoints are under `/api` and answered in the browser by `src/app/local-api`. Errors use one format: `{ "error": { "code", "message", "details?" } }`.

| Area | Endpoints | Permission |
|---|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET /auth/session` | Public / session |
| Auth | `POST /auth/forgot-password`, `POST /auth/reset-password` | Public |
| Demo | `GET /auth/demo-accounts`, `POST /auth/demo-reset` | Public |
| Dashboard | `GET /dashboard`, `GET /dashboard/announcements` | Session (view depends on role) |
| Employees | `GET /employees`, `POST /employees`, `GET /employees/meta` | `employees:read` / `employees:write` |
| Employees | `GET /employees/:id`, `PATCH /employees/:id`, `POST /employees/:id/offboard` | Scoped / `employees:write` |
| Employees | `PUT /employees/:id/bank-details`, `GET /employees/:id/sensitive` | `employees:sensitive` (audited) |
| Employees | `POST /employees/:id/salary`, `GET /employees/:id/salary-history` | `payroll:manage` / `payroll:read` |
| Employees | `GET /employees/export.csv`, `POST /employees/import`, `PUT/DELETE /employees/:id/photo` | `employees:export` / `employees:write` / HR or self |
| Attendance | `GET /attendance/today`, `POST /attendance/punch`, `GET /attendance/calendar`, `GET /attendance/summary`, `GET /attendance` | Own profile / scoped |
| Attendance | `POST /attendance/corrections`, `GET /attendance/corrections`, `POST /attendance/corrections/:id/review` | Own / manager scope / HR |
| Attendance | `GET /attendance/overtime`, `POST /attendance/overtime/review` | Own / manager scope / HR |
| Leave | `GET/POST /leave/types`, `PATCH /leave/types/:id`, `GET /leave/balances`, `GET/POST /leave/requests` | Session / `leave:manage` / scoped |
| Leave | `POST /leave/requests/:id/decision`, `/cancel`, `/cancellation-decision`, `GET /leave/calendar` | Manager scope / own / scoped |
| Payroll | `GET/POST /payroll/runs`, `GET /payroll/runs/:id`, `POST /payroll/runs/:id/recalculate`, `/validate`, `/reopen` | `payroll:read` / `payroll:manage` |
| Payroll | `POST /payroll/runs/:id/approve`, `/finalize`, `GET /payroll/runs/:id/bank-export.csv` | `payroll:approve` / `payroll:bank-export` |
| Payroll | `POST /payroll/entries/:entryId/payment`, `GET/POST /payroll/adjustments`, `GET /payroll/reports/summary` | `payroll:manage` / `payroll:read` |
| Payroll | `GET /payroll/payslips/mine`, `GET /payroll/payslips/:entryId`, `GET /payroll/payslips/:entryId/pdf` | Own (HR scoped) |
| Org | `GET/PATCH /org/profile`, departments, designations, holidays, announcements, `GET /org/audit-logs` | Session / `org:manage` / `audit:read` |
| Reports | `GET /reports/overview`, `GET /reports/export.csv?type=headcount\|attendance\|leave\|payroll` | `reports:read` |
| Notifications | `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` | Own only |

## 10. Testing

```bash
npm test
```

- **Rules:** attendance (grace periods, late minutes, breaks, overtime, half days), leave (working days, accrual, balances, overlaps), payroll (proration, PF/ESI ceilings, overtime, adjustments, negative net pay, rounding) and employee codes and reporting lines.
- **API:** runs the real API against the seeded demo company in memory: authentication, role and record scope, restricted data, payslip ownership and PDF, separation of duties, validation errors, transactions, persistence and demo reset.

Not covered by automated tests yet: component tests and end-to-end browser tests.

## 11. Known limitations

- **Single browser.** Data is stored per browser profile. Two people on two computers do not share data; that needs a server (section 4).
- **Email** is not sent: reset and welcome links appear in the browser console.
- **Payment** status is recorded by hand from the bank file. There is no bank integration.
- **Statutory calculations** are configurable but not verified for current rules (section 8).
- **Not built yet:** employee document uploads (profile photos are supported), reversal of finalized payroll (use an adjustment in a later run), multiple shifts, and location or identity checks on punch-in.
- **Reports** cover at most 186 days per request.
