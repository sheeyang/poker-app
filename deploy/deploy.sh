#!/bin/sh
# Forced SSH command for the release workflow's deploy key: starts one already-published image.
# Install once at /opt/poker/deploy.sh (see docs/deployment_guide.md). Repeating a deployment is safe.
set -eu
umask 077

revision=${SSH_ORIGINAL_COMMAND:-${1:-}}
case $revision in
  *[!0123456789abcdef]*) revision= ;;
esac
if [ ${#revision} -ne 40 ]; then
  echo 'Expected one full commit SHA.' >&2
  exit 2
fi

cd "$(dirname "$0")"
repository=$(sed -n 's/^APP_IMAGE_REPOSITORY=//p' .env)
if [ -z "$repository" ]; then
  echo 'Set APP_IMAGE_REPOSITORY in .env.' >&2
  exit 2
fi
image="$repository:$revision"

docker pull --quiet "$image"
# Configuration ships with code: use the Compose file released inside this image.
container=$(docker create "$image")
docker cp "$container:/app/deploy/compose.yaml" compose.yaml.next
docker rm "$container" >/dev/null
sed '/^APP_REVISION=/d' .env > .env.next
echo "APP_REVISION=$revision" >> .env.next
mv compose.yaml.next compose.yaml
mv .env.next .env

# Releases also pick up patch updates to the PostgreSQL 18 and Caddy 2 images.
docker compose pull --quiet
docker compose up --detach --remove-orphans
# Months of unattended releases must not fill the disk with old images.
docker image prune --all --force >/dev/null
echo "Started $image."
