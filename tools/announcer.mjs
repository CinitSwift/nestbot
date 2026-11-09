#!/usr/bin/env node
// 进频道欢迎播报（Kook / KOOK 官方语音 API，零依赖）
//
// 用法:
//   node announcer.mjs                常驻监听，用户进入语音频道时播报欢迎
//   node announcer.mjs --test [文本]  仅播报一句测试语音后退出（--force 忽略音乐冲突）
//
// 配置（环境变量，均可选）:
//   KOOK_BOT_TOKEN        缺省从 ../Kyouka/.env 的 TOKEN 读取
//   ANNOUNCE_CHANNEL      监听的语音频道（默认 8287660696605705 = 游戏）
//   ANNOUNCE_GUILD        服务器 ID（默认 5931533130556375）
//   ANNOUNCE_TEMPLATE     播报模板（默认 "欢迎 {name} 进入频道"）
//   ANNOUNCE_VOICE        say 语音名（默认 Tingting）
//   ANNOUNCE_COOLDOWN_MS  同一用户冷却毫秒（默认 60000）
//   ANNOUNCE_MIN_GAP_MS   两次播报最小间隔毫秒（默认 8000）
//   ANNOUNCE_MODE         poll（默认，轮询成员列表）| gateway（WS 事件；同 token 二次连接会被服务端踢，不推荐）
//   ANNOUNCE_POLL_MS      轮询间隔毫秒（默认 3000）
//   FFMPEG                ffmpeg 路径（默认 /opt/homebrew/bin/ffmpeg）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(__dirname, '..', 'Kyouka', '.env');
const TMP_DIR = '/tmp/khl-announce';
const API = 'https://www.kookapp.cn/api/v3';
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';

function loadEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

const fileEnv = loadEnvFile(ENV_FILE);
const TOKEN = process.env.KOOK_BOT_TOKEN || fileEnv.TOKEN || '';
if (!TOKEN) {
  console.error('缺少 TOKEN：请设置 KOOK_BOT_TOKEN 或确保 ../Kyouka/.env 存在 TOKEN');
  process.exit(1);
}

const BOT_ID = process.env.ANNOUNCE_BOT_ID || '3735085547';
const GUILD = process.env.ANNOUNCE_GUILD || '5931533130556375';
const CHANNEL = process.env.ANNOUNCE_CHANNEL || '8287660696605705';
const TEMPLATE = process.env.ANNOUNCE_TEMPLATE || '欢迎 {name} 进入频道';
const VOICE = process.env.ANNOUNCE_VOICE || 'Tingting';
const COOLDOWN_MS = Number(process.env.ANNOUNCE_COOLDOWN_MS || 60000);
const MIN_GAP_MS = Number(process.env.ANNOUNCE_MIN_GAP_MS || 8000);
const RUNNER_PREFIX = (fileEnv.CONTAINER_NAME || 'kyouka-runner') + '-';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

async function api(pathname, { method = 'GET', form } = {}) {
  const opts = { method, headers: { Authorization: `Bot ${TOKEN}` } };
  if (form) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(form).toString();
  }
  const res = await fetch(API + pathname, opts);
  return res.json();
}

function musicActive() {
  try {
    const r = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) return false;
    return r.stdout.split('\n').some((n) => n.trim().startsWith(RUNNER_PREFIX));
  } catch {
    return false;
  }
}

async function fetchName(userId, author) {
  if (author && author.bot === false && (author.nickname || author.username)) {
    return author.nickname || author.username;
  }
  const hit = nameCache.get(userId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.bot ? null : hit.name;
  try {
    const r = await api(`/user/view?user_id=${userId}&guild_id=${GUILD}`);
    if (r.code === 0 && r.data) {
      const name = r.data.nickname || r.data.username || userId;
      nameCache.set(userId, { name, bot: !!r.data.bot, at: Date.now() });
      return r.data.bot ? null : name;
    }
  } catch {}
  return userId;
}
const nameCache = new Map();

async function voiceJoin() {
  let last = null;
  for (let i = 1; i <= 10; i++) {
    try {
      const r = await api('/voice/join', { method: 'POST', form: { channel_id: CHANNEL } });
      if (r.code === 0 && r.data && r.data.ip && r.data.port) return r.data;
      last = r;
    } catch (e) {
      last = { code: -1, message: e.message };
    }
    log(`join 失败(${i}/10): ${last.code} ${last.message || ''}`);
    await sleep(2000);
  }
  throw new Error('join 语音失败(已达最大重试)');
}

async function voiceLeave() {
  try {
    const r = await api('/voice/leave', { method: 'POST', form: { channel_id: CHANNEL } });
    log(`已 leave: code=${r.code}`);
  } catch (e) {
    log('leave 出错:', e.message);
  }
}

function tts(text) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const out = path.join(TMP_DIR, `welcome-${Date.now()}.aiff`);
  const cands = [...new Set([VOICE, 'Tingting', 'Meijia'].filter(Boolean))];
  for (const v of cands) {
    const r = spawnSync('say', ['-v', v, '-o', out, text], { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  }
  const r = spawnSync('say', ['-o', out, text], { encoding: 'utf8' });
  if (r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  throw new Error('say TTS 失败: ' + (r.stderr || 'unknown'));
}

function push(file, vs) {
  return new Promise((resolve, reject) => {
    const bps = Number(vs.bitrate) > 0 ? Number(vs.bitrate) : 48000;
    let kbps = Math.round(bps / 1000);
    if (kbps < 8) kbps = 48;
    const ssrc = vs.audio_ssrc || 1111;
    const pt = vs.audio_pt || 111;
    let url = `rtp://${vs.ip}:${vs.port}`;
    if (vs.rtcp_mux === false) url += `?rtcpport=${vs.rtcp_port}`;
    const tee = `[select=a:f=rtp:ssrc=${ssrc}:payload_type=${pt}]${url}`;
    const args = [
      '-hide_banner', '-loglevel', 'level+info', '-nostats', '-re',
      '-i', file,
      '-map', '0:a:0', '-acodec', 'libopus', '-b:a', `${kbps}k`,
      '-ar', '48000', '-ac', '2', '-filter:a', 'volume=0.8',
      '-f', 'tee', tee,
    ];
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    const killer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
    }, 60000);
    p.on('close', (c) => {
      clearTimeout(killer);
      c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}: ${err.slice(-500)}`));
    });
    p.on('error', (e) => {
      clearTimeout(killer);
      reject(e);
    });
  });
}

async function playAnnouncement(text) {
  const aiff = tts(text);
  let vs;
  try {
    vs = await voiceJoin();
  } catch (e) {
    log(e.message);
    try { fs.unlinkSync(aiff); } catch {}
    return false;
  }
  log(`已 join: ${vs.ip}:${vs.port} bitrate=${vs.bitrate} ssrc=${vs.audio_ssrc}`);
  const ka = setInterval(() => {
    api('/voice/keep-alive', { method: 'POST', form: { channel_id: CHANNEL } }).catch(() => {});
  }, 45000);
  let ok = true;
  try {
    await sleep(500);
    await push(aiff, vs);
    log('推流完成');
  } catch (e) {
    ok = false;
    log('推流失败:', e.message);
  }
  clearInterval(ka);
  try { fs.unlinkSync(aiff); } catch {}
  await sleep(300);
  if (musicActive()) {
    log('音乐播放中，保留语音会话（不 leave）');
  } else {
    await sleep(500);
    if (musicActive()) log('音乐播放中（二次确认），不 leave');
    else await voiceLeave();
  }
  return ok;
}

async function announce(userId, author) {
  if (musicActive()) {
    log('音乐播放中，跳过播报');
    return;
  }
  const name = await fetchName(userId, author);
  if (name === null) {
    log(`用户 ${userId} 是 bot，跳过`);
    return;
  }
  const text = TEMPLATE.replaceAll('{name}', name).slice(0, 120);
  log(`播报: ${text}`);
  await playAnnouncement(text);
}

const queue = [];
let draining = false;
let lastAnnounceAt = 0;
const userCooldown = new Map();

function enqueue(userId, author) {
  const now = Date.now();
  if (now - (userCooldown.get(userId) || 0) < COOLDOWN_MS) {
    log(`冷却中，忽略 ${userId}`);
    return;
  }
  userCooldown.set(userId, now);
  if (queue.length >= 10) {
    log('队列已满，丢弃');
    return;
  }
  queue.push({ userId, author });
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const { userId, author } = queue.shift();
    const wait = lastAnnounceAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastAnnounceAt = Date.now();
    try {
      await announce(userId, author);
    } catch (e) {
      log('播报异常:', e.message);
    }
    await sleep(2000);
  }
  draining = false;
}

let knownUsers = null;
let pollTimer = null;

async function channelUserList() {
  const r = await api(`/channel/user-list?channel_id=${CHANNEL}&guild_id=${GUILD}`);
  if (r.code !== 0 || !Array.isArray(r.data)) throw new Error('user-list 失败: ' + (r.message || r.code));
  return r.data;
}

async function pollTick() {
  try {
    const list = await channelUserList();
    const current = new Set(list.filter((u) => u && u.id && u.id !== BOT_ID && !u.bot).map((u) => u.id));
    if (knownUsers === null) {
      knownUsers = current;
      const names = list.map((u) => u.nickname || u.username || u.id).join(', ');
      log(`轮询就绪，当前频道内 ${current.size} 人${names ? ': ' + names : '(空)'}`);
      return;
    }
    const joined = [...current].filter((id) => !knownUsers.has(id));
    knownUsers = current;
    for (const id of joined) {
      const u = list.find((x) => x.id === id) || {};
      log(`用户 ${u.nickname || u.username || id} 进入频道`);
      enqueue(id, { nickname: u.nickname, username: u.username, bot: false });
    }
  } catch (e) {
    log('轮询失败:', e.message);
  }
}

function startPolling() {
  const interval = Number(process.env.ANNOUNCE_POLL_MS || 3000);
  pollTick();
  pollTimer = setInterval(pollTick, interval);
  log(`轮询模式启动（间隔 ${interval}ms）`);
}

let ws = null;
let hbTimer = null;
let sn = 1;
let lastMsgAt = 0;
let stopping = false;

async function gatewayUrl() {
  const r = await api('/gateway/index?compress=0');
  if (r.code !== 0 || !r.data || !r.data.url) throw new Error('获取网关地址失败: ' + (r.message || r.code));
  return r.data.url;
}

async function connectGateway() {
  if (stopping) return;
  try {
    const url = await gatewayUrl();
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      log('网关已连接');
      sn = 1;
      lastMsgAt = Date.now();
    });
    ws.addEventListener('message', (ev) => onMessage(String(ev.data)));
    ws.addEventListener('close', () => {
      log('网关断开，5 秒后重连');
      if (hbTimer) clearInterval(hbTimer), (hbTimer = null);
      ws = null;
      if (!stopping) setTimeout(connectGateway, 5000);
    });
    ws.addEventListener('error', () => {});
  } catch (e) {
    log('网关连接失败:', e.message);
    if (!stopping) setTimeout(connectGateway, 5000);
  }
}

function onMessage(raw) {
  lastMsgAt = Date.now();
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.s === 1) {
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = setInterval(() => {
      if (Date.now() - lastMsgAt > 90000) {
        log('心跳超时，重连');
        try { ws.close(); } catch {}
        return;
      }
      try { ws.send(JSON.stringify({ s: 2, sn: sn++ })); } catch {}
    }, 30000);
  } else if (m.s === 0 && m.d) {
    const d = m.d;
    const extra = d.extra || {};
    if (d.type === 255 && extra.type === 'joined_channel') {
      const body = extra.body || {};
      const userId = body.user_id;
      if (body.channel_id !== CHANNEL) return;
      if (!userId || userId === BOT_ID) return;
      const author = extra.author || {};
      if (author.bot) return;
      log(`用户 ${author.nickname || author.username || userId} 进入频道`);
      enqueue(userId, author);
    }
  } else if (m.s === 5) {
    log('服务端要求重连');
    try { ws.close(); } catch {}
  }
}

function shutdown() {
  stopping = true;
  log('退出中');
  if (hbTimer) clearInterval(hbTimer);
  if (pollTimer) clearInterval(pollTimer);
  try { ws && ws.close(); } catch {}
  process.exit(0);
}

async function testMode(text, force) {
  log('测试模式');
  try {
    const v = await api('/voice/list');
    log('当前语音会话:', JSON.stringify(v.data ?? v));
  } catch (e) {
    log('voice/list 查询失败:', e.message);
  }
  if (musicActive() && !force) {
    log('检测到音乐 runner 正在运行，测试中止（--force 强制）');
    process.exit(1);
  }
  const ok = await playAnnouncement(text);
  process.exit(ok ? 0 : 1);
}

function cleanupTmp() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, f);
      try {
        if (now - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const args = process.argv.slice(2);
if (args[0] === '--probe') {
  try {
    log('当前频道用户:', JSON.stringify(await channelUserList()));
    process.exit(0);
  } catch (e) {
    log('查询失败:', e.message);
    process.exit(1);
  }
} else if (args[0] === '--test') {
  const force = args.includes('--force');
  const text = args.find((a, i) => i > 0 && !a.startsWith('--')) || '欢迎测试，一二三';
  await testMode(text, force);
} else {
  cleanupTmp();
  log(`启动: 频道=${CHANNEL} 模板="${TEMPLATE}" 语音=${VOICE} 冷却=${COOLDOWN_MS}ms 最小间隔=${MIN_GAP_MS}ms 模式=${process.env.ANNOUNCE_MODE || 'poll'}`);
  if ((process.env.ANNOUNCE_MODE || 'poll') === 'gateway') await connectGateway();
  else startPolling();
}
