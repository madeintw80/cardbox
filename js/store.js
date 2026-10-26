// 名片和公司檔案的「狀態中心」：畫面要的資料都從這裡拿；改資料一律走這裡（先寫雲端、成功才改畫面）

import { DEMO_MODE } from './config.js';
import { Auth } from './auth.js';
import { createGoogleBackend } from './google.js';
import { createDemoBackend } from './demo.js';
import { kvDb } from './localdb.js';
import { matchCompany, fillCompanyFromCard, makeCompanyFromCard } from './cards.js';

export const backend = DEMO_MODE ? createDemoBackend() : createGoogleBackend();

const listeners = new Set();
const cacheKey = () => `cards_${DEMO_MODE ? 'demo' : (Auth.user?.email || '')}`;

export const Store = {
  cards: [],
  companies: [],
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

  getCompany(id) {
    return id ? this.companies.find((co) => co.id === id) || null : null;
  },

  // 名片 → 它的公司檔案（公司被刪掉的話當作沒有）
  companyOf(card) {
    return card ? this.getCompany(card.company_id) : null;
  },

  cardsOfCompany(companyId) {
    return this.cards.filter((c) => c.company_id === companyId);
  },

  // 先顯示上次存在手機的清單（秒開、沒網路也看得到），再去雲端拿最新的
  async loadCached() {
    const cached = await kvDb.get(cacheKey()).catch(() => null);
    if (cached && !this.loaded) {
      // v0.2.0 存的是名片陣列；v0.3.0 起是 { cards, companies }
      this.cards = Array.isArray(cached) ? cached : (cached.cards || []);
      this.companies = Array.isArray(cached) ? [] : (cached.companies || []);
      this.emit();
    }
  },

  async refresh() {
    this.loading = true;
    this.emit();
    try {
      // 先讀名片：舊試算表在這一步會自動補上公司分頁，再讀公司才不會撞在一起
      const cards = await backend.listCards();
      const companies = await backend.listCompanies();
      this.cards = cards;
      this.companies = companies;
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

  async addCompany(co) {
    await backend.appendCompany(co);
    this.companies.push(co);
    await this._persist();
    this.emit();
  },

  async updateCompany(co) {
    const updated = { ...co, updated_at: new Date().toISOString() };
    await backend.updateCompany(updated);
    this.companies = this.companies.map((c) => (c.id === updated.id ? updated : c));
    await this._persist();
    this.emit();
    return updated;
  },

  // 刪公司檔案：名片不刪，只是變成「不歸屬任何公司」（名片上的 company_id 留著也沒關係，找不到就當沒有）
  async removeCompany(co) {
    await backend.deleteCompany(co);
    this.companies = this.companies.filter((c) => c.id !== co.id);
    await this._persist();
    this.emit();
  },

  // 名片 → 找到（或建立）它的公司檔案，順便把 AI 草稿填進公司「還空著」的欄位
  // 回傳帶 company_id 的名片（名片本身還沒存，由呼叫的人存）
  async linkCompany(card, auto = {}) {
    let company = this.companyOf(card) || matchCompany(card, this.companies);
    if (company) {
      const { company: filled, changed } = fillCompanyFromCard(company, card, auto);
      if (changed) company = await this.updateCompany(filled);
    } else {
      company = makeCompanyFromCard(card, auto);
      if (!company) return card; // 沒有公司名也沒有公司信箱 → 不歸屬
      await this.addCompany(company);
    }
    return card.company_id === company.id ? card : { ...card, company_id: company.id };
  },

  async _persist() {
    await kvDb.put(cacheKey(), { cards: this.cards, companies: this.companies }).catch(() => {});
  },

  reset() {
    this.cards = [];
    this.companies = [];
    this.loaded = false;
    this.emit();
  },
};
