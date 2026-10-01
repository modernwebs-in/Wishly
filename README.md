# Wishly — Backend & Database Layer

Real backend for the birthday-surprise SaaS: Next.js (App Router) API routes,
PostgreSQL via Prisma, session-based auth, and role-based authorization.
This is source code to deploy, not a demo — every endpoint performs actual
database operations and every restriction (locked fields, ownership,
admin-only actions) is enforced server-side.

## 1. Folder structure

```
wishly-backend/
├── prisma/
│   ├── schema.prisma        # full data model (see below)
│   └── seed.ts              # creates SiteSettings row + first admin account
├── src/
│   ├── lib/
│   │   ├── prisma.ts         # Prisma client singleton
│   │   ├── auth.ts           # password hashing + JWT session cookie
│   │   ├── auth-middleware.ts# requireAuth() / requireAdmin() guards
│   │   ├── slug.ts           # unguessable public surprise slugs
│   │   ├── audit.ts          # AuditLog writer
│   │   ├── storage.ts        # pluggable file storage (local now, S3-ready)
│   │   └── validation/       # zod schemas for every write endpoint
│   └── app/api/
│       ├── auth/{register,login,logout,me}/route.ts
│       ├── payments/{submit,status}/route.ts
│       ├── surprises/{create,me,photos}/route.ts
│       ├── public/s/[slug]/route.ts        # recipient-facing, no auth
│       ├── settings/public/route.ts        # pre-login landing/payment page data
│       └── admin/
│           ├── dashboard/route.ts
│           ├── users/route.ts, users/[id]/route.ts
│           ├── payments/route.ts, payments/[id]/approve|reject/route.ts
│           ├── surprises/route.ts, surprises/[id]/disable/route.ts
│           └── settings/route.ts
│   ├── middleware.ts          # route protection (edge-safe session check)
│   └── components/            # AppHeader, ParticlesBackground, CopyButton,
│                               # PasswordField, LiveSettings, SurpriseShareCard
│   (frontend pages live under src/app/: landing page, (auth)/login|register|
│    forgot-password|reset-password, payment/, dashboard/, create/)
├── .env.example
└── package.json
```

## 2. Data model

See `prisma/schema.prisma` for the full definitions. Summary:

- **User** — `id, name, email, passwordHash, role(USER|ADMIN), createdAt, updatedAt`
- **Payment** — `id, userId, amount, currency, utr, screenshotKey, status(PENDING|VERIFIED|REJECTED), adminNote, verifiedBy, verifiedAt` — `screenshotKey` is a **private** storage key (renamed from `screenshotUrl` during the security-hardening pass; see section 17)
- **Surprise** — `id, userId, recipientName, birthdayNumber, relationship, nickname, personalMessage, musicUrl, theme, publicSlug (unique, random), isLocked, isActive`
- **SurprisePhoto** — `id, surpriseId, imageUrl, position` (always editable, even when the parent surprise is locked)
- **Music** — default/royalty-free track options
- **SiteSettings** — single row (`id = "singleton"`) holding price, UPI ID, QR code URL, payment instructions, max photos, site name, registration toggle
- **AuditLog** — every admin action (approve/reject payment, disable surprise, change settings), who did it, and when

## 3. Setup

```bash
cd wishly-backend
npm install
cp .env.example .env
# Fill in DATABASE_URL (a Postgres connection string) and AUTH_SECRET
# (generate with: openssl rand -base64 32)

npx prisma migrate dev --name init   # creates tables
npm run db:seed                       # creates SiteSettings row + a first admin
npm run dev                           # http://localhost:3000
```

The seed script prints a starter admin login — **change that password
immediately** after your first login (there's no "change password" endpoint
included yet; update it via `prisma studio` or add one before going live).

## 4. Authentication model

- Passwords are hashed with **bcrypt** (cost 12) — never stored or logged in
  plaintext.
- On login/register, a signed JWT is set as an **httpOnly, Secure, SameSite=Lax
  cookie**. It's not readable by client-side JS, which rules out a large class
  of XSS-driven session theft.
- `requireAuth()` and `requireAdmin()` (in `lib/auth-middleware.ts`) re-check
  the user against the **database** on every request — not just the JWT
  claims — so a role change or account removal takes effect immediately
  instead of waiting for the token to expire.
- A basic in-memory rate limiter guards `/api/auth/login` against brute
  force. Replace it with Redis (e.g. Upstash) before running more than one
  server instance.

## 5. The core business flow, and how it's enforced

```
Register → Payment submitted (PENDING) → Admin verifies → VERIFIED
   → Surprise creation allowed → isLocked = true immediately on create
   → Only photos remain editable → Public link live at /s/[slug]
```

Enforcement points (all server-side, all in the route handlers themselves —
never trusted from the client):

- `POST /api/surprises/create` checks for a `VERIFIED` payment and refuses
  otherwise (403). The client can send whatever it wants; only the database
  record of a payment actually approved by an admin counts.
- The client can never set `status: VERIFIED` on a payment. Only
  `POST /api/admin/payments/[id]/approve`, gated by `requireAdmin()`, can do
  that — and it's the *only* code path in the whole app that writes that
  value.
- Once a `Surprise` row is created, `isLocked` is `true` from that moment.
  There is intentionally **no** `PATCH /api/surprises/[id]` endpoint for the
  locked fields — the update capability simply doesn't exist in the API
  surface, which is stronger than checking a flag before every edit.
- Photo endpoints (`/api/surprises/photos`) re-verify that the surprise
  belongs to the requesting user on every single call (ownership check),
  preventing IDOR — a user can't touch another user's photos by guessing IDs.
- Admin routes all call `requireAdmin()` first; a normal `USER` gets a 403,
  not a partial response.

## 6. Photo uploads

`src/lib/storage.ts` defines a small `StorageProvider` interface with one
implementation (`localStorageProvider`, writes to `./public/uploads`) and a
commented-out S3-compatible example. To move to Cloudinary/S3/Supabase in
production, implement the interface and change the single `export const
storage = ...` line — no route handler needs to change.

Every upload is validated server-side (`assertValidImage`) for MIME type
(JPG/PNG/WEBP only) and size (8MB default), and stored under a randomly
generated filename — the original filename is never trusted or used.

## 7. Public surprise route

`GET /api/public/s/[slug]` requires no authentication and returns only the
fields the interactive experience needs to render: recipient name, birthday
number, message, music URL, theme, and photos. It never returns the owning
user's id/email, payment data, or the internal database id. If the slug
doesn't exist or the surprise was disabled, it returns the same friendly
"no longer available" response either way — no information leak about which
case it was.

Slugs are 10-character random strings from an unambiguous alphabet
(`src/lib/slug.ts`, via nanoid) — not sequential, not guessable.

## 8. Connecting the existing interactive frontend

The `wishly-surprise-demo.html` artifact built earlier used hardcoded
placeholder data ("Riya", a fixed message, gradient placeholder photos). To
turn it into the real product:

1. On the public surprise page (`/s/[slug]`), fetch
   `GET /api/public/s/[slug]` on load.
2. If `available: false`, show the "This surprise is no longer available ❤️"
   scene instead of Scene 1.
3. Replace the hardcoded `Riya` in Scene 2 with `data.recipientName`.
4. Replace the gallery's placeholder `.ph` blocks in Scene 4 with `<img
   src={photo.url}>` for each entry in `data.photos` (sorted by `position`).
5. Replace `fullMsg` in the typewriter script with `data.personalMessage`.
6. Wire the background `<audio>` element to `data.musicUrl` (or the default
   track if null), starting only after a user interaction to respect
   autoplay restrictions.
7. Everything else — the scene flow, animations, candle-blow interaction,
   confetti — stays exactly as built; it was already decoupled from the
   data source.

The dashboard's "Copy Link" / "Share" / "WhatsApp Share" buttons should use
the `publicUrl` returned by `POST /api/surprises/create` and
`GET /api/surprises/me`.

## 9. Deployment

- **App**: deploy to Vercel (recommended for Next.js) or Railway.
- **Database**: Railway Postgres, Neon, or Supabase Postgres — copy the
  connection string into `DATABASE_URL`.
- Set `AUTH_SECRET`, `DATABASE_URL`, `NEXT_PUBLIC_APP_URL`, and your chosen
  storage provider's credentials as environment variables in your hosting
  dashboard — never commit `.env`.
- Run `npm run db:deploy` (wraps `prisma migrate deploy`) as part of your
  deploy pipeline to apply migrations.
- If deploying uploads to local disk (the default provider), note that most
  serverless hosts (Vercel included) have an **ephemeral filesystem** —
  switch to the S3-compatible provider in `lib/storage.ts` before going live
  anywhere other than a persistent server/container.

## 10. What's still manual (by design, for now)

Payment verification is manual: a user submits a UTR, an admin looks at it
and approves or rejects it from `/api/admin/payments`. This is intentionally
**not** presented as a real payment gateway integration — it isn't one. The
`Payment` model and the approve/reject endpoints are structured so that
swapping in Razorpay/PhonePe/PayU later means adding a webhook handler that
calls the same "mark VERIFIED" logic (with signature verification instead of
an admin click) — not redesigning the schema.

See `docs/API.md` for full endpoint-by-endpoint documentation.

## 11. Frontend layer (onboarding: landing → auth → payment → dashboard)

Everything here calls the real API routes from section 5 — no hardcoded
arrays, no fake users, no `localStorage`-based auth. Session state lives
entirely in the httpOnly cookie the backend already sets.

- **`middleware.ts`** — the first, cheap gate. Verifies the JWT's signature
  with `jose` (edge-safe, no DB call) to redirect unauthenticated visitors
  away from `/dashboard`, `/payment`, `/create`, and to bounce already-logged-in
  users away from `/login`/`/register`. It intentionally does **not** check
  payment status — that needs a DB lookup, so it's re-verified on the page
  itself (`dashboard/page.tsx`, `create/page.tsx` both call `getSession()` +
  Prisma directly, since they're server components).
- **Landing page** (`app/page.tsx`) — the price shown in the hero and pricing
  section comes from `GET /api/settings/public` via the `<LiveSettings>`
  client component. Change the price in `SiteSettings` (through the admin
  API) and it updates on next load — nothing to redeploy.
- **Auth pages** — register/login call the real endpoints and rely solely on
  the session cookie; login additionally calls `/api/auth/me` to decide
  whether to route to `/payment` or `/dashboard`. Forgot/reset-password
  needed two backend endpoints that didn't exist yet
  (`/api/auth/forgot-password`, `/api/auth/reset-password`) — added them
  rather than fake the screens; see the note below.
- **Payment page** (`app/payment/page.tsx`) — a single page that renders
  different states from the *same* live data (`GET /api/payments/status` +
  `GET /api/settings/public`): the UPI/QR form when there's no payment or the
  last one was rejected, a pending state with a manual refresh, and a
  verified state with a "Create My Surprise" button. The UTR is the only
  required field sent to `POST /api/payments/submit` — the frontend never
  sends a `status` value.
- **Dashboard** (`app/dashboard/page.tsx`) — server component, reads
  payment + surprise state directly from Prisma and renders exactly one of:
  no payment yet / pending / rejected / verified-no-surprise / surprise
  created. The share card (copy link, WhatsApp, native share, "Change
  Photos") only appears once a surprise actually exists.
- **`app/create/page.tsx`** — enforces the same access rule
  (`VERIFIED` payment + no existing surprise) at the page level, redirecting
  to `/payment` or `/dashboard` otherwise. *(As of this pass, it showed an
  honest placeholder instead of a wizard — the real multi-step Surprise
  Creation Wizard was built in the next pass and replaced this placeholder
  entirely; see section 12 below for the wizard itself.)*

### Password reset — added in this pass

The original backend build didn't include forgot/reset-password endpoints.
Building real UI for them meant adding the real endpoints rather than
wiring the form to nothing: `User` gained `passwordResetTokenHash` +
`passwordResetExpiresAt` fields (run a new migration), and
`/api/auth/forgot-password` / `/api/auth/reset-password` follow the same
pattern as the rest of the app — generic success message regardless of
whether the email exists, token is hashed at rest, 15-minute expiry. Actual
email delivery isn't wired up yet (*originally the reset link was logged
to the server console in development; that was removed in section 19 — the
token is never logged anywhere now*). Plug in Resend/SendGrid/Postmark in
`/api/auth/forgot-password/route.ts` before this goes live.

## 12. The Surprise Creation Wizard

Replaces the `/create` placeholder from the previous pass with a real
6-step flow (**About → Photos → Music → Message → Theme → Preview**), a
progress bar, back/forward navigation, and a final confirmation before
anything is written to the database.

```
src/components/wizard/
├── constants.ts        # steps, relationship/theme/birthday options, draft type
├── SurpriseWizard.tsx  # step state machine, draft persistence, create call
├── StepAboutThem.tsx   # Step 1
├── StepPhotos.tsx      # Step 2 — upload, drag-reorder, delete, retry
├── StepMusic.tsx       # Step 3 — built-in tracks + upload-your-own
├── StepMessage.tsx     # Step 4 — textarea with live count + typography preview
├── StepTheme.tsx       # Step 5 — 4 theme cards
├── StepPreview.tsx     # Step 6 — full read-back + lock warning
└── SuccessScreen.tsx   # shown after a real surprise is created
```

### Which real endpoints it calls, and when

| Step | Endpoint | Notes |
|---|---|---|
| Photos | `POST /api/uploads/image` | uploads each file as it's added; see "new endpoint" note below |
| Music (built-in list) | `GET /api/music` | reads the real `Music` table |
| Music (upload own) | `POST /api/uploads/audio` | genuinely stores the file; not faked |
| Final confirm | `POST /api/surprises/create` | the only point anything is written for real; sends `photoUrls` as the array of already-uploaded URLs |

No step submits partial data early — `POST /api/surprises/create` is called
exactly once, only from the Preview step's "Create My Surprise ❤️" button,
and only after the person has seen everything laid out with the "these
details will be locked" warning.

### A gap this pass had to close: draft photo/music uploads

The photo and photo-management endpoints built earlier
(`/api/surprises/photos`) all require an existing `Surprise` row — they
look it up by the requesting user. But the wizard needs to upload photos
*before* that row exists (creation happens once, at the very end, with
`photoUrls` already populated). Rather than fake the upload step, two new
endpoints were added:

- `POST /api/uploads/image` — validates and stores an image, tied only to
  the user (folder `drafts/{userId}/`), returns `{ url }`. Nothing is
  written to `SurprisePhoto` — that table only gets rows once
  `POST /api/surprises/create` runs.
- `POST /api/uploads/audio` — same pattern, for "upload your own music" in
  Step 3 (MP3/M4A/WAV, 15MB cap). This is a real feature now, not a
  "not supported" placeholder — `assertValidAudio` was added to
  `lib/storage.ts` alongside the existing `assertValidImage`.

**Known limitation, flagged rather than hidden:** if someone uploads photos
or a track and abandons the wizard, those files stay in storage with
nothing referencing them (a genuine orphaned-file situation). Fine for an
initial version; **now closed** — see section 17 ("Security hardening
pass") for `scripts/cleanup-draft-uploads.ts`, added later.

### A real bug this pass fixed: URL validation was rejecting the default storage provider's own output

`createSurpriseSchema.photoUrls`, `.musicUrl`, `submitPaymentSchema.screenshotUrl`,
and `updateSettingsSchema.qrCodeUrl` all used `z.string().url()`. But the
default `localStorageProvider` (still what's wired up — see section 6)
returns **root-relative paths** like `/uploads/surprises/abc/x.jpg`, which
`z.string().url()` rejects outright (it requires a scheme like `https://`).
Building the wizard's photo step surfaced this immediately — every
`POST /api/surprises/create` would have failed validation. Fixed with a
shared `urlOrPath` validator (`lib/validation/common.ts`) that accepts
either a full URL or a root-relative path, used everywhere a
storage-produced URL is validated. Worth knowing if you swap in the S3
provider later: both forms keep working either way.

### Draft persistence (refresh/back-button safety)

`SurpriseWizard` saves the in-progress draft to `localStorage` on every
change and restores it on mount — this is what makes "user refreshes
mid-wizard" non-destructive. Only non-sensitive fields are ever written
there: recipient name, birthday number, relationship, nickname, message
text, theme, and already-uploaded photo/music **URLs** (not the files
themselves, and nothing payment- or password-related touches
`localStorage` anywhere in this app). Photos still mid-upload or in an
error state are deliberately excluded before saving, so a refresh never
leaves a spinner that can never resolve.

### Double-submission / error recovery

- The create button disables itself the instant it's clicked, and a
  `useRef` flag blocks a second call even if disabling the button somehow
  raced with a fast double-click (belt-and-suspenders).
- A `409` from the API (meaning a surprise already exists — e.g. a second
  tab beat this one to it) redirects straight to `/dashboard` instead of
  retrying into a duplicate.
- A `403` (payment no longer verified) redirects to `/payment`.
- Any other failure shows "Something went wrong while creating your
  surprise" with the Preview step still intact, so the person can just
  press the button again — nothing they entered is lost.

### Updated end-to-end flow

```
Landing → Register/Login → Payment → Admin Verification → Dashboard
  → /create (gate re-checked against the DB)
  → Wizard: About → Photos → Music → Message → Theme → Preview
  → POST /api/surprises/create (the one real write)
  → Success screen with the REAL public URL (Copy / WhatsApp / Share / Preview)
  → Dashboard now shows the surprise + share card permanently
  → Recipient opens /s/[slug] — no account needed
```

### Still not built, as of this section (all four since completed later — see sections 13, 15, and 17)

- ~~The public-facing `/s/[slug]` page itself~~ — built; see section 13.
- ~~The admin dashboard UI~~ — built; see section 15.
- ~~A "change password" flow for the seeded admin account~~ — built, with
  real multi-device session revocation; see section 17.
- ~~A cleanup job for orphaned draft uploads~~ — built; see section 17.

(Left here, struck through rather than deleted, so this document's history
stays legible turn-by-turn rather than silently rewriting earlier claims.)

## 13. The public `/s/[slug]` experience

This is the recipient-facing page — no login, no account, real database data
throughout. It replaces the standalone `wishly-surprise-demo.html` artifact
built at the very start of this project with the actual product.

```
src/app/s/[slug]/page.tsx                        # metadata + mounts the client experience
src/components/public-surprise/
├── PublicSurpriseExperience.tsx  # fetch + loading/error/unavailable states + all 7 scenes
├── MusicPlayer.tsx               # persistent play/pause/volume/mute, autoplay-safe
└── useBlowDetector.ts            # opt-in mic "blow" detection via Web Audio API
src/lib/theme-config.ts           # theme id → gradients/colors, used here (and nowhere else)
```

### Where the data actually comes from

`PublicSurpriseExperience` calls `GET /api/public/s/[slug]` — the same
route documented in `docs/API.md` — on mount, client-side. That route
(unchanged from when it was built) already does everything section 20 of
this task asked for: looks the surprise up by slug, checks `isActive`,
and returns only the fields the experience needs (recipient name, birthday
number, relationship, nickname, message, music URL, theme, ordered photos)
— never the owning user's id/email, payment data, or internal database id.

`page.tsx`'s `generateMetadata` does a *separate*, minimal Prisma query
(`recipientName` and `isActive` only) purely to build the page's
`<title>`/OpenGraph tags server-side, so link previews show "A Birthday
Surprise for {name} ❤️" without JavaScript having to run first. That query's
result is never passed to the client component or rendered as page
content — the two fields are used for meta tags and nothing else.

### States handled

- **Loading** — "Preparing something special... ❤️" with a spinner, never a
  blank screen.
- **Unavailable** (slug doesn't exist, or `isActive = false`) — "This
  surprise is no longer available ❤️", same message either way so a
  disabled surprise and a typo'd URL are indistinguishable to a stranger.
- **Network/server error** — "Something went wrong while opening the
  surprise." with a "Try Again" button that just re-runs the fetch.
- **Ready** — the actual 7-scene experience: Intro → Name Reveal (+
  birthday number, via a real ordinal formatter, skipped entirely if
  `birthdayNumber` is null) → Questions → Photos → Message → Cake → Finale.

### Theme system

`Surprise.theme` is a free-text column; `lib/theme-config.ts` maps the four
known ids (`dreamy`, `midnight`, `starlight`, `romantic`) to a background
gradient, particle colors, and two accent colors. `getTheme()` falls back to
`dreamy` for any unrecognized value instead of erroring — the whole
experience is one component tree parameterized by this config, not four
duplicated pages.

### Music, autoplay, and mic detection — the specific care points

- The `<audio>` element is created as soon as the experience mounts, but
  `.play()` is never called until the recipient's first real interaction
  (tapping "Open Your Surprise" on the intro scene arms it via a ref
  callback). This is what keeps it inside browser autoplay policies instead
  of silently failing.
- If the audio fails to load, `MusicPlayer` just renders nothing — it never
  throws or blocks the rest of the experience.
- Mic-based candle blowing is **opt-in only**: nothing requests
  `getUserMedia` until the recipient explicitly taps "🎤 Try blowing into
  your mic (optional)" on the cake scene. The "Blow the Candles 🎂" button
  is the primary path and works with zero permissions, denied or not.

### Resilience details

- A broken photo URL (`onError`) removes just that one card from the
  gallery — it doesn't blank the scene or throw.
- `prefers-reduced-motion` is checked both via CSS (already in
  `globals.css`) and in JS: the typewriter renders the full message
  instantly instead of animating character-by-character, and confetti
  particle counts drop to 0.
- Because photos are read fresh from the database on every page load (not
  baked into a static page), replacing a photo in the dashboard shows up at
  the *same* `/s/[slug]` URL immediately — no new link, no redeploy,
  satisfying the "creator replaces Photo B with Photo C" requirement
  exactly.

### OG image

The OpenGraph/Twitter preview image points at `/og-default.png`. **Since
fixed** (security-hardening pass, section 17) — a real, generated 1200×630
image exists at that path: a gradient background in the app's own color
language with a simple vector cake illustration, deliberately not one of
the creator's uploaded photos, per the privacy requirement. Visually
verified; not verified inside an actual link-preview crawler (needs a real
public deployment URL — see section 18's final QA pass for the exact
distinction between what was and wasn't testable in this environment).

## 14. Complete end-to-end flow (current state of the project)

```
Landing (/)                         — live price from SiteSettings
  ↓
Register / Login (/register, /login) — real session cookie, no localStorage auth
  ↓
Payment (/payment)                  — real UPI/QR from SiteSettings, UTR submitted as PENDING
  ↓
[Admin verifies via /api/admin/payments/[id]/approve — manual, by design]
  ↓
Dashboard (/dashboard)              — status-driven; unlocks once VERIFIED
  ↓
Create (/create)                    — DB-checked access gate
  ↓
Wizard: About → Photos → Music → Message → Theme → Preview
  ↓
POST /api/surprises/create          — the one real write; isLocked = true immediately
  ↓
Success screen                      — REAL public URL, Copy / WhatsApp / Share / Preview
  ↓
Dashboard now shows the share card permanently
  ↓
Creator can replace photos any time — same public URL always reflects them
  ↓
Recipient opens /s/[slug]           — no account, real data, full 7-scene experience
```

*(As of this pass, two items were still gaps: the admin dashboard UI and
the orphaned-draft-upload cleanup job. Both were since built — see
sections 15 and 17.)*

## 15. Admin Dashboard (`/admin`)

A real admin panel over the admin API surface that's existed since the
backend was first built — dashboard stats, payments, users, surprises,
settings — plus one addition this pass required (audit logs, see below).
Nothing here is mock data; every screen fetches from the same endpoints
documented in `docs/API.md`.

```
src/app/admin/
├── layout.tsx           # authoritative DB-backed admin check (see below)
├── page.tsx              # Dashboard — stats + revenue + recent verified payments
├── payments/page.tsx     # status tabs, search, approve/reject, screenshot lightbox
├── users/page.tsx        # search + pagination
├── surprises/page.tsx    # search + pagination, disable action, open public link
├── settings/page.tsx     # SiteSettings form incl. QR upload
└── audit-logs/page.tsx   # paginated log viewer
src/components/admin/
├── AdminShell.tsx         # sidebar (desktop) / drawer (mobile) + header + logout
├── ToastProvider.tsx      # replaces alert()/confirm() feedback everywhere here
├── ConfirmDialog.tsx      # used before reject / disable
├── ImageLightbox.tsx      # payment screenshot preview
├── StatCard.tsx
└── DataStates.tsx         # shared Loading/Empty/Error building blocks
```

### Access control — two layers, one authority

`middleware.ts` now also gates `/admin/*`: it reads the `role` claim
already embedded in the session JWT (cheap, edge-safe, no DB round trip)
and redirects non-admins to `/dashboard`, logged-out visitors to `/login`.
This is a **fast first gate only** — if an admin's role were changed after
they logged in, this claim would be stale until they log in again. The
real authority is `src/app/admin/layout.tsx`, a server component that
re-checks `role === "ADMIN"` against the database on every single request,
exactly like every `requireAdmin()` call in the API layer already does.
A normal user hitting `/admin` directly is redirected before any admin
data is fetched, let alone rendered — the UI was never the only thing
standing in the way.

### Backend gap found and closed: no way to read audit logs back

`AuditLog` rows have existed and been written to since payment
approve/reject, surprise disable, and settings updates were first built —
but there was never a `GET` endpoint for them. Per the "inspect first,
extend minimally" instruction, added `GET /api/admin/audit-logs`
(admin-only, paginated, optional `targetType`/`action` filters) rather than
have the frontend fabricate a log view. Documented in `docs/API.md`.

### Two smaller backend extensions

- `GET /api/admin/payments` now accepts `query`, matching UTR or the
  submitting user's name/email — the payments screen needed this and the
  route only supported a status filter before.
- `GET /api/admin/surprises` now accepts `query` matching **either**
  recipient name or public slug (previously name only), plus `page`/
  `pageSize` pagination, matching the pattern `/api/admin/users` already
  used.

Both are additive — old callers passing only `status` or only `query` by
name still work exactly as before.

### Real bugs caught and fixed while wiring the admin UI to real data

- **Settings save was sending `null` for unset fields.** `SiteSettings`
  fields like `qrCodeUrl` and `paymentInstructions` are legitimately `null`
  until an admin sets them, but `updateSettingsSchema` only accepts a
  valid string or `undefined` — never `null`. Every save would have 400'd
  until a QR code existed. Fixed by having the settings form only send
  fields that actually have a value; PATCH semantics mean an omitted field
  is simply left alone, which is correct for "nothing to change here."
- **A 401 from a bad login password was being shown as "session
  expired."** `apiFetch` treated every 401 as a session-expiry (existing
  behavior from when the auth pages were first built), but
  `/api/auth/login` also legitimately returns 401 for wrong credentials.
  Login would have shown "Your session has expired. Please log in again."
  instead of "Email or password is incorrect" on a simple typo. Fixed by
  excluding `/api/auth/login` from the session-expiry handling.
- **Session expiry had no redirect anywhere in the app**, admin included —
  section 18 explicitly asked for a clean redirect. `apiFetch` now sends
  the browser to `/login?next=<path>` on any other 401, everywhere in the
  app (not just `/admin`), with a loop guard for when the person is
  already on `/login`.

### What's genuinely secure here vs. what still needs attention

- Password hashes, reset tokens, and any other auth internals are never
  selected in admin queries — `GET /api/admin/users` and
  `GET /api/admin/users/[id]` only ever `select` the safe fields shown in
  `docs/API.md`.
- Screenshot preview reuses the URL already returned by
  `GET /api/admin/payments` (itself admin-gated) — no new endpoint needed.
  **Known limitation, not fixed here:** the default local storage provider
  (`lib/storage.ts`) serves everything under `/uploads/` as a public static
  file with no access control at all — so while the *admin API* correctly
  requires an admin session, the *screenshot file itself*, if someone had
  its exact URL, would load for anyone. This was already true for photo/
  music uploads (fine — those are meant to be public once a surprise is
  shared) but is a real problem for payment screenshots specifically.
  Before production use with anything sensitive in a screenshot, switch to
  the S3-compatible provider (already stubbed in `lib/storage.ts`) with a
  **private bucket and signed URLs** rather than public object URLs.

## 16. Complete current architecture

```
Landing (/)
  ↓  live price, UPI ID, QR, instructions — all from SiteSettings, admin-editable
Register / Login
  ↓  real session cookie; 401 anywhere now redirects to /login cleanly
Payment (/payment)
  ↓  UTR submitted → PENDING (client can never set VERIFIED)
Admin verifies — /admin/payments → Approve/Reject (with reason) → AuditLog entry
  ↓
Dashboard (/dashboard) — unlocks once VERIFIED
  ↓
Create Wizard (/create) — About → Photos → Music → Message → Theme → Preview
  ↓
POST /api/surprises/create — the one real write; isLocked = true immediately
  ↓
Success screen — real public URL (Copy / WhatsApp / Share / Preview)
  ↓
Public "/s/[slug]" — no login, real DB data, full 7-scene interactive experience,
                      theme-driven visuals, opt-in mic candle-blow, graceful
                      loading/error/unavailable states
  ↓
Creator replaces photos any time from the dashboard — same URL reflects them
  ↓
Admin oversight throughout — /admin dashboard, payments, users, surprises
  (view/disable), settings (price/UPI/QR/site name — all live, nothing
  hardcoded), audit logs of every admin action
```

### Known gaps, unchanged from before this pass

- **Orphaned draft upload cleanup job.** Photos and music uploaded via
  `/api/uploads/image` / `/api/uploads/audio` during the wizard, then
  abandoned before the surprise is created, remain in storage with nothing
  referencing them. **Since fixed** — see section 17 ("Security hardening
  pass") for `scripts/cleanup-draft-uploads.ts`.
- Local storage provider serves all *public* uploads as public static
  files (intentional — birthday photos and music are meant to be public).
  Payment screenshots are **no longer** part of this list — **since
  fixed** in the security-hardening pass, which split storage into
  public/private; see section 17.
- The OpenGraph preview image (`/og-default.png`) is referenced. **Since
  fixed** — a real, generated image exists at that path; see section 17.
- No "change admin password" flow beyond the seeded default. **Since
  fixed** — see section 17 for `POST /api/auth/change-password` and its
  real multi-device session revocation.
- All four items above were fixed in the security-hardening pass (section
  17) — left here, marked, rather than deleted, so the document's history
  stays legible.

## 17. Security hardening pass

A full security/production-readiness review, done by inspecting the
existing implementation and making real code changes — not a documentation
pass describing what *should* happen. This section reports plainly what
was fixed, what was verified and how, what still needs real infrastructure
to be genuinely secure (not just coded), and what's still open.

### 1. Payment screenshot privacy — the highest-priority item, done

This was a real architectural gap, not a config toggle: payment
screenshots didn't even have a real upload path before this pass (the
payment form only accepted a pasted external URL). Fixed properly:

- `lib/storage.ts` now has a genuine **public/private split** —
  `uploadPublic`/`uploadPrivate`/`getPrivateAccess`/`deletePublic`/
  `deletePrivate`/`listPublicUnder`, replacing the old single `upload`/
  `delete`. Public files (birthday photos, music, QR codes, wizard drafts)
  are unchanged — still served same-origin from `/uploads/...`. Private
  files write to `LOCAL_PRIVATE_UPLOAD_DIR` (`./private-uploads` by
  default), which is **outside** `./public` — Next.js only serves static
  files from `./public`, so this directory has no URL at all, predictable
  or otherwise.
- `Payment.screenshotUrl` is renamed to `Payment.screenshotKey` (new
  migration required) and now stores an opaque private key, never a
  browsable URL. `submitPaymentSchema` was updated to match.
- New endpoint `POST /api/uploads/payment-screenshot` uploads to private
  storage and returns only the key.
- New endpoint `GET /api/admin/payments/[id]/screenshot` is the **only**
  path by which a screenshot is ever viewable — `requireAdmin()` first,
  then either streams the bytes (local provider) or 307-redirects to a
  signed URL with a 5-minute expiry (S3-compatible provider, stubbed).
  The admin UI's `<img>` tag points straight at this route; the browser's
  normal cookie-bearing request supplies the session automatically.
- Every place that used to return the full `Payment` row to the admin
  frontend (`GET /api/admin/payments`, the approve/reject responses,
  `GET /api/admin/users/[id]`) now strips `screenshotKey` and returns
  `hasScreenshot: boolean` instead — the raw key never reaches the
  browser, even to an authorized admin, even though the key alone
  wouldn't be enough to fetch the file anyway (`getPrivateAccess` isn't
  exposed as its own route).

**What this achieves right now (local dev / single-server deploy):** a
normal user, a logged-out visitor, or anyone with a guessed/leaked
`/uploads/...`-style URL genuinely cannot reach a payment screenshot — the
file isn't under any public path. **What still requires production
infrastructure to be true at scale:** the S3-compatible provider in
`lib/storage.ts` is written and commented, but not connected to a real
bucket, and therefore **not tested against real cloud storage**. Until
that's wired up, "private" for a screenshot means "outside the local
static file root," which is correct and real, but is a single-server
property, not a scaled one.

### 2–5. Storage abstraction, upload security, both covered above and:

- **Real content-sniffing added.** `sniffImageType`/`sniffAudioType` in
  `lib/storage.ts` check actual file signatures (PNG/JPEG/WEBP magic
  bytes; WAV/MP3/M4A container markers) against the declared MIME type,
  on all three upload endpoints (`/api/uploads/image`, `/api/uploads/audio`,
  `/api/uploads/payment-screenshot`) and the post-creation
  `/api/surprises/photos` upload. Previously, validation only checked the
  browser-supplied `File.type` and size — both fully client-controlled and
  spoofable (a renamed `.html` served with a forged `Content-Type` header
  would have passed).
- **Path-traversal guard added** (`assertWithinRoot` in `lib/storage.ts`).
  Every key this app generates is already a random UUID, so this was
  defense-in-depth rather than a fix for an exploitable path — but the
  local provider now explicitly verifies every resolved file path stays
  inside its intended root before reading, writing, or deleting.
- **Generated filenames only**, unchanged from before this pass — the
  original filename is never used for the on-disk name.
- **A real bug fixed:** `/api/surprises/photos`' image validation wasn't
  wrapped in a try/catch, so a rejected upload (wrong type, too large)
  threw an unhandled error that `withErrorHandling` turned into a generic
  500 ("Something went wrong") instead of the actual, actionable message
  ("Please upload JPG, PNG or WEBP."). Fixed to match the other two
  upload routes' pattern.

### 6. Payment screenshot retention — documented, not auto-deleted

Per the task's own instruction not to delete evidence without a defined
policy: **no automatic deletion was implemented.** Screenshots are
retained indefinitely by default, tied to their `Payment` row, viewable
by any admin regardless of that payment's status. `storage.deletePrivate`
exists and works if a retention policy is decided later (e.g., "purge
screenshots for payments verified or rejected more than 90 days ago" via
a scheduled job similar in shape to the draft-upload cleanup script
below) — but that's a compliance/business decision this pass didn't make
on the project's behalf, so nothing runs automatically.

### 7. Orphaned draft upload cleanup — actually implemented this time

`scripts/cleanup-draft-uploads.ts` is a real script now, not just a
documented gap. It:
- Lists every file under `drafts/` (via the new `listPublicUnder`)
- Cross-references each one against `SurprisePhoto.imageUrl` and
  `Surprise.musicUrl` in the database — a file is only ever deleted if it
  is **both** unreferenced **and** older than `UPLOAD_CLEANUP_AFTER_HOURS`
  (default 24)
- Is idempotent — every run recomputes "is this orphaned right now" from
  scratch; there's no persistent state to corrupt between runs
- Has a `--dry-run` flag (`npm run cleanup:drafts:dry-run`) that logs what
  it would delete without touching anything

**Not tested against a live database or filesystem** — there's no
Postgres instance or real upload history in this environment to run it
against. Written and reasoned through carefully (including the
in-use-vs-orphaned cross-check, which was the actual hard part), but run
`--dry-run` first against a real deployment and read its output before
trusting it unattended, same as you would any new delete-capable script.

Deployment note baked into the script's own comments: on serverless hosts
with an ephemeral filesystem (Vercel and similar), this script is only
meaningful once the S3 provider is wired up — the local provider's files
don't persist or share across invocations there regardless.

### 8. OG image — a real asset now exists

`public/og-default.png` (1200×630, the standard OpenGraph size) was
generated programmatically — a gradient background in the app's own color
language, a simple vector cake/candles illustration built from primitive
shapes, and generic copy ("A Birthday Surprise is waiting for you"). No
recipient photo, no copyrighted imagery, no placeholder text. It's
referenced correctly from `generateMetadata` in `src/app/s/[slug]/page.tsx`
(that code hasn't changed — it always pointed at this path; the path just
didn't resolve to a real file before now).

**Verified:** the file exists, is a valid PNG at the correct dimensions,
and was visually reviewed. **Not verified:** actual rendering inside
WhatsApp/Twitter/Facebook's link-preview crawlers, which requires a
publicly deployed URL those crawlers can reach — impossible to test from
this environment. The metadata shape (`openGraph.images`, `twitter.card:
"summary_large_image"`) follows the standard Next.js Metadata API
convention, which is well-established to work correctly when deployed.

### 9. Admin password change — implemented with real session revocation

The interesting part of this wasn't the form — it's that "invalidate
existing sessions" needed to be *true*, not cosmetic. This app has no
server-side session table (sessions are stateless JWTs), so:

- Added `User.passwordChangedAt` (new migration required).
- `createSession`'s JWT already carried an `iat` (issued-at) claim; it's
  now threaded through `getSession()` into `SessionPayload.issuedAt`.
- `requireAuth()` (and therefore every protected route and `requireAdmin()`,
  which calls it) now rejects any session whose token was issued **before**
  `user.passwordChangedAt`. That's real, database-checked revocation of
  every previously-issued token, on every device, the moment a password
  changes — not just clearing the current browser's cookie.
- `POST /api/auth/change-password` (current password required, verified
  with bcrypt; new password validated with the same strength rules as
  registration; hashed with bcrypt; current password never logged or
  stored) sets `passwordChangedAt` and then immediately issues a **fresh**
  session for the request that called it, so the person isn't logged out
  of the device they're actively using.
- `POST /api/auth/reset-password` (the forgot-password flow) now sets
  `passwordChangedAt` too — found while doing this: without it, resetting
  a password after a suspected compromise would have left any session an
  attacker already had open still valid, which defeats the entire point
  of a security-motivated password reset.
- The event is audited (`PASSWORD_CHANGED` in `AuditLog`) without ever
  logging either password, hashed or plain.
- UI: a "Change password" card on `/admin/settings`. The underlying
  endpoint is generic (any authenticated user, not admin-gated) per "use
  the existing authentication architecture, don't build a second one" —
  the admin panel is just the only place in the UI that currently
  surfaces it.

### 10–12. Auth, IDOR, and public-API audits — mostly confirming existing correctness

Re-reading every route against the checklist in the task:

- **httpOnly, Secure (in production), SameSite=Lax cookies** — already
  correct since the auth system was first built (`lib/auth.ts`); confirmed
  by re-reading, not changed.
- **Reset tokens are hashed, expire (15 min), and cannot be reused**
  (cleared on successful use) — already correct; confirmed.
- **Forgot-password gives a generic response regardless of account
  existence** — already correct; confirmed.
- **Every authenticated endpoint re-derives ownership from the session,
  never from a client-supplied ID** — audited each one explicitly:
  `/api/surprises/*` look up "the current user's surprise" by `userId`,
  never by an ID the client sent; `/api/surprises/photos` DELETE/PATCH
  verify the target photo's parent surprise belongs to the requester
  before touching it, returning the same 404 whether the photo doesn't
  exist or belongs to someone else; `/api/payments/*` are scoped to
  `userId` the same way. No changes needed — this was already sound.
- **Admin routes acting on an arbitrary `[id]`** (approve/reject payment,
  disable surprise, view screenshot) are correct **by design** — an admin
  is supposed to act on any resource; `requireAdmin()` is the gate, not
  per-resource ownership. Confirmed this isn't accidentally permissive.
- **`GET /api/public/s/[slug]`** was re-checked field-by-field against the
  task's exact "never return" list (user ID, email, payment ID, UTR,
  screenshot, password data, audit logs, admin info) — it already only
  ever selected the safe fields; no changes needed there. Added rate
  limiting (60/min/IP) as defense-in-depth against slug enumeration,
  though the actual protection is the slug space itself (10 random
  characters from a 57-symbol alphabet, unchanged).
- **Two response-shape bugs found and fixed in this pass** (not IDOR, but
  adjacent — over-fetching relation data): `GET /api/admin/payments` and
  `GET /api/admin/users/[id]` both used a bare Prisma `include`, which
  returns every scalar column on `Payment`, meaning `screenshotKey` (the
  private key) was reaching the browser even before this pass renamed the
  field. Fixed by switching both to explicit `select` + a computed
  `hasScreenshot` boolean.

### 13. Rate limiting — extended from login-only to every sensitive endpoint

Previously only `/api/auth/login` had it (inline, not reusable). Extracted
into `lib/rate-limit.ts` — configurable via env vars (see `.env.example`)
— and applied to registration, forgot/reset-password, payment submission,
all three upload endpoints (keyed per-user, not per-IP, since they're
authenticated), and the public surprise API. Still explicitly documented
as **in-memory and single-instance-only**; scaling to more than one server
process needs a shared store (Redis/Upstash) behind the same
`checkRateLimit()` signature.

### 14. Security headers — added, with one documented, deliberate compromise

`next.config.ts` didn't exist before this pass (see the scaffolding note
in section 18 below) — headers are new, not modified. Sets CSP,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`
(microphone allowed same-origin only, for the opt-in candle-blow feature;
camera/geolocation/payment explicitly denied), and HSTS.

**One deliberate, documented compromise:** `script-src` and `style-src`
include `'unsafe-inline'`. A stricter, nonce-based CSP is the ideal and is
explained in a comment right above it in `next.config.ts`, but wiring
nonces through middleware and the root layout correctly is genuinely easy
to get subtly wrong, and getting it wrong breaks the entire app's
hydration — not something to risk shipping unverified in an environment
where the app can't actually be run to confirm it still works. This is a
known, intentional relaxation, not an oversight.

### 15. Environment variables — audited, `.env.example` updated, no secrets found

Searched the repository for hardcoded credentials, API keys, connection
strings with embedded passwords, and private key material — **none
found**. `.env.example` now documents every variable this pass
introduced (`LOCAL_PRIVATE_UPLOAD_DIR`, `STORAGE_PUBLIC_BUCKET`,
`STORAGE_PRIVATE_BUCKET`, `UPLOAD_CLEANUP_AFTER_HOURS`, all seven
`RATE_LIMIT_*` variables) alongside everything from before, all as empty
placeholders or safe example values.

### 16. Error handling — every route now goes through one controlled path

Found **seven routes** (`register`, `login`, `logout`, `forgot-password`,
`reset-password`, `settings/public`, `public/s/[slug]`) that weren't
wrapped in `withErrorHandling` — mostly the pre-auth routes, which don't
throw `AuthError` so it was easy to overlook that they could still throw
something else (a Prisma error, a malformed-JSON parse failure) and fall
through to Next.js's own default error handling instead of this app's
controlled, generic message. All seven now route through the same
`withErrorHandling` used everywhere else, so a database hiccup anywhere in
the app now consistently produces "Something went wrong on our side.
Please try again." with the real error only ever reaching the server
console (`console.error`), never the client.

### 17. Database safety — reviewed, one field rename needs a migration

- Public slug uniqueness (`@unique` on `Surprise.publicSlug`), cascade
  rules, and foreign-key relations were reviewed and are correct;
  unchanged.
- Payment status cannot be client-forced (confirmed — `VERIFIED`/`REJECTED`
  are only ever written by the approve/reject routes, gated by
  `requireAdmin()`; no submit-time schema field for it exists at all).
- Locked `Surprise` fields cannot be modified post-creation (confirmed —
  there simply is no update endpoint for them, which was already the
  design; stronger than a flag check).
- **This pass's schema changes** (`Payment.screenshotUrl` →
  `screenshotKey`, new `User.passwordChangedAt`) are both additive/renaming,
  not destructive, but **do require a new migration**
  (`npx prisma migrate dev --name security_hardening`) before the app will
  run against an existing database. If a real deployment already has
  production `Payment` rows with `screenshotUrl` data, don't accept
  Prisma's default migration diff blindly — a column rename can get
  diffed as drop-and-recreate depending on the exact scenario, which would
  silently lose that data. Write the migration by hand (`ALTER TABLE
  payments RENAME COLUMN "screenshotUrl" TO "screenshotKey"`) if that
  applies. This project has no production data yet, so this wasn't
  exercised here — flagging it for whoever deploys against a database that
  does.

### 18. Production build — scaffolding gap found and fixed; full build not run

**Found while attempting to verify the build:** the project had no
`tsconfig.json`, `next.config`, `next-env.d.ts`, or `.eslintrc` at all —
`npm run build` would have failed immediately, before a single line of
this app's own code was even checked, regardless of code quality. This
wasn't a lint/type issue to fix, it was a missing-scaffolding issue,
now fixed: all four files added, plus a `.gitignore` (also previously
missing — `.env`, `node_modules`, and both upload directories would have
been committable).

**What was actually run and verified:** this sandbox has no network
access, so `npm install`, `npx prisma generate`, `npx prisma migrate`, and
a real `next build` genuinely could not be executed — running any of them
would fail on missing packages, not on anything about this code. What
*could* be run: the standalone `tsc` compiler (available globally in this
environment, independent of this project's own dependencies) against
every `.ts`/`.tsx` file in `src/` and `scripts/`, syntax-only
(`--noEmit`, `--skipLibCheck`, no type resolution for uninstalled
packages). Result: **zero syntax errors** across all ~90 files. Every
reported error was manually confirmed to be missing-dependency noise
(`Cannot find module 'next'/'@prisma/client'/etc.`, `Cannot find name
'process'/'global'` from missing `@types/node`) — expected and harmless
given `npm install` never ran, not a defect in this code.

**What this does and doesn't prove:** it confirms every file is
syntactically valid TypeScript/TSX — no mismatched braces, malformed JSX,
or broken statements anywhere in the codebase. It does **not** confirm
type-correctness against the real Prisma-generated client or Next's own
types, successful compilation end-to-end, correct hydration, or runtime
behavior — none of that is checkable without `npm install` and a real
`next build`, which need network access this sandbox doesn't have. Before
trusting this in production: run `npm install && npx prisma generate &&
npm run build` for real, and fix whatever that surfaces (there may well be
something — a syntax check is real evidence of code health, not a
substitute for a real build).

### What's Complete / Requires production infrastructure / Future work

**Complete — code written, reasoned through, and, where possible in this
environment, verified:**
- Public/private storage split; payment screenshots have no public URL
  under the local provider
- Real content-sniffing on every upload endpoint
- Path-traversal guard in the local storage provider
- Admin-only, authenticated screenshot viewing route
- `screenshotKey` never sent to the browser, even to an admin
- Draft-upload cleanup script (logic complete; not run against a live DB)
- Real OG image asset (visually verified; not verified in an actual link-preview crawler)
- Admin password change with genuine multi-device session revocation
- Password-reset flow also revokes existing sessions (fixed gap)
- Rate limiting extended to every sensitive endpoint
- Security headers including CSP, Permissions-Policy, HSTS
- Seven routes newly wrapped in consistent, non-leaking error handling
- `.env.example` fully updated; no hardcoded secrets found
- Missing project scaffolding (`tsconfig.json`, `next.config.ts`, `next-env.d.ts`, `.eslintrc.json`, `.gitignore`) added
- Zero syntax errors confirmed via standalone `tsc` across the entire codebase

**Requires production infrastructure to be genuinely true (code is ready, not yet connected/tested):**
- S3-compatible private bucket for payment screenshots at real scale — the
  local provider's privacy guarantee (no public path) is real today, but
  is a single-server property
- A real email provider for password-reset delivery (currently logs the
  link server-side in development only)
- Redis/Upstash (or similar) if running more than one server instance —
  both rate limiting and the in-memory login-style buckets are
  single-process only
- Actually running `npm install && npm run build && npx prisma migrate
  deploy` — genuinely not possible from this sandbox (no network); the
  standalone syntax check is real signal but not a substitute
- Verifying OG image rendering inside actual WhatsApp/Twitter/Facebook
  crawlers, which requires a real public deployment URL

**Future work — genuinely still open, not started this pass:**
- A defined, implemented screenshot retention/deletion policy (the
  capability exists via `storage.deletePrivate`; no policy decision was
  made or automated)
- A nonce-based (rather than `'unsafe-inline'`) CSP for script/style —
  deliberately deferred, see section 14 above
- Admin dashboard UI has no per-user detail page yet (the underlying API,
  `GET /api/admin/users/[id]`, exists and was included in this pass's
  audit, but nothing in the frontend calls it yet)
- No automated test suite of any kind exists for this project

### Known remaining risks, stated plainly

- Everything under "Requires production infrastructure" above is a real
  risk until that infrastructure is actually in place — code readiness is
  not the same as production security.
- Rate limiting and the login/upload buckets reset on every server
  restart/redeploy (in-memory) and don't coordinate across instances —
  someone could evade limits by timing requests around deploys, or by
  hitting different instances if scaled horizontally, until Redis is
  wired in.
- The CSP's `'unsafe-inline'` for scripts is a real, if standard-for-Next.js-without-nonces, relaxation — it doesn't defend against a successful XSS the way a strict nonce-based policy would.
- This pass did not have a real database, a real filesystem with existing
  uploads, or network access to run this application even once. Every
  claim above that isn't explicitly hedged with "not tested" reflects
  careful code review and reasoning, not an executed test run. Treat this
  as a thorough, honest static audit — not a substitute for actually
  running the app against a staging environment before launch.

## 18. Final production QA and deployment-readiness pass

A last pass focused on integration problems static inspection alone can't
catch — installation, build, and end-to-end behavior — plus closing the
remaining documentation staleness from earlier passes. Read this section
alongside its own honesty requirement: distinguishing **static
inspection** (reading code), **local execution** (something actually run
in this sandbox), and **infrastructure-dependent testing** (browser,
database, deployed environment — none of which this sandbox has).

### Environment check

This sandbox's network access to the npm registry returns `403 Forbidden`
(confirmed by directly attempting `npm install` — not a vague
connectivity issue, an explicit policy block). There is also no local
PostgreSQL, no Docker, and no project `node_modules` (this project has
never had `npm install` run against it in any session). Every finding
below reflects that constraint honestly.

### Installation verification (static inspection)

- **`package.json`**: reviewed. Two real gaps found and fixed:
  - No `lint` script existed at all, despite `.eslintrc.json` (added in
    the prior pass) referencing `next/core-web-vitals` — added
    `"lint": "next lint"` and `"type-check": "tsc --noEmit"`.
  - `eslint` and `eslint-config-next` were never added as dependencies,
    so `next lint` would have failed with a missing-package error even if
    `npm install` could run. Added both to `devDependencies`.
- **Lockfile**: **none exists.** `npm install` has never successfully run
  against this project in any session (no network access in any of them).
  A lockfile can't be honestly hand-written — it encodes exact resolved
  versions and integrity hashes computed by actually resolving the
  dependency graph against the registry, not something to fabricate. This
  is a real, standing gap: **the first `npm install` on a machine with
  real network access will both install dependencies and generate
  `package-lock.json` for the first time** — commit the result.
- **Prisma config**: `prisma/schema.prisma` re-read in full; confirmed
  syntactically well-formed (balanced blocks, valid field/attribute
  syntax) by manual inspection — `prisma validate` itself requires the
  Prisma CLI, which requires `npm install`, which requires network. Not
  run.
- **Next.js config**: `next.config.ts` reviewed; no issues found.
- **TypeScript config**: `tsconfig.json` reviewed; standard, matches the
  `@/*` → `./src/*` path alias used throughout the codebase.
- **Environment variables**: full audit below.

### Production build — NOT run; here's exactly why and what was done instead

**`npm run build` was not executed and I am not claiming it passed.** It
cannot run without `node_modules`, which cannot be installed without
network access, which this sandbox does not have. Saying otherwise would
be exactly the overclaiming this task explicitly prohibits.

What was actually done as the closest honest substitute:

- A **fresh, complete syntax-only check** with the standalone `tsc`
  compiler (available in this sandbox independent of this project's own
  dependencies) across all 88 `.ts`/`.tsx` files in `src/`, `scripts/`,
  and `next.config.ts`: **zero syntax errors (TS1xxx)**. Every remaining
  reported error was individually categorized and confirmed to be
  missing-dependency noise (`Cannot find module 'next'` /
  `'@prisma/client'` / etc., `Cannot find name 'process'`/`'global'` from
  absent `@types/node`) — expected and harmless given `npm install` never
  ran, not a defect in this code.
- This proves every file is syntactically valid TypeScript/TSX. It does
  **not** prove type-correctness against the real generated Prisma client
  or Next's own types, successful bundling, correct hydration, or runtime
  behavior — none of that is checkable without a real `next build`.

### Lint / type check

- **`next lint`**: cannot run — `eslint-config-next` isn't installed (see
  above), and installing it needs network access this sandbox doesn't
  have.
- **`tsc --noEmit`** (the new `type-check` script): run in the
  syntax-only mode described above. A **full** type check (resolving
  against the real `@prisma/client` types, Next's types, etc.) was not
  possible for the same missing-`node_modules` reason. The syntax-only
  result is real signal, not a substitute for the full check — run
  `npm run type-check` for real once dependencies are installed.

### Database (Prisma) — NOT run against PostgreSQL

No PostgreSQL instance, Docker, or network access to provision one exists
in this sandbox. **None of the following were executed and none are
claimed as verified:** migration generation/application, Prisma Client
generation, or any actual `User`/`Payment`/`Surprise`/`SurprisePhoto`/
`SiteSettings`/`AuditLog` row creation. What *was* done: careful manual
re-reading of the full schema (reproduced in section 4 above) confirming
internal consistency — every `screenshotKey` reference across the entire
`src/` tree matches the schema field name exactly (grep-verified, zero
stale `screenshotUrl` references outside intentional historical narrative
in this document), and likewise for `passwordChangedAt` across
`change-password`, `reset-password`, `lib/auth.ts`, and
`lib/auth-middleware.ts`. This confirms the rename and the new field are
used *consistently*, not that the migration itself will apply cleanly —
that requires a real database.

### Complete user flow, photo update flow, security scenarios, mobile QA, public-experience QA (items 6–19 of the task)

**None of these were executed.** They require a running application in a
real browser — registering an account, submitting a payment, clicking
through the wizard, opening a public surprise link, testing at specific
viewport widths, inspecting actual HTTP response headers, attempting
cross-account API access with a real second session, etc. This sandbox
has no way to serve this Next.js application and interact with it. Every
one of these is **BLOCKED BY ENVIRONMENT** in the checklist below, not
silently skipped — each was previously addressed at the *code* level
(ownership checks, field selections, error states, responsive CSS) during
earlier passes, and re-confirmed at the *code* level again in this pass
via the audits above and below, but code review is not the same claim as
"tested in a browser," and this document does not conflate the two.

### Error / logging audit (re-run fresh this pass)

- Every `route.ts` in the project (grep-verified, all ~40) now has either
  `withErrorHandling` or its own top-level `try/catch` — zero unprotected
  routes.
- `withErrorHandling`'s catch-all logs the real error server-side
  (`console.error`) and returns a fixed, generic client message — grep-
  confirmed no route echoes `err.message`/`err.stack` directly to the
  client.
- The 8 places that *do* send `(err as Error).message` to the client
  (the upload/validation routes) were individually traced: all 8 are
  scoped tightly around calls to `assertValidImage`/`assertValidAudio`/
  `assertContentMatchesDeclaredType`, which only ever throw one of 7
  hand-written, safe messages ("Please upload JPG, PNG or WEBP.", etc.) —
  never a raw system or Prisma error.
- **One thing worth naming plainly rather than just leaving implicit**:
  `forgot-password`'s dev-mode `console.log` includes the *raw, unhashed*
  reset token as part of the full reset URL. This is already documented
  as a local-development-only stand-in for a real email provider (section
  10), but is re-flagged here explicitly: if this code is ever deployed
  without replacing that `console.log` with a real email send, the reset
  token would appear in server/hosting-platform logs — a genuine
  production risk if missed, not merely a style note. See "Remaining
  risks" below.

### Cleanup script — logic re-verified by hand-tracing, still not executed

Re-traced `scripts/cleanup-draft-uploads.ts` end-to-end by hand against
the actual URL formats the rest of the app produces: `uploadPublic`
returns `/uploads/{folder}/{uuid}.{ext}` where `folder` is
`drafts/{userId}` (or `drafts/{userId}/audio`) during the wizard;
`listPublicUnder("drafts")` reconstructs the exact same `/uploads/...`
string from the filesystem walk. Confirmed these match byte-for-byte, so
the in-use-vs-orphaned cross-check against `SurprisePhoto.imageUrl`/
`Surprise.musicUrl` is sound. Also confirmed photos uploaded *after*
surprise creation (via `/api/surprises/photos`, folder
`surprises/{surpriseId}`) never live under `drafts/` at all, so they're
correctly outside this script's scope entirely — never at risk of
deletion by it. **Still not run against a live database or filesystem** —
this is careful logic-tracing, not an executed test. `--dry-run` first
against a real deployment, as already advised in section 17.

### Environment variable audit

Every `process.env.*` reference in `src/`, `scripts/`, `next.config.ts`,
and `prisma/schema.prisma`'s `env()` call was enumerated and diffed
against `.env.example` in both directions: **zero undocumented variables
referenced in code, and zero stale/unused entries in `.env.example`.**

| Variable | Category | Why |
|---|---|---|
| `DATABASE_URL` | **Required** | Prisma cannot connect without it |
| `AUTH_SECRET` | **Required** | `lib/auth.ts` throws explicitly on boot-time use if missing or under 32 chars — no session can be created or verified |
| `NEXT_PUBLIC_APP_URL` | **Required for correct behavior** | Doesn't crash without it, but public surprise links and password-reset links are built by prefixing this — empty without it |
| `LOCAL_UPLOAD_DIR` | Optional | Defaults to `./public/uploads` |
| `LOCAL_PRIVATE_UPLOAD_DIR` | Optional | Defaults to `./private-uploads` |
| `STORAGE_PROVIDER` | Optional (currently inert) | Defaults to `"local"`; setting it to `"s3"` alone does nothing yet — `lib/storage.ts`'s S3 provider is still commented-out code, not switched on by this variable |
| `UPLOAD_CLEANUP_AFTER_HOURS` | Optional | Defaults to 24 |
| `RATE_LIMIT_*` (7 variables) | Optional | Each has a sane default; see `docs/API.md`'s rate-limiting table |
| `STORAGE_URL` / `STORAGE_KEY` / `STORAGE_SECRET` / `STORAGE_REGION` / `STORAGE_PUBLIC_BUCKET` / `STORAGE_PRIVATE_BUCKET` / `STORAGE_PUBLIC_BASE_URL` | **Production-only** | Unread by any active code path today — only meaningful once the S3 provider in `lib/storage.ts` is uncommented |
| `NODE_ENV` | Framework-managed | Not in `.env.example` by convention — set automatically by `next dev`/`build`/`start`, never by hand. Affects the `Secure` cookie flag and Prisma log verbosity |

**A gap this audit surfaced rather than papered over:** there is no email
provider variable (no `SMTP_*`, no `RESEND_API_KEY`, etc.) anywhere,
because no real email-sending integration exists yet — this is the same
gap named in section 10 and re-flagged in "Remaining risks" below, not a
new discovery, but worth being explicit that it means **zero** production
email configuration currently exists, not just an unset one.

### Repository hygiene (re-checked fresh)

- Fresh secret scan (API keys, private key headers, embedded DB
  credentials) across `src/`, `prisma/`, `scripts/`, `next.config.ts`,
  `package.json`: **none found.**
- `.gitignore` re-read in full: covers `.env`/`.env.local`/`.env.*.local`
  (never `.env.example`, verified not accidentally matched),
  `node_modules`, `.next`/`out` build output, both upload directories,
  logs, and OS/editor cruft.
- No `.env` file exists in the tree (only `.env.example`) — confirmed.
- Confirmed `next-env.d.ts` is deliberately *not* gitignored (its own
  file comment explains why — committed so the project has a complete
  file set without relying on first-run generation).

### Stale documentation found and corrected in this pass

Re-reading this document end-to-end surfaced **four places** where
earlier passes' "not yet built" language was never updated after the
thing was, in fact, later built — a real documentation-hygiene bug, not
just a nitpick, since a reader landing on an early section could be
misled about the project's actual current state:

1. A "Still not built (next candidates)" list (originally written right
   after the backend-only pass) still claimed the public page, admin
   panel, password change, and cleanup job were unbuilt — all four were
   completed in later passes. Struck through with pointers to where each
   was actually built, rather than deleted outright, so the document's
   turn-by-turn history stays legible.
2. A "Known gaps" list (written right after the admin-panel pass) made
   the same claims about the OG image, payment-screenshot privacy, and
   password change — all fixed in the security-hardening pass. Same
   treatment.
3. The public-surprise-page section's "Not yet real" note about the OG
   image — fixed; updated in place.
4. `/create/page.tsx`'s description in the frontend-onboarding section
   described it in the present tense as *still* showing a placeholder,
   after the wizard pass had already replaced that placeholder entirely.
   Clarified as describing that pass's state specifically, with a pointer
   forward to the actual wizard section.

### Production checklist

**VERIFIED** (actually run/checked in this sandbox, with real output):
- Zero syntax errors across all 88 TS/TSX files (standalone `tsc`, fresh run)
- Zero hardcoded secrets anywhere in the repository (fresh grep audit)
- `screenshotKey` and `passwordChangedAt` used consistently everywhere they appear (grep-verified across every call site)
- Every API route has error handling; no route leaks `err.message`/`err.stack` to the client (grep-verified)
- Every client-facing validation error message traced to one of 7 hand-written safe strings, never a raw system error
- `.env.example` matches actual code usage exactly, both directions (no undocumented vars, no stale entries)
- `.gitignore` correctly excludes secrets/build output/uploads; no `.env` file present; no accidental exclusion of `.env.example`
- Cleanup script's URL-reconstruction logic hand-traced and confirmed byte-for-byte consistent with what the rest of the app actually stores
- Four stale "not yet built" documentation claims found and corrected

**BLOCKED BY ENVIRONMENT** (could not be tested here — no network, no database, no browser):
- `npm install` (registry returns 403; no lockfile could ever be generated in any session so far)
- `npm run build` (needs `node_modules`)
- `npm run lint` (needs `eslint-config-next` installed)
- Full `tsc` type check against real Prisma/Next types (only syntax-only mode was possible)
- Any Prisma migration or Client generation against a real PostgreSQL database
- Every item in "Complete user flow" through "Public surprise QA" (task items 6–19) — registration, login, payment submission, wizard completion, public-page rendering, admin approve/reject clicks, cross-account IDOR attempts with real sessions, actual HTTP response header inspection, mobile viewport rendering, microphone permission prompts — all require a running app in a real browser

**REQUIRES PRODUCTION CONFIGURATION** (code exists and is ready; real infrastructure has never been connected or tested against it):
- A real PostgreSQL database
- S3-compatible object storage (public + private buckets) for the storage provider to actually switch away from local disk
- A real email provider for password-reset delivery
- A production domain with HTTPS (several security properties — Secure cookies, HSTS — are inert or no-ops without it)
- Redis/Upstash (or equivalent) before running more than one server instance, for both rate limiting and login-attempt tracking
- A backup strategy for the database (not addressed by this project at all — genuinely out of scope for an application-layer pass, named here because the task asked for it explicitly)

**REMAINING RISKS** (genuine, unresolved, not already-fixed items dressed up as risks):
- ~~The dev-mode password-reset `console.log` included the raw reset token~~ — fixed in section 19 (no token or reset URL is logged or returned anywhere)
- No lockfile exists, so dependency versions aren't actually pinned yet — the first real `npm install` determines the exact resolved tree; until then, `^`-range versions in `package.json` mean the *exact* set of installed packages has never been fixed or verified to work together
- Nothing in this project has ever been executed end-to-end, in any session — every "fixed" claim across every pass of this project reflects careful code construction and static/logical verification, not a running, tested application. That gap only closes with real `npm install` + a real database + a real browser, none of which are available here

## 19. Remediation pass: reset-token logging, and a re-attempted install

### Reset-token logging — fixed

`forgot-password` previously printed `[password reset] <email> → <reset URL>`
— the URL contains the raw token, i.e. a credential. Removed. Delivery now
goes through `src/lib/email.ts` → `sendPasswordResetEmail(to, resetUrl)`,
which currently sends nothing and logs only the fixed string
`Password reset email delivery is not configured.` It never logs or returns
either argument, and the API response is unchanged (generic message, no
token). A grep of `src/` confirms no `console.*` call references a token or
reset URL.

**Behavior consequence, stated plainly:** with no email provider, password
reset **cannot complete end to end** — the token is generated and stored
hashed, but nobody receives it. Also, the generic response text still says
"we've sent a reset link" (required to avoid revealing which emails
exist), which is untrue until a provider is wired into `lib/email.ts`.
Don't launch relying on self-service password reset before that is done.

### Lockfile

Not created — deliberately not hand-written. Run `npm install` where the
registry is reachable and commit the generated `package-lock.json`.

### Install retry

`npm install` was retried this pass: still `E403 Forbidden` from
`registry.npmjs.org` (environment/policy block, not a code problem).
Per the pass instructions, all runtime steps (Prisma validate/generate,
type check, ESLint, build, smoke tests, runtime security checks) were
**not run**. Offline checks done: every imported package is declared in
`package.json` (the `@aws-sdk/*` imports are inside the commented-out S3
block); `build`/`lint`/`type-check`/Prisma scripts exist; `eslint` and
`eslint-config-next` are declared; syntax-only `tsc` over 89 files shows
zero syntax errors.

### New finding: no migrations are committed

`prisma/migrations/` does not exist. `npm run db:deploy`
(`prisma migrate deploy`) applies committed migrations, so on a fresh
database it would do nothing useful. On a machine with a database, run
`npx prisma migrate dev --name init` once, review the generated SQL, and
commit `prisma/migrations/` before deploying.
