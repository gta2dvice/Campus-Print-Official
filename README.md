# Campus Print & Delivery

Campus Print is a campus print-ordering platform. Students upload documents, choose print options and a pickup slot, pay, and collect prints at a campus location. Shop staff process paid orders; a super-admin account oversees users, shops, orders, and payments.

This README describes **what this repository actually implements**. Anything listed in a product wishlist but missing from the code is marked **Not implemented yet**.

---

## 1. Project Overview

### Problem

Students typically wait in line at a campus print shop with files on a USB drive or phone. Campus Print lets them place a paid print job online and pick it up at a booked campus collection point.

### How the platform works

1. A **student** signs up or logs in on the public React site.
2. They upload files (PDF, DOCX, DOC, PNG, JPEG), set colour / paper / sides / copies / add-ons, and the backend estimates or detects page count.
3. They choose a **collection location** and **time slot**, then pay.
4. Before checkout, the backend persists a `PAYMENT_PENDING` order intent, payment row, customer/collection details, print configuration, and uploaded file references.
5. A trusted Cashfree verification or signed webhook marks that intent paid and assigns its ticket.
6. The order is assigned to **shop id 1** (hard-coded single-shop deployment).
7. A **shop admin** sees only paid orders as `pending`, downloads files, and moves them through accept → printing → ready → completed.
8. The student tracks status on the dashboard and keeps a **secure collection ticket** (ticket number, location, time, transaction ref).

Fulfilment in this codebase is **campus pickup**, not courier tracking. An “Express Delivery” add-on is a **price flag** stored on the order; it does not add a separate delivery workflow.

### Roles

| Role | Database value | Who | Access |
|---|---|---|---|
| Student | `student` (default on signup) | End user | `/`, `/dashboard`, `/new-order`, `/ticket` via `/api/auth` session |
| Printer / shop | `shop_admin` | Print shop operator | `/admin` via `/api/admin` session (`adminId`) |
| Platform admin | `super_admin` | Operator of the whole platform | `/super-admin` via `/api/super-admin` session |

Signup always creates a student. Shop and super-admin users are seeded with `npm run init-db` when `ADMIN_*` / `SUPER_ADMIN_*` env vars are set. Super-admin can deactivate users and approve/activate shops. **Creating a new shop through the API/UI is Not implemented yet** (schema seeds shop id `1` named “Campus Print”).

Student, shop-admin, and super-admin sessions are **separate** cookie fields on the same `express-session`. Logging into one panel does not automatically authenticate the others.

### Implemented Cashfree workflow

**Cashfree path**

1. Student submits checkout → `POST /api/orders/payment/create` calculates the amount server-side, creates the pending order/payment intent, stores uploaded files in Supabase Storage, and then creates a Cashfree payment session.
2. Browser opens Cashfree Checkout (modal); browser state is not the source of truth.
3. Cashfree calls `POST /api/orders/payment/webhook`. The server verifies its signature, fetches the Cashfree order and payment records, checks the ID/currency/amount, and idempotently settles the stored intent and assigns one ticket.
4. On return, `POST /api/orders/payment/verify` performs the same trusted server-side reconciliation and returns `PAID`, `PAYMENT_PENDING`, or `PAYMENT_FAILED`. The client retries pending confirmation and navigates to `/ticket?token=…` only when the backend confirms payment.
5. The opaque Cashfree order ID is retained locally before checkout. Reopening the site resumes verification; the guest ticket endpoint accepts a separate HMAC-derived bearer token, not a sequential order ID.

**Simulate path** remains a separate development-only route (`POST /api/orders/payment/simulate`) when Cashfree is not configured.

1. Create returns **503**.
2. Client calls `POST /api/orders/payment/simulate`.
3. Order + files + payment (`method: simulated`) are created the same way.

If Cashfree keys **are** set, simulate is rejected (`400`: use the real checkout).

The webhook and browser verification converge on the same transaction-locked settlement function. Unique constraints on Cashfree order IDs, ticket numbers, and guest ticket-token hashes prevent duplicate records. Shop/admin order lists and slot counts exclude unpaid intents. For webhook recovery in a deployed environment, set `PUBLIC_API_URL` to the publicly reachable API origin so Cashfree can reach the webhook; configure the same webhook in the Cashfree dashboard if required by the account.

### Order lifecycle

**Order statuses that exist** (`orders.status`, schema + `Order.VALID_STATUSES`):

`pending` → `accepted` → `printing` → `ready` → `completed`

Also: `rejected` (from `pending` only), `cancelled` (from `accepted` / `printing` / `ready`).

Shop-admin transitions (`Order.ALLOWED_TRANSITIONS`):

| From | Allowed next |
|---|---|
| `pending` | `accepted`, `rejected` |
| `accepted` | `printing`, `cancelled` |
| `printing` | `ready`, `cancelled` |
| `ready` | `completed`, `cancelled` |
| `completed` / `rejected` / `cancelled` | none |

`orders.status` remains the shop workflow and defaults to `pending`. Payment is tracked separately in `orders.payment_status` (`PAYMENT_PENDING`, `PAID`, `PAYMENT_FAILED`), so shop `pending` means “paid, waiting for the shop.” The corresponding `payments.status` is `pending`, `success`, `failed`, or `refunded`.

Mapping to the product lifecycle names:

| Named stage | In this repo |
|---|---|
| CREATE ORDER | Client form on `/new-order` (not a DB status). |
| PAYMENT PENDING | `orders.payment_status = PAYMENT_PENDING` and `payments.status = pending`; intent and files already exist before checkout. |
| PAYMENT VERIFIED | Signed webhook or `POST /api/orders/payment/verify` re-fetches Cashfree order and payment state, verifies amount/currency, and settles idempotently. |
| PAID | `orders.payment_status = PAID`, payment row `status = success`, and `ticket_number` is assigned. Print workflow `orders.status` becomes `pending`. |
| SENT TO PRINTER | **Not implemented yet** as a named state. After pay, the order is `pending` on shop `1` and listed in the shop admin panel. |
| ACCEPTED | `accepted` |
| PRINTING | `printing` |
| READY | `ready` (ready for **pickup**) |
| OUT FOR DELIVERY | **Not implemented yet** |
| DELIVERED / COMPLETED | `completed` (shop marks pickup done). There is no courier “delivered” status. |

**Payment statuses** (`payments.status`): `pending`, `success`, `failed`, `refunded`. Cashfree intents start as `pending` and transition to `success` or `failed`. Reject/cancel sets the payment to `refunded` in the **database only**. A Cashfree refund API call is **Not implemented yet**.

---

## 2. Key Features

### Student

- Email/password signup, login, logout, session (`/api/auth/*`).
- Marketing home page with a price estimator; values can be stored in `localStorage` (`cp_pending_order`) and applied on `/new-order`.
- Dashboard: order list and counts (total / in progress / ready).
- New order: up to 10 files, 20 MB each; types PDF, DOCX, DOC, PNG, JPEG.
- Page detection via `POST /api/orders/detect-pages` (PDF/DOCX parsed; images = 1 page; failures fall back to 1-page estimate).
- Print options: B&W ₹2/page, colour ₹5/page, A4 or A3 (+₹10/page), single/double sided (required), copies 1–99, spiral binding +₹20, express add-on +₹15.
- Pickup: Main Gate, Red Canteen, Hostel Gate. Booking is **time first**, then location. Offered points depend on the slot (9:25 and 11:15 → Red Canteen only; 1:15 → Red Canteen + Hostel Gate; 2:05 and 4:00 → all three). Slots close **5 minutes before** the labeled time (IST). Capacity 6 per location+slot, with live booking counts plus seed occupancy.
- Collection ticket after payment (`/ticket`).
- `/select-location` exists as a **standalone demo-style page** with hardcoded sample documents. The live booking UI used for real orders is the modal on `/new-order`.

**Not implemented yet:** student file download after upload, in-browser file preview, choosing a shop (always shop `1`), student-initiated cancel, email/SMS notifications, Google Maps embed (home only has an external Maps link).

### Printer / shop (`/admin`)

- Login for `role = shop_admin`.
- Dashboard stats, order list/filters, status transitions, reject with reason.
- View/download order files (until storage cleanup expires them).
- Earnings and shop-scoped payment list.
- Shop profile edit (name, hours, contact, open flag).
- Change own password (min 8 characters).

**Not implemented yet:** multi-shop routing of incoming orders, printer-side live delivery map.

### Admin (`/super-admin`)

- Login for `role = super_admin`.
- Platform dashboard, user list/detail, activate/deactivate users.
- Shop list/detail, approval (`pending` / `approved` / `rejected`), activate/deactivate, profile update.
- Global orders (read + file access; **no** shop-style status PATCH on this router).
- Payment stats, transactions, read-only Cashfree config status (no secrets to the browser).
- Analytics (order counts + earnings).
- Change own password.

**Not implemented yet:** create shop from UI, create shop-admin user from UI (seed via `init-db` / SQL), edit Cashfree keys from the UI.

### Payments

- Cashfree PG (`cashfree-pg`): create session, checkout.js v3 modal, verify, webhook signature check.
- Sandbox vs production via `CASHFREE_ENV`.
- Simulate checkout when keys are absent.
- Amounts in INR; student checkout sends `totalPrice` only (phone falls back to `CASHFREE_DEFAULT_PHONE`).

**Not implemented yet:** Razorpay or other gateways, Cashfree refunds, collecting customer phone from the order form.

### File upload / storage

- Multer memory upload on detect-pages, simulate, and verify.
- Files stored in a **private** Supabase Storage bucket (default `uploaded-pdfs`) at `{userId}/{orderId}/{uniqueName}`.
- Metadata in `order_files`. Access only through authenticated admin/super-admin document routes.
- Cleanup: files older than 24 hours (override `CLEANUP_TTL_MS`) — hourly in the Node process, `POST/GET /api/internal/cleanup-pdfs` with `CRON_SECRET`, Vercel cron hitting that path, optional Supabase Edge Function `cleanup-expired-pdfs`. Rows stay; `storage_path` is cleared and `file_deleted_at` is set.

### Order tracking

- Student dashboard labels and shop/super-admin status badges for the statuses above.
- Ticket shows ticket number, pickup location/time, and payment `transaction_ref`.

### Delivery

- Implemented as **scheduled campus collection**, not parcel delivery.
- `express_delivery` is a boolean add-on on the order and in pricing/UI.

**Not implemented yet:** out-for-delivery, courier assignment, proof of delivery, GPS tracking.

---

## 3. System Architecture

```
Student website  (/ , /dashboard, /new-order, /ticket)
Shop dashboard   (/admin)
Platform admin   (/super-admin)
        ↓
React SPA (Vite) — client-react
        ↓  /api  (same origin, or Vite proxy / Vercel rewrite)
Express API — server/
        ↓
PostgreSQL (Supabase)     +     Supabase Storage (private bucket)
        ↓
Shop dashboard consumes the same API (orders, files, earnings)
```

| Layer | What it does |
|---|---|
| Student website | Marketing, auth modal, order UI, ticket. |
| Frontend | React 19 + React Router. Role UIs are routes in one SPA. Auth is cookie session checked per layout. |
| Backend/API | Express 5: auth, orders, Cashfree, admin, super-admin, internal cron. Serves `client-react/dist` in production. |
| Database | Postgres tables: `users`, `shops`, `orders`, `order_files`, `payments`. RLS enabled with no anon policies; the server uses `DATABASE_URL` (bypasses RLS) and the Storage service role. |
| File storage | Private bucket; service role upload/download/delete. |
| Printer dashboard | Shop admin React pages calling `/api/admin`. |
| Payments | Cashfree from the server only. Browser loads `https://sdk.cashfree.com/js/v3/cashfree.js`. |

Data flow for a paid order: browser → detect-pages → payment/create → Cashfree → payment/verify → Postgres inserts + Storage upload → shop lists `pending` → status PATCH → student dashboard/ticket read the same `orders` row.

In-memory `express-session` is the session store (not Redis). Multiple server instances will not share logins.

---

## 4. Technologies & Services

| Technology/Service | Purpose | Where used |
|---|---|---|
| Node.js | Runtime | `server/`, root `npm` scripts |
| npm | Package manager | Root and `client-react` lockfiles |
| Express 5 | HTTP API + static SPA | `server/server.js`, `server/routes/` |
| express-session | Cookie auth | `server/server.js` |
| cors | Cross-origin + credentials | `server/server.js` |
| dotenv | Env loading | `server/loadEnv.js` |
| React 19 | UI | `client-react/` |
| React Router 7 | Routing | `client-react/src/App.jsx` |
| Vite 8 | Dev server, production build | `client-react/` |
| Tailwind CSS 4 | Admin / super-admin styling | `client-react` (`@tailwindcss/vite`) |
| Three.js | Home/page background animation | `client-react` (`FloatingLines`) |
| oxlint | Frontend lint | `client-react` `npm run lint` |
| PostgreSQL | Primary database | `server/db.js` (`pg`) |
| Supabase | Hosted Postgres + Storage + optional Edge Function | `supabase/`, `server/storage.js` |
| `@supabase/supabase-js` | Storage (and Edge Function client) | `server/supabaseClient.js`, `supabase/functions/` |
| Cashfree Payments | Checkout | `server/cashfree.js`, `cashfree-pg`, checkout.js |
| bcryptjs | Password hashing | `server/models/User.js`, `initDb.js` |
| multer | Multipart uploads | `server/middleware/upload.js`, orders routes |
| pdf-parse | PDF page count | `server/pageDetect.js` |
| jszip | DOCX page count (`docProps/app.xml`) | `server/pageDetect.js` |
| mysql2 | **One-off MySQL → Postgres copy** | `scripts/migrate-mysql-to-supabase.js` only |
| nodemon | API reload in development | `npm run dev` |
| Vercel | SPA hosting + hourly cleanup cron | `vercel.json`, `client-react/vercel.json` |

**Not used as the live database:** MySQL (legacy migrate script only). **Not present:** Razorpay, Redis, Docker files, GitHub Actions.

---

## 5. Prerequisites

The repo does not set `engines` on the root `package.json`. `@supabase/supabase-js` declares **Node.js >= 22**. Vite 8 / oxlint in the client generally need **Node 20.19+ or 22.12+**. Use **Node 22**.

| Tool | Required? | Notes |
|---|---|---|
| Node.js 22 | Yes | Runtime for API and Vite |
| npm | Yes | `package-lock.json` in root and `client-react` |
| Git | Yes | Clone / version control |
| Supabase project | Yes for a working app | Postgres + Storage |
| Cashfree merchant account | Optional | Without keys, simulate checkout is used |
| Supabase CLI | Optional | Only if you deploy `supabase/functions/cleanup-expired-pdfs` |
| MySQL | Optional | Only for `npm run migrate-mysql` |
| pnpm / yarn | No | Not used |

```bash
node --version
npm --version
git --version
```

A browser is required to use the UI.

---

## 6. Repository layout

```
Campus-Print/
├── client-react/          # React SPA (student + /admin + /super-admin)
├── server/                # Express API, models, Cashfree, storage
├── supabase/              # schema.sql, storage-policies.sql, Edge Function
├── scripts/               # MySQL migration; leftover copy-three.js (old path)
├── .env.example           # Backend variable names (no secrets)
├── package.json           # Root scripts and API dependencies
├── vercel.json            # Hourly cron → /api/internal/cleanup-pdfs
└── README.md
```

Copy `.env.example` to **`server/.env`** (preferred) or a root `.env`. `server/loadEnv.js` loads `server/.env` first, then root `.env` for keys that are still empty. Never commit `.env` files (see `.gitignore`).

---

## 7. Installation

```bash
git clone <this-repository-url>
cd Campus-Print
npm install
cd client-react
npm install
cd ..
```

---

## 8. Environment variables

Names taken from `.env.example` and server code. **Do not put real keys in git.**

### Required for a working API + uploads

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase Postgres URI |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Storage (and privileged) key |
| `SESSION_SECRET` | Session cookie signing |

### Strongly recommended

| Variable | Purpose |
|---|---|
| `PORT` | API port (default `3000`) |
| `NODE_ENV` | `production` enables `Secure` + `SameSite=None` cookies |
| `FRONTEND_URL` | Exact production frontend origin allowed by CORS + Cashfree `return_url` |
| `CORS_ORIGINS` | Optional comma-separated list of additional exact frontend origins allowed by CORS |
| `PUBLIC_API_URL` | Public HTTPS API origin for Cashfree `notify_url`; required when `NODE_ENV=production` |
| `SUPABASE_STORAGE_BUCKET` | Default `uploaded-pdfs` |
| `CRON_SECRET` | Protects `/api/internal/cleanup-pdfs` |

### Optional seeds (`npm run init-db`)

`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`

### Cashfree (server only)

| Variable | Purpose |
|---|---|
| `CASHFREE_APP_ID` | App ID (test or live pair) |
| `CASHFREE_SECRET_KEY` | Secret (same environment as App ID) |
| `CASHFREE_ENV` | `sandbox` or `production` (default `sandbox`) |
| `CASHFREE_DEFAULT_PHONE` | Fallback customer phone (default `9999999999`) |
| `TICKET_TOKEN_SECRET` | Dedicated secret used to derive secure guest ticket tokens (falls back to the Cashfree secret if unset) |

Use **test keys with `sandbox`** and **live keys with `production`**. Mixing them causes Cashfree “Authentication failed”. Payment-session failures are returned to the frontend and are not converted into simulated checkouts.

### Optional / not in `.env.example`

| Variable | Purpose |
|---|---|
| `CLEANUP_TTL_MS` | File TTL in ms (default 24 hours) |

### MySQL migrate only

`MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` (default database name `campusprint`)

### Frontend (`client-react/.env.example`)

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Leave empty for the Vercel `/api` rewrite. The helper that reads it is not used by every API call. |

---

## 9. Database and storage setup

1. Create a Supabase project.
2. Apply schema — either paste `supabase/schema.sql` in the SQL editor, or:

   ```bash
   npm run init-db
   ```

   `init-db` applies `supabase/schema.sql`, ensures `payments.gateway_order_id`, and optionally seeds shop-admin / super-admin users.

3. Storage → new **private** bucket named `uploaded-pdfs` (or your `SUPABASE_STORAGE_BUCKET`).
4. Run `supabase/storage-policies.sql` so anon/authenticated roles cannot read that bucket. The Node service role bypasses those policies.

Row Level Security is on for app tables with **no** client policies: the browser must not use the anon key against these tables.

---

## 10. Running locally

Use **one command** and **one URL**. Express serves the React site, API, Cashfree, and file uploads together.

```bash
npm run dev
```

Then open **http://localhost:3000** (or `PORT` if you set it).

That command builds the frontend, starts the API, and rebuilds the UI when you save React files. Refresh the browser after a UI change. Do not use port 5173 for day-to-day work.

Production-style (build once, then run without the file watcher):

```bash
npm run build:client
npm start
```

Same URL: **http://localhost:3000**.

| App | Path |
|---|---|
| Student site | `/` |
| Student dashboard | `/dashboard` |
| New order | `/new-order` |
| Shop admin | `/admin/login` |
| Super admin | `/super-admin/login` |

---

## 11. Scripts

Root `package.json`:

| Script | Command | Purpose |
|---|---|---|
| `npm start` | `node server/server.js` | API + built SPA on port 3000 |
| `npm run dev` | `node scripts/dev.js` | Build SPA, watch UI, run API+site on port 3000 |
| `npm run build:client` | `cd client-react && npm run build` | Output to `client-react/dist` |
| `npm run init-db` | `node server/initDb.js` | Schema + optional admin seeds |
| `npm run migrate-mysql` | `node scripts/migrate-mysql-to-supabase.js` | Copy legacy MySQL rows + local `server/uploads` into Supabase |
| `npm run cleanup-pdfs` | Node one-liner | Run storage cleanup once |
| `npm test` | stub | Prints “no test specified” and exits 1 |

`client-react`: `npm run dev`, `npm run build`, `npm run lint` (oxlint), `npm run preview`.

`scripts/copy-three.js` copies Three.js into `client/vendor/three`, which is **not** the current Vite app path. Treat it as leftover unless you still maintain that old tree.

---

## 12. HTTP API (summary)

Prefix `/api`. Student and payment routes use `credentials: 'include'`.

**Auth** — `/api/auth`: `POST /signup`, `POST /login`, `GET /status`, `POST /logout`

**Orders** — `/api/orders`: `GET /slots`, `GET /stats`, `GET /`, `GET /:id`, `POST /detect-pages`, `POST /payment/create`, `POST /payment/simulate`, `POST /payment/verify`, `POST /payment/webhook`

**Shop admin** — `/api/admin`: login/status/logout, dashboard, orders CRUD-style list/get/status/accept/reject, document GET, earnings, transactions, shop-profile GET/PUT, account password PUT

**Super admin** — `/api/super-admin`: login/status/logout, dashboard, users, shops (update/approval/active), orders (read + documents), payments, transactions, payment-gateway, analytics, account password PUT

**Internal** — `/api/internal/cleanup-pdfs` (Bearer or `?secret=` must match `CRON_SECRET`)

---

## 13. Deployment

Observed config (not a full Docker/K8s setup):

**Express host (e.g. Render, VM)**  
Set the env vars above, `NODE_ENV=production`, `FRONTEND_URL` to the exact public Vercel origin, and `PUBLIC_API_URL` to the public Render API origin. Vercel builds the frontend separately; Render can run backend-only without `client-react/dist`. If a client build is present, Express serves it; otherwise the API root returns a health response. Start Render with `npm start`. The process also runs PDF cleanup on boot and every hour.

**Vercel (`client-react/vercel.json`)**  
Static build of the SPA. Rewrites `/api/*` to `https://campus-print-1yeh.onrender.com/api/$1` (the URL currently in that file). Root `vercel.json` schedules:

```
0 * * * *  →  /api/internal/cleanup-pdfs
```

That cron only works if the Vercel project can reach an API that implements that path and accepts `CRON_SECRET`.

**Supabase Edge Function** `cleanup-expired-pdfs`: optional extra cleanup; `config.toml` sets `verify_jwt = false` and the function still checks `CRON_SECRET` when set.

The Vercel frontend uses relative `/api/...` requests; `client-react/vercel.json` rewrites them to `https://campus-print-1yeh.onrender.com/api/...`. No `VITE_API_URL` is required with this proxy setup. Keep `VITE_API_URL` unset unless all frontend API calls are migrated to use it. HTTPS is required for production cookies (`secure: true`).

---

## 14. Testing

Automated tests are **Not implemented yet** (`npm test` is a stub). Frontend check: `cd client-react && npm run lint` and `npm run build`.

Manual checks that match the code:

- Signup/login, new order, page counts, price total.
- Without Cashfree keys: pay → ticket (simulate).
- With matching Cashfree keys: checkout → verify → ticket; shop admin sees `pending`.
- Shop: accept → printing → ready → completed; reject sets payment `refunded` in DB.
- Admin document download; after TTL, `410` expired.

---

## 15. Security notes

- Never commit `.env`, service role keys, or Cashfree secrets.
- Storage is private; students do not get direct bucket URLs.
- Cashfree webhook verifies signature when the SDK is configured; raw body is captured before JSON parsing.
- Default `SESSION_SECRET` fallback exists in code — set a real secret in any deployed environment.
- Super-admin payment-gateway endpoint returns provider/mode/connected flags only.

---

## 16. License

Root `package.json` license field: **ISC**.
