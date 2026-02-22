/* ================================================================
   ひらがな字幕 - フロントエンド
   ================================================================ */

// ---- 状態 ----
let player = null;
let ytAPIReady = false;
let pendingVideoId = null;
let currentVideoId = null;

let captionsData = {};   // { hiragana, katakana, furigana, original }
let activeCaptions = [];
let currentMode = 'hiragana';
let subtitleFontSize = 28;
let syncTimer = null;

// ---- DOM 要素 ----
const urlInput       = document.getElementById('url-input');
const loadBtn        = document.getElementById('load-btn');
const modeBar        = document.getElementById('mode-bar');
const playerWrapper  = document.getElementById('player-wrapper');
const overlay        = document.getElementById('subtitle-overlay');
const subtitleEl     = document.getElementById('subtitle-text');
const statusEl       = document.getElementById('status');
const sizeUpBtn      = document.getElementById('size-up');
const sizeDownBtn    = document.getElementById('size-down');
const fallbackPanel  = document.getElementById('fallback-panel');
const whisperBtn     = document.getElementById('whisper-btn');
const whisperProgress = document.getElementById('whisper-progress');
const lrcInput       = document.getElementById('lrc-input');
const lrcBtn         = document.getElementById('lrc-btn');

// ---- YouTube IFrame API ----
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

// ---- プレイヤー ----
function createPlayer(videoId) {
  if (player) {
    player.loadVideoById(videoId);
    return;
  }
  playerWrapper.style.display = 'block';

  player = new YT.Player('player', {
    videoId,
    playerVars: { cc_load_policy: 0, cc_lang_pref: 'ja', rel: 0 },
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
    showSubtitle(player.getCurrentTime());
  }, 80);
}

function showSubtitle(t) {
  const cap = activeCaptions.find(c => t >= c.start && t < c.start + c.duration);
  if (cap && cap.reading) {
    overlay.classList.remove('hidden');
    if (currentMode === 'furigana') {
      subtitleEl.innerHTML = cap.reading;
    } else {
      subtitleEl.textContent = cap.reading;
    }
  } else {
    overlay.classList.add('hidden');
    subtitleEl.textContent = '';
  }
}

// ---- 字幕データ適用 ----
function applyResult(data) {
  captionsData = data.captions;
  switchMode(currentMode);
  modeBar.style.display = 'flex';
  fallbackPanel.style.display = 'none';
  setStatus(`「${data.trackName}」 ${data.totalCount}行 よみこみました`, 'ok');
}

// ---- YouTube字幕フェッチ ----
async function loadCaptions(videoId) {
  setStatus('字幕をよみこんでいます...', '');

  const res = await fetch(`/api/captions?videoId=${encodeURIComponent(videoId)}`);
  const data = await res.json();

  if (res.ok) {
    applyResult(data);
    return;
  }

  // NO_CAPTIONS → フォールバックパネルを表示
  if (data.error === 'NO_CAPTIONS') {
    setStatus('YouTubeに字幕がありません。下のオプションで字幕をつけられます。', 'error');
    fallbackPanel.style.display = 'block';
  } else {
    setStatus(data.error || '字幕の取得に失敗しました', 'error');
  }
}

// ---- Whisper文字起こし ----
async function startWhisper() {
  if (!currentVideoId) return;

  whisperBtn.disabled = true;
  whisperProgress.style.display = 'block';
  whisperProgress.textContent =
    '音声をダウンロード中...\n(yt-dlp + Whisper APIで処理します。1〜3分かかることがあります)';

  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: currentVideoId }),
    });
    const data = await res.json();

    if (!res.ok) {
      whisperProgress.textContent = 'エラー: ' + data.error;
      return;
    }

    whisperProgress.style.display = 'none';
    applyResult(data);
  } catch (err) {
    whisperProgress.textContent = 'ネットワークエラー: ' + err.message;
  } finally {
    whisperBtn.disabled = false;
  }
}

// ---- LRC読み込み ----
async function loadLrc() {
  const lrc = lrcInput.value.trim();
  if (!lrc) {
    setStatus('LRCテキストを入力してください', 'error');
    return;
  }

  lrcBtn.disabled = true;
  setStatus('LRCをよみこんでいます...', '');

  try {
    const res = await fetch('/api/lrc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lrc }),
    });
    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || 'LRCの読み込みに失敗しました', 'error');
      return;
    }

    applyResult(data);
  } catch (err) {
    setStatus('ネットワークエラー: ' + err.message, 'error');
  } finally {
    lrcBtn.disabled = false;
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

// ---- ステータス ----
function setStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (type ? ' ' + type : '');
}

// ---- 動画ロード ----
async function loadVideo() {
  const raw = urlInput.value.trim();
  if (!raw) return;

  const videoId = extractVideoId(raw);
  if (!videoId) {
    setStatus('YouTubeのURLが正しくないよ。URLをもう一度かくにんしてね。', 'error');
    return;
  }

  currentVideoId = videoId;
  captionsData = {};
  activeCaptions = [];
  overlay.classList.add('hidden');
  fallbackPanel.style.display = 'none';
  modeBar.style.display = 'none';
  whisperProgress.style.display = 'none';
  loadBtn.disabled = true;

  if (ytAPIReady) {
    createPlayer(videoId);
  } else {
    pendingVideoId = videoId;
    playerWrapper.style.display = 'block';
  }

  await loadCaptions(videoId);
  loadBtn.disabled = false;
}

// ---- タブ切替 ----
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => (c.style.display = 'none'));
    document.getElementById('tab-' + btn.dataset.tab).style.display = 'block';
  });
});

// ---- イベントリスナー ----
loadBtn.addEventListener('click', loadVideo);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadVideo(); });
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => switchMode(btn.dataset.mode));
});
sizeUpBtn.addEventListener('click',   () => updateFontSize(+4));
sizeDownBtn.addEventListener('click', () => updateFontSize(-4));
whisperBtn.addEventListener('click', startWhisper);
lrcBtn.addEventListener('click', loadLrc);
