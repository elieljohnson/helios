# Helios Engineering Primer

**A plain-English guide to the technologies, principles, and patterns used to build Helios. Written for credibility in interviews and conversations — not for coding.**

This document has two parts:

1. **The story** — how everything fits together, in narrative form
2. **The glossary** — every term, defined in plain English with a "why we used it" note

Read part one first. Refer to part two when you want to look up a term you encountered.

---

# Part 1: How Helios works, end to end

Imagine a single sentence that describes Helios: *every five minutes, a piece of code wakes up, asks four different companies' computers what's happening at our house, decides what to do, sends commands back to those companies' computers, and writes everything down in a database.* That's it. Everything else is plumbing for that sentence.

Let's walk through what each piece of plumbing actually is.

## The website

Helios looks like a website because it is one. When you visit `helios-eliel.vercel.app` in your browser, your phone is loading **HTML, CSS, and JavaScript** — the three languages every website is made of. The HTML is the structure (where the boxes go), the CSS is the styling (what colors they are), and the JavaScript is the behavior (what happens when you tap a button).

But that website is not a single file sitting on a single computer somewhere. It's a complete application that runs partly in your phone's browser and partly on **servers** — which are just other people's computers, sitting in data centers, that we rent. The split between "what runs on your phone" and "what runs on the server" is one of the most important distinctions in modern web development. Some things have to run on the server (anything touching our database, anything with secret credentials), and some things have to run on your phone (anything that responds to a tap or a swipe instantly).

The framework that makes this split tractable for us is called **Next.js**. Without it, we'd have to build two separate applications — one for the browser, one for the server — and constantly fight to keep them in sync. With it, we write code once and Next.js figures out where each piece runs.

## The hosting

We don't own servers. We rent capacity from a company called **Vercel**, which owns servers and runs them on our behalf. When I push new code to GitHub, Vercel notices, builds the application, and deploys it to its servers worldwide within about 90 seconds. If a thousand people visit the dashboard at once, Vercel scales up automatically; if nobody visits for a day, Vercel scales down to zero and we pay nothing.

This pattern is called **serverless**. It's a misleading name — there are still servers — but the point is that we never think about them. We don't pick which physical machine our code runs on, we don't manage operating system updates, we don't configure load balancers. Vercel handles all of that. What we pay for is a flat monthly subscription ($20 for the Pro plan) plus a small fee per million requests if we exceed the free tier.

## The database

When the cron job wakes up every five minutes and reads the state of our solar system, it has to write that reading down somewhere so the dashboard can read it back later. That "somewhere" is a **database** — specifically, a **PostgreSQL** database (often shortened to "Postgres") hosted by a company called **Neon**.

A database is, at its core, a giant ordered set of tables — like a stack of spreadsheets that are connected to each other. Helios has a `energy_snapshots` table where every cron tick adds a row recording solar production, Powerwall state, EV state, etc. It has a `control_actions` table that logs every decision the engine makes. It has a `user_config` table with one row holding all the user-adjustable settings.

Postgres is one of dozens of database technologies — there's also MySQL, MongoDB, Redis, DynamoDB, Firebase, and many others. We picked Postgres because it speaks **SQL**, which is the standard language for asking complex questions of structured data. ("Show me the average self-sufficiency by hour of day for the last 30 days" is a one-line SQL query against Helios's data; in some other databases it would take a paragraph of code.)

Neon is a service that runs Postgres for us, the way Vercel runs servers for us. We don't install Postgres, we don't pick a server size, we don't manage backups manually. Neon handles all of that, and like Vercel, scales to zero when idle.

## The cron

The dashboard updates by itself even when nobody's looking at it because of a separate piece of automation called a **cron job**. The name comes from "chronos" — Greek for "time" — and it just means "a thing that runs on a schedule." Helios's cron runs every 5 minutes. We set it up using **GitHub Actions**, which is a service GitHub provides that runs automation tasks for us for free.

Every five minutes, GitHub Actions makes a network request to a specific URL on our website (`helios-eliel.vercel.app/api/cron/decide`). That URL triggers the entire decision pipeline: read the providers, run the engine, push commands, log the result. The fact that this is a regular HTTP request — same kind of request your browser makes when you visit a webpage — is what makes the whole system glue together cleanly.

## The integrations

The most consequential and finicky part of Helios is its connections to four other companies' systems:

- **Tesla** owns our Powerwalls and gives us live state through their **Fleet API**
- **Rivian** owns our truck and gives us charge control through their (unofficial) **GraphQL API**
- **Enphase** monitors our solar panels (currently disabled but kept warm)
- **Open-Meteo** provides solar production forecasts (free, no auth required)

Connecting to a company's API is more involved than calling a webpage. We have to **authenticate** — prove that we're allowed to ask their system about our equipment. The standard pattern for this is called **OAuth 2.0** (or just "OAuth"), and it works like this:

1. The user clicks "Connect Tesla account" on Helios
2. Helios redirects them to Tesla's website
3. The user logs into Tesla there (Tesla never sees our password, we never see Tesla's)
4. Tesla redirects back to Helios with a one-time **code**
5. Helios trades that code with Tesla for an **access token** — a long random string that proves we have permission
6. Every API call we make includes that access token in a header
7. Tokens expire (usually in 4-12 hours), so we also get a **refresh token** that lets us renew the access token without re-prompting the user

The whole dance happens once when you connect an account, then runs in the background forever. The tokens live in our database, encrypted, and the integration code knows how to refresh them automatically when they expire.

## The decision engine

Once the cron has read everything from the providers, it calls two functions: `decide()` for the Powerwall reserve target, and `decideEvCharge()` for the EV. Both are **pure functions** — given the same inputs, they always return the same outputs, and they don't change anything in the world (the calling code is responsible for actually pushing commands).

This purity is intentional and deeply consequential. It means we can test the engine by giving it fake snapshots and asserting what it returns, without ever connecting to Tesla or Rivian or anything else. We have 58 such tests; they run in 300 milliseconds; they're our safety net every time we change a rule.

The engine is structured as a series of **gates**: "Is the car plugged in? If not, hold. Is the EV at its target SoC? If yes, stop. Is it past the sunset cutoff? If yes, run the past-cutoff branch. Is the Powerwall on track to hit target? If not, stop the EV." Each gate either commits to a decision or falls through to the next. This pattern is easy to reason about, easy to test, and easy to add to without breaking existing logic.

## The dashboard

Everything we've described so far happens behind the scenes. The user-facing piece is the dashboard, which reads the most recent `energy_snapshots` row from the database and displays it as cards: the supply/demand bar, the cost-today number, the activity log, and so on.

The dashboard is built with **React**, which is a JavaScript library for building user interfaces out of components. Each card on the dashboard is a React component. When the data changes, React figures out which pixels need to update and updates only those, instead of redrawing the whole page. This is why the dashboard feels instant even though it's loaded over the internet.

The data refreshes every 30 seconds via a library called **SWR**, which stands for "stale-while-revalidate." The pattern: show the user the data we have right now (even if it's slightly out of date), then quietly fetch fresh data in the background, then update the display when the fresh data arrives. The user never sees a loading spinner unless it's the first visit.

## Authentication for portfolio sharing

The dashboard is public — anyone can visit and see live state. The Settings page and the API endpoints that *change* state (like adjusting the Powerwall reserve) require authentication. We implemented this with a single shared password that's compared against an environment variable called `ADMIN_TOKEN`.

When you log in at `/admin/login`, the server checks your password and, if it matches, sets a special **cookie** in your browser called `helios_admin`. Cookies are tiny pieces of data that your browser automatically sends with every subsequent request to the same site. Our **proxy** (a Next.js feature for intercepting requests) checks for that cookie before allowing any write operation. No cookie or wrong cookie? 401 Unauthorized.

The cookie is marked **HttpOnly** (JavaScript on the page can't read it, blocking a class of cross-site attacks), **Secure** (only sent over encrypted HTTPS connections), and **SameSite=Lax** (won't be sent if a malicious site tries to trigger a request to ours).

That's the whole authentication system. It's intentionally minimal because we have one user. A multi-user system would replace this with a database-backed sessions table, password hashing, password reset flows, etc. — but at our scope it would be over-engineering.

## How everything fits together

Picture the system as five concentric circles:

1. **The center**: pure functions (`decide`, `decideEvCharge`) that take inputs and produce decisions. No I/O, no side effects, fully testable.
2. **Around them**: the integration adapters (`src/lib/tesla`, `src/lib/rivian`, etc.) that translate between vendor APIs and our internal types.
3. **Around those**: the cron route handler that orchestrates a single tick — read, decide, act, log.
4. **Around that**: the database, which is the system's memory. Every snapshot, every action, every config change persists here.
5. **The outermost layer**: the user-facing UI that reads the database and displays it as cards. The UI never *decides* anything; it only mirrors what the engine has already done.

The directional flow is one-way: requests come in from outside (cron, browsers), get processed through the layers, write to the database, and the database becomes the new authoritative state for the next tick. There's no shared in-memory state, no global variables, no thread-safety concerns — every request stands alone.

That clean separation is what makes the system possible to reason about. It's also what makes it possible to evolve. Adding a new integration is a new file in `src/lib/`. Adding a new rule is a new gate in the engine. Adding a new card is a new React component. The architecture invites change instead of resisting it.

---

# Part 2: Glossary

Each term is defined in plain English, with a *why we use it* note explaining its role in Helios. Group the terms by domain in your head; the categories below are the same categories you'd encounter in any modern web project.

---

## Cloud and hosting

### Server
**Plain English**: A computer that's always on, connected to the internet, and runs code on behalf of users. Servers are physical hardware (or virtual slices of hardware) that companies rent out.

**In Helios**: Vercel runs our code on its servers; Neon runs our database on its servers. We don't own any servers — we just rent capacity.

---

### Vercel
**Plain English**: A hosting company that specializes in modern web applications. You push code to GitHub, Vercel notices, builds and deploys it within a couple of minutes. It also provides a global content-delivery network, free SSL certificates, secret management, and serverless functions — all bundled.

**In Helios**: Our deployment target. The application lives at `helios-eliel.vercel.app`, which is a Vercel-managed subdomain. We're on the Pro plan ($20/mo) which adds advanced cron, longer function timeouts, and team features.

**Why we use it**: Zero operational overhead. The alternative is running our own servers, which for a personal project would cost more in time than the entire app is worth.

---

### Serverless / Edge functions
**Plain English**: A way of running code where you don't think about servers at all. You write a function, deploy it, and the platform spins up a tiny container to run it whenever a request comes in — then shuts the container down when the request is done. You pay per request, not per hour.

**In Helios**: Every API endpoint (`/api/status`, `/api/config`, `/api/cron/decide`, etc.) is a serverless function. They're invoked on demand and shut down between calls.

**Why we use it**: Scales to zero when idle (cheap), scales up automatically when busy (no capacity planning), no patching or OS maintenance.

---

### CDN (Content Delivery Network)
**Plain English**: A network of servers in cities worldwide that store cached copies of your website's static files (images, CSS, JavaScript bundles). When a user in Tokyo visits the site, they download from a Tokyo server instead of one in Virginia — way faster.

**In Helios**: Vercel includes a global CDN automatically. The dashboard loads in under a second even from far away.

---

### Domain / DNS / CNAME
**Plain English**: A **domain** is the human-readable address of a website (`google.com`). **DNS** (Domain Name System) is the global phone book that translates domains into the numeric addresses computers actually use. A **CNAME** is a kind of DNS entry that says "this domain is an alias for that other domain."

**In Helios**: `helios-eliel.vercel.app` is our primary URL. If we ever want `helios.elieljohnson.com`, we'd add a CNAME at our DreamHost-managed elieljohnson.com pointing at Vercel.

---

### GitHub
**Plain English**: A website where developers store and collaborate on code. The underlying technology is **git**, a version-control system that tracks every change to every file over time, lets you branch off and merge work, and lets multiple people work in parallel.

**In Helios**: Our code lives at `github.com/elieljohnson/helios`. Pushing a commit to the `main` branch triggers Vercel to deploy.

---

### GitHub Actions
**Plain English**: GitHub's built-in automation system. You write a YAML file describing what should happen on a schedule or when an event occurs (a push, a pull request, etc.), and GitHub runs it on its own servers for free.

**In Helios**: Runs our cron job every 5 minutes. We picked GitHub Actions because Vercel's cron has a 1-day minimum on Pro and ours needs to fire 12 times an hour.

---

### Environment variables
**Plain English**: Configuration values that are stored *outside* the code so they can be different in development vs. production. Things like database passwords, API keys, and feature flags live as environment variables, not as hardcoded strings in the source.

**In Helios**: We have ~15 of them — `DATABASE_URL`, `TESLA_CLIENT_ID`, `ADMIN_TOKEN`, etc. — managed in Vercel's dashboard. The code reads them as `process.env.DATABASE_URL` and never knows the actual value at the moment of writing.

**Why this matters**: The same code can run against a dev database locally and a production database on Vercel without any code changes — just different env vars.

---

## The application framework

### HTML / CSS / JavaScript
**Plain English**: The three languages every website is built from. **HTML** is structure (headings, paragraphs, buttons). **CSS** is styling (colors, fonts, layouts). **JavaScript** is behavior (what happens when you click).

**In Helios**: Every modern framework — including Next.js — eventually compiles down to these three languages, because that's what browsers understand.

---

### TypeScript
**Plain English**: JavaScript with type annotations. Where plain JavaScript lets you write `function add(a, b) { return a + b }` and find out it's broken at runtime when someone passes a string, TypeScript lets you write `function add(a: number, b: number): number { return a + b }` and the compiler tells you immediately if you call it wrong.

**In Helios**: Every file is TypeScript. Strict mode is enabled, which catches a wide class of bugs at compile time. Cost: about 10% more characters typed. Benefit: massively reduced bugs, much better autocomplete in the editor, easier refactoring (rename a field and the compiler shows everywhere it's used).

**Why this matters in interviews**: TypeScript is the de facto standard for new JavaScript projects in 2025-26. Saying "we use TypeScript" is now table stakes; saying "we use TypeScript with strict mode" demonstrates intentionality.

---

### React
**Plain English**: A JavaScript library for building user interfaces from reusable components. Instead of one big HTML page, you compose a tree of components — `<Button>`, `<Card>`, `<Dashboard>` — each of which manages its own state and renders its own HTML.

**In Helios**: The entire frontend is React. `<HeroCard>`, `<EvPolicyForm>`, `<SelfSufficiencyHistoryCard>` etc. are React components. When the data changes, React efficiently figures out which DOM elements to update.

---

### Next.js
**Plain English**: A framework built on top of React that adds server-side rendering, routing, API endpoints, image optimization, and a dozen other things. It's the most widely used React framework in 2026 and is built by Vercel (the same company that hosts our app).

**In Helios**: We're on Next.js 16 (the latest major version). The `app/` directory structure is the modern "App Router" pattern; each folder is a URL, and `page.tsx` files are the pages.

**Why this matters**: Next.js handles the server/client split automatically. We write a single component; Next.js decides whether it runs on the server (for first paint) or in the browser (for interactivity). Without Next.js, we'd build two separate apps and constantly fight to keep them aligned.

---

### App Router
**Plain English**: Next.js's modern way of mapping folders to URLs. The folder `app/settings/page.tsx` becomes the URL `/settings`. Special files like `layout.tsx` (shared layout), `loading.tsx` (loading state), and `error.tsx` (error fallback) get rendered automatically.

**In Helios**: All our routes use the App Router. The earlier convention (the "Pages Router") is still supported but considered legacy.

---

### Server Components vs. Client Components
**Plain English**: In modern Next.js, components default to running on the **server** (faster first paint, no JavaScript downloaded for them). Components marked `"use client"` at the top of the file run in the **browser** (can use hooks, respond to clicks, etc.). The framework handles the boundary.

**In Helios**: The Settings form is a Client Component (it needs to respond to typing and submission). The Hero card on the homepage is a mix — the layout is server-rendered, but the live data updates in the client.

---

### Hooks
**Plain English**: React's mechanism for components to "remember things" and "react to changes." `useState` lets a component remember a value across renders. `useEffect` lets it run code when something changes. `useSearchParams` reads URL parameters. Hooks always start with the word "use" by convention.

**In Helios**: We use a half-dozen built-in hooks plus a custom one (`useAdmin`) that wraps SWR to check authentication.

---

### SWR
**Plain English**: A React data-fetching library whose name stands for "stale-while-revalidate." The pattern: show the cached data right now, fetch fresh data in the background, swap it in when ready. The user never sees a loading spinner on subsequent visits.

**In Helios**: Every dashboard card uses SWR to fetch its data from `/api/status` and friends. The 30-second refresh interval keeps the dashboard live without manual refreshes.

---

### Tailwind CSS
**Plain English**: A CSS framework where instead of writing CSS files, you put styling classes directly on HTML elements: `<button class="bg-blue-500 text-white px-4 py-2 rounded">`. Each class corresponds to a single CSS property. The result is a constrained, consistent visual system that's hard to misuse.

**In Helios**: We use Tailwind 4 (the latest major version). The design tokens (colors, spacing) are defined in CSS variables (`--solar`, `--battery`, etc.) and consumed both via Tailwind classes and inline styles.

**Why we use it**: Faster to iterate than writing CSS, harder to introduce visual inconsistencies, no naming bikeshedding.

---

### Turbopack
**Plain English**: Next.js 16's new build tool, replacing the older one called Webpack. Turbopack rebuilds incrementally as you edit code, so saving a file in dev mode shows the change in your browser within ~50 ms.

**In Helios**: Default for our Next.js 16 setup. Why it matters: iteration speed.

---

## Data layer

### Database
**Plain English**: Software that stores structured data and lets you query it. Different databases have different strengths: some are great for large-scale analytics, some for fast key-value lookups, some for flexible documents.

**In Helios**: PostgreSQL is our primary store. Everything Helios remembers is in there.

---

### PostgreSQL ("Postgres")
**Plain English**: A specific open-source database that's been around since 1996 and is widely considered the most capable general-purpose SQL database. It supports complex queries, transactions, JSON data, geographic data, and a lot more.

**In Helios**: All our tables — `energy_snapshots`, `control_actions`, `user_config`, `tokens` — are Postgres tables. We chose Postgres because it's overkill in the best way: any query we'd ever want to run, it can do.

---

### Neon
**Plain English**: A company that hosts PostgreSQL databases for you. Like Vercel for servers, but for Postgres. It scales to zero when idle (so a personal project costs nothing overnight) and scales up automatically when traffic comes in.

**In Helios**: Our database lives on Neon. The connection string is in the `DATABASE_URL` environment variable.

---

### SQL
**Plain English**: A standardized language for querying relational databases. Looks like English: `SELECT name, email FROM users WHERE created_at > '2026-01-01'`. Every relational database (Postgres, MySQL, SQLite, etc.) speaks SQL with minor variations.

**In Helios**: We don't write SQL directly most of the time — Drizzle generates it for us — but we drop into raw SQL for complex queries (the self-sufficiency rollups, for example).

---

### ORM (Object-Relational Mapper)
**Plain English**: A library that translates between database tables and your code's objects. Instead of writing `SELECT * FROM users WHERE id = 5`, you write `db.select().from(users).where(eq(users.id, 5))` — and the ORM generates the SQL.

**In Helios**: We use **Drizzle ORM**. The benefit over writing raw SQL is type safety: if I rename the `solar_w` column in the schema, every query that referenced it gets a compile error instantly.

---

### Drizzle
**Plain English**: A specific TypeScript-first ORM for PostgreSQL (and other databases). Lighter and more transparent than older ORMs like Prisma — it generates SQL that looks almost exactly like what you'd write by hand.

**In Helios**: All our database access goes through Drizzle. The schema is defined in `src/lib/db.ts` and shapes our TypeScript types automatically.

---

### Migrations
**Plain English**: Versioned, ordered changes to a database's structure. When you add a new column or change a table, you write a migration file (a small SQL script) and check it into source control. Other team members (and production) run the migrations in order, so everyone's database structure stays in sync.

**In Helios**: We have 10 migration files in `db/migrations/`, numbered 0001 through 0010. Each one is a single change: `0001_initial`, `0002_add_user_config`, ..., `0010_pre_departure_charge`.

**Why this matters**: Without migrations, schema changes are catastrophic. With them, the database evolves in lockstep with the code.

---

### Schema
**Plain English**: The structure of a database — what tables exist, what columns they have, what types those columns are. The schema is to a database what a blueprint is to a house.

**In Helios**: Defined in `src/lib/db.ts` using Drizzle's TypeScript syntax, then mirrored in the migration SQL files. The two are kept in sync manually (a Drizzle generate command can do this automatically; we use it sparingly).

---

### Zod
**Plain English**: A TypeScript library for validating data shapes at runtime. You define a schema (`{ email: string, age: number }`), and Zod will check whether incoming data matches and throw a clear error if not.

**In Helios**: Every POST endpoint validates its input with a Zod schema (`reserveRequestSchema`, `configUpdateSchema`, etc.). This is the runtime safety net — TypeScript catches type errors at compile time, Zod catches them at runtime when data arrives from the outside world.

---

## External integrations

### API (Application Programming Interface)
**Plain English**: A way for one piece of software to talk to another. Most modern web APIs are HTTP-based: you make a request to a URL, you get back a response. The URL, the request format, and the response format together are "the API."

**In Helios**: We talk to four external APIs (Tesla, Rivian, Enphase, Open-Meteo) and we expose our own (`/api/status`, `/api/config`, etc.) for our dashboard.

---

### REST
**Plain English**: A common pattern for designing HTTP APIs where each URL represents a "resource" (a noun) and the HTTP method (GET, POST, PUT, DELETE) represents the action. `GET /api/status` reads, `POST /api/config` writes. Most public APIs in 2025-26 are REST or REST-ish.

**In Helios**: Tesla, Enphase, and Open-Meteo are all REST APIs. Our own API surface is REST.

---

### GraphQL
**Plain English**: An alternative to REST where the client sends a query describing exactly what data it wants, and the server returns exactly that. A single endpoint handles everything; the request body is structured like a JSON-shaped query.

**In Helios**: Rivian uses GraphQL. We send queries to `https://rivian.com/api/gql/gateway/graphql` and get back vehicle state.

---

### HTTP / HTTPS
**Plain English**: The protocol every web request uses. **HTTPS** is HTTP with encryption (the `s` is for "secure"). All modern websites use HTTPS; HTTP-only is now treated as a bug.

**In Helios**: Vercel issues us a free HTTPS certificate automatically. Every API call to our system is encrypted in transit.

---

### Request and Response
**Plain English**: An HTTP request has a method (GET, POST, etc.), a URL, headers (metadata like `Content-Type` and `Authorization`), and optionally a body (the payload). A response has a status code (200 = OK, 401 = Unauthorized, 500 = Server Error), headers, and a body.

**In Helios**: Every interaction with every external system is some combination of these. The cron route is one big chain of requests and responses.

---

### Status codes
**Plain English**: A three-digit number every HTTP response carries indicating the outcome. **200** is success. **401** is "you're not authenticated." **403** is "you're authenticated but not authorized." **404** is "not found." **500** is "the server had an error." There are about 40 in common use.

**In Helios**: When the proxy (auth gate) blocks a request without a valid cookie, it returns 401. When the cron successfully writes a snapshot, it returns 200.

---

### JSON
**Plain English**: A text format for representing structured data. Looks like `{ "name": "Eliel", "age": 36 }`. It's the de facto standard for API request and response bodies because every programming language can parse it.

**In Helios**: Every API request and response body is JSON. The cron logs are JSON. The database tokens are JSON.

---

### OAuth 2.0
**Plain English**: A standard protocol for "log in with another service." The user is redirected to the third party (Tesla, Google, etc.), authorizes our app, and the third party sends them back to us with a temporary code we exchange for an access token. The user never tells us their password; we never see it.

**In Helios**: Tesla uses OAuth 2.0. Smartcar uses OAuth 2.0. The flow is implemented in `src/app/api/auth/<provider>/callback/route.ts`.

---

### Access token
**Plain English**: A long random string issued by an OAuth provider that proves you have permission to call their API on a user's behalf. Goes in the `Authorization` header of every API request: `Authorization: Bearer <token>`. Tokens expire (4 hours for Tesla).

**In Helios**: Stored in the `tokens` table in Postgres, encrypted, one row per provider. The integration libraries automatically pull the latest token before each call.

---

### Refresh token
**Plain English**: A second token, issued alongside the access token, that's used to get a new access token without re-prompting the user. Refresh tokens last much longer (90 days for Tesla); access tokens are short-lived for security.

**In Helios**: When an access token expires, the integration code automatically uses the refresh token to get a new pair, then retries the original request.

---

### CSRF (Cross-Site Request Forgery) token
**Plain English**: A defense against attacks where a malicious website tricks your browser into making a request to a site you're logged into. The defense: the legitimate site embeds a random token in its HTML, and the server checks that the same token comes back on the request. A malicious site can't guess the token, so its forged request fails.

**In Helios**: Rivian uses a CSRF token + session cookie pair for authentication. We extract them from a one-time login flow and store them with the same lifecycle as OAuth tokens.

---

### Webhook
**Plain English**: An inverted API call. Instead of you asking a service "anything new?", the service calls *you* when something happens. You give them a URL; they POST to it on events.

**In Helios**: We don't currently use webhooks (Tesla doesn't offer them in the form we'd need), but the Wall Connector ingestion endpoint at `/api/ingest/wall-connector` is structured as a webhook receiver in case we add one later.

---

## Authentication and security

### Cookies
**Plain English**: Small pieces of data that a server can ask the browser to remember. The browser then automatically sends them along with every subsequent request to the same site. Used for session management, preferences, and tracking.

**In Helios**: One cookie — `helios_admin` — proves you're authenticated to make changes. Set on login, cleared on logout, expires after 7 days.

---

### HttpOnly
**Plain English**: A flag on a cookie that makes it invisible to JavaScript running in the browser. Even if an attacker injects malicious JavaScript onto your page, they can't read the cookie. The cookie is still sent by the browser with each request — JavaScript just can't see it.

**In Helios**: Our admin cookie is HttpOnly. This blocks an entire class of XSS (cross-site scripting) attacks where an attacker would steal the cookie via injected JavaScript.

---

### Secure
**Plain English**: A cookie flag that says "only send this over HTTPS." Prevents the cookie from being intercepted on insecure networks (public Wi-Fi, etc.).

**In Helios**: Set on the admin cookie.

---

### SameSite
**Plain English**: A cookie flag that controls whether the cookie is sent on cross-site requests. `SameSite=Strict` means never. `SameSite=Lax` means only on top-level navigation (clicking a link to our site from another site). `SameSite=None` means always.

**In Helios**: We use `SameSite=Lax`, which prevents most CSRF attacks while still letting the cookie work for normal navigation.

---

### Bearer token
**Plain English**: A pattern where the API request includes the access token in the `Authorization` header prefixed with the word `Bearer`. The "bearer" framing means "anyone holding this token has access" — so tokens have to be kept secret.

**In Helios**: Every Tesla API call uses `Authorization: Bearer <access_token>`.

---

### CRON_SECRET
**Plain English**: A shared secret value that the cron job sends in its requests to prove it's the cron and not an attacker. Without it, anyone who guesses our cron URL could trigger unwanted decision cycles.

**In Helios**: Set as a Vercel environment variable; the cron route checks `request.headers.get("authorization") === "Bearer " + process.env.CRON_SECRET`.

---

### ADMIN_TOKEN
**Plain English**: Our application-level authentication password. Stored as an environment variable. The admin cookie's value must match it; if they match, the user is authenticated.

**In Helios**: A simple shared password works because we have one user. A multi-user system would replace this with hashed per-user passwords in the database.

---

## Cryptography

These four terms appear together in `lib/rivian/crypto.ts`, which signs the one-shot `STOP_CHARGING` / `CHARGING_LIMITS` commands sent to the Rivian. The Rivian cloud verifies each command came from a key it has on file, so we can't just send a request — we have to *prove* we're authorized by signing it.

### HMAC (Hash-based Message Authentication Code)
**Plain English**: A short fingerprint computed over a message + a shared secret. The receiver knows the same secret, recomputes the fingerprint themselves, and compares. If they match, the message is authentic and unmodified. Anyone without the secret can't fake a valid HMAC.

**In Helios**: Each Rivian vehicle command we send carries an HMAC over `command || timestamp`. Without the right HMAC the cloud rejects the request — that's how Rivian distinguishes an enrolled phone from any other caller with the same login.

---

### ECDH (Elliptic Curve Diffie-Hellman)
**Plain English**: A way for two parties to derive the same shared secret without ever transmitting it. Each party has a public/private key pair; you combine your private key with their public key, they combine their private key with your public key, and the math comes out the same on both sides. Eavesdroppers see the public keys but can't reconstruct the secret.

**In Helios**: We generate an EC key pair during phone enrollment. Rivian gives us back the *vehicle's* public key. ECDH(ourPrivate, vehiclePublic) gives us a 32-byte shared secret that only we and the car can derive. That shared secret is the seed for the HMAC key.

---

### HKDF (HMAC-based Key Derivation Function)
**Plain English**: Takes a raw shared secret (which may not be uniformly random) and stretches/conditions it into a key suitable for use with HMAC. Useful because raw ECDH output isn't quite the right shape to use directly as a cryptographic key.

**In Helios**: After ECDH gives us the shared secret, HKDF-SHA256 turns it into the 32-byte key used by the HMAC step. Empty salt, empty info, length 32 — matching Rivian's reference implementation.

---

### SECP256R1 (a.k.a. P-256, prime256v1)
**Plain English**: A specific elliptic curve — the most widely-used one in modern crypto, supported in browsers, smartphones, and TLS. "Use this curve" tells you which math the keys live in.

**In Helios**: Rivian's command API uses SECP256R1 keys. Node's `crypto` module supports it natively as `prime256v1` in the EC keypair API.

---

## Engineering principles

### Pure function
**Plain English**: A function that, given the same inputs, always returns the same output, and that doesn't change anything outside itself (no writes to disk, no API calls, no global state changes). The mathematical ideal.

**In Helios**: `decide()` and `decideEvCharge()` are pure. Their inputs are a snapshot, a config, and a forecast. Their output is a decision. They never call Tesla, never write to the database, never log anything. The cron route handles all of that *around* the engine.

**Why this matters**: Pure functions are trivially testable, trivially refactorable, and trivially reasoned about. Most production bugs come from impure code; pushing logic into pure functions reduces the surface area where bugs can hide.

---

### Idempotency
**Plain English**: An operation is **idempotent** if doing it twice has the same effect as doing it once. Setting the Powerwall reserve to 50% is idempotent (the second call doesn't change anything). Logging "increment counter by 1" is *not* idempotent (the second call doubles it).

**In Helios**: Every actuator call is idempotent by design. If a cron tick fails halfway through and re-runs, no state ends up double-applied.

---

### Hysteresis
**Plain English**: A control-system concept where you require *more* of a change to flip back than to flip forward, to prevent rapid toggling. Your thermostat doesn't turn the AC off the instant the temperature hits 68° if it just turned on at 70° — there's a buffer.

**In Helios**: The `min_action_interval_sec` setting is hysteresis: after pushing a Powerwall reserve change, we wait at least 5 minutes before pushing another, even if the conditions briefly suggest a different target. Without this, the engine would chatter on every cron tick.

---

### Conservation invariant
**Plain English**: A statement that *must* be true if the system is healthy. In Helios's case: supply equals demand (every watt produced or imported is consumed or exported or stored). If the dashboard ever shows them visibly out of balance, something upstream is wrong — the invariant is a debugging tool.

**In Helios**: Codified in the `<HeroCard>` component's bar chart. The two halves are visually compared on every render. When `|supply − demand| ≥ 0.5 kW`, the card now renders an inline alert chip naming the imbalance and hinting which side is likely stale (a Tesla gateway briefly desynced one of its CT readings). Self-corrects on the next snapshot — but the user sees the discrepancy instead of being left to math it out.

---

### Source health (`ProviderStatus`)
**Plain English**: A typed signal that says, for each external data source, whether the value sitting in the snapshot is actually fresh from the provider, was attempted-but-failed, or is unfilled placeholder data. Three states: `live`, `unavailable`, `mock`. The decision engine refuses to actuate when any source is anything other than `live`.

**In Helios**: Introduced after the 2026-04-29 mock-data incident. Before this, a Tesla API failure left the snapshot full of mock seed values that the engine then acted on as if real, costing ~$6.73 in unintended grid imports overnight. Now: every consumer (engine, UI, rollups) sees `sources: { solar: { status: "live" | "unavailable" | "mock" }, ... }` and is forced by the type system to handle each case explicitly. The dashboard renders an alert badge in the header when any source is `unavailable`. The cron route's defensive gate flips to `paused` on any non-live source. *Fail loudly, never to plausible-looking values* is the rule this implements.

---

### Tariff-environment assumption
**Plain English**: A rule whose correctness depends on the prices and time-windows of the user's specific utility tariff. When the tariff changes — by user-initiated plan switch, utility revision, or regulatory regime supersession — every such rule needs to be re-derived from the new economics. Carrying old rules into new tariffs costs real money silently.

**In Helios**: A peak-hour reserve guard from California's NEM 2.0 era cost ~$900/year of avoidable grid imports under the current NEM 3.0 tariff before being caught and removed. Now there's a written rule: tariff-dependent rules must cite their tariff and specific arbitrage by name in a comment at the call site. A grep for "preserve" or "save for" without a tariff citation is a code smell.

---

### Postmortem-driven engineering
**Plain English**: After every real incident — bug, outage, miss — write up a structured document covering what happened, the timeline, what caused it, what was tried that didn't work, what fixed it, and what rule the team will follow to prevent recurrence. The artifact isn't the point; the discipline of writing it is.

**In Helios**: Two postmortems written, one for each production incident. Both include a "hypotheses tried and ruled out" section that captures the dead ends in detail so a future investigator (including future me) doesn't re-walk the same paths. Both include action items tracked through to commit-level resolution. The pattern's value compounds: the 2026-04-30 postmortem cited a known-unknown from the 2026-04-29 postmortem that I should have prioritized higher — the discipline of writing the artifact made the regression visible.

---

### Time-series data
**Plain English**: Data points where each one is associated with a moment in time. Stock prices, temperature readings, server CPU usage — all time-series. Special database design patterns apply (you almost never delete old rows, you query by ranges, you bucket and aggregate frequently).

**In Helios**: Our `energy_snapshots` table is time-series. Every 5 minutes adds a new row; we never update or delete existing rows; we query them by time range to compute rollups.

---

### Single source of truth
**Plain English**: For every fact in your system, there's exactly one place that "owns" it. If the same fact lives in two places, they'll eventually drift and you won't know which is right.

**In Helios**: The user_config row in Postgres is the single source of truth for all settings. The Settings UI reads it and writes to it. The cron reads it. Nothing else stores config.

---

### Type safety
**Plain English**: The compiler (or runtime checker) ensures that values are used in ways consistent with their declared types. Adding a number and a string isn't allowed. Calling a function with the wrong shape of argument is caught.

**In Helios**: TypeScript at compile time, Zod at runtime. The combination catches bugs before they ship.

---

### Separation of concerns
**Plain English**: Each part of the system does one job. The decision engine decides; the actuator code acts; the database persists; the UI displays. Mixing concerns (e.g., letting the UI directly call the engine) makes systems brittle.

**In Helios**: Heavily enforced. The cron route is the only place that orchestrates decide → act → log; nothing else does any of those.

---

### Smoke test
**Plain English**: A quick check that the system is broadly working. Not exhaustive — just "is it on fire?" Run after every deploy.

**In Helios**: After every Vercel deploy, I run a curl command against `/api/status` and `/api/me` to verify the deploy is live and the auth gate is functioning. Took 30 seconds, caught two bad deploys this week.

---

### Feature flag
**Plain English**: A configuration switch that turns a feature on or off without redeploying code. Lets you ship code that's not yet active, then enable it for a subset of users or all users when ready.

**In Helios**: We don't currently use feature flags (the user base is one), but `automation_enabled` in the user_config is functionally one — it's a master switch for the entire actuator chain.

---

## Process and workflow

### Git
**Plain English**: A version-control system that tracks every change to every file over time. Every change is a "commit" with a message. Multiple people can work in parallel on "branches" and merge their work together.

**In Helios**: Every line of code I've written is in git. The 73 commits tell the story of the project's evolution.

---

### Commit
**Plain English**: A single saved change in git. Includes a message describing what changed and why.

**In Helios**: Commit messages follow a convention: `<area>: <change>` (e.g., `EV: car-first rate logic in pre-departure mode`). The message is permanent and should be useful to read in 6 months.

---

### Branch
**Plain English**: A divergent line of development in git. Lets you work on a new feature without disturbing the main code, then merge back when ready.

**In Helios**: For a solo project at this scale, I work mostly on `main` directly. For a team project, every change would be on its own branch and reviewed via pull request.

---

### Pull request
**Plain English**: A formal proposal in GitHub to merge one branch into another. Reviewers comment on the changes; once approved, the branch is merged.

**In Helios**: Not used currently (solo project), but the practice would scale up if collaborators joined.

---

### CI/CD (Continuous Integration / Continuous Deployment)
**Plain English**: The pipeline that automatically tests and deploys code on every push. **CI** runs tests; **CD** deploys to production if tests pass.

**In Helios**: Vercel handles CD automatically. CI is currently manual (I run `npm test` locally before pushing). For a team, GitHub Actions would run tests on every push.

---

### Deploy
**Plain English**: The act of taking new code and making it live in production. With Vercel, this happens automatically on every push to `main` and takes about 90 seconds.

**In Helios**: I've deployed ~73 times so far. Each deploy is a separate URL so I can roll back to a previous version with a single click if needed.

---

### npm / Node.js
**Plain English**: **Node.js** is a runtime that lets JavaScript run outside the browser (on servers, on your laptop). **npm** is its package manager — the tool you use to install third-party libraries (`npm install drizzle-orm` adds Drizzle to your project).

**In Helios**: Our `package.json` lists every library we depend on. `npm install` reads that file and downloads them into `node_modules/`.

---

### Vitest
**Plain English**: A modern JavaScript test runner. You write test files, Vitest runs them and tells you which passed and which failed.

**In Helios**: Our 58 unit tests are written for Vitest. They run in 300 ms locally; they're our safety net for engine changes.

---

### Linter / ESLint
**Plain English**: A tool that scans your code for stylistic issues and likely bugs without actually running it. Catches things like unused variables, accidental shadowing, and patterns the language allows but that are usually mistakes.

**In Helios**: ESLint runs on every save in my editor and on every build. Configured with the Next.js recommended rules.

---

# Closing notes

If you've read this far, you have enough vocabulary to have a credible conversation about every layer of Helios with an engineer, a hiring manager, or a peer. You don't need to write the code. You need to know what each tool does, why it's in the bag, and what would have been the cost of choosing differently.

A short list of what makes a non-engineering leader credible in technical conversations:

1. **Use precise terms.** "Database" is generic; "Postgres on Neon" is specific. Specifics signal that you've actually used the thing.
2. **Know the trade-offs.** "We chose Vercel because it scales to zero on a personal project — the alternative is running our own servers, which costs more in time than the project is worth" is a sentence with an opinion in it. Opinions, grounded in trade-offs, are credibility.
3. **Don't fake it.** If you don't know what GraphQL is, ask. The cost of pretending and being caught is much higher than the cost of asking.
4. **Tell the iteration story.** Engineers respect people who understand that systems evolve. "We started with a flat threshold, then realized it didn't account for trajectory, so we replaced it with a rate calculation" is a far more compelling story than "we built the thing."

Good luck.

---

*Written April 2026 alongside the Helios case study. If terms in here have shifted by the time you read this, the principles have not.*
