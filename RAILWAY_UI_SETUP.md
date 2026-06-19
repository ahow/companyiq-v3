# Setting Up a Dedicated Worker Service on Railway — UI-Only Guide

This guide uses **only the Railway dashboard** (the website). You will not open
a terminal or run any commands. The only text you "type" is into Railway's own
input boxes (a Start Command field and Variable fields).

Throughout: **web service** = your existing CompanyIQ service that serves the
site; **worker service** = the new service you are about to create that does the
heavy analysis work.

---

## Before you start

- Log in at https://railway.app and open the **project** that contains your
  CompanyIQ app.
- You should see your existing service (the web app), plus a Postgres and a
  Redis database in the same project. The worker must share that same Postgres
  and Redis, which is why everything stays in one project.

---

## Step 1 — Turn off the embedded worker on the WEB service

This makes your existing service serve only the website, so heavy work moves to
the new worker and your dashboard stays fast.

1. In the project canvas, **click your existing web service** (the CompanyIQ
   app tile).
2. Click the **Variables** tab.
3. Click **+ New Variable**.
4. Enter:
   - **Name:** `RUN_WORKER`
   - **Value:** `false`
5. Click **Add**, then click **Deploy** (or "Apply changes") when Railway
   prompts you. Wait for it to redeploy (green checkmark).

---

## Step 2 — Create the new WORKER service from the same repo

1. Go back to the project canvas (click the project name in the breadcrumb).
2. Click **+ New** (or **+ Create**) in the top-right.
3. Choose **GitHub Repo**.
4. Select the **same repository** your web app uses: **`ahow/companyiq-v3`**.
5. Railway creates a second service tile and starts building it from the same
   Dockerfile. Let the first build finish (it's fine if it then crashes/loops —
   we set its Start Command and variables next).

> Tip: rename it so you can tell them apart. Click the new service → **Settings**
> → **Service Name** → call it `worker`.

---

## Step 3 — Set the worker's Start Command

This tells the new service to run the worker entrypoint instead of the website.

1. Click the **worker** service tile.
2. Click the **Settings** tab.
3. Scroll to **Deploy** → find **Start Command** (sometimes under "Custom Start
   Command").
4. Type exactly this into the box:
   ```
   node --import tsx server/worker-main.ts
   ```
5. Click outside the box to save. (This is typed into Railway's field, not a
   terminal.)

---

## Step 4 — Give the worker the same variables as the web service

The worker MUST connect to the **same database and Redis** as the web service,
and needs the same API keys.

### Easiest way: copy from the web service using shared/reference variables

1. Click the **worker** service → **Variables** tab.
2. Look for **Add a Reference** / **Shared Variable** / the "Add all from
   another service" option (Railway shows a **Reference Variable** button).
3. For the database and Redis, add **reference variables** that point at the
   same Postgres and Redis plugins your web service uses:
   - `DATABASE_URL` → reference your Postgres service's connection URL
   - `REDIS_URL` → reference your Redis service's connection URL
   (Railway lets you pick the source service/variable from a dropdown — no
   copy-paste of secrets needed.)
4. For the LLM keys and other settings, the simplest path is: open your **web
   service → Variables**, use the **"⋯" menu → Raw Editor** to view all
   variables, copy them, then in the **worker service → Variables → Raw Editor**
   paste them in. This copies things like `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
   `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, etc.

> Make sure `DATABASE_URL` and `REDIS_URL` on the worker point to the **same**
> databases as the web service. If they differ, the worker won't see your
> queued jobs or your data.

### Then add the worker-specific tuning variables

Still on the **worker service → Variables**, click **+ New Variable** for each
of these (Name on the left, Value on the right):

| Name | Value |
|---|---|
| `WORKER_RUN_CLEANUP` | `true` |
| `WORKER_CONCURRENCY` | `12` |
| `INCOMPANY_FETCH_CONCURRENCY` | `4` |
| `LLM_MAX_CONCURRENCY` | `8` |
| `MAX_CONCURRENT_BROWSER` | `2` |

Click **Deploy / Apply** when prompted.

---

## Step 5 — Scale the worker to multiple replicas

This is what multiplies your speed.

1. Click the **worker** service → **Settings** tab.
2. Scroll to **Deploy** → **Replicas** (sometimes "Number of Replicas" or under
   a Regions/Scaling section on Pro).
3. Set it to **2** to start. Click to apply.
4. After it has run for a while and looks healthy (see Step 6), you can raise it
   to **3**.

> Why this is safe for quality: each replica runs the identical analysis
> pipeline. More replicas = more companies processed at once, not different
> results. The only shared limit to respect is the DeepSeek rate limit — see the
> note in Step 7.

---

## Step 6 — Confirm it's working

1. Click the **worker** service → **Deployments** (or **Logs**) tab.
2. You should see lines like:
   - `[Worker-Main] Starting standalone worker ...`
   - `[Worker-Main] alive @ ...` (a heartbeat every couple of minutes)
3. Click the **web** service → **Logs**: it should show
   `RUN_WORKER=false — embedded worker disabled`.
4. Open your app, go to **Settings → Queue & API Keys**: when you start a run
   you should see jobs moving (waiting → active → completed).

---

## Step 7 — Now do the full reset + re-run (from the app, as before)

1. In the app, go to **Companies** → use **Full reset all**.
2. Confirm your intended **active framework** on the Framework page.
3. Start the batch analysis (**Analyze**).
4. Watch progress on **Settings → Queue & API Keys**, and watch the worker
   service **Logs** in Railway.

### The one number that protects quality across replicas
`LLM_MAX_CONCURRENCY` is **per replica**. With 3 replicas at `8` each, that's
`3 × 8 = 24` simultaneous DeepSeek calls. Keep that total under your DeepSeek
account's limit. **If you ever see `429` / rate-limit errors in the worker
logs**, lower `LLM_MAX_CONCURRENCY` (e.g., to `6`) or reduce replicas. That is
the dial that guarantees no scoring is dropped — i.e., quality stays intact.

---

## If anything looks wrong

| Symptom | Likely cause | Fix in the UI |
|---|---|---|
| Worker logs show DB or Redis connection errors | `DATABASE_URL` / `REDIS_URL` not pointing at the shared services | Re-add them as **reference variables** on the worker (Step 4) |
| Jobs never move from "waiting" | Worker not consuming the same Redis as the web app | Ensure both services' `REDIS_URL` reference the **same** Redis plugin |
| Frequent `429` in worker logs | Total LLM concurrency too high | Lower `LLM_MAX_CONCURRENCY` or replica count (Step 7) |
| Worker restarts / out-of-memory | Too much concurrency for the RAM | Lower `WORKER_CONCURRENCY` or `MAX_CONCURRENT_BROWSER`, or raise the service's memory |
| Web app still doing heavy fetches | `RUN_WORKER=false` not set/deployed on web | Re-check Step 1 and redeploy the web service |

---

## Quick reference — what goes where

**Web service variables (add):**
```
RUN_WORKER=false
```

**Worker service — Start Command:**
```
node --import tsx server/worker-main.ts
```

**Worker service variables (same DB/Redis/keys as web, plus):**
```
WORKER_RUN_CLEANUP=true
WORKER_CONCURRENCY=12
INCOMPANY_FETCH_CONCURRENCY=4
LLM_MAX_CONCURRENCY=8
MAX_CONCURRENT_BROWSER=2
```

**Worker service replicas:** start at **2**, raise to **3** if healthy.
