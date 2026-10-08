#!/usr/bin/env bash
# One-shot install of SolarScope on a fresh Ubuntu 24.04 EC2 instance.
# Re-running is safe: it pulls the latest code and restarts the service.
#   curl -fsSL https://raw.githubusercontent.com/Pai05/solarscope/main/infra/setup.sh | sudo bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Pai05/solarscope.git}"
APP_DIR=/opt/solarscope
APP_USER=solarscope

echo "== packages"
apt-get update -y
apt-get install -y git python3-venv python3-pip unzip curl

echo "== swap (2 GB) so model loading does not OOM on a 2 GB instance"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== AWS CLI (uses the instance IAM role; no keys on disk)"
if ! command -v aws >/dev/null; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip
  unzip -q -o /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install --update
fi

echo "== app user and code"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "== python venv"
sudo -u "$APP_USER" python3 -m venv "$APP_DIR/.venv"
sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install -q --upgrade pip
sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"

echo "== systemd service on port 80"
cat > /etc/systemd/system/solarscope.service <<EOF
[Unit]
Description=SolarScope FastAPI app
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=-$APP_DIR/.env
ExecStart=$APP_DIR/.venv/bin/uvicorn backend.app:app --host 0.0.0.0 --port 80 --workers 1
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable solarscope
systemctl restart solarscope
sleep 3
systemctl --no-pager --lines=5 status solarscope || true
echo "== local check"
curl -fsS http://127.0.0.1/health && echo
echo "Done. Open http://<public-ip>/health from your browser."
