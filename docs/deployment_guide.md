# Deploy production from scratch: GitHub Actions and an Oracle Always Free VM

This guide starts with no accounts, checkout, or server. It ends with production
running on one Oracle Always Free Ampere VM: Caddy serves HTTPS, the server serves
the Trainer, API, and WebSockets, and PostgreSQL 18 runs beside it. Releases deploy
automatically after CI passes on the default branch, with a manual fallback.

Production never sleeps or cold-starts and stays available after months without
users. It is **not durable**: Table Sessions can be lost with the VM, and
[ADR-0014](adr/0014-allow-pre-release-record-breaking-changes.md) still allows a
release to make saved records unreadable. Each of your own deploys and manual
reboots interrupts play for a few seconds. The reasons are recorded in
[ADR-0031](adr/0031-host-production-on-one-oracle-always-free-vm.md).

Provider details checked on **30 October 2026**.

## 1. Create accounts and install local tools

1. Create a free [GitHub account](https://github.com/signup) and verify your email.
2. Create an [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/) account.
   Oracle normally asks for a mobile number and a card.
   - Choose **Singapore (`ap-singapore-1`)** as the **home region**. It cannot be
     changed later, and Always Free compute exists only in the home region.
3. Sign in to [DuckDNS](https://www.duckdns.org/) and create a subdomain, for
   example `yourname.duckdns.org`. **Choose carefully:** browsers hold Table
   Ownership cookies for this hostname, so changing it later loses every saved
   Table Session.
4. Install [Git](https://git-scm.com/downloads) and
   [Node.js 24](https://nodejs.org/en/download). Reopen your terminal afterward.
5. Install the repository's pinned package manager:

```powershell
npm install --global pnpm@11.25.0
```

Confirm `git --version`, `node --version` (24 or newer), and `pnpm --version`
(**11.25.0**). Windows 11 already includes the `ssh` and `ssh-keygen` commands.

## 2. Get the repository and enable CI

1. Open [sheeyang/poker-app](https://github.com/sheeyang/poker-app) while signed in.
   To set up your own copy, use **Fork**. If you own the original, use it directly.
2. Clone it and check it locally, replacing the example account:

```powershell
git clone https://github.com/YOUR-ACCOUNT/poker-app.git
cd poker-app
pnpm install --frozen-lockfile
pnpm check
```

No `.env` or database installation is required; tests manage temporary
PostgreSQL 18 automatically. See [local development](local-development.md).

The repository's **default branch** is the deployment branch throughout this guide.
The release workflow rejects other branches.

In GitHub, open **Actions → CI → Run workflow** on the default branch and wait for
its **check** job to pass. Automatic releases stay skipped until the `DEPLOY_HOST`
and `APP_URL` variables are set in section 6. The repository must stay **public**:
public repositories get free Actions minutes, free Arm runners, and free public
container images.

## 3. Upgrade Oracle to Pay As You Go and set a budget

Do this **before** creating the VM. Pay As You Go accounts are not subject to
Oracle's reclamation of idle Always Free instances, and Oracle does not charge for
Always Free resources after the upgrade. It does charge for anything beyond them,
so the budget alert is mandatory.

1. In the Oracle Console, open **Billing & Cost Management → Upgrade and Manage
   Payment** and upgrade to **Pay As You Go**. Oracle may place a temporary hold
   on the card.
2. Open **Billing & Cost Management → Budgets → Create Budget**. Create a monthly
   budget of **1 USD** for the root compartment, with an alert to your email when
   actual spending reaches 100%.

Create only resources marked **Always Free-eligible** in this guide. An alert means
something billable exists: find it and delete it.

## 4. Create the VM

In the Oracle Console, open **Compute → Instances → Create instance**. The wizard
has five steps. Settings not listed here can keep their defaults. Ignore the
banner suggesting additional regions: Always Free resources exist only in the
home region.

### Step 1: Basic information

| Setting | Choose |
| --- | --- |
| **Name** | `poker-production` (any name works). |
| **Create in compartment** | The root compartment (your tenancy name), which the budget covers. |
| **Placement → Availability domain** | **AD 1**, the only one in Singapore. |
| **Placement → Advanced options → Capacity type** | **On-demand capacity**. Never choose **Preemptible**: Oracle can reclaim it at any time. Capacity reservation, dedicated host, and compute cluster are billed. |
| **Placement → Advanced options → Cluster placement group** | None. |
| **Placement → Advanced options → Fault domain** | Leave unset so Oracle chooses. |
| **Image** | **Canonical Ubuntu 24.04**, the standard image rather than *Minimal*. If another image is shown, use **Change image**. Oracle selects the aarch64 build for Ampere shapes. |
| **Shape** | **Change shape → Ampere → VM.Standard.A1.Flex**, marked **Always Free-eligible**. The list shows only the defaults (1 OCPU, 6 GB). Select the row, then click the **▸** arrow beside the shape name to expand it. Set **Number of OCPUs** to **2** and **Amount of memory (GB)** to **12**, then choose **Select shape**. Check that the summary now reads 2 OCPUs and 12 GB. This is the documented Always Free allowance, so do not size it larger. |

Under **Advanced options**:

| Setting | Choose |
| --- | --- |
| **Management → Instance metadata service → Require an authorization header** | Leave unchanged. The server never calls the metadata service. |
| **Management → Initialization script** | None. Section 5 prepares the VM by hand. |
| **Tagging** | None. |
| **Availability configuration → Live migration** | **Use live migration if possible.** Oracle then moves the running VM during host maintenance without interrupting play, and falls back to a reboot only if that fails. |
| **Availability configuration → Restore instance lifecycle state after infrastructure maintenance** | **Enabled.** Otherwise a VM affected by maintenance comes back **stopped** and stays down until you notice. |
| **Oracle Cloud Agent** plugins | Leave the defaults; the monitoring plugin supplies the console's CPU and memory charts. Do not enable a plugin that installs OS updates, because section 5 configures updates without reboots. |

### Step 2: Security

| Setting | Choose |
| --- | --- |
| **Shielded instance** / confidential computing | Leave off. |
| **Advanced options → Security attributes** | None. |

### Step 3: Networking

| Setting | Choose |
| --- | --- |
| **VNIC name** | Leave empty or use `poker-production`. |
| **Primary network** | **Create new virtual cloud network**, unless you already created one for this VM. |
| **Subnet** | **Create new public subnet**. A private subnet cannot receive a public IP. |
| **Private IPv4 address assignment** | **Automatically assign private IPv4 address**. |
| **Public IPv4 address assignment** | **Automatically assign public IPv4 address**: enabled. Without it the VM is unreachable from the internet. |
| **IPv6 address assignment** | Off. |
| **Advanced options → DNS record** | **Assign a private DNS record**; the hostname is optional. The public hostname comes from DuckDNS. |
| **Advanced options → Launch options** | **Paravirtualized networking**. Hardware-assisted (SR-IOV) networking does not support live migration. |
| **Add SSH keys** | **Generate a key pair for me**, then **Download private key**. It is shown only once. Save it as `$HOME\.ssh\oracle-admin.key`. This is your administrator login, separate from the deploy key in section 5. You can instead paste or upload an existing public key. Never choose **No SSH keys**. |

### Step 4: Storage

| Setting | Choose |
| --- | --- |
| **Boot volume → Specify a custom boot volume size and performance setting** | Enabled. Set the size to **100 GB**, within the 200 GB Always Free block storage. |
| **Boot volume performance** | Keep **Balanced (10 VPUs/GB)**. Higher performance levels are billed. |
| **Use in-transit encryption** | Leave the default. |
| **Encrypt this volume with a key that you manage** | Off. Oracle-managed encryption is free and needs no Vault. |
| **Block volumes** | Attach none. The database lives on the boot volume. |

### Step 5: Review

Confirm the shape shows **Always Free-eligible**, **2 OCPUs and 12 GB**, a
public IPv4 address, and a **100 GB** boot volume. Then choose **Create**. Do not
save it as a stack.

If creation fails with **Out of host capacity**, retry later. Singapore has a
single availability domain, so there is no other domain to try.

After creation, copy the instance's **public IP address**, then:

1. In DuckDNS, set your subdomain's IP to that address.
2. Open the instance's subnet → **Security Lists → Default Security List → Add
   Ingress Rules**. Add source `0.0.0.0/0`, TCP, destination ports **80** and
   **443**. Port 22 is already open. Do not open PostgreSQL's 5432.

Sources: [Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm),
[Free Tier FAQ](https://www.oracle.com/cloud/free/faq/).

## 5. Prepare the VM

Log in as the image's `ubuntu` user with the administrator key from step 3,
replacing the hostname:

```powershell
ssh -i $HOME\.ssh\oracle-admin.key ubuntu@yourname.duckdns.org
```

Run the remaining commands in this section **on the VM**.

### Open the host firewall

Oracle's Ubuntu image also blocks ports in its own iptables rules. Save the new
rules **before** installing Docker so Docker's rules are not saved with them:

```bash
sudo iptables -I INPUT -p tcp -m multiport --dports 80,443 -m conntrack --ctstate NEW -j ACCEPT
sudo netfilter-persistent save
```

### Install updates and Docker

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y docker.io docker-compose-v2 unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

Answer **Yes** to automatic updates. Ubuntu then installs security updates daily
without rebooting; reboots stay manual (section 9). Docker comes from Ubuntu's
archive so those updates include it.

Keep containers running while Docker itself is updated, and cap log size so
months of unattended operation cannot fill the disk:

```bash
sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "live-restore": true,
  "log-driver": "local",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
sudo systemctl restart docker
```

### Create the deploy user and production settings

Replace the hostname and image repository below. The repository is
`ghcr.io/` followed by your GitHub account and repository name **in lowercase**.

```bash
sudo adduser --disabled-password --gecos '' deploy
sudo usermod -aG docker deploy
sudo install -d -o deploy -g deploy -m 700 /opt/poker
sudo -u deploy sh -c 'umask 077; cat > /opt/poker/.env' <<EOF
APP_HOST=yourname.duckdns.org
APP_IMAGE_REPOSITORY=ghcr.io/your-account/poker-app
POSTGRES_PASSWORD=$(openssl rand -hex 32)
EOF
sudo -u deploy curl -fsSL -o /opt/poker/deploy.sh \
  https://raw.githubusercontent.com/YOUR-ACCOUNT/poker-app/HEAD/deploy/deploy.sh
sudo chmod 700 /opt/poker/deploy.sh
```

`.env` holds the only copy of the database password; keep it on the VM. Each
release adds an `APP_REVISION` line to it. `deploy.sh` is installed once; if a
later commit changes `deploy/deploy.sh`, repeat the `curl` command.

### Install the deploy key

On **your own computer**, create a key for GitHub Actions outside the checkout.
Press Enter at both passphrase prompts:

```powershell
ssh-keygen -t ed25519 -C poker-release -f $HOME\.ssh\poker-release
Get-Content $HOME\.ssh\poker-release.pub
```

Back **on the VM**, authorize it to run only `deploy.sh`. Paste the printed
`ssh-ed25519 ...` line after `restrict `, keeping the single quotes:

```bash
sudo install -d -o deploy -g deploy -m 700 /home/deploy/.ssh
echo 'command="/opt/poker/deploy.sh",restrict PASTE-THE-PUBLIC-KEY-LINE-HERE' \
  | sudo -u deploy tee /home/deploy/.ssh/authorized_keys > /dev/null
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

The key can only start an already-published image of this repository. It cannot
open a shell, run other commands, or choose another image.

Print the VM's host key line for GitHub, replacing the hostname:

```bash
echo "yourname.duckdns.org $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
```

## 6. Connect GitHub Actions to the VM

In your GitHub repository, open **Settings → Secrets and variables → Actions**.

On the **Secrets** tab, add:

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_KEY` | The full contents of the private key file `$HOME\.ssh\poker-release`, including its `BEGIN` and `END` lines. |

On the **Variables** tab, add:

| Variable | Value |
| --- | --- |
| `DEPLOY_HOST` | `yourname.duckdns.org` |
| `DEPLOY_KNOWN_HOSTS` | The host key line printed at the end of section 5. |
| `APP_URL` | `https://yourname.duckdns.org`, without a path. |

You may delete the local key files afterward. If the private key leaks, replace
the `authorized_keys` line on the VM with a new key.

## 7. Run the first release

1. In GitHub, open **Actions → Release → Run workflow** on the default branch.
2. The first run publishes the container image and then stops with **Make the
   ghcr.io package public**. This is expected once: new packages start private.
3. Open your GitHub profile's **Packages → poker-app → Package settings → Change
   visibility**, choose **Public**, and confirm.
4. Re-run the failed job. Wait for the **whole workflow** to succeed: it checks
   the commit, publishes the image, deploys it, waits for `/readyz` to report that
   commit, and verifies the Trainer, secure cookie, and WebSocket.

The first deployment also obtains the HTTPS certificate and creates the database
tables, which can take a minute.

## 8. Verify and monitor production

1. Open `https://yourname.duckdns.org`, start practice, and play a Hand.
2. Reload in the same browser profile. Confirm your Table Session restores.
3. Open `https://yourname.duckdns.org/readyz`. It should report `ok: true`,
   `status: ready`, and the commit SHA of the successful run.

Nobody notices an outage when nobody is playing, so add an external monitor. In a
free [UptimeRobot](https://uptimerobot.com/) account, create an **HTTP(s)** monitor
for `https://yourname.duckdns.org/readyz` with email alerts. `/readyz` returns
HTTP 503 whenever the application is not ready. The monitor only watches; the VM
never sleeps.

## 9. Operate production

### Release changes

1. Make changes on a branch, push, and open a pull request.
2. Let **CI** pass, review, and merge into the default branch.
3. In that commit's **CI** run, the **Release** job builds the Arm image, deploys
   it, and verifies it. Wait for the whole run to succeed.

Pull requests and feature branches run checks only. Releases run one at a time; an
active release always finishes. For a manual retry, use **Actions → Release → Run
workflow**, which runs the project checks again. Repeating a deployment of the
same commit is safe.

Changes to `deploy/compose.yaml` ship with the release, and each release also
installs patch updates to the PostgreSQL 18 and Caddy 2 images. Changes to
`deploy/deploy.sh` require repeating its `curl` command on the VM (section 5).

### Reboot manually

Security updates install automatically, but nothing reboots by itself. Log in
occasionally; Ubuntu prints **System restart required** when a kernel update is
waiting. Reboot when nobody is playing:

```bash
sudo reboot
```

Containers start automatically afterward. Expect a brief interruption.

### Inspect the VM

Run these as the `ubuntu` user on the VM. Replace `app` with `caddy` or `postgres`
for the other services:

```bash
sudo -u deploy docker compose --project-directory /opt/poker ps
sudo -u deploy docker compose --project-directory /opt/poker logs --tail 200 app
```

### If the public IP changes

The IP stays with the instance until it is terminated. If you ever recreate the
VM, update the DuckDNS IP and `DEPLOY_KNOWN_HOSTS`. Keep the same hostname so
browsers keep their cookies; the database on the old VM is lost.

## 10. Handle failures

| Symptom | What to check |
| --- | --- |
| No Run workflow button | Workflow files must be on the default branch; enable Actions and ensure you have write access. |
| Automatic Release job is skipped | It requires a passing **check** on a push to the default branch, plus the `DEPLOY_HOST` and `APP_URL` variables. Add them, then run Release manually. |
| Release rejects the branch | Select the default branch in Run workflow. |
| Missing secret or variable | Use section 6; names must match exactly. |
| Make the ghcr.io package public | Section 7, step 3. |
| SSH host key verification failed | `DEPLOY_KNOWN_HOSTS` must match the VM's current host key for `DEPLOY_HOST`. Reprint it (section 5). |
| SSH permission denied | Check `/home/deploy/.ssh/authorized_keys` and that `DEPLOY_SSH_KEY` holds the matching private key. |
| `Expected one full commit SHA` | The workflow must pass only `$GITHUB_SHA`; nothing else is accepted. |
| Site unreachable, VM running | Check the DuckDNS IP, the security list (80/443), and the host iptables rule from section 5. |
| HTTPS certificate errors | Ports 80 and 443 must both be reachable for Let's Encrypt. Check the `caddy` logs (section 9). |
| Authority stays waiting | Another server is holding the authority lock on the same database. Never remove the guard. |
| Verification times out | Check the `app` logs (section 9) for schema, restoration, or startup errors. No automatic rollback or database reset happens. |
| Unknown gameplay COMMIT | Use the app's explicit outcome check. See [recovery](server-protocol.md#unknown-commit-resolution). |
| Oracle budget alert | Something billable exists. Delete it; keep only the resources in this guide. |
| UptimeRobot alert | Log in and check `ps`, then the logs (section 9). If the instance is stopped, start it from the Oracle Console. |

There is **no automatic rollback**. A previous image may not read records written
by a newer version under ADR-0014. Fix forward, or deliberately run Release for a
compatible commit.

## 11. Retire the Render and Neon setup

If you deployed with the earlier Render and Neon guide, do this only after
production passes section 8:

1. In Render, delete the `poker-trainer-preview` web service and its Blueprint.
2. In Neon, delete the `poker-trainer-preview` and `poker-trainer-tests` projects.
3. In GitHub, delete the `RENDER_API_KEY` and `NEON_TEST_DATABASE_URL` secrets and
   the `RENDER_SERVICE_ID` variable. Update `APP_URL` if it still points at Render.

Saved Table Sessions on Render are not migrated.

## 12. Stay within free allowances

| Provider | Free-plan considerations |
| --- | --- |
| Oracle | Always Free Ampere A1: 1,500 OCPU-hours and 9,000 GB-hours monthly, equal to 2 OCPUs and 12 GB running all month; 200 GB block storage; 10 TB monthly outbound transfer. Anything else is billed on Pay As You Go. |
| GitHub | Actions minutes, Arm runners, and public GitHub Container Registry packages are free for public repositories. |
| DuckDNS | Free subdomains. |
| UptimeRobot | The free plan's HTTP monitors and email alerts are enough. |

Sources: [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm),
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[GitHub package visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).
