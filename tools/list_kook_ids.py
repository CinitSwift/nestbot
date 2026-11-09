#!/usr/bin/env python3
"""列出 KOOK 机器人可见的服务器、语音频道和成员 ID。

用法：
  1. 把 bot token 填进 Kyouka/.env 的 TOKEN 字段
  2. python3 list_kook_ids.py

脚本只读取 TOKEN，不会打印 token 本身。
"""

import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://www.kookapp.cn/api/v3"
HERE = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.environ.get("KYOUKA_ENV", os.path.join(HERE, "Kyouka", ".env"))


def ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    for path in (os.environ.get("SSL_CERT_FILE"), "/etc/ssl/cert.pem", "/usr/local/etc/openssl/cert.pem"):
        if path and os.path.isfile(path):
            try:
                return ssl.create_default_context(cafile=path)
            except Exception:
                continue
    return ssl.create_default_context()


def load_env(path):
    values = {}
    if not os.path.isfile(path):
        sys.exit(f"找不到 {path}，请先从 .env.template 复制并填好 TOKEN")
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def call(token, path, params=None):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bot {token}", "User-Agent": "kyouka-id-helper"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20, context=ssl_context()) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as error:
        sys.exit(f"HTTP {error.code}: {error.read().decode('utf-8', 'replace')[:300]}")
    except Exception as error:
        sys.exit(f"请求失败：{error}")
    if payload.get("code") != 0:
        sys.exit(f"API 错误：{payload}")
    return payload.get("data", {})


def main():
    env = load_env(ENV_PATH)
    token = env.get("TOKEN", "")
    if not token:
        sys.exit(f"{ENV_PATH} 里没有 TOKEN")

    me = call(token, "/user/me")
    print(f"机器人：{me.get('username')}  用户ID={me.get('id')}\n")

    guilds = call(token, "/guild/list", {"page": 1, "page_size": 50}).get("items", [])
    if not guilds:
        print("机器人不在任何服务器。先在开发者后台生成邀请链接并邀请它。")
        return

    for guild in guilds:
        gid = guild.get("id")
        print(f"服务器：{guild.get('name')}  ID={gid}")
        channels = call(token, "/channel/list", {"guild_id": gid, "page_size": 100}).get("items", [])
        voice = [c for c in channels if c.get("type") == 2]
        if voice:
            print("  语音频道（可填入 CHANNEL）：")
            for channel in voice:
                print(f"    {channel.get('name')}  ID={channel.get('id')}")
        else:
            print("  没有可见语音频道")
        try:
            users = call(token, "/guild/user-list", {"guild_id": gid, "page_size": 100}).get("items", [])
            print("  成员（ADMIN_USERS 用这里的 ID）：")
            for user in users[:30]:
                print(f"    {user.get('nickname') or user.get('username')}  ID={user.get('id')}")
        except SystemExit as error:
            print(f"  成员列表读取失败：{error}")
        print()

    print(f"把语音频道 ID 填到 {ENV_PATH} 的 CHANNEL，把管理员 ID 填到 ADMIN_USERS。")


if __name__ == "__main__":
    main()
