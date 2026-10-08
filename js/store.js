// 名片清單的「狀態中心」：畫面要的名片都從這裡拿；改資料一律走這裡（先寫雲端、成功才改畫面）

import { DEMO_MODE } from './config.js';
import { Auth } from './auth.js';
import { createGoogleBackend } from './google.js';
import { createDemoBackend } from './demo.js';
import { kvDb } from './localdb.js';

export const backend = DEMO_MODE ? createDemoBackend() : createGoogleBackend();

const listeners = new Set();
const cacheKey = () => `cards_${DEMO_MODE ? 'demo' : (Auth.user?.email || '')}`;

export const Store = {
  cards: [],
  loaded: false,     // 有沒有成功從雲端讀過一次
  loading: false,

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  emit() {
    for (const fn of listeners) fn();
  },

  get(id) {
    return this.cards.find((c) => c.id === id) || null;
  },

  // 先顯示上次存在手機的清單（秒開、沒網路也看得到），再去雲端拿最新的
  async loadCached() {
    const cached = await kvDb.get(cacheKey()).catch(() => null);
    if (cached && !this.loaded) {
      this.cards = cached;
      this.emit();
    }
  },

  async refresh() {
    this.loading = true;
    this.emit();
    try {
      this.cards = await backend.listCards();
      this.loaded = true;
      await this._persist();
    } finally {
      this.loading = false;
      this.emit();
    }
  },

  async add(card) {
    await backend.appendCard(card);
    this.cards.push(card);
    await this._persist();
    this.emit();
  },

  async update(card) {
    const updated = { ...card, updated_at: new Date().toISOString() };
    await backend.updateCard(updated);
    this.cards = this.cards.map((c) => (c.id === updated.id ? updated : c));
    await this._persist();
    this.emit();
    return updated;
  },

  async remove(card) {
    await backend.deleteCard(card);
    this.cards = this.cards.filter((c) => c.id !== card.id);
    await this._persist();
    this.emit();
  },

  async _persist() {
    await kvDb.put(cacheKey(), this.cards).catch(() => {});
  },

  reset() {
    this.cards = [];
    this.loaded = false;
    this.emit();
  },
};
