const express = require('express');
const axios = require('axios');
const kuromoji = require('kuromoji');
const path = require('path');

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

/**
 * テキストを指定モードに変換する
 * mode: 'hiragana' | 'katakana' | 'furigana'
 * furigana の場合は HTML (<ruby>) を返す。他はプレーンテキスト。
 */
function convertText(text, mode) {
  if (!tokenizer) return text;

  const tokens = tokenizer.tokenize(text);

  return tokens.map(t => {
    const surface = t.surface_form;
    const reading = t.reading; // katakana or undefined

    switch (mode) {
      case 'hiragana':
        return reading ? kataToHira(reading) : surface;

      case 'katakana':
        if (reading) return reading; // kuromoji の reading はすでにカタカナ
        return hiraToKata(surface); // ひらがな→カタカナ、それ以外はそのまま

      case 'furigana': {
        const hiraReading = reading ? kataToHira(reading) : null;
        if (hiraReading && hasKanji(surface)) {
          // 読みが表層形と違う場合のみルビを付ける
          if (hiraReading !== kataToHira(surface)) {
            return `<ruby>${escapeHtml(surface)}<rt>${escapeHtml(hiraReading)}</rt></ruby>`;
          }
        }
        return escapeHtml(surface);
      }

      default:
        return surface;
    }
  }).join('');
}

// ---- YouTube字幕取得 ----

/**
 * HTML 文字列から JSON 配列 (key: [...]) を安全に取り出す
 */
function extractJsonArray(html, key) {
  const keyPattern = `"${key}"`;
  const keyIdx = html.indexOf(keyPattern);
  if (keyIdx === -1) return null;

  const arrStart = html.indexOf('[', keyIdx + keyPattern.length);
  if (arrStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

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

  if (
    html.includes('Sign in to confirm') ||
    html.includes('www.youtube.com/premium')
  ) {
    throw new Error('この動画はログインが必要またはアクセスできません');
  }

  const tracksJson = extractJsonArray(html, 'captionTracks');
  if (!tracksJson) return null;

  return JSON.parse(tracksJson);
}

async function fetchCaptionData(baseUrl) {
  const url = baseUrl + '&fmt=json3';
  const response = await axios.get(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    timeout: 15000,
  });
  return response.data;
}

function parseCaptionEvents(data) {
  if (!data?.events) return [];

  return data.events
    .filter(e => e.segs && e.segs.some(s => s.utf8 && s.utf8.trim()))
    .map(e => {
      const text = e.segs
        .map(s => s.utf8 || '')
        .join('')
        .replace(/\n/g, ' ')
        .trim();
      const duration = Math.min(Math.max((e.dDurationMs || 2000) / 1000, 0.3), 15);
      return {
        start: (e.tStartMs || 0) / 1000,
        duration,
        text,
      };
    })
    .filter(e => e.text);
}

// ---- API エンドポイント ----

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
      return res.status(404).json({
        error:
          'この動画には字幕がみつかりませんでした。\n' +
          '日本語字幕つきの動画を選んでください。',
      });
    }

    // 日本語トラックを優先 (手動 > 自動生成 > 他言語)
    const jaTrack =
      tracks.find(t => t.languageCode === 'ja' && !t.kind) ||
      tracks.find(t => t.languageCode === 'ja') ||
      tracks[0];

    const trackName =
      jaTrack.name?.simpleText || jaTrack.languageCode || '字幕';

    const captionData = await fetchCaptionData(jaTrack.baseUrl);
    const rawCaptions = parseCaptionEvents(captionData);

    if (rawCaptions.length === 0) {
      return res.status(404).json({ error: '字幕データが空です' });
    }

    // 4モード分まとめて変換
    const result = {
      trackName,
      totalCount: rawCaptions.length,
      captions: {
        original: rawCaptions.map(c => ({ ...c, reading: c.text })),
        hiragana: rawCaptions.map(c => ({
          ...c,
          reading: convertText(c.text, 'hiragana'),
        })),
        katakana: rawCaptions.map(c => ({
          ...c,
          reading: convertText(c.text, 'katakana'),
        })),
        furigana: rawCaptions.map(c => ({
          ...c,
          reading: convertText(c.text, 'furigana'),
        })),
      },
    };

    cacheSet(videoId, result);
    res.json(result);
  } catch (err) {
    console.error('Caption fetch error:', err.message);
    if (err.response?.status === 429) {
      return res.status(429).json({
        error: 'しばらく待ってからもう一度試してください',
      });
    }
    res.status(500).json({
      error: '字幕の取得に失敗しました: ' + err.message,
    });
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
