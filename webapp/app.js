import { KLSP100, UsbTransport, BleTransport, TAPES, SIDE_MARGIN_MM, DOTS_PER_MM, HEAD_DOTS } from './printer.js?v=1.1.26';
import { renderLabel, renderImage, toRaster, drawPreview } from './raster.js';
import { BARCODE_TYPES } from './barcode.js';
import * as library from './library.js';
import {
  PRESETS, SAMPLE_TEXT, supportsLocalFonts, localFontPermission, loadLocalFonts, localFonts,
  resolveFont, defaultStyle,
} from './fonts.js';

const $ = (id) => document.getElementById(id);
const APP_VERSION = '1.1.26';
const STORE_KEY = 'nameland-label-v3';
const TRANSPORT_KEY = 'nameland-last-transport';
const BLE_DEVICE_KEY = 'nameland-last-ble-device';

const TAPE_MM = [3.5, 6, 9, 12, 18, 24];
const TAPE_COLORS = [
  { v: 'white', c: '#fbfbf8', label: '白' },
  { v: 'yellow', c: '#f7dc4e', label: '黄' },
  { v: 'pink', c: '#f7b6cb', label: 'ピンク' },
  { v: 'blue', c: '#a5cdf0', label: '青' },
  { v: 'green', c: '#b6e0a8', label: '緑' },
  { v: 'clear', c: '#e4eaec', label: '透明' },
];
const INK = [24, 24, 26];

const SYMBOLS = [
  '★', '☆', '♥', '♡', '●', '○', '◎', '◆', '◇', '■', '□', '▲', '△', '▼', '▽', '※',
  '〒', '☎', '✉', '♪', '♫', '✓', '✔', '✗', '✕', '→', '←', '↑', '↓', '⇒', '⚠', '♻',
  '☀', '☁', '☂', '❄', '⚡', '♨', '℃', '℉', '㎜', '㎝', '㎏', '㎡', '№', '㈱', '©', '®',
  '™', '♂', '♀', '∞', '±', '×', '÷', '・', '…', '〜', '「', '」', '【', '】', '『', '』',
];
const EMOJI = [
  '📞', '✉️', '🏠', '🏢', '📦', '🔑', '🔒', '🔋', '💡', '🔌', '💊', '🩹', '🍴', '🍙', '☕', '🍺',
  '🔥', '❄️', '💧', '🗑️', '♻️', '📁', '📄', '🖊️', '✂️', '📌', '📎', '🎁', '🎂', '⭐', '❤️', '😊',
  '👍', '🐶', '🐱', '🐟', '🌸', '🌱', '🍀', '🚗', '🚲', '✈️', '⚽', '🎵', '📷', '💻', '📱', '⏰',
];

const state = {
  code: 'none',
  codePos: 'left',
  frame: 'none',
  align: 'center',
  tape: '3',
  margin: '0',
  lengthMode: 'auto',
  tapeColor: 'white',
  previewMode: 'smooth',
  font: { source: 'preset', family: PRESETS[0].family, style: 'W6' },
};
const INPUTS = ['text', 'qrText', 'barType', 'barText', 'barShowText', 'fontScale', 'invert',
  'length', 'copies', 'density', 'cutting'];

let printer = null;
let transport = null;
let busy = false;
let font = null;        // resolved { css, weight, family, style }
let current = null;     // last rendered label
let currentName = '';   // name of the label loaded from / saved to the library
let bleReconnectTimer = null;
let bleReconnectAttempt = 0;
let bleReconnectDevice = null;
let bleReconnectInFlight = false;
const syncs = [];       // segment re-sync functions, run after loading settings
const printerWaiters = []; // resolved on the next connection (MCP jobs wait here)

// ---------- settings ----------
function collectSettings() {
  const s = JSON.parse(JSON.stringify(state));
  for (const id of INPUTS) {
    const el = $(id);
    s[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return s;
}

function applySettings(saved) {
  for (const k of Object.keys(state)) if (k in saved) state[k] = saved[k];
  for (const id of INPUTS) {
    if (!(id in saved)) continue;
    const el = $(id);
    if (el.type === 'checkbox') el.checked = saved[id];
    else el.value = saved[id];
  }
  syncs.forEach((f) => f());
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved) applySettings(saved);
  } catch { /* ignore */ }
}

function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(collectSettings())); } catch { /* ignore */ }
}

// ---------- small UI helpers ----------
function log(msg) {
  const el = $('log');
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
}

function setStatus(text, on = false) {
  $('status').textContent = text;
  $('device').classList.toggle('on', on);
}

function updateButtons() {
  $('printBtn').disabled = !printer || busy || !current;
  $('readTapeBtn').disabled = !printer || busy;
  $('connectBtn').textContent = printer ? '切断' : '接続';
}

function segment(id, key, onChange = refresh) {
  const seg = $(id);
  const sync = () => seg.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('on', b.dataset.v === state[key]));
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state[key] = b.dataset.v;
    sync();
    onChange();
  });
  sync();
  syncs.push(sync);
  return sync;
}

function openModal(id) {
  $(id).classList.remove('hidden');
}

function closeModals() {
  document.querySelectorAll('.scrim').forEach((m) => m.classList.add('hidden'));
}

function insertAtCursor(textarea, str) {
  const { selectionStart: a, selectionEnd: b, value } = textarea;
  textarea.value = value.slice(0, a) + str + value.slice(b);
  textarea.selectionStart = textarea.selectionEnd = a + str.length;
  refresh();
}

// ---------- label ----------
function options() {
  const tape = Number(state.tape);
  const margin = Number(state.margin);
  return {
    tape,
    margin,
    sideMarginMm: SIDE_MARGIN_MM[margin],
    code: state.code,
    codePos: state.codePos,
    frame: state.frame,
    align: state.align,
    text: $('text').value,
    qrText: $('qrText').value,
    barType: $('barType').value,
    barText: $('barText').value,
    barShowText: $('barShowText').checked,
    font: font ? font.css : PRESETS[0].css,
    fontWeight: font ? font.weight : 'normal',
    fontScale: Number($('fontScale').value) / 100,
    invert: $('invert').checked,
    lengthMm: state.lengthMode === 'fixed' ? Math.max(0, Number($('length').value) || 0) : 0,
    copies: Math.min(99, Math.max(1, Number($('copies').value) || 1)),
    density: Number($('density').value),
    cutting: Number($('cutting').value),
    endCut: 0,
  };
}

function refresh() {
  $('qrField').classList.toggle('hidden', state.code !== 'qr');
  $('barField').classList.toggle('hidden', state.code !== 'barcode');
  $('codePosBox').classList.toggle('hidden', state.code === 'none');
  $('length').disabled = state.lengthMode !== 'fixed';
  $('fontScaleVal').textContent = `${$('fontScale').value}%`;
  $('densityVal').textContent = ['とても薄い', '薄い', '標準', '濃い', 'とても濃い'][Number($('density').value) - 1];
  $('labelName').textContent = currentName ? `「${currentName}」を編集中` : '';

  const o = options();
  try {
    current = renderLabel(o);
  } catch (e) {
    current = null;
    $('warn').textContent = e.message || String(e);
    updateButtons();
    return;
  }

  layoutPreview();

  const printedMm = current.widthDots / DOTS_PER_MM;
  const totalMm = printedMm + 2 * o.sideMarginMm;
  $('dim').textContent = `${totalMm.toFixed(totalMm % 1 ? 1 : 0)} mm`;

  const chips = [
    `${TAPES[o.tape].label}`,
    `印字 ${printedMm.toFixed(1)} mm`,
    `${current.widthDots} × ${current.heightDots} dot`,
  ];
  if (current.fontPx) chips.push(`文字高 ${(current.fontPx / DOTS_PER_MM).toFixed(1)} mm`);
  if (current.qrModuleDots) chips.push(`QR セル ${current.qrModuleDots} dot`);
  $('info').replaceChildren(...chips.map((t) => Object.assign(document.createElement('span'), { className: 'chip', textContent: t })));

  const warn = [];
  if (current.overflow) warn.push('内容が指定の長さに収まっていません。');
  if (current.qrModuleDots && current.qrModuleDots < 2) {
    warn.push('QRコードが細かすぎて読み取れない可能性があります。内容を短くするか、幅の広いテープを使ってください。');
  }
  if (current.barModuleDots && o.tape < 2) warn.push('バーコードは9mm以上のテープがおすすめです。');
  $('warn').textContent = warn.join(' ');
  updateButtons();
  saveSettings();
}

// Scale the preview to fit the stage: tape drawn to physical proportions.
function layoutPreview() {
  if (!current) return;
  const o = options();
  const avail = $('stage').clientWidth - 48;
  const feedDots = o.sideMarginMm * DOTS_PER_MM;
  const tapeDots = TAPE_MM[o.tape] * DOTS_PER_MM;
  const totalDots = current.widthDots + 2 * feedDots;
  const maxHeight = Math.min(120, window.innerHeight * 0.17);
  const scale = Math.max(0.2, Math.min(maxHeight / tapeDots, avail / totalDots, 6));

  const tape = $('tape');
  tape.style.width = `${totalDots * scale}px`;
  tape.style.height = `${tapeDots * scale}px`;
  tape.style.setProperty('--feed', `${feedDots * scale}px`);
  tape.style.setProperty('--tape', TAPE_COLORS.find((t) => t.v === state.tapeColor).c);
  const cv = $('preview');
  cv.style.width = `${current.widthDots * scale}px`;
  cv.style.height = `${HEAD_DOTS[o.tape] * scale}px`;
  $('dim').style.width = tape.style.width;

  // "dots" shows the exact 1-bit image that will print; "smooth" re-renders
  // the same layout at screen resolution so text is pleasant to read.
  const dots = state.previewMode === 'dots';
  cv.style.imageRendering = dots ? 'pixelated' : 'auto';
  if (dots) {
    drawPreview(cv, current.canvas, INK);
  } else {
    const hi = renderLabel(o, scale * (window.devicePixelRatio || 1)).canvas;
    cv.width = hi.width;
    cv.height = hi.height;
    cv.getContext('2d').drawImage(hi, 0, 0);
  }
}

// ---------- fonts ----------
let fontTab = 'preset';

async function applyFont() {
  font = await resolveFont(state.font);
  state.font = { source: font.family.source, family: font.family.family, style: font.style.label };
  $('fontName').textContent = font.family.label;
  $('fontName').style.fontFamily = font.css;
  $('fontName').style.fontWeight = font.weight;
  const sel = $('fontStyle');
  sel.replaceChildren(...font.family.styles.map((s) => new Option(s.label, s.label)));
  sel.value = font.style.label;
  sel.disabled = font.family.styles.length < 2;
  refresh();
}

function fontItem(f) {
  const b = document.createElement('button');
  const on = f.source === state.font.source && f.family === state.font.family;
  b.className = 'font-item' + (on ? ' on' : '');
  const s = document.createElement('span');
  s.className = 'sample';
  s.textContent = SAMPLE_TEXT;
  s.style.fontFamily = f.css;
  const n = document.createElement('span');
  n.className = 'name';
  n.textContent = f.label;
  const c = document.createElement('span');
  c.className = 'count';
  c.textContent = f.styles.length > 1 ? `${f.styles.length} スタイル` : '';
  b.append(s, n, c);
  b.addEventListener('click', () => {
    state.font = { source: f.source, family: f.family, style: defaultStyle(f).label };
    closeModals();
    applyFont();
  });
  return b;
}

function renderFontList() {
  document.querySelectorAll('#fontTab button').forEach((b) => b.classList.toggle('on', b.dataset.v === fontTab));
  const box = $('fontList');
  const q = $('fontSearch').value.trim().toLowerCase();
  const match = (f) => !q || f.family.toLowerCase().includes(q) || f.label.toLowerCase().includes(q);
  const empty = (msg) => { box.innerHTML = `<div class="picker-empty">${msg}</div>`; };

  if (fontTab === 'preset') {
    $('fontNote').classList.add('hidden');
    const list = PRESETS.filter(match);
    if (!list.length) return empty('見つかりませんでした');
    box.replaceChildren(...list.map(fontItem));
    return;
  }

  const all = localFonts();
  $('fontNote').classList.toggle('hidden', !!all);
  if (!all) return empty('「フォントを読み込む」を押すと、Macのフォントが一覧に出ます。');
  const list = all.filter(match);
  if (!list.length) return empty('見つかりませんでした');
  box.replaceChildren(...list.slice(0, 400).map(fontItem));
  if (list.length > 400) {
    box.append(Object.assign(document.createElement('div'), {
      className: 'picker-empty', textContent: `ほか ${list.length - 400} 件。検索で絞り込んでください。`,
    }));
  }
}

async function loadAllFonts() {
  try {
    const list = await loadLocalFonts();
    log(`フォント ${list.length} ファミリーを読み込みました`);
    renderFontList();
  } catch (e) {
    $('fontNoteText').textContent =
      'フォントの読み込みが許可されませんでした。アドレスバー左のアイコンからフォントへのアクセスを許可してください。';
    log(`フォント読み込みエラー: ${e.message}`);
  }
}

function openFontPicker() {
  fontTab = state.font.source === 'local' ? 'local' : 'preset';
  $('fontSearch').value = '';
  renderFontList();
  openModal('fontPicker');
  $('fontSearch').focus();
}

// ---------- symbols ----------
let symbolTab = 'symbols';

function renderSymbols() {
  document.querySelectorAll('#symbolTab button').forEach((b) => b.classList.toggle('on', b.dataset.v === symbolTab));
  const list = symbolTab === 'emoji' ? EMOJI : SYMBOLS;
  $('symbolGrid').replaceChildren(...list.map((ch) => {
    const b = document.createElement('button');
    b.textContent = ch;
    b.addEventListener('click', () => insertAtCursor($('text'), ch));
    return b;
  }));
}

// ---------- library ----------
function thumbnail() {
  if (!current) return '';
  const scale = Math.min(2, 480 / current.widthDots, 120 / current.heightDots);
  return renderLabel(options(), Math.max(0.3, scale)).canvas.toDataURL('image/png');
}

// The file name is the label text (lines joined with spaces).
function defaultName() {
  const text = $('text').value.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  if (text) return text.slice(0, 60);
  if (state.code === 'qr') return $('qrText').value.trim().slice(0, 60) || 'QRラベル';
  if (state.code === 'barcode') return $('barText').value.trim().slice(0, 60) || 'バーコード';
  return 'ラベル';
}

async function saveToLibrary(name = $('saveName').value.trim() || defaultName()) {
  try {
    // a remembered folder needs re-approval after the browser restarts
    if (await library.folderPermission() === 'prompt') await library.requestFolderPermission();
    if (await library.has(name) && !confirm(`「${name}」を上書きしますか？`)) return;
    await library.save({ name, savedAt: Date.now(), settings: collectSettings(), thumb: thumbnail() });
  } catch (e) {
    alert(`保存できませんでした。\n${e.message}`);
    return;
  }
  currentName = name;
  refresh();
  renderLibrary();
  log(`保存: ${name}`);
  $('progress').textContent = `「${name}」を保存しました`;
  setTimeout(() => { if (!busy) $('progress').textContent = ''; }, 3000);
}

function libraryCard(it) {
  const card = document.createElement('div');
  card.className = 'lib-card';
  const th = document.createElement('div');
  th.className = 'lib-thumb';
  th.title = '開く';
  if (it.thumb) th.append(Object.assign(document.createElement('img'), { src: it.thumb, alt: it.name }));
  th.addEventListener('click', () => openFromLibrary(it));

  const meta = document.createElement('div');
  meta.className = 'lib-meta';
  const info = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = it.name;
  const small = document.createElement('small');
  small.textContent = new Date(it.savedAt).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
  info.append(b, small);
  const open = Object.assign(document.createElement('button'), { className: 'btn', textContent: '開く' });
  open.addEventListener('click', () => openFromLibrary(it));
  const del = Object.assign(document.createElement('button'), { className: 'btn icon', title: '削除', textContent: '✕' });
  del.addEventListener('click', async () => {
    if (!confirm(`「${it.name}」を削除しますか？`)) return;
    await library.remove(it.name);
    if (currentName === it.name) currentName = '';
    renderLibrary();
    refresh();
  });
  meta.append(info, open, del);
  card.append(th, meta);
  return card;
}

async function renderFolderBar() {
  const perm = await library.folderPermission();
  const name = library.folderName();
  let text;
  if (!library.supportsFolder) text = '保存先: このブラウザの中（このブラウザはフォルダへの保存に対応していません）';
  else if (perm === 'none') text = '保存先: このブラウザの中。フォルダを選ぶと、Mac上にファイルとして保存します。';
  else if (perm === 'granted') text = `保存先フォルダ: ${name}`;
  else text = `保存先フォルダ「${name}」へのアクセス許可が必要です。`;
  $('libFolderText').textContent = text;
  $('libPermBtn').classList.toggle('hidden', perm !== 'prompt');
  $('libFolderBtn').classList.toggle('hidden', !library.supportsFolder);
  $('libFolderBtn').textContent = perm === 'none' ? '保存先フォルダを選ぶ' : 'フォルダを変更';
}

async function renderLibrary() {
  await renderFolderBar();
  const grid = $('libraryGrid');
  let items;
  try {
    items = await library.list();
  } catch (e) {
    grid.innerHTML = '';
    grid.append(Object.assign(document.createElement('div'), { className: 'picker-empty', textContent: `読み込めませんでした: ${e.message}` }));
    return;
  }
  if (!items.length) {
    grid.innerHTML = '<div class="picker-empty">保存したラベルはまだありません。上の欄に名前を入れて「保存」を押してください。</div>';
    return;
  }
  grid.replaceChildren(...items.map(libraryCard));
}

async function chooseLibraryFolder() {
  try {
    const moved = await library.chooseFolder();
    if (moved.length) log(`ブラウザ内のラベル ${moved.length} 件をフォルダへ移しました`);
  } catch (e) {
    if (e.name !== 'AbortError') alert(`フォルダを使えませんでした。\n${e.message}`);
  }
  renderLibrary();
}

function openFromLibrary(it) {
  applySettings(it.settings);
  currentName = it.name;
  closeModals();
  applyFont();
}

function openLibrary() {
  $('saveName').value = defaultName();
  renderLibrary();
  openModal('library');
}

// ---------- printer ----------
function cancelBleReconnect() {
  if (bleReconnectTimer !== null) clearTimeout(bleReconnectTimer);
  bleReconnectTimer = null;
  bleReconnectAttempt = 0;
}

function scheduleBleReconnect(delay = null) {
  if (bleReconnectTimer !== null || bleReconnectInFlight || printer || !('bluetooth' in navigator)) return;
  let lastTransport = null;
  let deviceId = null;
  try {
    lastTransport = localStorage.getItem(TRANSPORT_KEY);
    deviceId = localStorage.getItem(BLE_DEVICE_KEY);
  } catch { /* storage unavailable */ }
  if (lastTransport !== 'ble') return;

  const wait = delay ?? Math.min(30000, 1000 * (2 ** Math.min(bleReconnectAttempt, 5)));
  setStatus(wait ? 'Bluetooth再接続待ち…' : 'Bluetoothへ再接続中…');
  bleReconnectTimer = setTimeout(async () => {
    bleReconnectTimer = null;
    if (printer) return;
    bleReconnectInFlight = true;
    setStatus('Bluetoothプリンターを検索中…');
    let retry = true;
    try {
      const t = await BleTransport.reconnect(bleReconnectDevice || deviceId);
      if (t) {
        bleReconnectAttempt = 0;
        attach(t);
        log('Bluetoothへ自動再接続しました');
        retry = false;
      } else {
        setStatus('Bluetooth端末を選択してください');
        log('許可済みBluetooth端末が見つかりません。接続ボタンから選択してください。起動時の自動接続にはChromeの「Use the new permissions backend for Web Bluetooth」を有効にする必要があります');
        retry = false;
      }
    } catch (e) {
      log(`Bluetooth再接続 ${bleReconnectAttempt + 1} 回目: ${e.message}`);
    } finally {
      bleReconnectInFlight = false;
    }
    if (!retry || printer) return;
    bleReconnectAttempt++;
    scheduleBleReconnect();
  }, wait);
}

function attach(t) {
  if (bleReconnectTimer !== null) clearTimeout(bleReconnectTimer);
  bleReconnectTimer = null;
  bleReconnectAttempt = 0;
  transport = t;
  printer = new KLSP100(t, log);
  const kind = t instanceof BleTransport ? 'ble' : 'usb';
  if (kind === 'ble') bleReconnectDevice = t.device;
  $('transportMode').value = kind;
  try {
    localStorage.setItem(TRANSPORT_KEY, kind);
    if (kind === 'ble') localStorage.setItem(BLE_DEVICE_KEY, t.device.id);
  } catch { /* storage unavailable */ }
  if (t instanceof BleTransport) t.device.addEventListener('gattserverdisconnected', () => {
    if (transport !== t) return;
    if (t.intentionalClose) return;
    bleReconnectDevice = t.device;
    printer = transport = null;
    setStatus('切断されました');
    log('Bluetoothが切断されました。再接続を試みます');
    updateButtons();
    if (!t.intentionalClose) scheduleBleReconnect();
  }, { once: true });
  setStatus(t.name, true);
  log(`接続: ${t.name}`);
  updateButtons();
  printerWaiters.splice(0).forEach((resolve) => resolve());
}

async function connect() {
  if (printer) {
    transport.intentionalClose = true;
    bleReconnectDevice = null;
    try { localStorage.removeItem(TRANSPORT_KEY); } catch { /* storage unavailable */ }
    await transport.close();
    printer = transport = null;
    cancelBleReconnect();
    setStatus('未接続');
    updateButtons();
    return;
  }
  try {
    cancelBleReconnect();
    const kind = $('transportMode').value;
    attach(await (kind === 'ble' ? BleTransport.request() : UsbTransport.request()));
  } catch (e) {
    if (e.name === 'NotFoundError') return; // picker cancelled
    setStatus('接続できません');
    log(`接続エラー: ${e.message}`);
    alert(`接続できませんでした。\n${e.message}\n\nLABEL DESIGN MAKER が起動中の場合は終了してから再度お試しください。`);
  }
}

// quiet: rethrow instead of alerting (MCP jobs report errors back to Claude)
async function withBusy(fn, { quiet = false } = {}) {
  if (busy) throw new Error('プリンターは処理中です');
  busy = true;
  updateButtons();
  try {
    return await fn();
  } catch (e) {
    log(`エラー: ${e.message}`);
    $('progress').textContent = '';
    if (quiet) throw e;
    alert(e.message);
  } finally {
    busy = false;
    updateButtons();
  }
}

let syncTape = () => {};

// Read the loaded tape and select it; returns the tape index.
async function loadTape() {
  const t = await printer.readTape();
  if (t.index < 0) throw new Error(`テープを認識できませんでした（コード 0x${t.code.toString(16)}）`);
  state.tape = String(t.index);
  syncTape();
  refresh();
  log(`テープ: ${TAPES[t.index].label}`);
  return t.index;
}

function readTape() {
  return withBusy(loadTape);
}

async function sendPrint() {
  const o = options();
  const page = { data: toRaster(current.canvas), widthDots: current.widthDots };
  $('progress').textContent = '送信中…';
  await printer.print([page], o, (done, total) => {
    $('progress').textContent = `${done} / ${total} 枚`;
  });
  $('progress').textContent = '印刷しました';
  setTimeout(() => { if (!busy) $('progress').textContent = ''; }, 4000);
}

function print() {
  if (!current) return;
  return withBusy(sendPrint);
}

// ---------- MCP bridge ----------
// On the local server, mcp/nameland_mcp.py hands print jobs to this tab:
// the tab long-polls /bridge/next and posts the result to /bridge/result.

const BRIDGE_HEADERS = { 'X-Nameland-Bridge': '1' };
const MARGINS = { small: '0', medium: '1', large: '2' };
const CUTTING = { full: '0', full_half: '1', none: '2' };

function waitForPrinter(ms) {
  if (printer) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => resolve(!!printer);
    printerWaiters.push(done);
    setTimeout(done, ms);
  });
}

function findFontFamily(name) {
  const q = name.trim().toLowerCase();
  const hit = (f) => f.family.toLowerCase() === q || f.label.toLowerCase() === q;
  const f = PRESETS.find(hit) || (localFonts() || []).find(hit)
    || PRESETS.find((x) => x.label.toLowerCase().includes(q) || x.family.toLowerCase().includes(q))
    || (localFonts() || []).find((x) => x.family.toLowerCase().includes(q));
  if (!f) throw new Error(`フォント「${name}」が見つかりません`);
  return f;
}

const setInput = (id, v) => { if (v !== undefined && v !== null) $(id).value = String(v); };

// Tape and print settings shared by text and image jobs.
function applyPrintArgs(a) {
  if (a.tape_mm !== undefined) {
    const i = TAPE_MM.indexOf(Number(a.tape_mm));
    if (i < 0) throw new Error(`テープ幅 ${a.tape_mm}mm には対応していません`);
    state.tape = String(i);
  }
  if (a.invert !== undefined) $('invert').checked = !!a.invert;
  if (a.margin) state.margin = MARGINS[a.margin] ?? state.margin;
  setInput('copies', a.copies);
  setInput('density', a.density);
  if (a.cutting) setInput('cutting', CUTTING[a.cutting]);
}

// Apply job arguments over the current settings; unspecified ones stay as they are.
async function applyJobArgs(a) {
  closeModals();
  const set = setInput;
  set('text', a.text);
  applyPrintArgs(a);
  if (a.align) state.align = a.align;
  if (a.frame) state.frame = a.frame;
  set('fontScale', a.font_scale);
  if (a.length_mm !== undefined) {
    state.lengthMode = Number(a.length_mm) > 0 ? 'fixed' : 'auto';
    if (Number(a.length_mm) > 0) set('length', a.length_mm);
  }
  state.code = a.code || (a.qr_text ? 'qr' : a.barcode_text ? 'barcode' : 'none');
  if (a.code_position) state.codePos = a.code_position;
  set('qrText', a.qr_text);
  set('barType', a.barcode_type);
  set('barText', a.barcode_text);
  if (a.barcode_show_text !== undefined) $('barShowText').checked = !!a.barcode_show_text;
  if (a.font) {
    const f = findFontFamily(a.font);
    const style = f.styles.find((s) => s.label.toLowerCase() === String(a.font_style || '').toLowerCase()) || defaultStyle(f);
    state.font = { source: f.source, family: f.family, style: style.label };
  } else if (a.font_style) {
    state.font = { ...state.font, style: a.font_style };
  }
  currentName = '';
  syncs.forEach((f) => f());
  await applyFont();   // re-renders the label
  if (!current) throw new Error($('warn').textContent || 'ラベルを作れませんでした');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = src;
  });
}

// Image jobs change only the print settings; the text label in the editor stays as it is.
async function renderImageJob(a) {
  closeModals();
  applyPrintArgs(a);
  syncs.forEach((f) => f());
  refresh();
  const img = await loadImage(a.image);
  // SVG mm / in lengths resolve at 96 px per inch; raster pixels default to one dot each
  const dpi = Number(a.dpi) || (a.image.startsWith('data:image/svg') ? 96 : DOTS_PER_MM * 25.4);
  const o = options();
  current = renderImage(img, o, a.size || 'fit', dpi);
  const mm = (d) => Math.round(d / DOTS_PER_MM * 100) / 100;
  return {
    image: a.name,
    tape: TAPES[o.tape].label,
    imageMm: current.imageDots.map(mm),
    lengthMm: Math.round((current.widthDots / DOTS_PER_MM + 2 * o.sideMarginMm) * 10) / 10,
    dots: [current.widthDots, current.heightDots],
    copies: o.copies,
  };
}

function labelInfo() {
  const o = options();
  const printedMm = current.widthDots / DOTS_PER_MM;
  return {
    text: o.text,
    tape: TAPES[o.tape].label,
    lengthMm: Math.round((printedMm + 2 * o.sideMarginMm) * 10) / 10,
    font: `${font.family.label} ${font.style.label}`,
    textHeightMm: current.fontPx ? Math.round(current.fontPx / DOTS_PER_MM * 10) / 10 : 0,
    copies: o.copies,
    warning: $('warn').textContent || undefined,
  };
}

// The exact 1-bit dots, black on white, enlarged so small tapes stay legible.
function previewPng() {
  const dots = document.createElement('canvas');
  drawPreview(dots, current.canvas, [0, 0, 0]);
  const s = Math.max(1, Math.min(4, Math.floor(1600 / current.widthDots)));
  const out = document.createElement('canvas');
  out.width = dots.width * s;
  out.height = dots.height * s;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(dots, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

async function runBridgeJob(job) {
  const a = job.args || {};
  log(`MCP: ${job.type}`);
  if (job.type === 'status') {
    const info = { connected: !!printer, transport: transport ? (transport instanceof BleTransport ? 'ble' : 'usb') : null,
      printer: transport ? transport.name : null, busy, appVersion: APP_VERSION };
    if (printer && !busy) info.tape = TAPES[await withBusy(loadTape, { quiet: true })].label;
    return { ok: true, info };
  }
  if (job.type === 'preview') {
    if (a.tape_mm === undefined && printer && !busy) await withBusy(loadTape, { quiet: true });
    await applyJobArgs(a);
    return { ok: true, png: previewPng(), info: labelInfo() };
  }
  if (job.type === 'preview_image') {
    if (a.tape_mm === undefined && printer && !busy) await withBusy(loadTape, { quiet: true });
    try {
      const info = await renderImageJob(a);
      return { ok: true, png: previewPng(), info };
    } finally {
      refresh();   // back to the text label in the editor
    }
  }
  if (job.type === 'print' || job.type === 'print_image') {
    if (!printer) {
      log('MCP: プリンターの接続を待っています…');
      if (!await waitForPrinter(20000)) {
        throw new Error('プリンターに接続されていません。アプリの「接続」を押してから、もう一度実行してください');
      }
    }
    if (a.copies === undefined) a.copies = 1;
    return await withBusy(async () => {
      if (a.tape_mm === undefined) await loadTape();
      if (job.type === 'print_image') {
        try {
          const info = await renderImageJob(a);
          await sendPrint();
          return { ok: true, info };
        } finally {
          refresh();
        }
      }
      await applyJobArgs(a);
      if (current.overflow) throw new Error('内容が指定の長さに収まっていません');
      const info = labelInfo();
      await sendPrint();
      return { ok: true, info };
    }, { quiet: true });
  }
  throw new Error(`unknown job: ${job.type}`);
}

async function bridgeLoop() {
  let delay = 1000;
  for (;;) {
    let job = null;
    try {
      const appState = { connected: !!printer, busy };
      const res = await fetch('/bridge/next', { headers: { ...BRIDGE_HEADERS, 'X-Nameland-State': JSON.stringify(appState) }, cache: 'no-store' });
      if (res.status === 404 || res.status === 501) return;   // plain static server: no bridge
      if (res.status === 200) job = await res.json();
      else if (res.status !== 204) throw new Error(`HTTP ${res.status}`);
      delay = 1000;
    } catch {
      // server not running (MCP session ended); keep trying quietly
      await new Promise((ok) => setTimeout(ok, delay));
      delay = Math.min(10000, delay * 2);
      continue;
    }
    if (!job) continue;
    let result;
    try {
      result = await runBridgeJob(job);
    } catch (e) {
      result = { ok: false, error: e.message || String(e) };
    }
    await fetch('/bridge/result', {
      method: 'POST', headers: { ...BRIDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: job.id, result }),
    }).catch(() => {});
  }
}

// ---------- init ----------
function tabs(id, onPick) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) onPick(b.dataset.v);
  });
}

function init() {
  $('appVersion').textContent = `v${APP_VERSION}`;
  const tapeSeg = $('tapeSeg');
  for (const t of TAPES) {
    const b = document.createElement('button');
    b.dataset.v = String(t.index);
    b.textContent = t.label.replace('mm', '');
    b.title = t.label;
    tapeSeg.append(b);
  }
  const swatches = $('tapeColor');
  for (const t of TAPE_COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.v = t.v;
    b.title = t.label;
    b.style.setProperty('--c', t.c);
    swatches.append(b);
  }
  $('barType').replaceChildren(...BARCODE_TYPES.map((t) => new Option(t.label, t.v)));

  const syncSwatch = () => swatches.querySelectorAll('.swatch').forEach((b) =>
    b.classList.toggle('on', b.dataset.v === state.tapeColor));
  syncs.push(syncSwatch);
  swatches.addEventListener('click', (e) => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    state.tapeColor = b.dataset.v;
    syncSwatch();
    layoutPreview();
    saveSettings();
  });

  segment('code', 'code');
  segment('codePos', 'codePos');
  segment('frame', 'frame');
  segment('align', 'align');
  segment('margin', 'margin');
  segment('lengthMode', 'lengthMode');
  segment('previewMode', 'previewMode', () => { layoutPreview(); saveSettings(); });
  syncTape = segment('tapeSeg', 'tape');
  loadSettings();

  for (const id of INPUTS) $(id).addEventListener('input', refresh);
  $('copiesDown').addEventListener('click', () => { $('copies').value = Math.max(1, Number($('copies').value) - 1); saveSettings(); });
  $('copiesUp').addEventListener('click', () => { $('copies').value = Math.min(99, Number($('copies').value) + 1); saveSettings(); });

  // modals
  document.querySelectorAll('.scrim').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModals(); });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

  // fonts
  $('fontStyle').addEventListener('change', () => {
    state.font = { ...state.font, style: $('fontStyle').value };
    applyFont();
  });
  $('fontBtn').addEventListener('click', openFontPicker);
  tabs('fontTab', (v) => { fontTab = v; renderFontList(); });
  $('fontSearch').addEventListener('input', renderFontList);
  $('fontLoadBtn').addEventListener('click', loadAllFonts);
  if (!supportsLocalFonts) {
    $('fontNoteText').textContent = 'このブラウザではMacのフォント一覧を取得できません（Chrome / Edge で使えます）。';
    $('fontLoadBtn').classList.add('hidden');
  }

  // symbols
  $('symbolBtn').addEventListener('click', () => { renderSymbols(); openModal('symbolPicker'); });
  tabs('symbolTab', (v) => { symbolTab = v; renderSymbols(); });

  // library
  $('libraryBtn').addEventListener('click', openLibrary);
  $('saveBtn').addEventListener('click', () => saveToLibrary(defaultName()));
  $('saveConfirm').addEventListener('click', () => saveToLibrary());
  $('saveName').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) saveToLibrary(); });
  $('libFolderBtn').addEventListener('click', chooseLibraryFolder);
  $('libPermBtn').addEventListener('click', async () => { await library.requestFolderPermission(); renderLibrary(); });
  library.restoreFolder();

  // printer
  $('connectBtn').addEventListener('click', connect);
  $('readTapeBtn').addEventListener('click', readTape);
  $('printBtn').addEventListener('click', print);

  const hasUsb = 'usb' in navigator;
  const hasBle = 'bluetooth' in navigator;
  $('transportMode').querySelector('[value=usb]').disabled = !hasUsb;
  $('transportMode').querySelector('[value=ble]').disabled = !hasBle;
  let lastTransport = null;
  try { lastTransport = localStorage.getItem(TRANSPORT_KEY); } catch { /* storage unavailable */ }
  if (lastTransport === 'ble' && hasBle) $('transportMode').value = 'ble';
  else if (lastTransport === 'usb' && hasUsb) $('transportMode').value = 'usb';
  else if (!hasUsb && hasBle) $('transportMode').value = 'ble';
  if (!hasUsb && !hasBle) {
    $('unsupported').classList.remove('hidden');
    $('connectBtn').disabled = true;
  }
  if (hasUsb) {
    navigator.usb.addEventListener('disconnect', (e) => {
      if (transport && e.device === transport.device) {
        printer = transport = null;
        setStatus('切断されました');
        updateButtons();
      }
    });
  }
  if (lastTransport === 'ble' && hasBle) {
    scheduleBleReconnect(0);
  } else if (hasUsb) {
    UsbTransport.reconnect().then((t) => t && attach(t))
      .catch((e) => log(`USBへ自動接続できませんでした: ${e.message}`));
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !printer) scheduleBleReconnect(0);
  });
  window.addEventListener('online', () => scheduleBleReconnect(0));
  window.addEventListener('pagehide', (e) => {
    // Release the BLE link before Chrome tears down this PWA window. Keep the
    // remembered transport/device so the next launch reconnects automatically.
    if (!e.persisted && transport instanceof BleTransport) {
      transport.intentionalClose = true;
      transport.close();
    }
  });

  new ResizeObserver(layoutPreview).observe($('stage'));

  // If fonts were allowed before, load them silently so a saved Mac font resolves.
  localFontPermission().then(async (p) => {
    if (p === 'granted') await loadAllFonts();
    await applyFont();
  });
  refresh();
  updateButtons();
}

// ---------- installable app ----------
const APP_WINDOW = { w: 1120, h: 720 };

// Chrome opens a freshly installed app window at an arbitrary size; size and
// centre it once so everything fits, then leave later resizing to the user.
function sizeAppWindow() {
  if (!matchMedia('(display-mode: standalone)').matches) return;
  try {
    if (localStorage.getItem('nameland-window-sized')) return;
    const { w, h } = APP_WINDOW;
    window.resizeTo(w, h);
    window.moveTo(
      (screen.availLeft || 0) + Math.max(0, Math.round((screen.availWidth - w) / 2)),
      (screen.availTop || 0) + Math.max(0, Math.round((screen.availHeight - h) / 2)));
    localStorage.setItem('nameland-window-sized', '1');
  } catch { /* storage or window APIs unavailable */ }
}

function setupInstall() {
  sizeAppWindow();
  if ('serviceWorker' in navigator) {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      // A production PWA service worker is useful on GitHub Pages, but on the
      // local development server it can keep an older module graph alive.
      navigator.serviceWorker.getRegistrations().then((registrations) =>
        Promise.all(registrations.map((registration) => registration.unregister())))
        .catch((e) => log(`Service Worker 解除エラー: ${e.message}`));
    } else {
      navigator.serviceWorker.register('sw.js').then((registration) => registration.update())
        .catch((e) => log(`Service Worker 登録エラー: ${e.message}`));
    }
  }
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $('installBtn').classList.remove('hidden');
  });
  $('installBtn').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $('installBtn').classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => $('installBtn').classList.add('hidden'));
}

init();
setupInstall();
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') bridgeLoop();
