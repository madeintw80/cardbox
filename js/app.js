// 名片盒 CardBox — 主程式：畫面切換、按鈕事件
// 頁面用網址 # 切換（手機返回鍵／滑動返回都能用）：
//   #/            名片清單
//   #/card/<id>   名片詳細
//   #/edit/<id>   編輯名片
//   #/settings    設定

import { VERSION, DEMO_MODE } from './config.js';
import { Auth } from './auth.js';
import { Store, backend } from './store.js';
import { Queue } from './queue.js';
import { thumbDb, clearAllLocal } from './localdb.js';
import { makeThumb } from './image.js';
import { recognizeCard } from './ocr.js';
import { openCamera, cameraSupported } from './camera.js';
import {
  EDITABLE_FIELDS, OCR_FIELDS, searchCards, sortCards, avatarText,
  cardToVCard, cardsToVCard, splitMulti, withScheme, telHref,
} from './cards.js';
import {
  esc, toast, confirmDialog, actionSheet, showBanner, hideBanner,
  shareOrDownload, copyText, detectInAppBrowser, isStandalone, isIOS,
} from './ui.js';

const $app = document.getElementById('app');
const FIELD_LABEL = Object.fromEntries(EDITABLE_FIELDS);

const view = {
  query: '',
  sort: localStorage.getItem('cardbox_sort') || 'recent',
  listScroll: 0,
};

// ======================= 啟動 =======================

async function boot() {
  registerServiceWorker();
  window.addEventListener('hashchange', onRouteChange);
  window.addEventListener('cardbox:auth-expired', onAuthExpired);
  $app.addEventListener('click', onClick);
  $app.addEventListener('input', onInput);
  document.getElementById('file-album').addEventListener('change', onFilesPicked);
  document.getElementById('file-camera').addEventListener('change', onFilesPicked);

  if (DEMO_MODE) {
    Auth.user = { email: 'demo@example.com', name: '試玩模式', picture: '' };
    return startMain();
  }
  renderSplash('載入中…');
  try {
    await Auth.init();
  } catch (err) {
    renderSplash(err.message);
    return;
  }
  if (Auth.user) startMain();
  else renderLogin();
}

let mainStarted = false;
async function startMain() {
  if (!mainStarted) {
    mainStarted = true;
    Store.subscribe(() => render('store'));
    Queue.subscribe(() => render('queue'));
  }
  await Store.loadCached();
  render();
  Store.refresh().catch((err) => handleError(err, '讀取雲端失敗，先顯示這支手機上次存的資料'));
  Queue.init();
}

function onAuthExpired() {
  Queue.paused = true;
  showBanner('reauth-banner', '登入已過期（Google 每小時要重新確認一次）', '重新連線', async () => {
    try {
      await Auth.login();
      hideBanner('reauth-banner');
      Queue.resume();
      Store.refresh().catch((err) => handleError(err));
    } catch (err) {
      toast(err.message);
    }
  });
}

function handleError(err, prefix = '') {
  console.error(err);
  const msg = err?.message || String(err);
  if (/續登|登入已過期|token/i.test(msg)) return; // 已經有重新連線橫幅
  toast(prefix ? `${prefix}（${msg.slice(0, 60)}）` : msg.slice(0, 120), 4000);
}

// ======================= 路由 =======================

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const [name, id] = parts;
  if (name === 'card' && id) return { name: 'card', id: decodeURIComponent(id) };
  if (name === 'edit' && id) return { name: 'edit', id: decodeURIComponent(id) };
  if (name === 'settings') return { name: 'settings' };
  return { name: 'list' };
}

function onRouteChange() {
  const current = $app.dataset.view;
  if (current === 'list') view.listScroll = window.scrollY;
  render('route');
}

function go(hash) {
  if (location.hash === hash) render('route');
  else location.hash = hash;
}

// reason：route（換頁）、store（名片變了）、queue（佇列變了）
function render(reason = 'route') {
  if (!Auth.user) return renderLogin();
  const route = parseRoute();
  const current = $app.dataset.view;

  if (route.name === 'list') {
    if (current === 'list' && reason !== 'route') {
      updateListParts();
      return;
    }
    renderList();
    if (reason === 'route') window.scrollTo(0, view.listScroll);
    return;
  }
  // 佇列變化只影響清單頁
  if (reason === 'queue') return;
  // 正在編輯時，別的地方的變化不要把表單洗掉
  if (route.name === 'edit' && current === 'edit' && reason !== 'route') return;

  if (route.name === 'card') renderDetail(route.id);
  else if (route.name === 'edit') renderEdit(route.id);
  else if (route.name === 'settings') renderSettings();
  if (reason === 'route') window.scrollTo(0, 0);
}

// ======================= 登入頁 =======================

function renderSplash(text) {
  $app.dataset.view = 'splash';
  $app.innerHTML = `<div class="splash"><div class="logo">📇</div><p>${esc(text)}</p></div>`;
}

function renderLogin() {
  $app.dataset.view = 'login';
  const inApp = detectInAppBrowser();
  $app.innerHTML = `
    <div class="login">
      <div class="logo">📇</div>
      <h1>名片盒</h1>
      <p class="login-lead">拍下名片，AI 自動整理成聯絡人。<br>照片和資料都存在你自己的 Google 雲端硬碟。</p>
      ${inApp ? `
        <div class="warn-box">
          <b>⚠️ 你現在在 ${esc(inApp)} 裡面開啟</b>
          <p>Google 不允許在這裡登入。請複製網址，改用 Safari 或 Chrome 打開。</p>
          <button type="button" class="btn btn-small" data-action="copy-url">複製網址</button>
        </div>` : ''}
      <button type="button" class="btn btn-primary btn-big" data-action="login">用 Google 帳號登入</button>
      <p class="fineprint">
        登入時 Google 的授權畫面會顯示「BroTrip」——那是開發者另一個 App 的名字，共用同一組設定，可以放心。<br>
        名片盒只拿得到「它自己建立的檔案」，看不到你雲端硬碟裡的其他東西。
      </p>
    </div>`;
}

async function doLogin() {
  try {
    const user = await Auth.login();
    if (user.missingDrive) {
      toast('授權時沒有勾選「Google 雲端硬碟」，名片會存不進去，請重新登入並勾選', 6000);
      Auth.logout();
      renderLogin();
      return;
    }
    toast(`歡迎，${user.name}`);
    go('#/');
    startMain();
  } catch (err) {
    toast(err.message || '登入失敗');
  }
}

// ======================= 清單頁 =======================

function renderList() {
  $app.dataset.view = 'list';
  $app.innerHTML = `
    <header class="appbar">
      <div class="appbar-row">
        <h1 class="appbar-title">📇 名片盒 <span class="count" id="card-count"></span></h1>
        <button type="button" class="icon-btn" data-action="refresh" aria-label="重新整理" id="refresh-btn">⟳</button>
        <a class="icon-btn" href="#/settings" aria-label="設定">⚙︎</a>
      </div>
      <div class="search">
        <input type="search" id="search" placeholder="搜尋姓名、公司、職稱、電話、備註…" value="${esc(view.query)}" autocomplete="off">
      </div>
      <div class="sort-row" id="sort-row"></div>
    </header>
    ${DEMO_MODE ? '<div class="demo-note">🧪 試玩模式：資料只存在這台裝置，AI 辨識是假的</div>' : ''}
    <section id="queue-box"></section>
    <main id="list-body" class="list"></main>
    <nav class="bottom-bar">
      <button type="button" class="btn btn-primary bottom-btn" data-action="camera">📷 拍名片</button>
      <button type="button" class="btn btn-secondary bottom-btn" data-action="album">🖼 從相簿選</button>
    </nav>`;
  updateListParts();
}

function updateListParts() {
  const countEl = document.getElementById('card-count');
  if (countEl) countEl.textContent = Store.cards.length ? `${Store.cards.length} 張` : '';
  document.getElementById('refresh-btn')?.classList.toggle('spinning', Store.loading);

  const sortRow = document.getElementById('sort-row');
  if (sortRow) {
    const opts = [['recent', '最新'], ['name', '姓名'], ['company', '公司']];
    sortRow.innerHTML = opts.map(([k, label]) =>
      `<button type="button" class="chip ${view.sort === k ? 'active' : ''}" data-action="sort" data-sort="${k}">${label}</button>`).join('');
  }

  const qBox = document.getElementById('queue-box');
  if (qBox) qBox.innerHTML = queueHtml();
  hydrateQueueThumbs();

  const body = document.getElementById('list-body');
  if (!body) return;
  const list = sortCards(searchCards(Store.cards, view.query), view.sort);
  if (!Store.cards.length) {
    body.innerHTML = Store.loading && !Store.loaded
      ? '<div class="empty">讀取中…</div>'
      : `<div class="empty"><div class="empty-icon">🗂️</div><p>還沒有名片</p><p class="muted">按下面的「拍名片」，或從相簿一次選很多張</p></div>`;
    return;
  }
  if (!list.length) {
    body.innerHTML = `<div class="empty"><p>找不到「${esc(view.query)}」</p></div>`;
    return;
  }
  let html = '';
  let lastGroup = null;
  for (const card of list) {
    if (view.sort === 'company') {
      const group = card.company || '（沒有公司）';
      if (group !== lastGroup) {
        html += `<div class="group-head">${esc(group)}</div>`;
        lastGroup = group;
      }
    }
    html += cardItemHtml(card);
  }
  body.innerHTML = html;
  hydrateImages(body);
}

function cardItemHtml(card) {
  const name = card.name || card.name_alt || '（沒有姓名）';
  const sub = [card.title, card.company].filter(Boolean).join(' · ');
  const photo = card.photos?.[0];
  return `
    <a class="card-item" href="#/card/${encodeURIComponent(card.id)}">
      <div class="card-thumb">
        ${photo ? `<img data-thumb="${esc(photo)}" alt="">` : ''}
        <span class="avatar">${esc(avatarText(card))}</span>
      </div>
      <div class="card-main">
        <div class="card-name">${esc(name)}${card.name && card.name_alt ? ` <span class="muted">${esc(card.name_alt)}</span>` : ''}</div>
        <div class="card-sub">${esc(sub || card.email || card.mobile || '')}</div>
      </div>
      ${card.status === 'error' ? '<span class="tag tag-warn">待補</span>' : ''}
    </a>`;
}

function queueHtml() {
  const items = Queue.items;
  if (!items.length) return '';
  const errors = items.filter((it) => it.state === 'error').length;
  const busy = items.length - errors;
  const head = [
    busy ? `⏳ 處理中 ${busy} 張` : '',
    errors ? `<span class="warn-text">⚠️ 失敗 ${errors} 張</span>` : '',
  ].filter(Boolean).join('　');
  return `
    <div class="queue">
      <div class="queue-head">
        <span>${head}</span>
        ${errors ? '<button type="button" class="btn btn-small" data-action="retry-all">全部重試</button>' : ''}
      </div>
      ${Queue.paused ? '<div class="queue-note">登入過期，按上方「重新連線」後會自動繼續</div>' : ''}
      <div class="queue-row">
        ${items.map((it) => `
          <button type="button" class="q-item q-${it.state}" data-action="queue-item" data-qid="${esc(it.qid)}">
            <img data-qthumb="${esc(it.qid)}" alt="">
            <span class="q-badge">${esc(queueLabel(it))}</span>
          </button>`).join('')}
      </div>
    </div>`;
}

function queueLabel(it) {
  if (it.state === 'queued') return '排隊中';
  if (it.state === 'working') return it.step || '處理中';
  return it.notCard ? '不是名片？' : '失敗';
}

async function onQueueItem(qid) {
  const item = Queue.items.find((it) => it.qid === qid);
  if (!item) return;
  if (item.state !== 'error') { toast(queueLabel(item)); return; }
  const choice = await actionSheet(item.error || '辨識失敗', [
    { label: '🔄 重試', value: 'retry' },
    { label: '✏️ 存成空白名片，我自己填', value: 'blank' },
    { label: '🗑 不要這張', value: 'discard', danger: true },
  ]);
  if (choice === 'retry') Queue.retry(qid);
  else if (choice === 'blank') {
    const card = await Queue.saveAsBlank(qid);
    if (card) go(`#/edit/${encodeURIComponent(card.id)}`);
  } else if (choice === 'discard') {
    Queue.discard(qid);
  }
}

// ======================= 照片載入 =======================

const thumbUrls = new Map();   // Drive 檔案 ID → 縮圖網址
const fullUrls = new Map();    // Drive 檔案 ID → 原圖網址
const queueUrls = new Map();   // 佇列 qid → 縮圖網址

// 同時最多抓 3 張，滑很快時不會一次塞爆網路
function limiter(n) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= n || !waiting.length) return;
    active += 1;
    const { fn, resolve, reject } = waiting.shift();
    fn().then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next(); });
}
const photoLimit = limiter(3);

async function getThumbUrl(fileId) {
  if (thumbUrls.has(fileId)) return thumbUrls.get(fileId);
  let blob = await thumbDb.get(fileId).catch(() => null);
  if (!blob) {
    // 這支手機沒有縮圖（例如在別台手機拍的）→ 下載原圖做一張
    const full = await photoLimit(() => backend.getPhoto(fileId));
    blob = await makeThumb(full);
    await thumbDb.put(fileId, blob).catch(() => {});
  }
  const url = URL.createObjectURL(blob);
  thumbUrls.set(fileId, url);
  return url;
}

async function getFullUrl(fileId) {
  if (fullUrls.has(fileId)) return fullUrls.get(fileId);
  const blob = await photoLimit(() => backend.getPhoto(fileId));
  const url = URL.createObjectURL(blob);
  fullUrls.set(fileId, url);
  return url;
}

const thumbObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        thumbObserver.unobserve(e.target);
        fillThumb(e.target);
      }
    }
  }, { rootMargin: '300px' })
  : null;

function fillThumb(img) {
  getThumbUrl(img.dataset.thumb)
    .then((url) => { img.src = url; img.closest('.card-thumb')?.classList.add('has-photo'); })
    .catch(() => {});
}

function hydrateImages(root) {
  root.querySelectorAll('img[data-thumb]').forEach((img) => {
    const cached = thumbUrls.get(img.dataset.thumb);
    if (cached) { img.src = cached; img.closest('.card-thumb')?.classList.add('has-photo'); }
    else if (thumbObserver) thumbObserver.observe(img);
    else fillThumb(img);
  });
  root.querySelectorAll('img[data-full]').forEach((img) => {
    const box = img.closest('.photo');
    getFullUrl(img.dataset.full)
      .then((url) => { img.src = url; box?.classList.add('loaded'); })
      .catch(() => box?.classList.add('failed'));
  });
}

function hydrateQueueThumbs() {
  // 清掉已經不在佇列裡的縮圖網址（釋放記憶體）
  const alive = new Set(Queue.items.map((it) => it.qid));
  for (const [qid, url] of queueUrls) {
    if (!alive.has(qid)) { URL.revokeObjectURL(url); queueUrls.delete(qid); }
  }
  document.querySelectorAll('img[data-qthumb]').forEach((img) => {
    const qid = img.dataset.qthumb;
    let url = queueUrls.get(qid);
    if (!url) {
      const item = Queue.items.find((it) => it.qid === qid);
      if (!item?.thumb) return;
      url = URL.createObjectURL(item.thumb);
      queueUrls.set(qid, url);
    }
    img.src = url;
  });
}

function openViewer(fileId) {
  const wrap = document.createElement('div');
  wrap.className = 'viewer';
  wrap.innerHTML = `<button type="button" class="viewer-close" aria-label="關閉">✕</button><div class="viewer-scroll"><img alt=""></div>`;
  document.body.appendChild(wrap);
  document.body.classList.add('no-scroll');
  const img = wrap.querySelector('img');
  getFullUrl(fileId).then((url) => { img.src = url; }).catch(() => toast('照片載入失敗'));
  img.addEventListener('click', () => wrap.classList.toggle('zoom')); // 點一下放大、再點縮回
  wrap.querySelector('.viewer-close').addEventListener('click', () => {
    wrap.remove();
    document.body.classList.remove('no-scroll');
  });
}

// ======================= 詳細頁 =======================

function renderDetail(id) {
  const card = Store.get(id);
  $app.dataset.view = 'detail';
  if (!card) {
    $app.innerHTML = `${topbar('名片')}<div class="empty">${Store.loaded ? '找不到這張名片（可能已經刪除）' : '讀取中…'}</div>`;
    return;
  }
  const name = card.name || card.name_alt || '（沒有姓名）';
  const role = [card.title, card.department].filter(Boolean).join(' · ');
  $app.innerHTML = `
    ${topbar('名片', `<a class="topbar-action" href="#/edit/${encodeURIComponent(card.id)}">編輯</a>`)}
    <div class="detail">
      ${card.photos.length ? `
        <div class="photos ${card.photos.length > 1 ? 'multi' : ''}">
          ${card.photos.map((pid, i) => `
            <button type="button" class="photo" data-action="view-photo" data-photo="${esc(pid)}">
              <img data-full="${esc(pid)}" alt="名片照片 ${i + 1}">
              ${card.photos.length > 1 ? `<span class="photo-tag">${i === 0 ? '正面' : '背面'}</span>` : ''}
            </button>`).join('')}
        </div>` : ''}
      <div class="person">
        <h1>${esc(name)}</h1>
        ${card.name && card.name_alt ? `<div class="person-alt">${esc(card.name_alt)}</div>` : ''}
        ${role ? `<div class="person-role">${esc(role)}</div>` : ''}
        ${card.company ? `<div class="person-company">${esc(card.company)}</div>` : ''}
      </div>
      <div class="info-list">
        ${infoRows(card) || '<div class="empty small">還沒有聯絡資料，按右上角「編輯」補上</div>'}
      </div>
      <div class="detail-actions">
        <button type="button" class="btn btn-secondary" data-action="vcard">📇 加入手機通訊錄</button>
        ${card.photos.length ? '<button type="button" class="btn btn-ghost" data-action="reocr">🔄 重新辨識</button>' : ''}
        <button type="button" class="btn btn-ghost danger-text" data-action="delete">🗑 刪除名片</button>
      </div>
      ${card.raw_text ? `<details class="raw"><summary>名片上的原始文字</summary><pre>${esc(card.raw_text)}</pre></details>` : ''}
      <div class="meta">建立 ${esc(fmtTime(card.created_at))}${card.updated_at && card.updated_at !== card.created_at ? `　修改 ${esc(fmtTime(card.updated_at))}` : ''}</div>
    </div>`;
  hydrateImages($app);
}

function topbar(title, right = '') {
  return `
    <header class="topbar">
      <button type="button" class="icon-btn" data-action="back" aria-label="返回">‹</button>
      <span class="topbar-title">${esc(title)}</span>
      <span class="topbar-right">${right}</span>
    </header>`;
}

// 一個欄位一行；同一格有多個號碼就拆成多行，每個都能直接撥
function infoRows(card) {
  const rows = [];
  const row = (label, value, actions = '') => rows.push(`
    <div class="info-row">
      <div class="info-label">${esc(label)}</div>
      <div class="info-value">${esc(value)}</div>
      <div class="info-acts">${actions}<button type="button" class="chip" data-action="copy" data-text="${esc(value)}">複製</button></div>
    </div>`);
  for (const m of splitMulti(card.mobile)) {
    row('手機', m, `<a class="chip chip-primary" href="${esc(telHref(m))}">撥打</a><a class="chip" href="${esc(telHref(m).replace('tel:', 'sms:'))}">簡訊</a>`);
  }
  for (const p of splitMulti(card.phone)) row('電話', p, `<a class="chip chip-primary" href="${esc(telHref(p))}">撥打</a>`);
  for (const f of splitMulti(card.fax)) row('傳真', f);
  for (const e of splitMulti(card.email)) row('Email', e, `<a class="chip chip-primary" href="mailto:${esc(e)}">寄信</a>`);
  for (const w of splitMulti(card.website)) row('網站', w, `<a class="chip" href="${esc(withScheme(w))}" target="_blank" rel="noopener">開啟</a>`);
  if (card.address) {
    const map = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(card.address)}`;
    row('地址', card.address, `<a class="chip" href="${esc(map)}" target="_blank" rel="noopener">地圖</a>`);
  }
  if (card.social) row('LINE／社群', card.social);
  if (card.note) row('備註', card.note);
  if (card.tags) row('標籤', card.tags);
  return rows.join('');
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function onDelete(card) {
  const ok = await confirmDialog({
    title: `刪除「${card.name || card.company || '這張名片'}」？`,
    message: '試算表裡這一列會被刪掉；照片會移到 Google 雲端硬碟的垃圾桶（30 天內還救得回來）。',
    okText: '刪除',
    danger: true,
  });
  if (!ok) return;
  try {
    await Store.remove(card);
    toast('已刪除');
    go('#/');
  } catch (err) {
    handleError(err, '刪除失敗');
  }
}

async function onVCard(card) {
  const name = (card.name || card.company || 'card').replace(/[\\/:*?"<>|]/g, '');
  const result = await shareOrDownload(cardToVCard(card), `${name}.vcf`, 'text/vcard');
  if (result === 'downloaded') {
    toast(isIOS() ? '已下載，點開檔案選「加入聯絡人」' : '已下載通訊錄檔，點開就能加入聯絡人', 4000);
  }
}

// 重新辨識：先給她看「哪些欄位會變」，勾選後才套用（不會偷偷蓋掉她改過的資料）
async function onReOcr(card) {
  const ok = await confirmDialog({
    title: '重新辨識這張名片？',
    message: '會用正面照片重新請 AI 讀一次，讀完先給你看差異，你決定要套用哪些欄位。',
    okText: '開始',
  });
  if (!ok) return;
  toast('重新辨識中…（約 10 秒）', 10000);
  let ocr;
  try {
    const blob = await backend.getPhoto(card.photos[0]);
    ocr = await recognizeCard(blob);
  } catch (err) {
    handleError(err, '重新辨識失敗');
    return;
  }
  const changes = OCR_FIELDS.filter((f) => ocr[f] && ocr[f] !== card[f]);
  if (!changes.length) {
    toast('辨識結果跟現在的資料一樣，不用改');
    return;
  }
  const html = `
    <div class="diff">
      ${changes.map((f) => `
        <label class="diff-row">
          <input type="checkbox" name="diff" value="${f}" checked>
          <span class="diff-field">${esc(FIELD_LABEL[f] || f)}</span>
          <span class="diff-old">${esc(card[f] || '（空白）')}</span>
          <span class="diff-arrow">→</span>
          <span class="diff-new">${esc(ocr[f])}</span>
        </label>`).join('')}
    </div>`;
  // confirmDialog 關掉前先記下勾選狀態
  let picked = changes;
  const onChange = () => {
    picked = [...document.querySelectorAll('input[name="diff"]:checked')].map((el) => el.value);
  };
  document.addEventListener('change', onChange);
  const apply = await confirmDialog({ title: '要套用哪些欄位？', html, okText: '套用勾選的欄位' });
  document.removeEventListener('change', onChange);
  if (!apply || !picked.length) return;
  const updated = { ...card };
  for (const f of picked) updated[f] = ocr[f];
  if (ocr.raw_text) updated.raw_text = ocr.raw_text;
  try {
    await Store.update(updated);
    toast(`已更新 ${picked.length} 個欄位`);
  } catch (err) {
    handleError(err, '更新失敗');
  }
}

// ======================= 編輯頁 =======================

function renderEdit(id) {
  const card = Store.get(id);
  $app.dataset.view = 'edit';
  if (!card) {
    $app.innerHTML = `${topbar('編輯')}<div class="empty">找不到這張名片</div>`;
    return;
  }
  const longFields = new Set(['address', 'note']);
  $app.innerHTML = `
    ${topbar('編輯名片', '<button type="button" class="topbar-action" data-action="save">儲存</button>')}
    <form class="edit-form" id="edit-form" data-id="${esc(card.id)}">
      ${card.photos[0] ? `<button type="button" class="edit-photo photo" data-action="view-photo" data-photo="${esc(card.photos[0])}"><img data-full="${esc(card.photos[0])}" alt="名片照片"></button>` : ''}
      ${EDITABLE_FIELDS.map(([key, label]) => `
        <label class="field">
          <span class="field-label">${esc(label)}</span>
          ${longFields.has(key)
            ? `<textarea name="${key}" rows="${key === 'note' ? 3 : 2}">${esc(card[key])}</textarea>`
            : `<input name="${key}" value="${esc(card[key])}" ${fieldInputAttrs(key)}>`}
        </label>`).join('')}
      <p class="muted small">多個電話或 Email 用逗號「,」隔開；標籤也用逗號隔開（例：客戶, 展覽）</p>
      <button type="submit" class="btn btn-primary btn-big">儲存</button>
    </form>`;
  hydrateImages($app);
  document.getElementById('edit-form').addEventListener('submit', (e) => { e.preventDefault(); onSave(); });
}

function fieldInputAttrs(key) {
  if (key === 'mobile' || key === 'phone' || key === 'fax') return 'type="tel" inputmode="tel"';
  if (key === 'email') return 'type="text" inputmode="email" autocapitalize="off"';
  if (key === 'website') return 'type="text" inputmode="url" autocapitalize="off"';
  return 'type="text"';
}

let saving = false;
async function onSave() {
  const form = document.getElementById('edit-form');
  if (!form || saving) return;
  const card = Store.get(form.dataset.id);
  if (!card) return;
  const updated = { ...card };
  for (const [key] of EDITABLE_FIELDS) updated[key] = (form.elements[key]?.value || '').trim();
  updated.status = 'ok';
  saving = true;
  try {
    await Store.update(updated);
    toast('已儲存');
    history.back();
  } catch (err) {
    handleError(err, '儲存失敗');
  } finally {
    saving = false;
  }
}

// ======================= 設定頁 =======================

async function renderSettings() {
  $app.dataset.view = 'settings';
  const user = Auth.user || {};
  $app.innerHTML = `
    ${topbar('設定')}
    <div class="settings">
      <section class="set-group">
        <div class="set-title">帳號</div>
        <div class="set-row"><span>${esc(user.name || '')}</span><span class="muted">${esc(user.email || '')}</span></div>
      </section>
      <section class="set-group">
        <div class="set-title">我的資料（在你自己的 Google 雲端硬碟）</div>
        <a class="set-row link" id="link-sheet" target="_blank" rel="noopener">📊 打開名片試算表 <span class="muted">（可以直接在裡面改）</span></a>
        <a class="set-row link" id="link-folder" target="_blank" rel="noopener">🗂️ 打開照片資料夾</a>
        <button type="button" class="set-row link" data-action="export-all">📇 全部匯出成通訊錄檔（${Store.cards.length} 張）</button>
      </section>
      ${!isStandalone() ? `
      <section class="set-group">
        <div class="set-title">加到手機主畫面（像 App 一樣用）</div>
        <div class="set-row help">${isIOS()
          ? '用 Safari 打開 → 按下方「分享」⬆️ → 「加入主畫面」'
          : '用 Chrome 打開 → 右上角 ⋮ → 「加到主畫面」或「安裝應用程式」'}</div>
      </section>` : ''}
      <section class="set-group">
        <div class="set-title">關於</div>
        <div class="set-row"><span>版本</span><span class="muted">v${esc(VERSION)}</span></div>
        <button type="button" class="set-row link" data-action="check-update">🔄 檢查新版本</button>
      </section>
      <section class="set-group">
        <button type="button" class="set-row link" data-action="switch-account">換一個 Google 帳號</button>
        <button type="button" class="set-row link danger-text" data-action="logout">登出</button>
      </section>
    </div>`;
  try {
    const links = await backend.links();
    const sheet = document.getElementById('link-sheet');
    const folder = document.getElementById('link-folder');
    if (sheet) links.sheet ? (sheet.href = links.sheet) : sheet.classList.add('disabled');
    if (folder) links.folder ? (folder.href = links.folder) : folder.classList.add('disabled');
  } catch (err) {
    handleError(err);
  }
}

async function onLogout(switchAccount = false) {
  const pending = Queue.items.length;
  const ok = await confirmDialog({
    title: switchAccount ? '換帳號？' : '登出？',
    message: pending
      ? `還有 ${pending} 張照片沒處理完，登出會清掉這支手機上的待處理照片。雲端裡已存的名片不會動。`
      : '只會清掉這支手機上的暫存，雲端裡的名片和照片都不會動。',
    okText: switchAccount ? '換帳號' : '登出',
    danger: pending > 0,
  });
  if (!ok) return;
  backend.resetWorkspace();
  Auth.logout();
  await clearAllLocal().catch(() => {});
  Store.reset();
  Queue.items = [];
  location.hash = '';
  if (switchAccount) {
    try {
      await Auth.login({ forceSelectAccount: true });
      startMain();
      return;
    } catch (err) {
      toast(err.message);
    }
  }
  renderLogin();
}

// ======================= 事件 =======================

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const route = parseRoute();
  const card = route.id ? Store.get(route.id) : null;

  switch (action) {
    case 'login': doLogin(); break;
    case 'copy-url':
      copyText(location.href).then((ok) => toast(ok ? '已複製網址，請貼到 Safari 或 Chrome' : location.href, 4000));
      break;
    case 'back':
      if (history.length > 1) history.back(); else go('#/');
      break;
    case 'refresh':
      Store.refresh().then(() => toast('已更新')).catch((err) => handleError(err, '更新失敗'));
      break;
    case 'sort':
      view.sort = el.dataset.sort;
      localStorage.setItem('cardbox_sort', view.sort);
      updateListParts();
      break;
    case 'camera': onCamera(); break;
    case 'album': document.getElementById('file-album').click(); break;
    case 'queue-item': onQueueItem(el.dataset.qid); break;
    case 'retry-all': Queue.retryAll(); break;
    case 'view-photo': e.preventDefault(); openViewer(el.dataset.photo); break;
    case 'copy':
      copyText(el.dataset.text).then((ok) => toast(ok ? '已複製' : '複製失敗'));
      break;
    case 'vcard': if (card) onVCard(card); break;
    case 'reocr': if (card) onReOcr(card); break;
    case 'delete': if (card) onDelete(card); break;
    case 'save': onSave(); break;
    case 'export-all': onExportAll(); break;
    case 'check-update': checkUpdate(); break;
    case 'switch-account': onLogout(true); break;
    case 'logout': onLogout(false); break;
    default: break;
  }
}

let searchTimer = null;
function onInput(e) {
  if (e.target.id !== 'search') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    view.query = e.target.value;
    updateListParts();
  }, 120);
}

async function onCamera() {
  if (!cameraSupported()) {
    document.getElementById('file-camera').click();
    return;
  }
  try {
    await openCamera(async (blobs) => {
      if (!blobs.length) return;
      const n = await Queue.addFiles(blobs);
      toast(`已加入 ${n} 張，開始辨識`);
    });
  } catch (err) {
    console.warn('camera failed', err);
    toast('打不開相機（可能沒有允許相機權限），改用系統相機', 3500);
    document.getElementById('file-camera').click();
  }
}

async function onFilesPicked(e) {
  const files = [...(e.target.files || [])].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  e.target.value = ''; // 清空，下次選同一張也會觸發
  if (!files.length) return;
  toast(`處理 ${files.length} 張照片中…`);
  const n = await Queue.addFiles(files);
  if (n < files.length) toast(`已加入 ${n} 張（${files.length - n} 張讀不了，可能是不支援的格式）`, 4000);
  else toast(`已加入 ${n} 張，開始辨識`);
  if (parseRoute().name !== 'list') go('#/');
}

async function onExportAll() {
  if (!Store.cards.length) { toast('還沒有名片'); return; }
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const result = await shareOrDownload(cardsToVCard(sortCards(Store.cards, 'name')), `名片盒_${stamp}.vcf`, 'text/vcard');
  if (result === 'downloaded') toast('已下載，點開檔案就能一次匯入通訊錄', 4000);
}

// ======================= 版本更新 =======================

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // 第一次打開時還沒有舊版，裝好快取不算「有新版本」；要先記下「打開時有沒有舊版在管」
  // （不能事後看 controller：sw.js 的 clients.claim() 會讓第一次安裝也馬上有 controller）
  const hadOldVersion = !!navigator.serviceWorker.controller;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      reg.update();
      setInterval(() => reg.update(), 15 * 60 * 1000);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'activated' && hadOldVersion) {
            showBanner('update-banner', '有新版本了', '更新', () => location.reload());
          }
        });
      });
    } catch (err) {
      console.warn('SW register failed', err);
    }
  });
}

async function checkUpdate() {
  toast('檢查新版本中…');
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
    await Promise.all(regs.map((r) => r.update()));
  } catch {}
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('cardbox-')).map((n) => caches.delete(n)));
  } catch {}
  setTimeout(() => location.reload(), 800);
}

boot();
