// 試玩模式（網址加 ?demo=1）：不連 Google、不花 AI 錢，用假資料把整個流程跑一遍
// 用途：還沒設定 Google／中繼站前先看畫面、改 UI 時快速測試

import { rowToCard, cardToRow, rowToCompany, companyToRow } from './cards.js';
import { kvDb } from './localdb.js';

const CARDS_KEY = 'demo_cards';
const COMPANIES_KEY = 'demo_companies';

// 假的辨識結果。第 2 筆是第 1 筆的「英文背面」（手機相同）→ 用來測正反面自動合併
// 第 5、6 筆是同一家只印簡寫的公司（同網域）→ 用來測公司檔案自動歸到同一家、全名只查一次
// company_* 是辨識主機順便查的公司檔案草稿
const SAMPLES = [
  {
    name: '王小明', name_alt: '', company: '星辰半導體股份有限公司', department: '業務部',
    title: '資深業務經理', mobile: '0912-345-678', phone: '(02) 2345-6789 #321', fax: '(02) 2345-6790',
    email: 'ming.wang@star-semi.example', website: 'www.star-semi.example', address: '台北市信義區松仁路 100 號 20 樓',
    social: 'LINE: ming0912', raw_text: '星辰半導體\n王小明 資深業務經理\n0912-345-678', is_business_card: true,
    company_full: '', company_about: '設計並銷售電源管理晶片的 IC 設計公司。', company_industry: '半導體', company_region: '台北市',
  },
  {
    name: 'Ming Wang', name_alt: '', company: 'Star Semiconductor Corp.', department: 'Sales',
    title: 'Senior Sales Manager', mobile: '+886 912 345 678', phone: '', fax: '',
    email: 'ming.wang@star-semi.example', website: '', address: '20F, No. 100, Songren Rd., Taipei',
    social: '', raw_text: 'Star Semiconductor\nMing Wang\nSenior Sales Manager', is_business_card: true,
    company_full: '', company_about: '', company_industry: '', company_region: '',
  },
  {
    name: '陳美玲', name_alt: 'Meiling Chen', company: '綠野設計工作室', department: '',
    title: '創意總監', mobile: '0988-111-222', phone: '', fax: '',
    email: 'meiling@greenfield.example', website: 'greenfield.example', address: '台中市西區公益路 50 號',
    social: 'IG: @greenfield.design', raw_text: '綠野設計\n陳美玲 創意總監', is_business_card: true,
    company_full: '', company_about: '', company_industry: '', company_region: '台中市',
  },
  {
    name: '林志豪', name_alt: '', company: '海風餐飲集團', department: '採購處',
    title: '採購專員', mobile: '0933-456-789', phone: '07-555-1234', fax: '',
    email: 'hao.lin@seabreeze.example', website: '', address: '高雄市前鎮區成功二路 8 號',
    social: '', raw_text: '海風餐飲集團 採購處\n林志豪', is_business_card: true,
    company_full: '海風餐飲集團股份有限公司（待確認）', company_about: '經營連鎖海鮮餐廳與團膳。', company_industry: '餐飲', company_region: '高雄市',
  },
  {
    name: 'Daniel Wu', name_alt: '吳大年', company: 'ACME', department: 'Asia Sales',
    title: 'Sales Director', mobile: '+886 920 111 333', phone: '+1 614 555 0100', fax: '',
    email: 'daniel.wu@acme-pack.example', website: 'www.acme-pack.example', address: '100 Main St, Columbus, OH, USA',
    social: '', raw_text: 'ACME\nDaniel Wu\nSales Director', is_business_card: true,
    company_full: 'Acme Industrial Packaging, Inc.', company_about: '工業包裝製造商，生產鋼桶、塑膠桶與中型散裝容器。',
    company_industry: '工業包裝', company_region: '美國',
  },
  {
    name: 'Grace Lin', name_alt: '', company: 'ACME', department: 'Procurement',
    title: 'Buyer', mobile: '', phone: '+1 614 555 0123', fax: '',
    email: 'grace.lin@asia.acme-pack.example', website: '', address: 'Columbus, OH, USA',
    social: '', raw_text: 'ACME\nGrace Lin\nBuyer', is_business_card: true,
    company_full: 'Acme Industrial Packaging, Inc.', company_about: '工業包裝製造商，生產鋼桶、塑膠桶與中型散裝容器。',
    company_industry: '工業包裝', company_region: '美國',
  },
];

let sampleIndex = 0;

export async function demoRecognize() {
  await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800)); // 假裝 AI 在想
  const s = SAMPLES[sampleIndex % SAMPLES.length];
  sampleIndex += 1;
  return { ...s };
}

// 假的「雲端」：名片和公司存在這台電腦的 IndexedDB，照片也是
// 每個分頁一組增刪改查，邏輯跟真的試算表一樣（一列＝一個陣列）
function demoTable(key, fromRow, toRow) {
  const load = async () => (await kvDb.get(key)) || [];
  const save = (rows) => kvDb.put(key, rows);
  return {
    async list() {
      return (await load()).map((row, i) => fromRow(row, i + 2)).filter((x) => x.id);
    },
    async append(obj) {
      const rows = await load();
      rows.push(toRow(obj));
      await save(rows);
    },
    async update(obj) {
      const rows = await load();
      const idx = rows.findIndex((r) => r[0] === obj.id);
      if (idx < 0) throw new Error('找不到這筆資料');
      rows[idx] = toRow(obj);
      await save(rows);
    },
    async remove(obj) {
      await save((await load()).filter((r) => r[0] !== obj.id));
    },
  };
}

export function createDemoBackend() {
  const cards = demoTable(CARDS_KEY, rowToCard, cardToRow);
  const companies = demoTable(COMPANIES_KEY, rowToCompany, companyToRow);

  return {
    name: 'demo',

    listCards: () => cards.list(),
    appendCard: (card) => cards.append(card),
    updateCard: (card) => cards.update(card),
    deleteCard: (card) => cards.remove(card),

    listCompanies: () => companies.list(),
    appendCompany: (co) => companies.append(co),
    updateCompany: (co) => companies.update(co),
    deleteCompany: (co) => companies.remove(co),

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
