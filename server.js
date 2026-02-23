require('dotenv').config();

const express = require('express');
const axios = require('axios');
const kuromoji = require('kuromoji');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

// ---- yt-dlp パス検索 ----
function findYtDlp() {
  try {
    return execSync('which yt-dlp 2>/dev/null || command -v yt-dlp 2>/dev/null').toString().trim();
  } catch {}
  const candidates = [
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    path.join(os.homedir(), '.local/bin/yt-dlp'),
    path.join(os.homedir(), 'Library/Python/3.12/bin/yt-dlp'),
    path.join(os.homedir(), 'Library/Python/3.11/bin/yt-dlp'),
    path.join(os.homedir(), 'Library/Python/3.10/bin/yt-dlp'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'yt-dlp';
}
const YT_DLP = findYtDlp();
console.log(`[OK] yt-dlp: ${YT_DLP}`);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- メモリキャッシュ (10分TTL、YouTube字幕用) ----
const cache = new Map();
function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) { cache.delete(key); return null; }
  return item.data;
}
function cacheSet(key, data, ttlMs = 600_000) {
  cache.set(key, { data, expiry: Date.now() + ttlMs });
}

// ---- 永続キャッシュ (ファイル保存、Whisper文字起こし用) ----
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

function persistentGet(videoId) {
  const filePath = path.join(CACHE_DIR, `${videoId}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function persistentSet(videoId, data) {
  const filePath = path.join(CACHE_DIR, `${videoId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
}

// ---- kuromoji 初期化 ----
let tokenizer = null;

function initTokenizer() {
  return new Promise((resolve, reject) => {
    kuromoji
      .builder({ dicPath: path.join(__dirname, 'node_modules/kuromoji/dict') })
      .build((err, built) => {
        if (err) reject(err);
        else resolve(built);
      });
  });
}

// ---- 文字変換ユーティリティ ----
function kataToHira(str) {
  return str.replace(/[\u30A1-\u30F6]/g, c =>
    String.fromCharCode(c.charCodeAt(0) - 0x60)
  );
}

function hiraToKata(str) {
  return str.replace(/[\u3041-\u3096]/g, c =>
    String.fromCharCode(c.charCodeAt(0) + 0x60)
  );
}

function hasKanji(str) {
  return /[\u4E00-\u9FAF\u3400-\u4DBF]/.test(str);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function convertText(text, mode) {
  if (!tokenizer) return text;

  const tokens = tokenizer.tokenize(text);

  return tokens.map(t => {
    const surface = t.surface_form;
    const reading = t.reading;

    switch (mode) {
      case 'hiragana':
        return reading ? kataToHira(reading) : surface;

      case 'katakana':
        if (reading) return reading;
        return hiraToKata(surface);

      case 'furigana': {
        const hiraReading = reading ? kataToHira(reading) : null;
        if (hiraReading && hasKanji(surface) && hiraReading !== kataToHira(surface)) {
          return `<ruby>${escapeHtml(surface)}<rt>${escapeHtml(hiraReading)}</rt></ruby>`;
        }
        return escapeHtml(surface);
      }

      default:
        return surface;
    }
  }).join('');
}

/** rawCaptions: [{start, duration, text}] → 4モード変換結果 */
function buildAllModes(rawCaptions, trackName) {
  return {
    trackName,
    totalCount: rawCaptions.length,
    captions: {
      original: rawCaptions.map(c => ({ ...c, reading: c.text })),
      hiragana: rawCaptions.map(c => ({ ...c, reading: convertText(c.text, 'hiragana') })),
      katakana: rawCaptions.map(c => ({ ...c, reading: convertText(c.text, 'katakana') })),
      furigana: rawCaptions.map(c => ({ ...c, reading: convertText(c.text, 'furigana') })),
    },
  };
}

// ---- YouTube字幕取得 ----
function extractJsonArray(html, key) {
  const keyPattern = `"${key}"`;
  const keyIdx = html.indexOf(keyPattern);
  if (keyIdx === -1) return null;

  const arrStart = html.indexOf('[', keyIdx + keyPattern.length);
  if (arrStart === -1) return null;

  let depth = 0, inString = false, escape = false;

  for (let i = arrStart; i < html.length; i++) {
    const ch = html[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) return html.slice(arrStart, i + 1);
      }
    }
  }
  return null;
}

async function fetchCaptionTracks(videoId) {
  const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'Accept-Language': 'ja,en-US;q=0.9',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    },
    timeout: 15000,
  });

  const html = response.data;
  if (html.includes('Sign in to confirm') || html.includes('www.youtube.com/premium')) {
    throw new Error('この動画はアクセスできません');
  }

  const tracksJson = extractJsonArray(html, 'captionTracks');
  if (!tracksJson) return null;
  return JSON.parse(tracksJson);
}

async function fetchCaptionData(baseUrl) {
  const response = await axios.get(baseUrl + '&fmt=json3', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 15000,
  });
  return response.data;
}

function parseCaptionEvents(data) {
  if (!data?.events) return [];
  return data.events
    .filter(e => e.segs && e.segs.some(s => s.utf8 && s.utf8.trim()))
    .map(e => ({
      start: (e.tStartMs || 0) / 1000,
      duration: Math.min(Math.max((e.dDurationMs || 2000) / 1000, 0.3), 15),
      text: e.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim(),
    }))
    .filter(c => c.text);
}

// ---- LRC パーサー ----
function parseLrc(lrcText) {
  const timeRe = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
  const metaRe = /^\[(ti|ar|al|by|offset|length|re|ve):/i;
  const entries = [];

  for (const rawLine of lrcText.split('\n')) {
    const line = rawLine.trim();
    if (!line || metaRe.test(line)) continue;

    const times = [];
    let m;
    timeRe.lastIndex = 0;
    while ((m = timeRe.exec(line)) !== null) {
      const min = parseInt(m[1]);
      const sec = parseInt(m[2]);
      const ms  = parseInt((m[3] || '0').padEnd(3, '0'));
      times.push(min * 60 + sec + ms / 1000);
    }
    if (times.length === 0) continue;

    const text = line.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
    if (!text) continue;

    for (const start of times) entries.push({ start, text });
  }

  entries.sort((a, b) => a.start - b.start);

  return entries.map((entry, i) => ({
    start: entry.start,
    duration: i < entries.length - 1
      ? Math.min(entries[i + 1].start - entry.start, 8)
      : 5,
    text: entry.text,
  }));
}

// ---- yt-dlp ラッパー ----
function downloadAudio(videoId, outPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YT_DLP, [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '5',
      '--no-playlist',
      '--extractor-args', 'youtube:player_client=android,tv_embedded',
      '-o', outPath,
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);

    const errLines = [];
    proc.stderr.on('data', d => errLines.push(d.toString()));

    proc.on('error', err => {
      if (err.code === 'ENOENT') {
        reject(new Error(
          'yt-dlp がインストールされていません。\n' +
          '  pip install yt-dlp  または  brew install yt-dlp  で入れてください。'
        ));
      } else {
        reject(err);
      }
    });

    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('yt-dlp 失敗: ' + errLines.slice(-3).join(' ')));
    });
  });
}

// ---- API: YouTube字幕 ----
app.get('/api/captions', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'videoIdが正しくありません' });
  }

  const cached = cacheGet(videoId);
  if (cached) return res.json(cached);

  try {
    const tracks = await fetchCaptionTracks(videoId);
    if (!tracks || tracks.length === 0) {
      return res.status(404).json({ error: 'NO_CAPTIONS' });
    }

    const jaTrack =
      tracks.find(t => t.languageCode === 'ja' && !t.kind) ||
      tracks.find(t => t.languageCode === 'ja') ||
      tracks[0];

    const captionData = await fetchCaptionData(jaTrack.baseUrl);
    const rawCaptions = parseCaptionEvents(captionData);

    if (rawCaptions.length === 0) {
      return res.status(404).json({ error: 'NO_CAPTIONS' });
    }

    const result = buildAllModes(
      rawCaptions,
      jaTrack.name?.simpleText || jaTrack.languageCode || '字幕'
    );

    cacheSet(videoId, result);
    res.json(result);
  } catch (err) {
    console.error('captions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- API: LRC変換 ----
app.post('/api/lrc', (req, res) => {
  const { lrc } = req.body;
  if (!lrc || typeof lrc !== 'string') {
    return res.status(400).json({ error: 'LRCテキストがありません' });
  }

  const rawCaptions = parseLrc(lrc);
  if (rawCaptions.length === 0) {
    return res.status(400).json({ error: 'タイムスタンプが見つかりませんでした。LRC形式で入力してください。' });
  }

  res.json(buildAllModes(rawCaptions, 'LRC歌詞'));
});

// ---- 動画ダウンロード (OCR用、映像あり) ----
function downloadVideo(videoId, outPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YT_DLP, [
      '-f', 'best[height<=480]/best',
      '--no-playlist',
      '--merge-output-format', 'mp4',
      '--extractor-args', 'youtube:player_client=android,tv_embedded',
      '-o', outPath,
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
    const errLines = [];
    proc.stderr.on('data', d => errLines.push(d.toString()));
    proc.on('error', err => {
      if (err.code === 'ENOENT') reject(new Error('yt-dlp がインストールされていません。'));
      else reject(err);
    });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('yt-dlp 失敗: ' + errLines.slice(-3).join(' ')));
    });
  });
}

// ---- フレーム抽出 (ffmpeg) ----
const OCR_FPS = 0.5;   // 2秒に1フレーム

function extractFrames(videoPath, framesDir) {
  return new Promise((resolve, reject) => {
    // 下35%にクロップ (字幕が出やすいエリア)、0.5fps
    const proc = spawn('ffmpeg', [
      '-i', videoPath,
      '-vf', `crop=iw:ih*0.35:0:ih*0.65,fps=${OCR_FPS}`,
      '-q:v', '3',
      '-y',
      path.join(framesDir, 'frame_%04d.jpg'),
    ]);
    const errLines = [];
    proc.stderr.on('data', d => errLines.push(d.toString()));
    proc.on('error', err => {
      if (err.code === 'ENOENT') {
        reject(new Error('ffmpeg がインストールされていません。brew install ffmpeg などで入れてください。'));
      } else {
        reject(err);
      }
    });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg 失敗: ' + errLines.slice(-3).join(' ')));
    });
  });
}

// ---- テキスト類似度 (OCRノイズ除去用) ----
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev.splice(0, n + 1, ...curr);
  }
  return prev[n];
}

function isSimilarText(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const maxLen = Math.max(a.length, b.length);
  return editDistance(a, b) / maxLen < 0.25;
}

// ---- OCR処理 ----
async function ocrFrames(framesDir) {
  const tesseract = require('node-tesseract-ocr');
  const frames = fs.readdirSync(framesDir)
    .filter(f => /^frame_\d+\.jpg$/.test(f))
    .sort();

  const BATCH = 4;
  const rawResults = [];

  for (let i = 0; i < frames.length; i += BATCH) {
    const batch = frames.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async frame => {
        const frameNum = parseInt(frame.match(/frame_(\d+)\.jpg/)[1]);
        const timeSec = (frameNum - 1) / OCR_FPS;
        try {
          const text = await tesseract.recognize(
            path.join(framesDir, frame),
            { lang: 'jpn', oem: 1, psm: 6 }
          );
          const cleaned = text.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
          return { time: timeSec, text: cleaned };
        } catch {
          return { time: timeSec, text: '' };
        }
      })
    );
    rawResults.push(...results);
  }

  rawResults.sort((a, b) => a.time - b.time);

  // 連続する同じ/似たテキストをまとめて1字幕にする
  const captions = [];
  let current = null;
  for (const r of rawResults) {
    if (!r.text) {
      if (current) { captions.push(current); current = null; }
      continue;
    }
    if (current && isSimilarText(current.text, r.text)) {
      current.duration = (r.time - current.start) + (1 / OCR_FPS);
    } else {
      if (current) captions.push(current);
      current = { start: r.time, duration: 1 / OCR_FPS, text: r.text };
    }
  }
  if (current) captions.push(current);

  return captions;
}

// ---- API: OCR文字起こし ----
app.post('/api/ocr', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'videoIdが正しくありません' });
  }

  const cachedFile = persistentGet(`ocr_${videoId}`);
  if (cachedFile) {
    console.log(`[ocr cache hit] ${videoId}`);
    return res.json(cachedFile);
  }

  const tmpDir  = path.join(os.tmpdir(), `ytcc_ocr_${videoId}`);
  const videoPath = path.join(tmpDir, 'video.mp4');
  const framesDir = path.join(tmpDir, 'frames');

  try {
    fs.mkdirSync(framesDir, { recursive: true });

    await downloadVideo(videoId, videoPath);
    await extractFrames(videoPath, framesDir);

    const rawCaptions = await ocrFrames(framesDir);
    if (rawCaptions.length === 0) {
      return res.status(404).json({ error: '字幕テキストが検出できませんでした' });
    }

    const result = buildAllModes(rawCaptions, 'OCR 文字認識');
    persistentSet(`ocr_${videoId}`, result);
    res.json(result);

  } catch (err) {
    console.error('OCR error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ---- API: Whisper文字起こし ----
app.post('/api/transcribe', async (req, res) => {
  const { videoId, apiKey } = req.body;

  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'videoIdが正しくありません' });
  }

  const resolvedApiKey = apiKey || process.env.OPENAI_API_KEY;
  if (!resolvedApiKey) {
    return res.status(400).json({
      error: 'OpenAI API キーが必要です。入力欄に sk-... を入力してください。',
    });
  }

  // 永続キャッシュ確認 (一度文字起こしした動画はファイルから返す → 無料)
  const cachedFile = persistentGet(videoId);
  if (cachedFile) {
    console.log(`[cache hit] ${videoId}`);
    return res.json(cachedFile);
  }

  const tmpPath = path.join(os.tmpdir(), `ytcc_${videoId}.mp3`);

  try {
    // 1. 音声ダウンロード
    await downloadAudio(videoId, tmpPath);

    // 2. Whisper API へ送信
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: resolvedApiKey });

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'ja',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    // 3. セグメントをパース
    const rawCaptions = (transcription.segments || [])
      .map(seg => ({
        start: seg.start,
        duration: Math.max(seg.end - seg.start, 0.5),
        text: seg.text.trim(),
      }))
      .filter(c => c.text);

    if (rawCaptions.length === 0) {
      return res.status(404).json({ error: '音声から文字を認識できませんでした' });
    }

    const result = buildAllModes(rawCaptions, 'Whisper 文字起こし');
    persistentSet(videoId, result);   // ← ファイルに永続保存 (以後は無料)
    res.json(result);

  } catch (err) {
    console.error('transcribe error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
});

// ---- 起動 ----
const PORT = process.env.PORT || 3000;

initTokenizer()
  .then(t => {
    tokenizer = t;
    console.log('[OK] 日本語解析エンジン 準備完了');
    app.listen(PORT, () => {
      console.log(`[OK] サーバー起動: http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('[ERROR] 初期化失敗:', err);
    process.exit(1);
  });
