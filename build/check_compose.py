#!/usr/bin/env python3
"""docker-compose 结构与变量自检。

本地没装 docker 时 `docker compose config` 跑不了，这个脚本顶替它做两件事：

  1. 模拟变量插值 —— 把 .env.example 当 .env 用，扫出所有 `${VAR:?...}` 必需变量，
     逐个确认有非空值。缺任何一个，用户跑 `docker compose up -d` 都会在解析阶段直接失败。
  2. 检查 YAML 结构 —— 服务属性有没有跑到错误的层级（顶层 volumes 下面混进 ports 之类）、
     主文件里有没有混入可选服务（caddy）。

用法：
    python3 build/check_compose.py [仓库根目录]

依赖 pyyaml：pip install pyyaml
"""
import os
import re
import sys

try:
    import yaml
except ImportError:
    sys.exit("需要 pyyaml：pip install pyyaml")

VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([-?])([^}]*))?\}")

# compose 规范里的服务级属性（够用即可，出现不在表里的键基本就是层级写错了）
SERVICE_KEYS = {
    "build", "image", "container_name", "restart", "environment", "env_file",
    "ports", "expose", "volumes", "volumes_from", "depends_on", "profiles",
    "healthcheck", "command", "entrypoint", "user", "working_dir", "networks",
    "labels", "deploy", "logging", "cap_add", "cap_drop", "privileged",
    "read_only", "tmpfs", "ulimits", "sysctls", "stop_grace_period", "init",
    "dns", "extra_hosts", "hostname", "pid", "security_opt", "shm_size",
    "stdin_open", "tty", "platform", "pull_policy", "group_add", "configs",
    "secrets", "devices", "ipc", "links", "mac_address", "pids_limit",
    "stop_signal", "userns_mode", "external_links", "isolation", "cpus",
    "mem_limit", "scale", "runtime",
}

TOP_KEYS = {"name", "version", "services", "volumes", "networks", "configs", "secrets", "include"}

# 顶层 volumes 下的每个命名卷，只允许这些键
VOLUME_KEYS = {"driver", "driver_opts", "external", "name", "labels"}

errors = []
warnings = []


def load_env(path):
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def collect_vars(node, out):
    if isinstance(node, dict):
        for v in node.values():
            collect_vars(v, out)
    elif isinstance(node, list):
        for v in node:
            collect_vars(v, out)
    elif isinstance(node, str):
        for m in VAR_RE.finditer(node):
            out.append((m.group(1), m.group(2), (m.group(3) or "").strip()))


def check_structure(path, data, label):
    for k in data:
        if k in TOP_KEYS or k.startswith("x-"):
            continue
        errors.append(f"{label}: 顶层出现了未知键 `{k}`（会不会是缩进错了？）")

    services = data.get("services") or {}
    if not services:
        errors.append(f"{label}: 没有任何 services")

    for name, svc in services.items():
        if not isinstance(svc, dict):
            errors.append(f"{label}: services.{name} 不是映射（缩进大概错了）")
            continue
        for k in svc:
            if k not in SERVICE_KEYS and not k.startswith("x-"):
                errors.append(
                    f"{label}: services.{name}.{k} 不是合法的服务属性"
                    f"（常见于该键属于别的服务、或被上方段落挤到了错误层级）"
                )

    vols = data.get("volumes") or {}
    for name, v in vols.items():
        if v is None:
            continue
        if not isinstance(v, dict):
            errors.append(f"{label}: volumes.{name} 不是映射")
            continue
        for k in v:
            if k not in VOLUME_KEYS:
                errors.append(
                    f"{label}: volumes.{name}.{k} 不是合法的卷属性 —— "
                    f"`{k}` 看起来是服务属性，八成是缩进被破坏了（会连带丢掉该服务里排在它前面的配置）"
                )


def check_interpolation(path, data, env, label, strict=True):
    """strict=True 用于主文件：必需变量缺失就是错误。
    strict=False 用于可选的叠加文件（caddy 等）：缺失是预期行为，只提示。"""
    refs = []
    collect_vars(data, refs)
    missing, defaulted = [], []
    for name, op, arg in refs:
        if op == "?" and not env.get(name):
            missing.append((name, arg))
        elif op == "-" and not env.get(name):
            defaulted.append((name, arg))
    missing = list(dict.fromkeys(missing))
    defaulted = list(dict.fromkeys(defaulted))
    for name, msg in missing:
        detail = (
            f"必需变量 {name} 在 .env.example 里没有非空值 —— "
            f"用户跑 `docker compose up` 会直接失败：required variable {name} is missing a value: {msg}"
        )
        if strict:
            errors.append(f"{label}: {detail}")
        else:
            warnings.append(
                f"{label}: 可选文件里的必需变量 {name} 未赋值 —— 符合预期，"
                f"只有叠加使用这个文件时才需要设置（届时缺了会明确报错：{msg}）"
            )
    return sorted({n for n, _, _ in refs}), defaulted


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    main_file = os.path.join(root, "docker-compose.yml")
    caddy_file = os.path.join(root, "deploy", "docker-compose.caddy.yml")
    env = load_env(os.path.join(root, ".env.example"))

    if not os.path.exists(main_file):
        sys.exit(f"找不到 {main_file}")

    files = [f for f in (main_file, caddy_file) if os.path.exists(f)]
    loaded = {}
    for f in files:
        label = os.path.relpath(f, root).replace(os.sep, "/")
        try:
            with open(f, encoding="utf-8") as fh:
                data = yaml.safe_load(fh) or {}
        except yaml.YAMLError as e:
            errors.append(f"{label}: YAML 解析失败 —— {e}")
            continue
        loaded[f] = (label, data)
        check_structure(f, data, label)
        used, defaulted = check_interpolation(f, data, env, label, strict=(f == main_file))
        print(f"[{label}]")
        print(f"  services : {sorted((data.get('services') or {}).keys())}")
        print(f"  volumes  : {sorted((data.get('volumes') or {}).keys())}")
        print(f"  变量引用 : {used}")
        if defaulted:
            print(f"  走默认值 : {[f'{n}({d})' for n, d in defaulted]}")
        print()

    # 主文件里不该出现可选件
    main_label, main_data = loaded.get(main_file, (None, {}))
    main_text = open(main_file, encoding="utf-8").read()
    if main_label:
        extra = set((main_data.get("services") or {}).keys()) - {"api"}
        if extra:
            errors.append(f"{main_label}: 主文件里出现了可选服务 {sorted(extra)}，应当拆到独立文件")
        if "DOMAIN" in main_text:
            errors.append(f"{main_label}: 主文件引用了 DOMAIN（属于 Caddy 的变量，应当隔离）")
        api = (main_data.get("services") or {}).get("api") or {}
        for key in ("ports", "volumes", "environment"):
            if key not in api:
                errors.append(f"{main_label}: services.api 缺 `{key}`（缩进被破坏的典型症状）")

    print("=" * 60)
    for w in warnings:
        print(f"! {w}")
    if errors:
        for e in errors:
            print(f"x {e}")
        print(f"\n{len(errors)} 项不通过")
        sys.exit(1)
    print("全部通过 ✓")


if __name__ == "__main__":
    main()
