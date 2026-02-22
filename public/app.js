/* ================================================================
   ひらがな字幕 - フロントエンド
   ================================================================ */

// ---- 状態 ----
let player = null;
let ytAPIReady = false;
let pendingVideoId = null;

let captionsData = {};   // { hiragana: [...], katakana: [...], furigana: [...], original: [...] }
let activeCaptions = []; // 現在モードの字幕配列
let currentMode = 'hiragana';
let subtitleFontSize = 28; // px
let syncTimer = null;

// ---- DOM 要素 ----
const urlInput     = document.getElementById('url-input');
const loadBtn      = document.getElementById('load-btn');
const modeBar      = document.getElementById('mode-bar');
const playerWrapper = document.getElementById('player-wrapper');
const overlay      = document.getElementById('subtitle-overlay');
const subtitleEl   = document.getElementById('subtitle-text');
const statusEl     = document.getElementById('status');
const sizeUpBtn    = document.getElementById('size-up');
const sizeDownBtn  = document.getElementById('size-down');

// ---- YouTube IFrame API コールバック ----
window.onYouTubeIframeAPIReady = function () {
  ytAPIReady = true;
  if (pendingVideoId) {
    createPlayer(pendingVideoId);
    pendingVideoId = null;
  }
};

// ---- videoId 抽出 ----
function extractVideoId(url) {
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /^([A-Za-z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// ---- プレイヤー生成 / 動画切替 ----
function createPlayer(videoId) {
  if (player) {
    player.loadVideoById(videoId);
    return;
  }

  playerWrapper.style.display = 'block';

  player = new YT.Player('player', {
    videoId,
    playerVars: {
      cc_load_policy: 0,      // YouTubeデフォルト字幕を非表示
      cc_lang_pref: 'ja',
      rel: 0,
    },
    events: {
      onReady: () => startSync(),
      onStateChange: e => {
        if (e.data === YT.PlayerState.PLAYING) startSync();
      },
    },
  });
}

// ---- 字幕同期 ----
function startSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (!player || typeof player.getCurrentTime !== 'function') return;
    const t = player.getCurrentTime();
    showSubtitle(t);
  }, 80);
}

function showSubtitle(t) {
  const cap = activeCaptions.find(c => t >= c.start && t < c.start + c.duration);
  if (cap && cap.reading) {
    overlay.classList.remove('hidden');
    if (currentMode === 'furigana') {
      subtitleEl.innerHTML = cap.reading; // HTML (ruby タグあり)
    } else {
      subtitleEl.textContent = cap.reading; // プレーンテキスト
    }
  } else {
    overlay.classList.add('hidden');
    subtitleEl.textContent = '';
  }
}

// ---- 字幕データ読み込み ----
async function loadCaptions(videoId) {
  setStatus('字幕をよみこんでいます...', '');

  try {
    const res = await fetch(`/api/captions?videoId=${encodeURIComponent(videoId)}`);
    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || '字幕の取得に失敗しました', 'error');
      return;
    }

    captionsData = data.captions;
    switchMode(currentMode);

    setStatus(
      `「${data.trackName}」の字幕 ${data.totalCount}こ よみこみました`,
      'ok'
    );
  } catch (err) {
    setStatus('ネットワークエラー: ' + err.message, 'error');
  }
}

// ---- モード切替 ----
function switchMode(mode) {
  currentMode = mode;
  activeCaptions = captionsData[mode] || [];

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

// ---- フォントサイズ ----
function updateFontSize(delta) {
  subtitleFontSize = Math.min(Math.max(subtitleFontSize + delta, 16), 64);
  document.documentElement.style.setProperty('--sub-size', subtitleFontSize + 'px');
}

// ---- ステータス表示 ----
function setStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (type ? ' ' + type : '');
}

// ---- 動画ロードメイン ----
async function loadVideo() {
  const raw = urlInput.value.trim();
  if (!raw) return;

  const videoId = extractVideoId(raw);
  if (!videoId) {
    setStatus('YouTubeのURLが正しくないよ。URLをもう一度かくにんしてね。', 'error');
    return;
  }

  captionsData = {};
  activeCaptions = [];
  overlay.classList.add('hidden');
  modeBar.style.display = 'flex';
  loadBtn.disabled = true;

  // プレイヤー生成
  if (ytAPIReady) {
    createPlayer(videoId);
  } else {
    pendingVideoId = videoId;
    playerWrapper.style.display = 'block';
  }

  // 字幕取得 (プレイヤーと並行)
  await loadCaptions(videoId);
  loadBtn.disabled = false;
}

// ---- イベントリスナー ----
loadBtn.addEventListener('click', loadVideo);
urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') loadVideo();
});

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => switchMode(btn.dataset.mode));
});

sizeUpBtn.addEventListener('click',   () => updateFontSize(+4));
sizeDownBtn.addEventListener('click', () => updateFontSize(-4));
