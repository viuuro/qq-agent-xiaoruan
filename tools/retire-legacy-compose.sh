#!/usr/bin/env bash
# Safely retire legacy Compose files after the qqdeploy/data migration is proven.
set -euo pipefail
umask 077

if [[ "${QQ_OPS_TEST_MODE:-0}" == "1" ]]; then
  ROOT="${QQ_ROOT:?QQ_ROOT is required in test mode}"
  DOCKER_BIN="${DOCKER_BIN:?DOCKER_BIN is required in test mode}"
else
  ROOT="/opt/qq"
  DOCKER_BIN="docker"
fi

die() {
  echo "❌ $*" >&2
  exit 1
}

[[ -d "$ROOT" ]] || die "目录不存在：$ROOT"
cd "$ROOT"

# 使用 qqdeploy 同一把锁，避免部署和退役在预检/改名期间交错。
command -v flock >/dev/null 2>&1 || die "缺少 flock，拒绝无锁退役"
exec 9>"$ROOT/.deploy.lock"
if ! flock -n 9; then
  die "另一个 qqdeploy/退役操作正在运行；等待结束后重试"
fi

echo "===== 0. 只读确认 qqdeploy B 阶段 ====="

# B 阶段需要有一致的 qqdeploy 部署记录、current 软链、运行中的新式容器挂载，
# 且 data/config.json 有真实内容。仅有空目录不构成迁移成功。
B_CHECK="$(cat <<'PY'
import json
import os
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
def fail(message):
    print("❌ " + message, file=sys.stderr)
    raise SystemExit(1)

state_path = root / ".deployed.json"
try:
    state = json.loads(state_path.read_text(encoding="utf-8"))
except Exception:
    fail("缺少或无法读取 .deployed.json；未确认 qqdeploy 已完成 B 阶段")

current = state.get("current")
if not isinstance(current, dict):
    fail(".deployed.json 没有 current 部署记录")
sha = current.get("sha")
release = current.get("dir")
if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{7,40}", sha):
    fail(".deployed.json current.sha 无效")
if not isinstance(release, str):
    fail(".deployed.json current.dir 无效")
release_candidate = Path(release)
expected_candidate = root / "releases" / sha[:12]
if not release_candidate.is_absolute() or os.path.normpath(str(release_candidate)) != os.path.normpath(str(expected_candidate)):
    fail("current.dir 不符合 qqdeploy 的 releases/<sha前12位> 布局")
if expected_candidate.is_symlink() or not expected_candidate.is_dir():
    fail("部署 release 目录不存在或是符号链接")
current_link = root / "current"
if not current_link.is_symlink():
    fail("current 不是 qqdeploy 管理的软链")
try:
    release_path = expected_candidate.resolve(strict=True)
    current_path = current_link.resolve(strict=True)
except OSError:
    fail("current release 或 current 软链目标不存在")
if current_path != release_path:
    fail("current 软链与 .deployed.json release 不一致")
if not (release_path / "app" / "src" / "app.js").is_file():
    fail("current release 缺少 app/src/app.js")

try:
    inspected = json.load(sys.stdin)
    container = inspected[0]
except Exception:
    fail("无法解析 docker inspect qq-agent")
if not container.get("State", {}).get("Running"):
    fail("qq-agent 当前未运行")
labels = container.get("Config", {}).get("Labels") or {}
if labels.get("com.docker.compose.service") != "qq-agent":
    fail("qq-agent 容器缺少预期的 Compose 服务标签")
if not labels.get("com.docker.compose.project"):
    fail("qq-agent 容器缺少 Compose 项目标记")
if container.get("Config", {}).get("Image") != "qq-agent:local":
    fail("qq-agent 容器不是 qqdeploy 使用的 qq-agent:local 镜像")
mounts = {m.get("Destination"): m.get("Source") for m in container.get("Mounts", [])}
for target, dirname in (("/app/data", "qq-agent-data"),
                        ("/app/plugins", "qq-agent-plugins")):
    source = mounts.get(target)
    expected = str(root / dirname)
    if not source or os.path.realpath(source) != os.path.realpath(expected):
        fail("%s 未挂载到预期路径 %s" % (target, expected))
    if not Path(source).is_dir():
        fail("数据挂载源不存在：%s" % source)

data_config = root / "qq-agent-data" / "config.json"
try:
    if not data_config.is_file() or data_config.stat().st_size == 0:
        fail("qq-agent-data/config.json 不存在或为空；不能把空目录当作迁移成功")
except OSError:
    fail("无法检查 qq-agent-data/config.json")

print("✅ 部署记录、current、运行容器及数据挂载均与 B 阶段一致")
PY
)"
if ! "$DOCKER_BIN" inspect qq-agent 2>/dev/null | python3 -c "$B_CHECK" "$ROOT"; then
  cat >&2 <<'STEPS'

没有停止容器，也没有改动 Compose 或数据。退役已中止。请先人工完成并核对：
  1. 备份当前机器人实际挂载的数据、插件目录和 NapCat 登录态，保留属主及权限；
  2. 对照 docker inspect 的实际 Source/Target，将旧 data/plugins 迁移到
     /opt/qq/qq-agent-data 与 /opt/qq/qq-agent-plugins；不要以空目录作为完成依据；
  3. 安排维护窗口后切换部署，确认 /opt/qq/current 与 .deployed.json 一致，
     且 qq-agent 的 /app/data、/app/plugins 挂载正确；
  4. 验证 data/config.json、插件和应用状态后，再重新运行本脚本。
STEPS
  exit 1
fi

echo
echo "===== 1. 检查旧文件归档目标 ====="
for f in docker-compose.yml docker-compose.platform.yml; do
  if [[ ( -e "$f" || -L "$f" ) && ( -e "$f.legacy" || -L "$f.legacy" ) ]]; then
    die "$f 与唯一归档 $f.legacy 同时存在；拒绝覆盖。请人工核对并保留两份内容"
  fi
done

# 不打印完整 inspect JSON：其中含容器环境变量。只提取生成 compose 所需的运行设置。
COMPOSE_GENERATOR="$(cat <<'PY'
import json
import os
import re
import sys

root = os.path.abspath(sys.argv[1])
def fail(message):
    print("NapCat 配置检查失败：" + message, file=sys.stderr)
    raise SystemExit(1)
def q(value):
    return json.dumps(value, ensure_ascii=False)

try:
    inspected = json.load(sys.stdin)
    container = inspected[0]
except Exception:
    fail("无法解析 docker inspect napcat")
if container.get("Name", "").lstrip("/") != "napcat":
    fail("inspect 返回的容器不是 napcat")
if not container.get("State", {}).get("Running"):
    fail("NapCat 当前未运行，拒绝按猜测配置退役")
config = container.get("Config") or {}
host = container.get("HostConfig") or {}
env = {}
for item in config.get("Env") or []:
    key, sep, value = item.partition("=")
    if sep:
        env[key] = value

def numeric_env(key):
    value = env.get(key, "")
    if not value:
        return "1000"
    if not re.fullmatch(r"[0-9]+", value):
        fail("%s 不是数字，拒绝生成配置" % key)
    return value

image = config.get("Image")
if not isinstance(image, str) or not image:
    fail("运行容器未报告镜像名")
mounts = container.get("Mounts") or []
required_targets = {"/app/napcat/config", "/app/.config/QQ"}
found_targets = set()
volume_defs = {}
volume_items = []
for index, mount in enumerate(mounts):
    kind = mount.get("Type")
    destination = mount.get("Destination")
    if not destination:
        fail("存在没有 Destination 的挂载")
    found_targets.add(destination)
    entry = {"target": destination}
    if kind == "bind":
        source = mount.get("Source")
        if not source or not os.path.isabs(source) or not os.path.exists(source):
            fail("bind 挂载源不存在或不是绝对路径：" + str(source))
        entry.update({"type": "bind", "source": source})
    elif kind == "volume":
        name = mount.get("Name")
        if not name:
            fail("named volume 缺少名称")
        source_key = "napcat_volume_%d" % index
        volume_defs[source_key] = name
        entry.update({"type": "volume", "source": source_key})
    else:
        fail("无法安全保留挂载类型 %r" % kind)
    if mount.get("RW") is False:
        entry["read_only"] = True
    volume_items.append(entry)
missing = required_targets - found_targets
if missing:
    fail("运行容器缺少关键登录态/配置挂载：" + ", ".join(sorted(missing)))

network_state = (container.get("NetworkSettings") or {}).get("Networks") or {}
if not network_state:
    fail("运行容器没有可保留的 Docker network")
network_defs = {}
service_networks = {}
for index, (name, details) in enumerate(sorted(network_state.items())):
    network_key = "napcat_net_%d" % index
    network_defs[network_key] = {"external": True, "name": name}
    aliases = details.get("Aliases") or []
    item = {}
    if aliases:
        item["aliases"] = list(dict.fromkeys(a for a in aliases if a))
    service_networks[network_key] = item

ports = []
for binding_key, bindings in ((container.get("NetworkSettings") or {}).get("Ports") or {}).items():
    if not bindings:
        continue
    target_text, _, protocol = binding_key.partition("/")
    if not target_text.isdigit():
        fail("无法解析容器端口：" + binding_key)
    for binding in bindings:
        published = binding.get("HostPort", "")
        if not str(published).isdigit():
            fail("无法解析已发布端口：" + str(published))
        item = {"target": int(target_text), "published": str(published),
                "protocol": protocol or "tcp"}
        host_ip = binding.get("HostIp")
        if host_ip:
            item["host_ip"] = host_ip
        ports.append(item)

restart = ((host.get("RestartPolicy") or {}).get("Name") or "always")
shm_size = host.get("ShmSize")
if not isinstance(shm_size, int) or shm_size <= 0:
    fail("无法读取有效的 shm_size")
lines = [
    "services:",
    "  napcat:",
    "    image: " + q(image),
    "    container_name: napcat",
    "    restart: " + q(restart),
    "    shm_size: " + str(shm_size),
    "    environment:",
    "      NAPCAT_UID: " + q(numeric_env("NAPCAT_UID")),
    "      NAPCAT_GID: " + q(numeric_env("NAPCAT_GID")),
    '      WEBUI_TOKEN: "${WEBUI_TOKEN:?需要在 .env 中设置 WEBUI_TOKEN}"',
    '      ACCOUNT: "${QQ_ACCOUNT:-}"',
    "      TZ: " + q(env.get("TZ") or "Asia/Shanghai"),
]
if ports:
    lines.append("    ports:")
    for port in ports:
        lines.extend([
            "      - target: " + str(port["target"]),
            "        published: " + q(port["published"]),
            "        protocol: " + q(port["protocol"]),
        ])
        if "host_ip" in port:
            lines.append("        host_ip: " + q(port["host_ip"]))
if volume_items:
    lines.append("    volumes:")
    for item in volume_items:
        lines.append("      - type: " + q(item["type"]))
        lines.append("        source: " + q(item["source"]))
        lines.append("        target: " + q(item["target"]))
        if item.get("read_only"):
            lines.append("        read_only: true")
lines.append("    networks:")
for key, item in service_networks.items():
    lines.append("      " + key + ":")
    if item.get("aliases"):
        lines.append("        aliases:")
        lines.extend("          - " + q(alias) for alias in item["aliases"])
lines.append("networks:")
for key, value in network_defs.items():
    lines.extend([
        "  " + key + ":",
        "    external: true",
        "    name: " + q(value["name"]),
    ])
if volume_defs:
    lines.append("volumes:")
    for key, name in volume_defs.items():
        lines.extend([
            "  " + key + ":",
            "    external: true",
            "    name: " + q(name),
        ])
sys.stdout.write("\n".join(lines) + "\n")
PY
)"

echo
echo "===== 2. 读取 NapCat 实际挂载、网络、UID/GID 并生成临时配置 ====="
if ! napcat_json="$("$DOCKER_BIN" inspect napcat 2>/dev/null)"; then
  die "无法 inspect napcat；没有更改文件"
fi
tmp_file="$(mktemp "$ROOT/.docker-compose.napcat.yml.tmp.XXXXXX")"
new_file="$ROOT/docker-compose.napcat.yml"
backup_file=""
final_change="none"
moved=()

rollback_changes() {
  local status=$?
  if (( status != 0 )); then
    for pair in "${moved[@]:-}"; do
      local original="${pair%%|*}"
      local archived="${pair#*|}"
      if [[ ( -e "$archived" || -L "$archived" ) && ! ( -e "$original" || -L "$original" ) ]]; then
        mv -- "$archived" "$original" || echo "⚠️ 请人工恢复 $archived → $original" >&2
      fi
    done
    if [[ "$final_change" == "new" ]]; then
      rm -f -- "$new_file"
    elif [[ "$final_change" == "replaced" && -n "$backup_file" && -f "$backup_file" ]]; then
      local restore_tmp
      restore_tmp="$(mktemp "$ROOT/.docker-compose.napcat.restore.XXXXXX")"
      cp -p -- "$backup_file" "$restore_tmp" && mv -f -- "$restore_tmp" "$new_file" \
        || echo "⚠️ 请人工用 $backup_file 恢复 $new_file" >&2
    fi
  fi
  [[ -z "${tmp_file:-}" || ! -e "$tmp_file" ]] || rm -f -- "$tmp_file"
  exit "$status"
}
trap rollback_changes EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s' "$napcat_json" | python3 -c "$COMPOSE_GENERATOR" "$ROOT" > "$tmp_file"
unset napcat_json
chmod 600 "$tmp_file"

echo
echo "===== 3. 校验临时 compose（只解析，不创建/重启容器）====="
if [[ ! -f "$ROOT/.env" ]]; then
  die "$ROOT/.env 不存在；请先按备份/迁移步骤完成 B 阶段并配置 WEBUI_TOKEN"
fi
if ! "$DOCKER_BIN" compose --env-file "$ROOT/.env" -f "$tmp_file" config --quiet >/dev/null 2>&1; then
  die "临时 Compose 校验失败（检查 .env 中 WEBUI_TOKEN 和生成配置）；旧配置未退役"
fi

if [[ -e "$new_file" || -L "$new_file" ]]; then
  if cmp -s -- "$tmp_file" "$new_file"; then
    rm -f -- "$tmp_file"
    tmp_file=""
    echo "  已有 NapCat compose 与运行配置一致，保留原文件"
  else
    backup_file="$(mktemp "$ROOT/docker-compose.napcat.yml.bak.XXXXXX")"
    cp -p -- "$new_file" "$backup_file"
    final_change="replaced"
    mv -f -- "$tmp_file" "$new_file"
    tmp_file=""
    echo "  已备份旧 NapCat compose：$backup_file"
    echo "  已原子替换为从运行容器生成并校验的配置"
  fi
else
  final_change="new"
  mv -- "$tmp_file" "$new_file"
  tmp_file=""
  echo "  已原子安装校验后的 NapCat compose"
fi

echo
echo "===== 4. 唯一归档旧 compose（不停止容器）====="
for f in docker-compose.yml docker-compose.platform.yml; do
  if [[ -e "$f" || -L "$f" ]]; then
    # 目标在前置检查中确认不存在；mv 同目录原子改名。
    moved+=("$f|$f.legacy")
    mv -- "$f" "$f.legacy"
    echo "  ✅ $f → $f.legacy"
  elif [[ -e "$f.legacy" || -L "$f.legacy" ]]; then
    echo "  已归档，跳过：$f.legacy"
  else
    echo "  不存在，跳过：$f"
  fi
done

# 归档警告不修改原文件内容，避免覆盖历史手工内容。
echo
echo "完成。容器未停止或重建；确认新入口："
echo "  docker compose --env-file $ROOT/.env -f $new_file config --quiet"
echo "  docker compose --env-file $ROOT/.env -f $new_file up -d"
