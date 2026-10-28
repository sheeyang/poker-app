# Deploy from scratch: GitHub Actions, Render Free, and Neon Free

This guide starts with no accounts, checkout, database, or hosted service. It ends
with one free Render service serving the Trainer, API, and WebSockets, a free Neon
database, automatic releases after CI passes on the default branch, and a manual
release fallback.

The application and automation described here are already implemented in this
repository. There are no source-code patches to copy from this guide. Account
creation, access grants, and entering secrets are one-time human steps.

Provider details checked on **27 October 2026**. This is a free preview, with sleep
and usage limits, rather than a promise of continuous availability.

## 1. Create accounts and install local tools

1. Create a free [GitHub account](https://github.com/signup) and verify your email.
2. Create free [Neon](https://console.neon.tech/) and
   [Render](https://dashboard.render.com/) accounts. You may use GitHub sign-in.
   Keep Neon on **Free** and use a free Render workspace and compute instance;
   no paid database, disk, custom domain, or additional frontend service is needed.
3. Install [Git](https://git-scm.com/downloads) and
   [Node.js 24](https://nodejs.org/en/download). Reopen your terminal afterward.
4. Install the repository's pinned package manager:

```powershell
npm install --global pnpm@11.25.0
```

Confirm the tools are available:

```powershell
git --version
node --version
pnpm --version
```

Expect Node 24 or newer and pnpm **11.25.0**. The hosted service uses the Node 24
version pinned in `render.yaml`.

## 2. Get the repository and enable CI

1. Open [sheeyang/poker-app](https://github.com/sheeyang/poker-app) while signed in.
   If you do not have access, obtain repository access from its owner first.
2. If you are setting up your own copy, use **Fork** to create a copy under your
   account. If you own or administer the original, you can use it directly.
3. Click **Code → HTTPS** and copy your repository's clone URL.
4. Clone it, replacing the example account below:

```powershell
git clone https://github.com/YOUR-ACCOUNT/poker-app.git
cd poker-app
pnpm install --frozen-lockfile
pnpm check
```

No `.env` or database installation is required for this local check. Its tests
manage temporary PostgreSQL automatically. See [local development](local-development.md)
for platform support and troubleshooting.

The repository's **default branch** is the deployment branch throughout this
guide. Its name might be `main` or something else. Use the branch marked as the
default in GitHub; the release workflow rejects other branches.

In GitHub:

1. Open the repository's **Actions** tab.
2. Select **CI → Run workflow**, choose the default branch, and run it. Wait for
   its **check** job to pass before creating the hosted service.

CI's **check** job runs `pnpm check`, including typechecking, real PostgreSQL tests,
builds, and workspace-boundary checks. This job needs no cloud secrets and consumes
no Neon quota. Automatic releases stay skipped until both `RENDER_SERVICE_ID` and
`APP_URL` repository variables are set in section 5. Pull requests, feature-branch
pushes, and manual CI runs perform checks only. Manual workflow files must exist on
the default branch for the **Run workflow** button to appear.
[GitHub workflow instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

## 3. Create two Neon Free projects

Create separate projects for the hosted preview and integration tests. This keeps
release tests away from saved preview tables.

For the **preview project**:

1. Sign in to Neon and click **New Project**.
2. Name it `poker-trainer-preview` and keep its plan **Free**.
3. Choose the closest available Neon region to the Render service's region
   configured in `render.yaml`.
4. Expand the Postgres settings and select **PostgreSQL 18**, matching local tests.
   Leave unrelated Auth, Functions, and storage services disabled.
5. Create the project. Use its initial branch and database, commonly `neondb`.
6. Open **Connect**. Select that branch, database, and the database-owner role.
7. **Disable connection pooling** and copy the direct primary PostgreSQL URL.
   Preserve all supplied TLS parameters, including `sslmode=require` and any
   channel-binding setting. Keep this URL privately: it will go into Render only.

Repeat these steps for a second project named `poker-trainer-tests`. Copy its
**direct** URL separately. Clearly label which URL is preview and which is test.

The app uses session settings and a session advisory lock, so use a direct TCP
connection. A Neon pooled hostname contains `-pooler`; do not use that URL here.
The app's own `pg` pools still manage its direct connections.

Sources: [Neon projects](https://neon.com/docs/manage/projects),
[connection details](https://neon.com/docs/get-started/connect-neon), and
[pooling limitations](https://neon.com/docs/connect/connection-pooling#connection-pooling-in-transaction-mode).

Before the first Render deployment, verify recovery against the **test** project
from your local checkout. Replace `YOUR_NEON_TEST_DATABASE_URL_HERE` with the test
project's direct URL, keeping the single quotes. In PowerShell:

```powershell
$env:TEST_DATABASE_URL = 'YOUR_NEON_TEST_DATABASE_URL_HERE'
pnpm test apps/server/test/recovery.test.ts
Remove-Item Env:TEST_DATABASE_URL
```

Expect the recovery tests to pass. They create and drop isolated test schemas;
never substitute the preview URL. Later releases repeat this check automatically.
Resolve failures before relying on hosted recovery, following
[ADR-0027](adr/0027-use-embedded-postgresql-for-local-development-and-tests.md).

There is no SQL schema to import manually. The application initializes an empty
preview database after acquiring server authority. This is initial schema setup,
not a migration or backwards-compatibility guarantee.

## 4. Create the free Render service from the Blueprint

1. Sign in to Render. Choose **New → Blueprint**.
2. Connect your GitHub account when prompted and grant access to the repository
   selected in section 2.
3. Select that repository and its **default branch**. Use `render.yaml` at the
   repository root as the Blueprint file.
4. Review the planned resources. There should be **one Web Service on Free**,
   named `poker-trainer-preview`, and no Render database or persistent disk.
5. When prompted for `DATABASE_URL`, paste the **preview project's direct Neon
   URL**, not the test project's URL. Do not surround it with quotes.
6. Deploy the Blueprint and watch its build and runtime logs.
7. Open the Blueprint's **Settings** and set **Auto Sync to No**. This prevents
   configuration pushes from deploying outside the release workflow. Future
   configuration changes require an intentional Manual Sync.
8. Open the created web service and verify **Auto-Deploy is Off**. Leave pull
   request previews disabled; they must not share the preview database.

The Blueprint already supplies:

| Setting | Configured value |
| --- | --- |
| Runtime / instance | Node / **Free** |
| Root directory | Repository root |
| Build | `corepack enable && corepack pnpm install --frozen-lockfile --prod=false && corepack pnpm build` |
| Start | `node apps/server/dist/main.js` |
| Render health check | `/healthz` |
| Node | `24.21.0` |
| Runtime environment | `NODE_ENV=production`, `HOST=0.0.0.0`, `SERVE_WEB=true`, `SINGLE_SERVER_GUARD=true`, `POKER_ADMIN_MODE=false` |

Render supplies `PORT` and `RENDER_GIT_COMMIT`. Do not add `TEST_DATABASE_URL`,
`POKER_POSTGRES_PORT`, or `POKER_API_TARGET` to this service. Do not start Vite or
`pnpm dev:trainer` in Render. No pre-deploy command or paid interactive shell is
needed.

The initial Blueprint creation performs the bootstrap deployment. This is why
sections 2 and 3 validate the code and Neon recovery first. Subsequent code
releases use GitHub Actions.

Sources: [Blueprint setup](https://render.com/docs/infrastructure-as-code),
[disabling automatic sync](https://render.com/docs/infrastructure-as-code#disabling-automatic-sync),
[Blueprint fields](https://render.com/docs/blueprint-spec), and
[Render environment variables](https://render.com/docs/environment-variables).

## 5. Connect GitHub Actions to Render and the test database

### Obtain the Render credentials and service information

1. In Render account settings, open **API Keys** and create a key for this
   deployment workflow. Copy it privately; do not put it in a repository file.
2. Open your web service and copy its **service ID**, beginning with `srv-`.
   It is also part of the service's dashboard URL.
3. Copy the service's public **HTTPS origin**, for example
   `https://poker-trainer-preview-EXAMPLE.onrender.com`. Use the exact hostname
   Render assigned, without `/readyz`, `/api`, or another path.

See [Render API authentication](https://render.com/docs/api).

### Add repository secrets and variables

In your **GitHub repository**, open **Settings → Secrets and variables → Actions**.
On the **Secrets** tab, choose **New repository secret** for each entry:

| Secret | Value |
| --- | --- |
| `RENDER_API_KEY` | The Render API key just created. |
| `NEON_TEST_DATABASE_URL` | The **test project's direct URL** from section 3. |

On the **Variables** tab, choose **New repository variable** for each entry:

| Variable | Value |
| --- | --- |
| `RENDER_SERVICE_ID` | Your `srv-...` service ID. |
| `APP_URL` | Your Render HTTPS origin. |

These are repository secrets/variables; no paid GitHub deployment environment is
required. The preview `DATABASE_URL` stays in Render, while tests receive only the
separate test URL. Never put either database URL into a `VITE_` variable, source,
workflow YAML, screenshot, or log.

[GitHub secret setup](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)

## 6. Run the first automated release

Use the manual fallback for this first release because the setup steps above did
not require a new push after configuring hosting.

1. In GitHub, open **Actions → Release preview → Run workflow**.
2. Choose the repository's **default branch**, then start the run.
3. Follow the job's steps. It will:
   - Install the pinned dependencies and run `pnpm check` with temporary PostgreSQL
     for this manual run. Automatic releases reuse the successful CI check instead.
   - Run recovery tests against the separate Neon test project.
   - Ask Render to deploy the exact Git commit selected by this run.
   - Wait for Render to report the new deployment live.
   - Wait for `/readyz` to report that same commit with restored authority.
   - Load the frontend and its built JavaScript, establish a fresh secure
     identity cookie, and verify an authenticated WebSocket upgrade.
4. Wait for the **whole workflow** to succeed. Render's Live label alone means
   the listener is up, not that game restoration is complete.

For later default-branch pushes, open the **CI** run and follow its **Release
preview** job after **check** succeeds. The automatic release appears inside that
CI run; it does not create a separate manually dispatched **Release preview** run.
If checks fail or are canceled, deployment does not start. The release checks out
and deploys the same commit SHA that CI tested.

Automatic and manual releases share one release queue. An active release is not
canceled by a newer push. At most one release waits behind it; a new pending
release replaces the previous pending one. A later merge does not change the
commit already selected by a running release. Superseded CI checks can still be
canceled to save runner time.

See [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
and [concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

A release can briefly interrupt play, typically around **1–2 minutes** during
handoff in addition to build time. The new process binds its listener first, but
keeps application requests and `/readyz` unavailable until the old process stops
and releases its database lock. It then initializes, restores, and resumes play.
Both versions use the same service URL, so the browser's identity cookie and
committed Table Sessions remain available after reconnect.

The mechanism and its limits are documented in
[ADR-0030](adr/0030-handoff-hosted-authority-after-listener-readiness.md).
[Render's rolling lifecycle](https://render.com/docs/deploys#zero-downtime-deploys)
explains the separation between listener liveness and application readiness.

## 7. Verify the first hosted session

After the release succeeds:

1. Open your Render HTTPS URL in a browser and start practice. Play a Hand and
   confirm human actions and Bot responses work.
2. Reload in the same browser profile. Confirm your Table Session restores.
3. In developer tools, check `/api/live`: it should upgrade with status **101**
   over `wss://` on the same hostname. Inspect `poker_local`: it should be HttpOnly,
   Secure, and SameSite=Strict.
4. Open `YOUR-ORIGIN/readyz`. Its JSON should contain `ok: true`, `status: ready`,
   and the commit SHA shown by the successful GitHub run.
5. Close the browser, allow the free service to sleep, then reopen it using the
   same profile. Allow for wake-up and confirm committed state restores.

A fresh browser profile has a new identity. Hosting does not add accounts,
identity transfer, or the planned shared multiplayer feature. Keep the same
hostname and browser cookie to retain ownership of existing tables.

## 8. Make later changes and release them

1. Make changes on a branch, commit them, push, and open a pull request.
2. Let **CI** finish; review the changes and merge into the default branch.
3. Open the new **CI** run for the merge commit. When **check** passes, **Release
   preview** automatically tests Neon recovery, deploys that exact commit, and
   verifies the hosted app. There is no extra dashboard step to start deployment.
4. Wait for the whole CI run, including readiness and smoke checks, to succeed
   before treating the release as complete. Existing clients can reconnect to
   their committed tables; reload the page after readiness if it was opened
   during the interruption.

To retry a release deliberately or publish without a new push, use **Actions →
Release preview → Run workflow** on the default branch. This manual fallback runs
`pnpm check` itself before the Neon tests and deployment. **CI → Run workflow**
performs checks only.

Keep the **same Render service**. Do not delete/recreate it, change the hostname,
remove the authority guard, or enable independent automatic deploys. Ordinary
releases require neither a manual suspension nor a new Neon project.

For changes to `render.yaml`, first validate and merge them, then deliberately
use the Blueprint's **Manual Sync**. A sync can trigger a deployment outside
GitHub Actions, so do not sync during another release. After it settles, run
Release preview to verify the intended revision and settings.

## 9. Handle failures

| Symptom | What to check |
| --- | --- |
| No Run workflow button | The workflow files must be on the default branch; enable Actions and ensure your account has repository write access. |
| A fork asks to enable workflows | If the **Actions** tab displays an enable-workflows prompt, accept it, then run CI. |
| No separate Release preview run after a merge | Automatic releases run as the **Release preview** job inside that commit's **CI** run. Open that run to inspect deployment progress. |
| Automatic Release preview job is skipped | It requires a successful **check** job from a push to the default branch and both `RENDER_SERVICE_ID` and `APP_URL` repository variables. PRs, feature branches, and manual CI runs do not deploy. Add the section 5 settings, then use the manual release fallback or push a new commit. |
| Release rejects the branch | Select the default branch, rather than a feature branch, in Run workflow. |
| Missing secret or variable | Use the repository Actions settings from section 5; names must match exactly. Empty Neon secrets are rejected rather than silently using local PostgreSQL. |
| CI or Neon test failure | Read the failed step and fix it before retrying. A failure before the deployment step does not request a Render release. |
| Build or port failure | Confirm the Blueprint commands, repository root, Node version, `HOST=0.0.0.0`, and Render's supplied `PORT`. |
| Authority stays waiting | Stop any other/local guarded server using the preview database. Check the previous Render instance's shutdown logs. Never change the lock key or remove the guard. |
| Render is Live but the workflow still waits | `/healthz` is liveness. Check `/readyz` and startup logs for lock acquisition, database wake-up, schema errors, or restoration failures. |
| Database connection error | Use the direct primary URL for the correct project and preserve Neon's TLS parameters. Do not disable TLS verification. |
| Deploy creation was not confirmed | Inspect Render's Deploys page before retrying: the API request might have created a deployment. The script deliberately does not repeat an ambiguous deployment request. |
| Saved tables are absent | Check the browser profile, cookie, hostname, and Neon branch. A table ID in browser storage does not establish ownership. |
| Unknown gameplay COMMIT | Use the app's explicit outcome check. Do not clear request journals, reset data, or invent a new request ID automatically. See [recovery](server-protocol.md#unknown-commit-resolution). |

There is **no automatic code rollback or database reset**. A previous binary may
not read records written by a newer version under
[ADR-0014](adr/0014-allow-pre-release-record-breaking-changes.md). Inspect the failure,
fix forward or deliberately choose a compatible revision, and retain Neon data.
A failed startup after Render switches routing can leave the preview unavailable.

If a process loses its authority connection, it stops serving application work.
Render may restart or replace it, using the same handoff process. This coordinates
normal deployment/maintenance overlap; it does not promise distributed failover
or uninterrupted play during network partitions.

## 10. Stay within free allowances

| Provider | Free-plan considerations |
| --- | --- |
| Render | Free services sleep after 15 idle minutes and can take about a minute to wake. The workspace shares 750 free instance hours monthly, plus limited build and transfer allowances. Local filesystem changes are ephemeral. |
| Neon | At the date above, each Free project has 100 CU-hours monthly and 1 GB storage. Idle compute can scale to zero, but an active connection/authority lock may keep it awake. |
| GitHub Actions | Standard hosted runners are free for public repositories. Private repositories have a limited included allowance; inspect Actions usage and configure budgets to avoid paid overages. |

Sources: [Render Free](https://render.com/docs/free),
[Neon pricing](https://neon.com/pricing), and
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Use the default HTTPS domain and keep the service on Free. Close unused browsers
and local database connections; do not add uptime pings that continuously wake the
preview. Cloud recovery checks run for releases, including automatic releases
after successful default-branch pushes; pull requests use temporary PostgreSQL.
Review usage in all three dashboards. Free limits are finite; for example,
100 CU-hours corresponds to about 400 active hours at 0.25 CU, before other usage.

To stop using compute, suspend the Render service. Resume the same service when
needed to preserve its URL. Keep Neon if you want the saved data. Deleting a Neon
project deletes its data; it is not a remedy for a failed build.

## Verification status

Local automated checks cover the authority handoff, restoration, secure cookies,
frontend routing, and release-script behavior. Provider documentation informs
the Render lifecycle integration. A real cloud deployment is verified only after
your Neon recovery checks and the first GitHub release and browser checks pass;
this guide does not imply accounts or cloud resources already exist.
