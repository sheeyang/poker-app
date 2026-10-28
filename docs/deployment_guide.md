# Deploy from scratch: GitHub Actions, Render Free, and Neon Free

This guide starts with no accounts, checkout, database, or hosted service. It ends
with one free Render service serving the Trainer, API, and WebSockets, a free Neon
database, automatic releases after CI passes on the default branch, and a manual
release fallback.

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

The **check** job uses temporary PostgreSQL and needs no cloud credentials.
Automatic releases stay skipped until both `RENDER_SERVICE_ID` and `APP_URL`
repository variables are set in section 5.
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

A direct Neon URL has no `-pooler` in its hostname. The connection requirements
are explained in [ADR-0030](adr/0030-handoff-hosted-authority-after-listener-readiness.md).

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

Wait for all recovery tests to pass before continuing. Always use the **test**
project's URL for this command. See [ADR-0027](adr/0027-use-embedded-postgresql-for-local-development-and-tests.md)
for test-database management.

The application creates its database tables automatically on first startup.

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

The Blueprint supplies the build, start, and runtime settings and performs the
initial deployment. Complete the checks in sections 2 and 3 before creating it.

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

## 6. Run the first release

Start the first release manually after configuring hosting:

1. In GitHub, open **Actions → Release preview → Run workflow**.
2. Choose the repository's **default branch**, then start the run.
3. Wait for the **whole workflow** to succeed. It runs the project checks and
   Neon recovery tests, deploys the selected commit, and verifies the hosted app.
   Render's Live label alone does not confirm the application is ready.

A release can briefly interrupt play. Reconnect using the same URL and browser
profile to retain your committed Table Session. The handoff is explained in
[ADR-0030](adr/0030-handoff-hosted-authority-after-listener-readiness.md).

## 7. Verify the first hosted session

After the release succeeds:

1. Open your Render HTTPS URL in a browser and start practice. Play a Hand and
   confirm human actions and Bot responses work.
2. Reload in the same browser profile. Confirm your Table Session restores.
3. Open `YOUR-ORIGIN/readyz`. Its JSON should contain `ok: true`, `status: ready`,
   and the commit SHA shown by the successful GitHub run.

## 8. Make later changes and release them

1. Make changes on a branch, commit them, push, and open a pull request.
2. Let **CI** finish; review the changes and merge into the default branch.
3. Open the **CI** run for the merge commit. After **check** passes, its **Release
   preview** job automatically tests Neon recovery, deploys that exact commit,
   and verifies the hosted app. Wait for the whole CI run to succeed.

Pull requests and feature-branch pushes run checks only. Releases run one at a
time. New pushes can cancel older checks or pending releases, but an active
release finishes.

For a manual retry, follow section 6; it runs the project checks again.
**CI → Run workflow** performs checks only.

Keep the **same Render service and hostname** for subsequent releases.

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

## 10. Stay within free allowances

| Provider | Free-plan considerations |
| --- | --- |
| Render | Free services sleep after 15 idle minutes and can take about a minute to wake. The workspace shares 750 free instance hours monthly, plus limited build and transfer allowances. Local filesystem changes are ephemeral. |
| Neon | At the date above, each Free project has 100 CU-hours monthly and 1 GB storage. |
| GitHub Actions | Standard hosted runners are free for public repositories. Private repositories have a limited included allowance; inspect Actions usage and configure budgets to avoid paid overages. |

Sources: [Render Free](https://render.com/docs/free),
[Neon pricing](https://neon.com/pricing), and
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Keep Render on Free and use its default HTTPS domain. Review usage in all three
dashboards; each release uses Neon test compute and GitHub Actions time.

To pause the preview, suspend and later resume the same Render service. Retain
the Neon database to preserve saved Table Sessions.
