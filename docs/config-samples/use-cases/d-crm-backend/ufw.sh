#!/bin/sh
# ufw.sh: the VPS firewall. Only SSH and the proxy (80 for the certificate, 443) are open;
# the engine ports (3901, 3902, ...) and the QR port 18927 stay on 127.0.0.1 and are never
# opened here. Run once, as root, from a session you can get back into (keep it open
# until `ufw status` looks right).
#   sudo sh ufw.sh
set -eu
ufw default deny incoming
ufw default allow outgoing
# SSH: better from your own address only, e.g. `ufw allow from 203.0.113.7 to any port 22 proto tcp`.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose
