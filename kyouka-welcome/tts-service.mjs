#!/usr/bin/env node
// 欢迎播报 TTS 微服务（主机侧，供 Kyouka 容器内的 welcome 模块调用）
//
// 用法: nohup node tts-service.mjs > tts-service.out 2>&1 &
// 环境变量: TTS_PORT（默认 8799）TTS_VOICE（默认 Tingting）TTS_LEAD_SILENCE（前导静音秒数，默认 4）
//
// 接口:
//   GET /tts?text=欢迎xx进入频道  -> {"url":"http://host.docker.internal:8799/files/xxx.aiff"}
//   GET /files/<name>            -> 音频文件（容器经 host.docker.internal 拉取）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { URL } from 'node:url';

const PORT = Number(process.env.TTS_PORT || 8799);
const VOICE = process.env.TTS_VOICE || 'Tingting';
const TMP_DIR = '/tmp/khl-announce';
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const LEAD_SILENCE_S = Number(process.env.TTS_LEAD_SILENCE || 4);

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function tts(text) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const raw = path.join(TMP_DIR, `welcome-${stamp}-raw.aiff`);
  let made = false;
  const cands = [...new Set([VOICE, 'Tingting', 'Meijia'].filter(Boolean))];
  for (const v of cands) {
    const r = spawnSync('say', ['-v', v, '-o', raw, text], { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(raw) && fs.statSync(raw).size > 0) {
      made = true;
      break;
    }
  }
  if (!made) {
    const r = spawnSync('say', ['-o', raw, text], { encoding: 'utf8' });
    made = r.status === 0 && fs.existsSync(raw) && fs.statSync(raw).size > 0;
  }
  if (!made) throw new Error('say TTS failed');
  const out = path.join(TMP_DIR, `welcome-${stamp}.aiff`);
  const args = [
    '-y',
    '-f', 'lavfi', '-t', String(LEAD_SILENCE_S), '-i', 'anullsrc=r=22050:cl=mono',
    '-i', raw,
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]',
    '-map', '[out]', '-c:a', 'pcm_s16be', out,
  ];
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  try { fs.unlinkSync(raw); } catch {}
  if (r.status !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) {
    throw new Error('prepend silence failed: ' + (r.stderr || '').slice(-300));
  }
  return out;
}

function cleanup() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, f);
      try {
        if (now - fs.statSync(p).mtimeMs > 3600 * 1000) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname === '/tts') {
    const text = (u.searchParams.get('text') || '').slice(0, 200);
    if (!text) {
      res.writeHead(400);
      res.end('missing text');
      return;
    }
    try {
      const file = tts(text);
      const name = path.basename(file);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: `http://host.docker.internal:${PORT}/files/${name}` }));
      log('tts ok:', text);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
      log('tts failed:', e.message);
    }
  } else if (u.pathname.startsWith('/files/')) {
    const base = path.basename(decodeURIComponent(u.pathname.slice('/files/'.length)));
    const file = path.join(TMP_DIR, base);
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'audio/aiff' });
      fs.createReadStream(file).pipe(res);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(PORT, '0.0.0.0', () => log(`TTS service on 0.0.0.0:${PORT} voice=${VOICE}`));
setInterval(cleanup, 3600 * 1000);
