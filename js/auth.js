// Google 登入（GIS token client，沿用 BroTrip 已驗證的寫法）
// 重點：
//  - token 只有 1 小時效期，過期先「安靜續登」；iPhone 主畫面 App 常常續不了 → 跳「重新連線」橫幅讓使用者點一下
//  - 首次登入用 consent（完整同意），之後用空 prompt（已同意過，秒回）

import { GOOGLE_CLIENT_ID, GOOGLE_SCOPES } from './config.js';

const TOKEN_KEY = 'cardbox_token';
const USER_KEY = 'cardbox_user';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const Auth = {
  user: null,          // { email, name, picture }
  accessToken: null,
  expiresAt: 0,
  tokenClient: null,

  // 等 Google 的登入程式載入完成（index.html 用 async 載入，所以要輪詢）
  init() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const wait = () => {
        if (window.google?.accounts?.oauth2) {
          this.tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID,
            scope: GOOGLE_SCOPES,
            callback: () => {},
          });
          this.restoreSession();
          resolve();
        } else if (Date.now() - started > 15000) {
          reject(new Error('Google 登入元件載入失敗，請檢查網路後重新整理'));
        } else {
          setTimeout(wait, 100);
        }
      };
      wait();
    });
  },

  restoreSession() {
    try {
      const savedUser = localStorage.getItem(USER_KEY);
      if (savedUser) this.user = JSON.parse(savedUser);
      const savedToken = localStorage.getItem(TOKEN_KEY);
      if (savedToken) {
        const { accessToken, expiresAt } = JSON.parse(savedToken);
        if (accessToken && expiresAt > Date.now() + 60000) {
          this.accessToken = accessToken;
          this.expiresAt = expiresAt;
          return true;
        }
      }
    } catch (err) {
      console.warn('restoreSession failed:', err);
    }
    return false;
  },

  saveToken() {
    try {
      localStorage.setItem(TOKEN_KEY, JSON.stringify({
        accessToken: this.accessToken,
        expiresAt: this.expiresAt,
      }));
    } catch {}
  },

  // 登入（按鈕觸發）。換帳號 → select_account；登入過 → 空 prompt；第一次 → consent
  login(opts = {}) {
    if (opts.forceSelectAccount) return this._requestToken('select_account', false);
    if (localStorage.getItem(USER_KEY)) return this._requestToken('', true);
    return this._requestToken('consent', false);
  },

  _requestToken(prompt, allowFallback) {
    return new Promise((resolve, reject) => {
      this.tokenClient.callback = async (resp) => {
        if (resp.error) {
          if (allowFallback) this._requestToken('consent', false).then(resolve, reject);
          else reject(new Error(resp.error_description || resp.error));
          return;
        }
        this._takeToken(resp);
        // 使用者如果在授權畫面把「雲端硬碟」取消勾選，之後所有存取都會失敗 → 先告訴 App
        const missingDrive = !(resp.scope || '').includes(DRIVE_FILE_SCOPE);
        try {
          this.user = await this.fetchUserInfo();
          localStorage.setItem(USER_KEY, JSON.stringify(this.user));
          resolve({ ...this.user, missingDrive });
        } catch (err) {
          reject(err);
        }
      };
      // 使用者關掉彈出視窗時 GIS 不會呼叫 callback，而是這個
      this.tokenClient.error_callback = (err) => {
        reject(new Error(err?.type === 'popup_closed' ? '登入視窗被關掉了' : (err?.message || '登入失敗')));
      };
      this.tokenClient.requestAccessToken({ prompt });
    });
  },

  _takeToken(resp) {
    this.accessToken = resp.access_token;
    this.expiresAt = Date.now() + resp.expires_in * 1000 - 30000; // 提早 30 秒當作過期
    this.saveToken();
  },

  async fetchUserInfo() {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!r.ok) throw new Error('讀取帳號資料失敗');
    const info = await r.json();
    return { email: info.email, name: info.name || info.email, picture: info.picture || '' };
  },

  // 每次呼叫 Google API 前都先拿一次 token；過期就安靜續登（最多試 2 次）
  async ensureToken() {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this._silentRefresh();
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
      }
    }
    window.dispatchEvent(new CustomEvent('cardbox:auth-expired'));
    throw lastErr || new Error('登入已過期');
  },

  _silentRefresh() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('續登逾時')), 8000);
      this.tokenClient.callback = (resp) => {
        clearTimeout(timer);
        if (resp.error) { reject(new Error(resp.error)); return; }
        this._takeToken(resp);
        resolve(this.accessToken);
      };
      this.tokenClient.error_callback = (err) => {
        clearTimeout(timer);
        reject(new Error(err?.type || '續登失敗'));
      };
      this.tokenClient.requestAccessToken({ prompt: '' });
    });
  },

  logout() {
    if (this.accessToken) {
      try { google.accounts.oauth2.revoke(this.accessToken, () => {}); } catch {}
    }
    this.accessToken = null;
    this.user = null;
    this.expiresAt = 0;
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(TOKEN_KEY);
  },

  isLoggedIn() {
    return !!this.accessToken && Date.now() < this.expiresAt;
  },
};
