require('dotenv').config();

const express = require('express');
const axios = require('axios');
const kuromoji = require('kuromoji');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- 簡易キャッシュ (10分TTL) ----
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
    const proc = spawn('yt-dlp', [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '5',
      '--no-playlist',
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

// ---- API: Whisper文字起こし ----
app.post('/api/transcribe', async (req, res) => {
  const { videoId } = req.body;

  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'videoIdが正しくありません' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({
      error:
        'OPENAI_API_KEY が設定されていません。\n' +
        'プロジェクトフォルダに .env ファイルを作って\n' +
        'OPENAI_API_KEY=sk-... と書いてください。',
    });
  }

  // キャッシュ確認
  const cacheKey = `whisper_${videoId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  const tmpPath = path.join(os.tmpdir(), `ytcc_${videoId}.mp3`);

  try {
    // 1. 音声ダウンロード
    await downloadAudio(videoId, tmpPath);

    // 2. Whisper API へ送信
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
    cacheSet(cacheKey, result);
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
