// 試玩模式（網址加 ?demo=1）：不連 Google、不花 AI 錢，用假資料把整個流程跑一遍
// 用途：還沒設定 Google／中繼站前先看畫面、改 UI 時快速測試

import { rowToCard, cardToRow } from './cards.js';
import { kvDb } from './localdb.js';

const CARDS_KEY = 'demo_cards';

// 假的辨識結果。第 2 筆是第 1 筆的「英文背面」（手機相同）→ 用來測正反面自動合併
const SAMPLES = [
  {
    name: '王小明', name_alt: '', company: '星辰半導體股份有限公司', department: '業務部',
    title: '資深業務經理', mobile: '0912-345-678', phone: '(02) 2345-6789 #321', fax: '(02) 2345-6790',
    email: 'ming.wang@example.com', website: 'www.example.com', address: '台北市信義區松仁路 100 號 20 樓',
    social: 'LINE: ming0912', raw_text: '星辰半導體\n王小明 資深業務經理\n0912-345-678', is_business_card: true,
  },
  {
    name: 'Ming Wang', name_alt: '', company: 'Star Semiconductor Corp.', department: 'Sales',
    title: 'Senior Sales Manager', mobile: '+886 912 345 678', phone: '', fax: '',
    email: 'ming.wang@example.com', website: '', address: '20F, No. 100, Songren Rd., Taipei',
    social: '', raw_text: 'Star Semiconductor\nMing Wang\nSenior Sales Manager', is_business_card: true,
  },
  {
    name: '陳美玲', name_alt: 'Meiling Chen', company: '綠野設計工作室', department: '',
    title: '創意總監', mobile: '0988-111-222', phone: '', fax: '',
    email: 'meiling@greenfield.example', website: 'greenfield.example', address: '台中市西區公益路 50 號',
    social: 'IG: @greenfield.design', raw_text: '綠野設計\n陳美玲 創意總監', is_business_card: true,
  },
  {
    name: '林志豪', name_alt: '', company: '海風餐飲集團', department: '採購處',
    title: '採購專員', mobile: '0933-456-789', phone: '07-555-1234', fax: '',
    email: 'hao.lin@seabreeze.example', website: '', address: '高雄市前鎮區成功二路 8 號',
    social: '', raw_text: '海風餐飲集團 採購處\n林志豪', is_business_card: true,
  },
];

let sampleIndex = 0;

export async function demoRecognize() {
  await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800)); // 假裝 AI 在想
  const s = SAMPLES[sampleIndex % SAMPLES.length];
  sampleIndex += 1;
  return { ...s };
}

// 假的「雲端」：名片存在這台電腦的 IndexedDB，照片也是
export function createDemoBackend() {
  async function load() {
    return (await kvDb.get(CARDS_KEY)) || [];
  }
  async function save(rows) {
    await kvDb.put(CARDS_KEY, rows);
  }

  return {
    name: 'demo',

    async listCards() {
      const rows = await load();
      return rows.map((row, i) => rowToCard(row, i + 2)).filter((c) => c.id);
    },

    async appendCard(card) {
      const rows = await load();
      rows.push(cardToRow(card));
      await save(rows);
    },

    async updateCard(card) {
      const rows = await load();
      const idx = rows.findIndex((r) => r[0] === card.id);
      if (idx < 0) throw new Error('找不到這張名片');
      rows[idx] = cardToRow(card);
      await save(rows);
    },

    async deleteCard(card) {
      const rows = (await load()).filter((r) => r[0] !== card.id);
      await save(rows);
    },

    async uploadPhoto(blob) {
      await new Promise((r) => setTimeout(r, 300));
      const id = `demo_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      await kvDb.put(`demo_photo_${id}`, blob);
      return id;
    },

    async getPhoto(fileId) {
      const blob = await kvDb.get(`demo_photo_${fileId}`);
      if (!blob) throw new Error('試玩照片不見了');
      return blob;
    },

    async links() {
      return { sheet: '', folder: '' };
    },

    resetWorkspace() {},
  };
}
