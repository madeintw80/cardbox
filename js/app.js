// 名片盒 CardBox — 主程式：畫面切換、按鈕事件
// 頁面用網址 # 切換（手機返回鍵／滑動返回都能用）：
//   #/                    清單（名片／公司 兩個分頁）
//   #/card/<id>           名片詳細
//   #/edit/<id>           編輯名片
//   #/company/<id>        公司檔案
//   #/company-edit/<id>   編輯公司檔案
//   #/settings            設定
//   #/options             整理下拉選單

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
  COMPANY_FIELDS, PICK_FIELDS, PRODUCT_FIELD, CARD_PICK_FIELDS, GROUP_FIELDS, UNGROUPED,
  companyDisplayName, cleanFullName, autoFieldSet, totalTons, cleanProducts, makeCompanyFromCard,
  matchCompany, cardDomains,
  searchCompanies, sortCompanies, pickOptions, optionCounts, renameOption, groupCards,
  localDayKey, monthGrid, shiftMonth,
} from './cards.js';
import {
  esc, toast, confirmDialog, promptDialog, actionSheet, showBanner, hideBanner,
  shareOrDownload, copyText, detectInAppBrowser, isStandalone, isIOS,
} from './ui.js';

const $app = document.getElementById('app');
const FIELD_LABEL = Object.fromEntries(EDITABLE_FIELDS);
const COMPANY_LABEL = { ...Object.fromEntries(COMPANY_FIELDS), [PRODUCT_FIELD]: '需求產品' };
const GROUP_LABEL = Object.fromEntries(GROUP_FIELDS.map(([key, label]) => [key, label]));

// 自訂排序（她用「＋」加的分組欄位）存在這支手機
function loadCustomSorts() {
  try {
    const list = JSON.parse(localStorage.getItem('cardbox_custom_sorts') || '[]');
    return Array.isArray(list) ? list.filter((k) => GROUP_LABEL[k]) : [];
  } catch {
    return [];
  }
}

const view = {
  query: '',
  mode: localStorage.getItem('cardbox_mode') === 'companies' ? 'companies' : 'cards', // 清單看名片還是公司
  sort: localStorage.getItem('cardbox_sort') || 'recent',
  customSorts: loadCustomSorts(),
  month: '',      // 日曆正在看哪個月（"2026-10"；空白＝最新名片那個月）
  day: '',        // 日曆點選的那一天（空白＝整個月）
  relation: '',   // 公司分頁：只看某種關係（空白＝全部）
  listScroll: 0,
};
if (view.sort.startsWith('group:') && !view.customSorts.includes(view.sort.slice(6))) view.sort = 'recent';

const companyOf = (card) => Store.companyOf(card);
const companyNameOf = (card) => companyDisplayName(companyOf(card)) || card.company;

// ======================= 啟動 =======================

async function boot() {
  registerServiceWorker();
  window.addEventListener('hashchange', onRouteChange);
  window.addEventListener('cardbox:auth-expired', onAuthExpired);
  $app.addEventListener('click', onClick);
  $app.addEventListener('input', onInput);
  $app.addEventListener('change', onChange);
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
  if (name === 'company' && id) return { name: 'company', id: decodeURIComponent(id) };
  if (name === 'company-edit' && id) return { name: 'company-edit', id: decodeURIComponent(id) };
  if (name === 'settings') return { name: 'settings' };
  if (name === 'options') return { name: 'options' };
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
  if ((route.name === 'edit' || route.name === 'company-edit') && current === route.name && reason !== 'route') return;

  if (route.name === 'card') renderDetail(route.id);
  else if (route.name === 'edit') renderEdit(route.id);
  else if (route.name === 'company') renderCompany(route.id);
  else if (route.name === 'company-edit') renderCompanyEdit(route.id);
  else if (route.name === 'settings') renderSettings();
  else if (route.name === 'options') renderOptions();
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
      <div class="mode-tabs" id="mode-tabs"></div>
      <div class="search">
        <input type="search" id="search" value="${esc(view.query)}" autocomplete="off" placeholder="${view.mode === 'companies'
          ? '搜尋公司、產品、產業、地區、備註…'
          : '搜尋姓名、公司、職稱、電話、備註…'}">
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
  const isCompanies = view.mode === 'companies';
  const countEl = document.getElementById('card-count');
  if (countEl) countEl.textContent = Store.cards.length ? `${Store.cards.length} 張` : '';
  document.getElementById('refresh-btn')?.classList.toggle('spinning', Store.loading);

  const tabs = document.getElementById('mode-tabs');
  if (tabs) {
    tabs.innerHTML = [['cards', `名片 ${Store.cards.length || ''}`], ['companies', `公司 ${Store.companies.length || ''}`]]
      .map(([k, label]) => `<button type="button" class="mode-tab ${view.mode === k ? 'active' : ''}" data-action="mode" data-mode="${k}">${esc(label.trim())}</button>`)
      .join('');
  }

  const sortRow = document.getElementById('sort-row');
  if (sortRow) sortRow.innerHTML = isCompanies ? relationChipsHtml() : sortChipsHtml();

  const qBox = document.getElementById('queue-box');
  if (qBox) qBox.innerHTML = queueHtml();
  hydrateQueueThumbs();

  const body = document.getElementById('list-body');
  if (!body) return;
  if (Store.loading && !Store.loaded && !Store.cards.length) {
    body.innerHTML = '<div class="empty">讀取中…</div>';
    return;
  }
  body.innerHTML = isCompanies ? companiesBodyHtml() : cardsBodyHtml();
  hydrateImages(body);
}

// 名片分頁的排序按鈕：內建四種＋她自己加的分組＋「＋」
function sortChipsHtml() {
  const opts = [['recent', '最新'], ['name', '姓名'], ['company', '公司'], ['date', '📅 日曆'],
    ...view.customSorts.map((k) => [`group:${k}`, GROUP_LABEL[k]])];
  return opts.map(([k, label]) =>
    `<button type="button" class="chip ${view.sort === k ? 'active' : ''}" data-action="sort" data-sort="${esc(k)}">${esc(label)}</button>`).join('')
    + '<button type="button" class="chip chip-add" data-action="add-sort" aria-label="新增排序">＋</button>';
}

// 公司分頁：用「關係」篩選
function relationChipsHtml() {
  const counts = optionCounts(Store.companies, 'relation');
  const missing = Store.companies.filter((co) => !co.relation).length;
  const opts = [['', '全部'], ...pickOptions(Store.companies, 'relation').map((v) => [v, `${v} ${counts.get(v) || 0}`])];
  if (missing) opts.push([UNGROUPED, `未填 ${missing}`]);
  return opts.map(([v, label]) =>
    `<button type="button" class="chip ${view.relation === v ? 'active' : ''}" data-action="relation" data-value="${esc(v)}">${esc(label)}</button>`).join('');
}

function cardsBodyHtml() {
  if (!Store.cards.length) {
    return `<div class="empty"><div class="empty-icon">🗂️</div><p>還沒有名片</p><p class="muted">按下面的「拍名片」，或從相簿一次選很多張</p></div>`;
  }
  const found = searchCards(Store.cards, view.query, companyOf);
  if (view.sort === 'date') return calendarHtml(found);
  if (!found.length) return `<div class="empty"><p>找不到「${esc(view.query)}」</p></div>`;

  if (view.sort.startsWith('group:')) {
    return groupCards(found, view.sort.slice(6), companyOf).map(([group, list]) =>
      `<div class="group-head">${esc(group)} <span class="group-n">${list.length}</span></div>${list.map(cardItemHtml).join('')}`).join('');
  }
  let html = '';
  let lastGroup = null;
  for (const card of sortCards(found, view.sort, companyNameOf)) {
    if (view.sort === 'company') {
      const group = companyNameOf(card) || '（沒有公司）';
      if (group !== lastGroup) {
        html += `<div class="group-head">${esc(group)}</div>`;
        lastGroup = group;
      }
    }
    html += cardItemHtml(card);
  }
  return html;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// 日曆：上面是月曆（有加名片的日子標張數），下面是那個月（或點選那天）的名片，依日期分段
function calendarHtml(cards) {
  const byDay = new Map();
  for (const card of cards) {
    const key = localDayKey(card.created_at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(card);
  }
  if (!view.month) {
    const latest = [...byDay.keys()].filter(Boolean).sort().at(-1);
    view.month = (latest || localDayKey(new Date().toISOString())).slice(0, 7);
  }
  const today = localDayKey(new Date().toISOString());
  const [y, m] = view.month.split('-').map(Number);
  const cells = monthGrid(view.month).map((day) => {
    if (!day) return '<span class="cal-cell blank"></span>';
    const n = byDay.get(day)?.length || 0;
    const cls = ['cal-cell', n ? 'has' : '', day === view.day ? 'sel' : '', day === today ? 'today' : ''].join(' ');
    return `<button type="button" class="${cls}" data-action="cal-day" data-day="${day}" ${n ? '' : 'disabled'}>
      <span class="cal-num">${Number(day.slice(8))}</span>${n ? `<span class="cal-n">${n}</span>` : ''}</button>`;
  }).join('');

  const days = [...byDay.keys()].filter((d) => (view.day ? d === view.day : d.startsWith(view.month))).sort().reverse();
  const monthTotal = [...byDay.entries()].filter(([d]) => d.startsWith(view.month)).reduce((s, [, l]) => s + l.length, 0);
  const listHtml = days.length
    ? days.map((d) => {
      const list = [...byDay.get(d)].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      const date = new Date(`${d}T00:00:00`);
      return `<div class="group-head">${date.getMonth() + 1}/${date.getDate()}（${WEEKDAYS[date.getDay()]}） <span class="group-n">${list.length} 張</span></div>${list.map(cardItemHtml).join('')}`;
    }).join('')
    : `<div class="empty small">${view.query ? `這個月沒有符合「${esc(view.query)}」的名片` : '這個月沒有加名片'}</div>`;

  return `
    <div class="cal">
      <div class="cal-head">
        <button type="button" class="icon-btn" data-action="cal-month" data-delta="-1" aria-label="上個月">‹</button>
        <span class="cal-title">${y} 年 ${m} 月 <span class="muted small">${monthTotal} 張</span></span>
        <button type="button" class="icon-btn" data-action="cal-month" data-delta="1" aria-label="下個月">›</button>
      </div>
      <div class="cal-grid">${WEEKDAYS.map((w) => `<span class="cal-week">${w}</span>`).join('')}${cells}</div>
      ${view.day ? `<div class="cal-filter">只看 ${Number(view.day.slice(5, 7))}/${Number(view.day.slice(8))} 加入的名片 <button type="button" class="chip" data-action="cal-day" data-day="">看整個月</button></div>` : ''}
    </div>
    ${listHtml}`;
}

function companiesBodyHtml() {
  if (!Store.companies.length) {
    return `<div class="empty"><div class="empty-icon">🏢</div><p>還沒有公司檔案</p>
      <p class="muted">拍名片時會自動建立；也可以在名片的編輯頁指定公司</p></div>`;
  }
  let list = sortCompanies(searchCompanies(Store.companies, view.query));
  if (view.relation) list = list.filter((co) => (co.relation || UNGROUPED) === view.relation);
  if (!list.length) return `<div class="empty"><p>找不到符合的公司</p></div>`;
  return list.map(companyItemHtml).join('');
}

function companyItemHtml(co) {
  const name = companyDisplayName(co);
  const full = cleanFullName(co.full_name);
  const n = Store.cardsOfCompany(co.id).length;
  const sub = [co.relation, co.industry, co.region].filter(Boolean).join(' · ') || co.about;
  return `
    <a class="card-item" href="#/company/${encodeURIComponent(co.id)}">
      <div class="card-thumb co-thumb"><span class="avatar">${esc(Array.from(name)[0] || '?')}</span></div>
      <div class="card-main">
        <div class="card-name">${esc(name)}${full && full !== name ? ` <span class="muted">${esc(full)}</span>` : ''}</div>
        <div class="card-sub">${esc(sub || '')}</div>
      </div>
      <span class="count-badge">${n} 張</span>
    </a>`;
}

function cardItemHtml(card) {
  const name = card.name || card.name_alt || '（沒有姓名）';
  const sub = [card.title, companyNameOf(card)].filter(Boolean).join(' · ');
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
        ${card.nationality ? `<div class="co-chips"><span class="tag tag-soft">🌏 ${esc(card.nationality)}</span></div>` : ''}
        ${role ? `<div class="person-role">${esc(role)}</div>` : ''}
        ${card.company ? `<div class="person-company">${esc(card.company)}</div>` : ''}
      </div>
      ${companyCardHtml(card)}
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

const autoTag = () => '<span class="auto-tag">自動產生</span>';

// 名片詳細頁裡的「公司小卡」：公司全名、在做什麼、關係／產業／地區、需求產品，點了進公司檔案
function companyCardHtml(card) {
  const co = companyOf(card);
  if (!co) return '';
  const auto = autoFieldSet(co);
  const name = companyDisplayName(co);
  const chips = [co.relation, co.industry, co.region, co.sales_type].filter(Boolean);
  const products = co.products.map((p) => `${p.name}${p.tons ? ` ${p.tons} 噸/月` : ''}`).join('、');
  return `
    <a class="co-card" href="#/company/${encodeURIComponent(co.id)}">
      <div class="co-card-head"><span class="co-card-name">🏢 ${esc(name)}</span><span class="co-card-go">公司檔案 ›</span></div>
      ${co.full_name && cleanFullName(co.full_name) !== name ? `<div class="co-card-full">${esc(co.full_name)}${auto.has('full_name') ? autoTag() : ''}</div>` : ''}
      ${co.about ? `<div class="co-card-about">${esc(co.about)}${auto.has('about') ? autoTag() : ''}</div>` : ''}
      ${chips.length ? `<div class="co-chips">${chips.map((c) => `<span class="tag tag-soft">${esc(c)}</span>`).join('')}</div>` : ''}
      ${products ? `<div class="co-card-products">需求產品：${esc(products)}</div>` : ''}
    </a>`;
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
  const result = await shareOrDownload(cardToVCard(card, companyOf(card)), `${name}.vcf`, 'text/vcard');
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
    // 名片沒變，但可能還沒有公司檔案（v0.3.0 以前拍的）→ 補建
    if (!companyOf(card)) {
      try {
        const linked = await Store.linkCompany(card, ocr.auto);
        if (linked.company_id) {
          await Store.update(linked);
          toast('名片沒有變，已補上公司檔案');
          return;
        }
      } catch (err) {
        handleError(err, '補公司檔案失敗');
        return;
      }
    }
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
  let updated = { ...card };
  for (const f of picked) updated[f] = ocr[f];
  if (ocr.raw_text) updated.raw_text = ocr.raw_text;
  try {
    // 順便補公司檔案（舊名片還沒有公司檔案的，重新辨識一次就會建好、填上 AI 查的全名和簡介）
    updated = await Store.linkCompany(updated, ocr.auto);
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
      ${EDITABLE_FIELDS.map(([key, label]) => (CARD_PICK_FIELDS.includes(key) ? `
        <div class="field">
          <span class="field-label">${esc(label)}</span>
          ${pickSelectHtml(key, card[key], key, Store.cards)}
        </div>` : `
        <label class="field">
          <span class="field-label">${esc(label)}</span>
          ${longFields.has(key)
            ? `<textarea name="${key}" rows="${key === 'note' ? 3 : 2}">${esc(card[key])}</textarea>`
            : `<input name="${key}" value="${esc(card[key])}" ${fieldInputAttrs(key)}>`}
        </label>`) + (key === 'company' ? companySelectHtml(card) : '')).join('')}
      <p class="muted small">多個電話或 Email 用逗號「,」隔開；標籤也用逗號隔開（例：客戶, 展覽）。飲食禁忌、宗教習慣這類特殊需求寫在「備註」。</p>
      <button type="submit" class="btn btn-primary btn-big">儲存</button>
    </form>`;
  hydrateImages($app);
  document.getElementById('edit-form').addEventListener('submit', (e) => { e.preventDefault(); onSave(); });
}

// 「所屬公司」選單：自動配對錯了可以在這裡改；也可以用「公司」欄建一個新的公司檔案
function companySelectHtml(card) {
  const current = companyOf(card)?.id || '';
  const options = sortCompanies(Store.companies).map((co) =>
    `<option value="${esc(co.id)}" ${co.id === current ? 'selected' : ''}>${esc(companyDisplayName(co))}</option>`).join('');
  return `
    <label class="field">
      <span class="field-label">所屬公司檔案 <span class="muted">（同公司的名片共用一份公司資料）</span></span>
      <select name="company_id">
        <option value="" ${current ? '' : 'selected'}>（不歸屬任何公司）</option>
        ${options}
        <option value="__new">＋ 用上面的「公司」欄建立新的公司檔案</option>
      </select>
    </label>`;
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
  for (const [key] of EDITABLE_FIELDS) {
    const v = (form.elements[key]?.value || '').trim();
    updated[key] = v === '__new' ? (card[key] || '') : v; // 下拉選單停在「＋ 新增選項」沒打字 → 維持原值
  }
  updated.status = 'ok';
  const pickedCompany = form.elements.company_id?.value ?? updated.company_id;
  saving = true;
  try {
    if (pickedCompany === '__new') {
      const co = makeCompanyFromCard(updated);
      if (!co) {
        toast('「公司」欄是空的，沒辦法建公司檔案');
        return;
      }
      await Store.addCompany(co);
      updated.company_id = co.id;
    } else {
      updated.company_id = pickedCompany;
    }
    await Store.update(updated);
    toast('已儲存');
    history.back();
  } catch (err) {
    handleError(err, '儲存失敗');
  } finally {
    saving = false;
  }
}

// ======================= 公司檔案頁 =======================

function renderCompany(id) {
  const co = Store.getCompany(id);
  $app.dataset.view = 'company';
  if (!co) {
    $app.innerHTML = `${topbar('公司檔案')}<div class="empty">${Store.loaded ? '找不到這個公司檔案（可能已經刪除）' : '讀取中…'}</div>`;
    return;
  }
  const auto = autoFieldSet(co);
  const name = companyDisplayName(co);
  const cards = sortCards(Store.cardsOfCompany(co.id), 'name');
  const chips = [co.relation, co.industry, co.region, co.sales_type].filter(Boolean);
  $app.innerHTML = `
    ${topbar('公司檔案', `<a class="topbar-action" href="#/company-edit/${encodeURIComponent(co.id)}">編輯</a>`)}
    <div class="detail">
      <div class="person">
        <h1>🏢 ${esc(name)}</h1>
        ${co.full_name && cleanFullName(co.full_name) !== name ? `<div class="person-alt">${esc(co.full_name)}${auto.has('full_name') ? autoTag() : ''}</div>` : ''}
        ${chips.length ? `<div class="co-chips">${chips.map((c) => `<span class="tag tag-soft">${esc(c)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="about-box">${co.about
        ? `${esc(co.about)}${auto.has('about') ? autoTag() : ''}`
        : '<span class="muted">還沒寫這家公司在做什麼，按右上角「編輯」補上</span>'}</div>
      <div class="section-title">需求產品</div>
      ${productsHtml(co)}
      <div class="section-title">公司資料</div>
      <div class="info-list">${companyInfoRows(co, auto) || '<div class="empty small">還沒有資料，按右上角「編輯」補上</div>'}</div>
      <div class="section-title">這家公司的名片（${cards.length} 張）</div>
      <div>${cards.map(cardItemHtml).join('') || '<div class="empty small">還沒有名片歸到這家公司</div>'}</div>
      <div class="detail-actions">
        <button type="button" class="btn btn-ghost danger-text" data-action="company-delete">🗑 刪除公司檔案（名片不會刪）</button>
      </div>
      <div class="meta">建立 ${esc(fmtTime(co.created_at))}${co.updated_at && co.updated_at !== co.created_at ? `　修改 ${esc(fmtTime(co.updated_at))}` : ''}</div>
    </div>`;
  hydrateImages($app);
}

function productsHtml(co) {
  if (!co.products.length) return '<div class="info-list"><div class="empty small">還沒填需求產品</div></div>';
  const { sum, skipped } = totalTons(co.products);
  return `
    <div class="info-list">
      ${co.products.map((p) => `
        <div class="prod-line"><span>${esc(p.name || '（沒寫產品名）')}</span><span class="muted">${p.tons ? `${esc(p.tons)} 噸/月` : '—'}</span></div>`).join('')}
      ${co.products.length > 1 ? `<div class="prod-line prod-total"><span>合計</span><span>${sum} 噸/月${skipped ? '（有幾筆不是數字沒算進去）' : ''}</span></div>` : ''}
    </div>`;
}

function companyInfoRows(co, auto) {
  const rows = [];
  // compact：下拉選單類的短欄位（關係、產業…）一行一個、不放複製鍵
  const row = (label, value, isAuto = false, actions = '', compact = false) => rows.push(`
    <div class="info-row">
      <div class="info-label">${esc(label)}</div>
      <div class="info-value">${esc(value)}${isAuto ? autoTag() : ''}</div>
      ${compact ? '' : `<div class="info-acts">${actions}<button type="button" class="chip" data-action="copy" data-text="${esc(value)}">複製</button></div>`}
    </div>`);
  for (const key of ['relation', 'industry', 'region', 'sales_type', 'material_source']) {
    if (co[key]) row(COMPANY_LABEL[key], co[key], auto.has(key), '', true);
  }
  if (co.full_name) row('公司全名', co.full_name, auto.has('full_name'));
  for (const w of splitMulti(co.website)) row('網站', w, false, `<a class="chip" href="${esc(withScheme(w))}" target="_blank" rel="noopener">開啟</a>`);
  if (co.domains) row('公司信箱網域', co.domains);
  if (co.note) row('備註', co.note);
  if (co.tags) row('標籤', co.tags);
  return rows.join('');
}

async function onCompanyDelete(co) {
  if (!co) return;
  const n = Store.cardsOfCompany(co.id).length;
  const ok = await confirmDialog({
    title: `刪除「${companyDisplayName(co)}」的公司檔案？`,
    message: `公司資料（在做什麼、需求產品、備註…）會從試算表刪掉。${n ? `這家公司的 ${n} 張名片不會刪，只是變成不歸屬任何公司。` : ''}`,
    okText: '刪除',
    danger: true,
  });
  if (!ok) return;
  try {
    await Store.removeCompany(co);
    toast('已刪除公司檔案');
    view.mode = 'companies';
    go('#/');
  } catch (err) {
    handleError(err, '刪除失敗');
  }
}

// ---- 編輯公司檔案 ----

// 下拉選單（可以「＋ 新增選項」）；選單內容＝預設值＋所有公司（或所有名片，list 決定）填過的值
function pickSelectHtml(name, value, field, list = Store.companies) {
  const options = pickOptions(list, field);
  if (value && !options.includes(value)) options.push(value);
  const label = COMPANY_LABEL[field] || FIELD_LABEL[field] || '選項';
  return `
    <select name="${esc(name)}" data-pick data-label="${esc(label)}" data-prev="${esc(value || '')}">
      <option value="">（未填）</option>
      ${options.map((o) => `<option value="${esc(o)}" ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      <option value="__new">＋ 新增選項…</option>
    </select>`;
}

function productRowHtml(p = { name: '', tons: '' }) {
  return `
    <div class="prod-row">
      ${pickSelectHtml('prod_name', p.name, PRODUCT_FIELD)}
      <input class="prod-tons" name="prod_tons" value="${esc(p.tons)}" inputmode="decimal" placeholder="月用量" aria-label="月用量（噸）">
      <span class="prod-unit">噸/月</span>
      <button type="button" class="icon-btn prod-del" data-action="remove-product" aria-label="刪除這個產品">✕</button>
    </div>`;
}

function renderCompanyEdit(id) {
  const co = Store.getCompany(id);
  $app.dataset.view = 'company-edit';
  if (!co) {
    $app.innerHTML = `${topbar('編輯公司檔案')}<div class="empty">找不到這個公司檔案</div>`;
    return;
  }
  const auto = autoFieldSet(co);
  const longFields = new Set(['about', 'note']);
  const fieldHtml = ([key, label]) => {
    const head = `<span class="field-label">${esc(label)}${auto.has(key) ? autoTag() : ''}</span>`;
    if (PICK_FIELDS.includes(key)) return `<div class="field">${head}${pickSelectHtml(key, co[key], key)}</div>`;
    if (longFields.has(key)) return `<label class="field">${head}<textarea name="${key}" rows="3">${esc(co[key])}</textarea></label>`;
    const attrs = key === 'website' || key === 'domains' ? 'inputmode="url" autocapitalize="off"' : '';
    return `<label class="field">${head}<input name="${key}" value="${esc(co[key])}" type="text" ${attrs}></label>`;
  };
  $app.innerHTML = `
    ${topbar('編輯公司檔案', '<button type="button" class="topbar-action" data-action="company-save">儲存</button>')}
    <form class="edit-form" id="company-form" data-id="${esc(co.id)}">
      ${COMPANY_FIELDS.map((f) => fieldHtml(f) + (f[0] === 'material_source' ? `
        <div class="field">
          <span class="field-label">需求產品（每個產品的月用量，單位：噸/月）</span>
          <div id="prod-list">${(co.products.length ? co.products : [undefined]).map(productRowHtml).join('')}</div>
          <button type="button" class="btn btn-small add-prod" data-action="add-product">＋ 新增產品</button>
        </div>` : '')).join('')}
      <p class="muted small">標「自動產生」的是 AI 從名片和官網查的，改過就不會再標。「公司信箱網域」用來把新名片自動歸到這家公司，多個用逗號隔開。</p>
      <button type="submit" class="btn btn-primary btn-big">儲存</button>
    </form>`;
  document.getElementById('company-form').addEventListener('submit', (e) => { e.preventDefault(); onCompanySave(); });
}

async function onCompanySave() {
  const form = document.getElementById('company-form');
  if (!form || saving) return;
  const co = Store.getCompany(form.dataset.id);
  if (!co) return;
  const updated = { ...co };
  for (const [key] of COMPANY_FIELDS) {
    const v = (form.elements[key]?.value || '').trim();
    updated[key] = v === '__new' ? (co[key] || '') : v;
  }
  updated.products = cleanProducts([...form.querySelectorAll('.prod-row')].map((rowEl) => {
    const name = rowEl.querySelector('select').value;
    return { name: name === '__new' ? '' : name, tons: rowEl.querySelector('.prod-tons').value };
  }));
  if (!updated.name && !updated.full_name) {
    toast('公司簡稱和全名至少要填一個');
    return;
  }
  // 改過的欄位就不再標「自動產生」
  const auto = autoFieldSet(co);
  for (const f of [...auto]) if ((updated[f] || '') !== (co[f] || '')) auto.delete(f);
  updated.auto_fields = [...auto].join(',');
  saving = true;
  try {
    await Store.updateCompany(updated);
    toast('已儲存');
    history.back();
  } catch (err) {
    handleError(err, '儲存失敗');
  } finally {
    saving = false;
  }
}

// 下拉選單選了「＋ 新增選項…」→ 跳出輸入框，打的字加進這個選單並選起來（存檔後所有公司的選單都會有）
async function onChange(e) {
  const sel = e.target.closest('select[data-pick]');
  if (!sel) return;
  if (sel.value !== '__new') {
    sel.dataset.prev = sel.value;
    return;
  }
  const text = await promptDialog({ title: `新增${sel.dataset.label}`, placeholder: '輸入新的選項', okText: '加入' });
  const v = (text || '').trim();
  if (!v) {
    sel.value = sel.dataset.prev || '';
    return;
  }
  addOption(sel, v);
  sel.value = v;
  sel.dataset.prev = v;
  // 產品名稱：其他列的選單也馬上看得到剛加的（不用等存檔）
  if (sel.name === 'prod_name') syncProductOptions();
}

function addOption(sel, value) {
  if (![...sel.options].some((o) => o.value === value)) {
    sel.insertBefore(new Option(value, value), sel.querySelector('option[value="__new"]'));
  }
}

// 需求產品每一列的選單內容對齊（新增的列也帶到這次編輯裡剛加的產品）
function syncProductOptions() {
  const selects = [...document.querySelectorAll('#prod-list select')];
  const values = new Set(selects.flatMap((s) => [...s.options].map((o) => o.value)).filter((v) => v && v !== '__new'));
  for (const s of selects) for (const v of values) addOption(s, v);
}

// ======================= 補查公司檔案 =======================
// v0.3.0 以前拍的名片沒有公司檔案；這裡把它們的照片重新交給辨識主機，只拿「公司檔案草稿」來用，名片欄位不動

let backfillRunning = false;

// 要補查的名片：有照片，而且（還沒歸屬公司、但有公司名或公司信箱）或（公司檔案的全名和簡介都空著）
function cardsNeedingProfile() {
  return Store.cards.filter((c) => {
    if (!c.photos?.length) return false;
    const co = companyOf(c);
    if (!co) return !!(c.company || cardDomains(c).length);
    return !co.full_name && !co.about;
  });
}

async function onBackfillCompanies() {
  if (backfillRunning) {
    toast('正在補查中，請等它跑完');
    return;
  }
  const targets = cardsNeedingProfile();
  if (!targets.length) {
    toast('所有名片的公司都有全名或簡介了');
    return;
  }
  const ok = await confirmDialog({
    title: `補查 ${targets.length} 張名片的公司檔案？`,
    message: '會請電腦上的 Claude 重新看這幾張名片的照片，查公司全名、在做什麼、產業和地區。只補公司檔案，名片上的資料不會改。一張大約 10～20 秒，同公司的第二張起會直接沿用；跑的時候 App 不要關。',
    okText: '開始',
  });
  if (!ok) return;
  backfillRunning = true;
  let linked = 0;   // 補到全名或簡介
  let notFound = 0; // 有公司檔案了，但 AI 查不到全名和簡介
  let skipped = 0;  // 名片上沒有公司名也沒有公司信箱
  let failed = 0;
  try {
    for (const [i, target] of targets.entries()) {
      toast(`補查公司檔案 ${i + 1}/${targets.length}…`, 60000);
      const card = Store.get(target.id);
      if (!card) continue;
      try {
        // 同公司前一張已經查好了 → 直接歸過去，不用再讀照片
        const known = matchCompany(card, Store.companies);
        const auto = known && (known.full_name || known.about)
          ? {}
          : (await recognizeCard(await backend.getPhoto(card.photos[0]))).auto;
        const result = await Store.linkCompany(card, auto);
        if (!result.company_id) {
          skipped += 1;
          continue;
        }
        if (result.company_id !== card.company_id) await Store.update(result);
        const co = Store.getCompany(result.company_id);
        if (co?.full_name || co?.about) linked += 1; else notFound += 1;
      } catch (err) {
        console.warn('backfill failed', card.id, err);
        failed += 1;
      }
    }
  } finally {
    backfillRunning = false;
  }
  toast(`補查完成：${linked} 張補到公司全名／簡介`
    + `${notFound ? `；${notFound} 張的公司 AI 查不到（公司檔案已建好，可以自己填）` : ''}`
    + `${skipped ? `；${skipped} 張名片上沒有公司名，略過` : ''}`
    + `${failed ? `；${failed} 張失敗（可以再按一次）` : ''}`, 6000);
  if (parseRoute().name === 'settings') renderSettings();
}

// ======================= 整理下拉選單 =======================
// 打錯字、同一個東西兩種寫法 → 在這裡改名合併（全部公司一起改）

// 選單欄位在哪裡：名片（個人，例如國籍）或公司檔案
const isCardField = (field) => CARD_PICK_FIELDS.includes(field);
const optionSource = (field) => (isCardField(field)
  ? { list: Store.cards, unit: '張名片', label: FIELD_LABEL[field], nameOf: (c) => c.name || c.name_alt || '（沒有姓名）', save: (c) => Store.update(c) }
  : { list: Store.companies, unit: '家公司', label: COMPANY_LABEL[field], nameOf: companyDisplayName, save: (c) => Store.updateCompany(c) });

function renderOptions() {
  $app.dataset.view = 'options';
  const fields = [...CARD_PICK_FIELDS, ...PICK_FIELDS, PRODUCT_FIELD];
  $app.innerHTML = `
    ${topbar('整理下拉選單')}
    <div class="settings">
      <p class="muted small">點一個選項可以改名（全部一起改），或全部清掉。數字＝有幾張名片／幾家公司在用。</p>
      ${fields.map((f) => {
        const src = optionSource(f);
        const counts = optionCounts(src.list, f);
        const opts = pickOptions(src.list, f);
        return `
          <section class="set-group">
            <div class="set-title">${esc(src.label)}${isCardField(f) ? '（名片）' : ''}</div>
            <div class="opt-chips">${opts.length
              ? opts.map((o) => `<button type="button" class="chip" data-action="opt-edit" data-field="${f}" data-value="${esc(o)}">${esc(o)} <span class="opt-n">${counts.get(o) || 0}</span></button>`).join('')
              : `<span class="muted small">還沒有選項（在${isCardField(f) ? '名片' : '公司'}編輯頁選「＋ 新增選項」就會出現在這裡）</span>`}</div>
          </section>`;
      }).join('')}
    </div>`;
}

async function onOptionEdit(field, value) {
  const src = optionSource(field);
  const n = optionCounts(src.list, field).get(value) || 0;
  const choice = await actionSheet(`「${value}」（${n} ${src.unit}在用）`, [
    { label: '改名（全部一起改）', value: 'rename' },
    { label: '全部清掉', value: 'clear', danger: true },
  ]);
  if (!choice) return;
  let to = '';
  if (choice === 'rename') {
    const input = await promptDialog({ title: `把「${value}」改成`, value, okText: '下一步' });
    to = (input || '').trim();
    if (!to || to === value) return;
  }
  const changed = renameOption(src.list, field, value, to);
  if (!changed.length) {
    toast(`沒有${src.unit.slice(1)}在用這個選項（預設選項會一直留在選單裡）`, 3500);
    return;
  }
  const names = changed.slice(0, 5).map(src.nameOf).join('、') + (changed.length > 5 ? '…' : '');
  const ok = await confirmDialog({
    title: choice === 'rename' ? `確定把「${value}」改成「${to}」？` : `確定全部清掉「${value}」？`,
    message: `會改到 ${changed.length} ${src.unit}：${names}`,
    okText: '確定',
    danger: choice === 'clear',
  });
  if (!ok) return;
  try {
    for (const item of changed) await src.save(item);
    toast(`已更新 ${changed.length} ${src.unit}`);
  } catch (err) {
    handleError(err, '更新失敗（可能只改了一部分，請重新整理後再看一次）');
  }
}

// ======================= 自訂排序 =======================

function saveCustomSorts() {
  localStorage.setItem('cardbox_custom_sorts', JSON.stringify(view.customSorts));
}

function setSort(sort) {
  view.sort = sort;
  localStorage.setItem('cardbox_sort', sort);
  updateListParts();
}

async function onAddSort() {
  const available = GROUP_FIELDS.filter(([key]) => !view.customSorts.includes(key));
  if (!available.length) {
    toast('能加的排序都加了');
    return;
  }
  const key = await actionSheet('新增排序：依哪個欄位分組？',
    available.map(([k, label, source]) => ({ label: `${label}${source === 'company' ? '（公司檔案）' : '（名片）'}`, value: k })));
  if (!key) return;
  view.customSorts.push(key);
  saveCustomSorts();
  setSort(`group:${key}`);
}

async function onRemoveSort(sort) {
  const key = sort.slice(6);
  const choice = await actionSheet(`「${GROUP_LABEL[key]}」排序`, [{ label: '移除這個排序按鈕', value: 'remove', danger: true }]);
  if (choice !== 'remove') return;
  view.customSorts = view.customSorts.filter((k) => k !== key);
  saveCustomSorts();
  setSort('recent');
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
      <section class="set-group">
        <div class="set-title">公司檔案</div>
        <a class="set-row link" href="#/options">🗂️ 整理下拉選單 <span class="muted">（國籍、關係、產業、地區、產品…改名或合併）</span></a>
        <button type="button" class="set-row link" data-action="backfill">🔄 補查公司檔案 <span class="muted">（${cardsNeedingProfile().length} 張名片的公司還沒有全名／簡介）</span></button>
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
      // 再點一次自己加的排序 → 問要不要移除
      if (el.dataset.sort === view.sort && view.sort.startsWith('group:')) onRemoveSort(view.sort);
      else setSort(el.dataset.sort);
      break;
    case 'add-sort': onAddSort(); break;
    case 'mode':
      view.mode = el.dataset.mode === 'companies' ? 'companies' : 'cards';
      localStorage.setItem('cardbox_mode', view.mode);
      renderList();
      break;
    case 'relation': view.relation = el.dataset.value; updateListParts(); break;
    case 'cal-month':
      view.month = shiftMonth(view.month, Number(el.dataset.delta));
      view.day = '';
      updateListParts();
      break;
    case 'cal-day':
      view.day = el.dataset.day === view.day ? '' : el.dataset.day;
      updateListParts();
      break;
    case 'company-save': onCompanySave(); break;
    case 'company-delete': onCompanyDelete(route.name === 'company' ? Store.getCompany(route.id) : null); break;
    case 'add-product':
      document.getElementById('prod-list')?.insertAdjacentHTML('beforeend', productRowHtml());
      syncProductOptions();
      break;
    case 'remove-product': el.closest('.prod-row')?.remove(); break;
    case 'opt-edit': onOptionEdit(el.dataset.field, el.dataset.value); break;
    case 'backfill': onBackfillCompanies(); break;
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
  const result = await shareOrDownload(cardsToVCard(sortCards(Store.cards, 'name'), companyOf), `名片盒_${stamp}.vcf`, 'text/vcard');
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
