"""欢迎播报模块（合并进 Kyouka 的补丁）

- 监听 JOINED_CHANNEL 系统事件，命中 WELCOME_CHANNELS 的用户进频道时进入欢迎队列
- 播放由 update_played_time_and_change_music 的 5 秒心跳驱动：空闲立即播；放歌时在歌曲间隙插入
- TTS 由主机侧 tts-service.mjs 生成：GET {WELCOME_TTS_BASE}/tts?text=... -> {"url": ...}
- 播放复用 shuyangzhang/khl-voice 容器（SOURCE=URL），播完自动退出

可选环境变量（不设置则用默认值）：
  WELCOME_CHANNELS    逗号分隔频道 id（默认 游戏+音乐）
  WELCOME_TEMPLATE    播报模板（默认 欢迎 {name} 进入频道）
  WELCOME_TTS_BASE    主机 TTS 服务地址（默认 http://host.docker.internal:8799）
  WELCOME_GUILD       服务器 id（用于查昵称，默认本服务器）
  WELCOME_COOLDOWN_MS 同一用户冷却（默认 60000）
  WELCOME_MAX_AGE_MS  排队过期（默认 600000）
  WELCOME_MAX_QUEUE   队列上限（默认 5）
"""
import asyncio
import os
import time
import uuid
from urllib.parse import quote

import aiohttp
import aiodocker
from loguru import logger
from khl import Event, EventTypes

from app.bot import bot
from app.config.common import settings


def _env_list(name: str, default: list) -> list:
    value = os.environ.get(name, "").strip()
    if not value:
        return default
    return [item.strip() for item in value.split(",") if item.strip()]


WELCOME_CHANNELS = _env_list("WELCOME_CHANNELS", ["8287660696605705", "2764745485432716"])
WELCOME_TEMPLATE = os.environ.get("WELCOME_TEMPLATE", "欢迎 {name} 进入频道")
WELCOME_TTS_BASE = os.environ.get("WELCOME_TTS_BASE", "http://host.docker.internal:8799")
WELCOME_GUILD = os.environ.get("WELCOME_GUILD", "5931533130556375")
WELCOME_COOLDOWN_MS = int(os.environ.get("WELCOME_COOLDOWN_MS", "60000"))
WELCOME_MAX_AGE_MS = int(os.environ.get("WELCOME_MAX_AGE_MS", "600000"))
WELCOME_MAX_QUEUE = int(os.environ.get("WELCOME_MAX_QUEUE", "5"))

IMAGE_NAME = "shuyangzhang/khl-voice"
CONTAINER_PREFIX = f"{settings.container_name}-welcome-"


class WelcomeManager:
    def __init__(self):
        self.client = aiodocker.Docker()
        self.pending = []
        self.cooldown = {}
        self.name_cache = {}
        self._bot_id = None

    async def bot_id(self):
        if self._bot_id is None:
            me = await bot.client.fetch_me()
            self._bot_id = me.id
        return self._bot_id

    async def fetch_name(self, user_id: str) -> str:
        cached = self.name_cache.get(user_id)
        if cached and time.time() * 1000 - cached[1] < 3600 * 1000:
            return cached[0]
        try:
            url = f"https://www.kookapp.cn/api/v3/user/view?user_id={user_id}&guild_id={WELCOME_GUILD}"
            headers = {"Authorization": f"Bot {settings.token}"}
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    data = (await resp.json()).get("data") or {}
            name = data.get("nickname") or data.get("username") or user_id
            self.name_cache[user_id] = (name, time.time() * 1000)
            return name
        except Exception as e:
            logger.warning(f"welcome: fetch_name failed for {user_id}: {e}")
            return user_id

    async def on_joined_channel(self, event: Event):
        try:
            body = event.body or {}
            channel_id = str(body.get("channel_id") or "")
            user_id = str(body.get("user_id") or getattr(event, "author_id", "") or "")
            if channel_id not in WELCOME_CHANNELS or not user_id:
                return
            if user_id == await self.bot_id():
                return
            author = (event.extra or {}).get("author") or {}
            if author.get("bot"):
                return
            now = time.time() * 1000
            if now - self.cooldown.get(user_id, 0) < WELCOME_COOLDOWN_MS:
                return
            self.cooldown[user_id] = now
            name = author.get("nickname") or author.get("username") or await self.fetch_name(user_id)
            if len(self.pending) >= WELCOME_MAX_QUEUE:
                logger.info(f"welcome: queue full, drop {name}")
                return
            self.pending.append({"name": name, "channel_id": channel_id, "ts": now})
            logger.info(f"welcome: {name} joined {channel_id}, queued ({len(self.pending)} pending)")
        except Exception as e:
            logger.error(f"welcome: on_joined_channel error: {e}")

    def has_pending(self) -> bool:
        now = time.time() * 1000
        self.pending = [item for item in self.pending if now - item["ts"] < WELCOME_MAX_AGE_MS]
        return bool(self.pending)

    async def play_pending(self):
        while self.pending:
            item = self.pending.pop(0)
            await self._play(item)

    async def _play(self, item):
        text = WELCOME_TEMPLATE.format(name=item["name"])
        try:
            async with aiohttp.ClientSession() as session:
                url = f"{WELCOME_TTS_BASE}/tts?text={quote(text)}"
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=20)) as resp:
                    tts_url = (await resp.json()).get("url")
            if not tts_url:
                logger.warning(f'welcome: tts returned no url for "{text}"')
                return
            logger.info(f'welcome: playing "{text}"')
            await self._run_container(tts_url, item["channel_id"])
            logger.info(f'welcome: played "{text}"')
        except Exception as e:
            logger.error(f'welcome: play failed ("{text}"): {e}')

    async def _run_container(self, source: str, channel_id: str):
        name = f"{CONTAINER_PREFIX}{str(uuid.uuid4())[:8]}"
        env_list = [f"TOKEN={settings.token}", f"CHANNEL={channel_id}", f"SOURCE={source}", "REPEAT=false"]
        config = {
            "Image": IMAGE_NAME,
            "AttachStdin": False,
            "AttachStdout": False,
            "AttachStderr": False,
            "Tty": True,
            "OpenStdin": False,
            "HostConfig": {"AutoRemove": False},
            "Env": env_list,
        }
        container = await self.client.containers.run(config=config, name=name)
        try:
            result = await asyncio.wait_for(container.wait(), timeout=60)
            rc = (result or {}).get("StatusCode")
            logger.info(f"welcome: container {name} exited rc={rc}")
            try:
                logs = await container.log(stdout=True, stderr=True)
                tail = [line for line in "".join(logs).splitlines() if line.strip()][-8:]
                logger.info("welcome: runner log tail:\n" + "\n".join(tail))
            except Exception as e:
                logger.warning(f"welcome: read runner logs failed: {e}")
        except asyncio.TimeoutError:
            logger.warning(f"welcome: container {name} timeout, stopping")
            try:
                await container.stop()
            except Exception:
                pass
        finally:
            try:
                await container.delete(force=True)
            except Exception:
                pass

    async def cleanup_leaked(self):
        try:
            leaked = []
            for container in await self.client.containers.list(all=True):
                cname = container._container.get("Names", [""])[0][1:]
                if cname.startswith(CONTAINER_PREFIX):
                    leaked.append(cname)
            for cname in leaked:
                try:
                    container = await self.client.containers.get(cname)
                    await container.stop()
                    await container.delete(force=True)
                except Exception:
                    pass
            if leaked:
                logger.info(f"welcome: cleaned leaked containers: {leaked}")
        except Exception as e:
            logger.error(f"welcome: cleanup_leaked error: {e}")


welcome_manager = WelcomeManager()


@bot.on_event(EventTypes.JOINED_CHANNEL)
async def _welcome_on_joined_channel(_bot, event: Event):
    await welcome_manager.on_joined_channel(event)
