#!/usr/bin/env bash
# Install a constrained qqdeploy entry point for one named collaborator.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sudo tools/setup-deploy-access.sh --user USER (--pubkey KEY | --pubkey-file FILE)

The SSH public key and deploy account are required. This installer never adds
users to the docker group and never embeds a contributor key.
EOF
}

DEPLOY_USER=""
PUBKEY=""
PUBKEY_FILE=""
while (($#)); do
  case "$1" in
    --user) (($# >= 2)) || { usage >&2; exit 2; }; DEPLOY_USER="$2"; shift 2 ;;
    --pubkey) (($# >= 2)) || { usage >&2; exit 2; }; PUBKEY="$2"; shift 2 ;;
    --pubkey-file) (($# >= 2)) || { usage >&2; exit 2; }; PUBKEY_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Run this installer as root." >&2; exit 1; }
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || {
  echo "--user must be a valid local account name." >&2; exit 2;
}
[[ -n "$PUBKEY" && -z "$PUBKEY_FILE" || -z "$PUBKEY" && -n "$PUBKEY_FILE" ]] || {
  echo "Provide exactly one of --pubkey or --pubkey-file." >&2; exit 2;
}
if [[ -n "$PUBKEY_FILE" ]]; then
  [[ -f "$PUBKEY_FILE" && ! -L "$PUBKEY_FILE" ]] || {
    echo "Public-key file must be a regular non-symlink file." >&2; exit 2;
  }
  PUBKEY="$(<"$PUBKEY_FILE")"
fi
[[ -n "$PUBKEY" && "$PUBKEY" != *$'\n'* && "$PUBKEY" != *$'\r'* ]] || {
  echo "Provide exactly one OpenSSH public-key line." >&2; exit 2;
}

for command in dirname node python3 runuser docker visudo flock ssh-keygen \
               adduser useradd install getent id stat awk grep sed cut tr mktemp \
               mv rm chmod chown; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command is missing: $command" >&2; exit 1;
  }
done

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
for source in "$SCRIPT_DIR/qqdeploy.py" "$SCRIPT_DIR/check-modules.py" \
              "$SCRIPT_DIR/qqdeploy-compose.template.yml" "$SCRIPT_DIR/README-部署.md" \
              "$REPO_DIR/deploy/Dockerfile"; do
  [[ -f "$source" && ! -L "$source" ]] || {
    echo "Required regular source file missing: $source" >&2; exit 1;
  }
done

for dir in /usr/local /usr/local/bin /usr/local/lib /etc /etc/sudoers.d; do
  [[ -d "$dir" && ! -L "$dir" ]] || { echo "Unsafe/missing directory: $dir" >&2; exit 1; }
  [[ "$(stat -c '%u' "$dir")" == 0 ]] || { echo "Directory is not root-owned: $dir" >&2; exit 1; }
  mode="$(stat -c '%a' "$dir")"
  (( (8#$mode & 022) == 0 )) || { echo "Directory is group/world writable: $dir" >&2; exit 1; }
done

KEY_TMP="$(mktemp)"
SUDOERS_TMP=""
README_TMP=""
trap 'rm -f -- "$KEY_TMP" "$SUDOERS_TMP" "$README_TMP"' EXIT
printf '%s\n' "$PUBKEY" > "$KEY_TMP"
ssh-keygen -lf "$KEY_TMP" >/dev/null || { echo "Invalid SSH public key." >&2; exit 2; }
KEY_BLOB="$(awk '{print $2}' "$KEY_TMP")"

echo "===== Deploy account: $DEPLOY_USER ====="
if id "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "Account exists; preserving its existing groups and files."
else
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
if id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx docker; then
  echo "WARNING: $DEPLOY_USER is already in docker. Docker access is root-equivalent; audit it with the administrator. No group membership was changed." >&2
else
  echo "No Docker group membership was added."
fi

DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
PRIMARY_GROUP="$(id -gn "$DEPLOY_USER")"
[[ -n "$DEPLOY_HOME" && -d "$DEPLOY_HOME" && ! -L "$DEPLOY_HOME" ]] || {
  echo "Could not safely locate the account home." >&2; exit 1;
}
README_TARGET="$DEPLOY_HOME/README-部署.md"
[[ ! -L "$README_TARGET" ]] || {
  echo "Deployment guide target cannot be a symlink." >&2; exit 1;
}
[[ ! -e "$README_TARGET" || -f "$README_TARGET" ]] || {
  echo "Deployment guide target must be a regular file." >&2; exit 1;
}
SSH_DIR="$DEPLOY_HOME/.ssh"
AUTH="$SSH_DIR/authorized_keys"
[[ ! -L "$SSH_DIR" && ! -L "$AUTH" ]] || { echo "SSH paths cannot be symlinks." >&2; exit 1; }
install -d -m 700 -o "$DEPLOY_USER" -g "$PRIMARY_GROUP" "$SSH_DIR"
if [[ ! -e "$AUTH" ]]; then
  install -m 600 -o "$DEPLOY_USER" -g "$PRIMARY_GROUP" /dev/null "$AUTH"
fi
if grep -qF "$KEY_BLOB" "$AUTH"; then
  echo "Public key already installed."
else
  printf '%s\n' "$PUBKEY" >> "$AUTH"
  echo "Public key installed."
fi
chmod 600 "$AUTH"
chown "$DEPLOY_USER:$PRIMARY_GROUP" "$AUTH"
ssh-keygen -lf "$AUTH" | sed 's/^/  /'

echo "===== Trusted deployment files ====="
[[ ! -L /usr/local/bin/qqdeploy ]] || { echo "Refusing symlink at /usr/local/bin/qqdeploy." >&2; exit 1; }
[[ ! -L /usr/local/lib/qqdeploy ]] || { echo "Refusing symlink at /usr/local/lib/qqdeploy." >&2; exit 1; }
install -d -m 755 -o root -g root /usr/local/lib/qqdeploy
install -m 755 -o root -g root "$SCRIPT_DIR/qqdeploy.py" /usr/local/bin/qqdeploy
install -m 644 -o root -g root "$SCRIPT_DIR/check-modules.py" /usr/local/lib/qqdeploy/check-modules.py
install -m 644 -o root -g root "$REPO_DIR/deploy/Dockerfile" /usr/local/lib/qqdeploy/Dockerfile
install -m 644 -o root -g root "$SCRIPT_DIR/qqdeploy-compose.template.yml" /usr/local/lib/qqdeploy/compose.template.yml
python3 -c 'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read())' /usr/local/bin/qqdeploy

if ! id qqcheck >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin qqcheck
fi
[[ "$(id -u qqcheck)" != 0 ]] || { echo "qqcheck must not be root." >&2; exit 1; }
QQCHECK_GROUPS="$(id -nG qqcheck | tr ' ' '\n')"
if [[ "$(id -gn qqcheck)" == root ]] || printf '%s\n' "$QQCHECK_GROUPS" | grep -Eq '^(root|docker|sudo|wheel)$'; then
  echo "qqcheck belongs to a privileged group; refusing to use it as a low-privilege checker." >&2
  exit 1
fi

echo "===== Administrator repository allowlist ====="
install -d -m 755 -o root -g root /etc/qqdeploy
REPO_CONFIG=/etc/qqdeploy/repositories.json
[[ ! -L "$REPO_CONFIG" ]] || { echo "Repository config cannot be a symlink." >&2; exit 1; }
if [[ ! -e "$REPO_CONFIG" ]]; then
  printf '{"default":"viuuro/qq-agent-xiaoruan","allowed":["viuuro/qq-agent-xiaoruan"]}\n' \
    > "$REPO_CONFIG"
  chmod 644 "$REPO_CONFIG"
  chown root:root "$REPO_CONFIG"
fi
python3 -c 'import json,os,stat,sys; p=sys.argv[1]; s=os.stat(p,follow_symlinks=False); d=json.load(open(p,encoding="utf-8")); ok=stat.S_ISREG(s.st_mode) and s.st_uid==0 and not (s.st_mode & 0o022) and isinstance(d,dict) and isinstance(d.get("allowed"),list) and bool(d["allowed"]) and d.get("default") in d["allowed"] and all(isinstance(x,str) and __import__("re").fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+",x) for x in d["allowed"]); sys.exit(0 if ok else 1)' "$REPO_CONFIG" || {
  echo "Invalid /etc/qqdeploy/repositories.json; require root-owned JSON default/allowed allowlist." >&2; exit 1;
}
echo "Default repository is administrator-selected. Forks require an administrator edit to $REPO_CONFIG."

echo "===== Constrained sudo command ====="
SUDOERS_FILE="/etc/sudoers.d/qqdeploy-${DEPLOY_USER}"
[[ ! -L "$SUDOERS_FILE" ]] || { echo "sudoers target cannot be a symlink." >&2; exit 1; }
if [[ -e "$SUDOERS_FILE" ]]; then
  [[ -f "$SUDOERS_FILE" && "$(stat -c '%u' "$SUDOERS_FILE")" == 0 ]] || {
    echo "Existing per-user sudoers target must be a root-owned regular file." >&2; exit 1;
  }
  grep -q '^# Managed qqdeploy command; arguments are constrained by argparse\.$' "$SUDOERS_FILE" || {
    echo "Existing sudoers file is not managed by this installer; refusing to overwrite it." >&2; exit 1;
  }
fi
if [[ -e /etc/sudoers.d/qqdeploy && "$SUDOERS_FILE" != /etc/sudoers.d/qqdeploy ]]; then
  echo "WARNING: legacy shared /etc/sudoers.d/qqdeploy is retained; audit its grants manually." >&2
fi
SUDOERS_TMP="$(mktemp "/etc/sudoers.d/.qqdeploy-${DEPLOY_USER}.XXXXXX")"
printf '# Managed qqdeploy command; arguments are constrained by argparse.\n%s ALL=(root) NOPASSWD: /usr/local/bin/qqdeploy\n' "$DEPLOY_USER" > "$SUDOERS_TMP"
chmod 440 "$SUDOERS_TMP"
chown root:root "$SUDOERS_TMP"
visudo -cf "$SUDOERS_TMP" >/dev/null
mv -f -- "$SUDOERS_TMP" "$SUDOERS_FILE"

README_TMP="$(mktemp "$DEPLOY_HOME/.README-部署.XXXXXX")"
install -m 644 -o root -g root "$SCRIPT_DIR/README-部署.md" "$README_TMP"
chown "$DEPLOY_USER:$PRIMARY_GROUP" "$README_TMP"
[[ ! -L "$README_TARGET" ]] || {
  echo "Deployment guide target became a symlink; refusing to replace it." >&2; exit 1;
}
mv -fT -- "$README_TMP" "$README_TARGET"
README_TMP=""
echo "Installed deployment guide at $README_TARGET"
echo "Installed qqdeploy, trusted checker/Dockerfile/template, and sudo command."
echo "Review any pre-existing docker group access separately; it was not changed."
