# CineDrive production deployment

These files define the CineDrive fork's main-to-production flow. The VPS is
prepared for its first application deployment; this directory is the versioned
reconstruction copy. Keep VPS-specific secrets and the real server IP out of
this checkout.

## What runs on a push to main

- Pull requests run the full CI suite, including the browser matrix, and the
  container security scan. CI can also be started manually. These checks do not
  publish production images or connect to the VPS.
- Each push to `main` runs the separate `Deploy production` workflow. Its first
  job reads the production environment variable `DEPLOY_ENABLED`.
- When the value is exactly `true`, the workflow builds and publishes the
  server and web images as immutable production-SHA40 tags, then sends that
  commit SHA through the restricted SSH command. The VPS deploy script updates
  the Compose services and verifies local and public health endpoints; it
  restores the previous images if a later deployment fails.
- With `DEPLOY_ENABLED=false`, only the small switch job runs; no image build,
  publish, or VPS connection occurs.
- Deployment does not wait for CI, CodeQL, the browser matrix, or container
  scanning. CodeQL and Container Security remain on pull requests and their
  scheduled scans, independent of pushes to `main`.
- The inherited Release workflow is separate and does not participate in the
  `main` deployment. Its tag-based publishing flow is not configured for this
  VPS and should not be used for this deployment.

GitHub Actions has been enabled for this fork. Workflow files cannot change
that repository setting.

## HTTP access for personal use

This setup intentionally serves the app over HTTP on the selected public port
for personal use. The production cookie remains Secure by default; set
SESSION_COOKIE_SECURE=false in the VPS .env to allow browser sessions over
HTTP. The deployment example includes this setting. This does not switch
NODE_ENV out of production. HTTP does not encrypt login or session traffic, so
use this only for the personal access setup you requested. If HTTPS is added
later, set SESSION_COOKIE_SECURE=true.

The existing app.db retains the Google Drive connection when the same
TOKEN_ENCRYPTION_KEY is used. A fresh Google authorization is not part of the
normal deployment path.

## Confirm the VPS before setup

On 2026-11-10, the VPS was confirmed as Debian 13 (Trixie), architecture
`amd64`, with Docker Compose v5.3.1. The image workflow's `linux/amd64`
platform matches. Docker is already running. Nginx 1.26.3-3+deb13u10 was
installed from `trixie-security` on 2026-11-10; the CineDrive site is enabled
and Nginx is listening on port 52794. The
`deploy` account exists (uid 1003); its `.ssh` directory and `authorized_keys`
have modes 700 and 600. The dedicated Ed25519 key is in `authorized_keys` with
the forced deployment-gate command. The deploy scripts and sudoers entry are
installed and syntax-checked; the restricted SSH key was tested from Windows
and returned `cinedrive production SSH authentication OK`.
Ports 18080 and 18081 are occupied, so the app's loopback web port is 18082.
Recheck before changing the server:

On 2026-11-10, both shell scripts passed `bash -n`, the sudoers file passed
`visudo -cf`, and the production Compose file passed `docker compose config
--quiet` on the VPS. The Nginx virtual host has the server IP set, and
`nginx -t` succeeded after enabling this virtual host in `sites-enabled`.
The default site is disabled. Nginx is running; the upstream app will return
502 until its first deployment starts.

The local SQLite backup `cinedrive-20261110T193532Z.db` passed the backup
integrity check. It was transferred to `/root/app.db.backup` and imported into
the new `cinedrive_app_data` volume. The source and imported database hashes
matched; the database is owned by `node:node` with mode 0640. Keep both backups
until the first image deployment, migrations, and health checks succeed. No
CineDrive application containers are running yet.

The Compose file treats `cinedrive_app_data` as external because it was created
and seeded before the first deployment; Compose will use it without managing
its lifecycle.

You reported copying the updated `infra/main/compose.yaml` to the VPS. Before
the first deployment, validate the copied file there and confirm the existing
database volume remains external:

    cd /opt/apps/cinedrive-production
    docker compose --env-file .env -f compose.yaml config --quiet
    docker volume inspect cinedrive_app_data

    uname -m
    dpkg --print-architecture
    sudo ss -lntp
    sudo docker --version
    sudo docker compose version
    sudo nginx -v

The architecture check returned `amd64`, so no image-platform change is
needed. Port 52794 is the confirmed public web port; it is separate from the
SSH port, which will be entered directly in the GitHub Environment when that
step is reached.

## Install Nginx and Docker

Debian's Trixie package repository currently provides the maintained Nginx
package. Install from Debian's repository so apt receives security updates:

    sudo apt update
    sudo apt install --no-install-recommends nginx
    nginx -v
    sudo systemctl disable --now nginx

Keep Nginx stopped until the CineDrive site configuration is installed. This
avoids leaving Debian's default site active on port 80 during setup.

Docker Compose v5.3.1 is already installed on this VPS, so skip the Docker
installation below. These commands are only for a fresh/restored server where
Docker Engine or Compose is absent. They use Docker's signed Debian apt
repository:

    sudo apt update
    sudo apt install ca-certificates curl
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc

Create /etc/apt/sources.list.d/docker.sources using the detected Debian
architecture, then install the current stable packages:

    ARCH="$(dpkg --print-architecture)"
    printf 'Types: deb\nURIs: https://download.docker.com/linux/debian\nSuites: trixie\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$ARCH" | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null
    sudo apt update
    sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    sudo systemctl enable --now docker
    sudo docker run --rm hello-world
    sudo docker compose version

Do not add the deploy account to the docker group; that group grants root-level
control. Debian's Nginx package is maintained in the Debian security repository.

## Copy the proposed files to the VPS

Transfer each local file through the file-transfer client into its destination
on the VPS. Use an administrator session with access to the system directories.
If a destination directory is missing, create it in that client. Do not upload
the local README. Leave `<SERVER_IP>` placeholders unchanged in this checkout;
replace them only in the VPS copies during the later configuration step.

| Local file | VPS destination |
| --- | --- |
| `infra/main/cinedrive-production-deploy` | `/etc/sudoers.d/cinedrive-production-deploy` |
| `infra/main/scripts/deploy-cinedrive-production` | `/usr/local/sbin/deploy-cinedrive-production` |
| `infra/main/scripts/cinedrive-production-deploy-gate` | `/usr/local/sbin/cinedrive-production-deploy-gate` |
| `infra/main/nginx/cinedrive` | `/etc/nginx/sites-available/cinedrive` |
| `infra/main/compose.yaml` | `/opt/apps/cinedrive-production/compose.yaml` |
| `infra/main/.env.example` | `/opt/apps/cinedrive-production/.env` |

Do not overwrite an existing `.env`. If it already exists, stop and preserve
its values. The local `.env.example` is only a template; its placeholders must
be replaced on the VPS. After the files and destination directory are present,
run these ownership and permission corrections as root:

    chown root:root /etc/sudoers.d/cinedrive-production-deploy /usr/local/sbin/deploy-cinedrive-production /usr/local/sbin/cinedrive-production-deploy-gate /etc/nginx/sites-available/cinedrive /opt/apps/cinedrive-production /opt/apps/cinedrive-production/compose.yaml /opt/apps/cinedrive-production/.env
    chmod 0440 /etc/sudoers.d/cinedrive-production-deploy
    chmod 0750 /usr/local/sbin/deploy-cinedrive-production
    chmod 0755 /usr/local/sbin/cinedrive-production-deploy-gate
    chmod 0644 /etc/nginx/sites-available/cinedrive /opt/apps/cinedrive-production/compose.yaml
    chmod 0700 /opt/apps/cinedrive-production
    chmod 0600 /opt/apps/cinedrive-production/.env

The SSH port is separate from public web port 52794. The local deployment key
has already been generated and its public key added to `deploy`'s
`authorized_keys`; do not copy the private key to the VPS.

The VPS `.env`, deploy script, and Nginx virtual host have been configured with
the real server IP. The root-only GHCR login also succeeded; its Docker auth
config is stored under `/opt/apps/cinedrive-production/docker-auth`. Leave
`<SERVER_IP>` in local templates unchanged.

## Prepare the application directory and database

The `deploy` account, its SSH directory, and its restricted public key are
already prepared on this VPS. Do not repeat account/key setup or replace
`authorized_keys`. The forced-command gate must be present before testing this
key.

On the VPS, verify the host-key fingerprint locally and format the matching
known_hosts line for GitHub. Use the SSH port confirmed on this server:

    sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
    read -r -p "Verified SSH port: " SSH_PORT
    sudo awk -v host='<SERVER_IP>' -v port="$SSH_PORT" '{ if (port == 22) print host, $1, $2; else print "[" host "]:" port, $1, $2 }' /etc/ssh/ssh_host_ed25519_key.pub

Compare the fingerprint through a trusted channel before saving that line as
VPS_SSH_KNOWN_HOSTS. The SSH port must be reachable from GitHub-hosted runners;
it is separate from the public web port 52794.

The Compose file and `.env` are copied directly to their final paths per the
previous section. If `.env` already exists, preserve it. Fill its required
values on the VPS; do not commit or send it. Keep the same `SESSION_SECRET`,
`TOKEN_ENCRYPTION_KEY`, Google client ID, and Google client secret as the local
deployment. In particular, `TOKEN_ENCRYPTION_KEY` must match the key that
encrypted the Google tokens in `app.db`.

Back up the local SQLite database with the project's `pnpm db:backup` command
before transferring it through SFTP. On this VPS, the backup was copied to
`/root/app.db.backup`; verify its ownership and mode are `root:root` and 0600.
For a first-time import into an empty named volume, use this guarded copy. It
stops if the volume already contains files and verifies the import byte for
byte. The helper container is removed on exit; the named volume remains:

    docker volume create cinedrive_app_data
    docker run --rm --user 0:0 \
      --mount type=volume,source=cinedrive_app_data,target=/data,volume-nocopy \
      --mount type=bind,source=/root/app.db.backup,target=/tmp/app.db.backup,readonly \
      node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 \
      sh -eu -c '
        test -z "$(ls -A /data)"
        cp /tmp/app.db.backup /data/app.db
        chown node:node /data /data/app.db
        chmod 0755 /data
        chmod 0640 /data/app.db
        cmp -s /tmp/app.db.backup /data/app.db
        stat -c "%U:%G %a %s %n" /data /data/app.db
        sha256sum /tmp/app.db.backup /data/app.db
      '

The database import is already complete on this VPS; do not rerun the command
there. The server image applies pending Prisma migrations at startup. Rolling
back an image does not reverse a database migration, so retain the local and
VPS backups until the first deployment and health checks succeed.

## Prepare GHCR and enable Nginx before the first app deployment

The Compose and Nginx files are already copied to their final paths per the
file-transfer table. Log in to GHCR on the VPS using a separate read-only token
with `packages:read`; do not use the GitHub Actions token here:

    sudo install -d -m 700 -o root -g root /opt/apps/cinedrive-production/docker-auth
    read -r -s -p "GHCR read token: " GHCR_TOKEN
    printf '%s' "$GHCR_TOKEN" | sudo docker --config /opt/apps/cinedrive-production/docker-auth login ghcr.io --username <github-user> --password-stdin
    unset GHCR_TOKEN
    sudo chown root:root /opt/apps/cinedrive-production/docker-auth/config.json
    sudo chmod 600 /opt/apps/cinedrive-production/docker-auth/config.json

Enable the copied Nginx site before the first deployment. The deploy script
checks both the local web endpoint and the public endpoint on port 52794; that
public check requires Nginx to be running. It is expected to return 502 until
the first app deployment starts. Keep Debian's default site disabled and test
the loaded configuration before starting Nginx:

    if [ ! -e /etc/nginx/sites-enabled/cinedrive ]; then sudo ln -s /etc/nginx/sites-available/cinedrive /etc/nginx/sites-enabled/cinedrive; fi
    if [ -L /etc/nginx/sites-enabled/default ]; then sudo unlink /etc/nginx/sites-enabled/default; fi
    sudo nginx -t
    sudo systemctl enable --now nginx

The public listener is `<SERVER_IP>:52794`. The Compose web port is bound only
to `127.0.0.1:18082`; ports 18080 and 18081 are already occupied on this VPS
and remain untouched. The server itself has no host-published port.

## Install the restricted deploy command

The deploy scripts and sudoers file are copied to their final paths per the
file-transfer table. Validate them after the permission corrections:
    sudo bash -n /usr/local/sbin/deploy-cinedrive-production
    sudo bash -n /usr/local/sbin/cinedrive-production-deploy-gate
    sudo visudo -cf /etc/sudoers.d/cinedrive-production-deploy

The deploy account can invoke only the exact deploy script, and the SSH key
accepts only ping or deploy followed by a 40-character lowercase commit SHA.
Verify the VPS host-key fingerprint through a trusted channel before saving
the matching known_hosts entry in GitHub.

## GitHub environment setup

GitHub Actions is enabled and the `production` environment is configured. Its
`DEPLOY_ENABLED` variable must be exactly `true` to deploy or `false` to skip
image publication and VPS access. The environment also contains these secrets:

- VPS_SSH_DEPLOY_KEY: the dedicated private key; never commit it.
- VPS_SSH_KNOWN_HOSTS: the host key checked against the VPS fingerprint.
- VPS_SSH_HOST: <SERVER_IP>.
- VPS_SSH_PORT: the SSH port, confirmed on the VPS; this is not 52794.
- VPS_SSH_USER: deploy.

The workflow reads `DEPLOY_ENABLED` in a lightweight production environment
gate; an unset or invalid value fails closed. With `false`, pushes to `main`
only read the switch and do not build images or contact the VPS. With `true`, the
next push builds and publishes both images, then deploys that exact commit. The
environment may keep its branch/tag setting at `No restriction`: workflow
conditions limit the gate, image publishing, and deployment to pushes to `main`.

The workflow uses GITHUB_TOKEN only to publish packages to this repository's
GHCR namespace. GHCR images should remain private; the VPS uses its own
read-only token. Do not add secrets to repository-level workflow permissions.

## Rollback and verification

The deploy script pulls both new images and confirms the previous tagged images
are available before changing IMAGE_TAG. It then starts both services, waits
for Compose health checks, and checks /health and /api/ready through Nginx. If
startup or HTTP checks fail, it restores the previous tag and containers. It
never deletes volumes or runs docker system prune. The bootstrap deploy has no
previous image to restore.

After a deployment, verify from the VPS:

    cd /opt/apps/cinedrive-production
    sudo docker compose --env-file .env -f compose.yaml ps
    sudo docker compose --env-file .env -f compose.yaml logs --tail=100 server web
    curl --fail http://127.0.0.1:52794/health
    curl --fail http://127.0.0.1:52794/api/ready

If deploying a new migration, keep a separate database backup before pushing
main. Rollback preserves data and restores the previous application images; it
cannot undo a migration that already changed the SQLite schema.

## Official installation references

- Docker Engine for Debian, including Trixie: https://docs.docker.com/engine/install/debian/
- Debian Trixie Nginx package: https://packages.debian.org/trixie/nginx
- GitHub Actions workflows in forks: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
