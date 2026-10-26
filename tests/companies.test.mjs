// 公司檔案、自訂分組、日曆的邏輯測試（不用瀏覽器）
// 用法：node --test C:/Users/User/projects/CardBox/tests/companies.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANY_COLUMNS, rowToCompany, companyToRow, cleanOcrResult, makeCardFromOcr, rowToCard, cardToRow,
  cardDomains, baseDomain, companyNameKey, matchCompany, makeCompanyFromCard, fillCompanyFromCard,
  pickOptions, optionCounts, renameOption, totalTons, groupCards, UNGROUPED, searchCards, searchCompanies,
  cardToVCard, localDayKey, monthGrid, shiftMonth, PRODUCT_FIELD, autoFieldSet,
} from '../js/cards.js';

const NOW = new Date('2026-10-27T01:00:00+08:00');

const greifOcr = cleanOcrResult({
  name: 'Alex Chen', company: 'GREIF', email: 'alex.chen@us.greif.com', address: 'Delaware, OH, USA',
  is_business_card: true,
  company_full: 'Greif, Inc.', company_about: '工業包裝製造商', company_industry: '工業包裝', company_region: '美國',
});

test('辨識結果會帶出公司檔案草稿；舊版主機沒有這幾欄就是空白', () => {
  assert.deepEqual(greifOcr.auto, { full_name: 'Greif, Inc.', about: '工業包裝製造商', industry: '工業包裝', region: '美國' });
  const old = cleanOcrResult({ name: 'A', company: 'B' });
  assert.deepEqual(old.auto, { full_name: '', about: '', industry: '', region: '' });
});

test('名片多了 company_id 欄，舊的 20 欄資料讀進來不會錯位', () => {
  const card = { ...makeCardFromOcr(greifOcr, 'p1', NOW), company_id: 'co_x' };
  assert.equal(rowToCard(cardToRow(card), 2).company_id, 'co_x');
  const oldRow = cardToRow(card).slice(0, 20);
  assert.equal(rowToCard(oldRow, 2).company_id, '');
  assert.equal(rowToCard(oldRow, 2).raw_text, card.raw_text);
});

test('公司信箱網域：收斂到主網域、排除免費信箱和社群', () => {
  assert.equal(baseDomain('sales.sfa.com.tw'), 'sfa.com.tw');
  assert.equal(baseDomain('www.greif.com'), 'greif.com');
  assert.equal(baseDomain('abc.co.uk'), 'abc.co.uk');
  assert.deepEqual(cardDomains({ email: 'a@gmail.com, b@ms12.hinet.net, c@mail.sfa.com.tw', website: 'www.sfa.com.tw/zh, facebook.com/sfa' }),
    ['sfa.com.tw']);
});

test('公司名骨幹：去掉公司尾巴與標點，簡稱和全名寫法不同也能比', () => {
  assert.equal(companyNameKey('台灣積體電路製造股份有限公司'), '台灣積體電路製造');
  assert.equal(companyNameKey('Greif, Inc.'), 'greif');
  assert.equal(companyNameKey('GREIF'), 'greif');
  assert.equal(companyNameKey('S.F.A. Co., Ltd.（待確認）'), 'sfa');
  assert.equal(companyNameKey(''), '');
});

test('建立公司檔案：AI 草稿填進去並標成自動產生', () => {
  const card = makeCardFromOcr(greifOcr, 'p1', NOW);
  const co = makeCompanyFromCard(card, greifOcr.auto, NOW);
  assert.equal(co.name, 'GREIF');
  assert.equal(co.full_name, 'Greif, Inc.');
  assert.equal(co.region, '美國');
  assert.equal(co.domains, 'greif.com');
  assert.deepEqual([...autoFieldSet(co)].sort(), ['about', 'full_name', 'industry', 'region']);
  assert.equal(makeCompanyFromCard({ company: '', email: 'x@gmail.com' }, {}, NOW), null);
});

test('自動配對：先比網域，沒有公司信箱才比名字', () => {
  const co = makeCompanyFromCard(makeCardFromOcr(greifOcr, 'p1', NOW), greifOcr.auto, NOW);
  // 名字寫法不同、但同網域 → 同一家
  assert.equal(matchCompany({ company: 'Greif Packaging', email: 'bob@greif.com' }, [co]), co);
  // 沒有公司信箱、名字對得上全名 → 同一家
  assert.equal(matchCompany({ company: 'Greif, Inc.', email: 'bob@gmail.com' }, [co]), co);
  // 都對不上 → 新公司
  assert.equal(matchCompany({ company: 'SFA', email: 'x@sfa.com.tw' }, [co]), null);
});

test('補公司檔案：只補空欄，她改過的不蓋；新網域會加進去', () => {
  const base = makeCompanyFromCard({ company: 'SFA', email: 'a@sfa.com.tw' }, {}, NOW);
  const edited = { ...base, about: '她自己寫的', relation: '直接用戶' };
  const { company, changed } = fillCompanyFromCard(edited,
    { company: 'SFA', email: 'b@sfa-group.com' }, { full_name: 'SFA Group Co., Ltd.', about: 'AI 寫的' }, NOW);
  assert.equal(changed, true);
  assert.equal(company.about, '她自己寫的');
  assert.equal(company.full_name, 'SFA Group Co., Ltd.');
  assert.equal(company.domains, 'sfa.com.tw, sfa-group.com');
  assert.deepEqual([...autoFieldSet(company)], ['full_name']);
  const again = fillCompanyFromCard(company, { company: 'SFA', email: 'b@sfa-group.com' }, {}, NOW);
  assert.equal(again.changed, false);
});

test('Companies 分頁列 ↔ 物件（需求產品存成 JSON）', () => {
  const co = { ...makeCompanyFromCard({ company: 'SFA' }, {}, NOW), products: [{ name: 'PP 粒', tons: '20' }, { name: '', tons: '' }] };
  const row = companyToRow(co);
  assert.equal(row.length, COMPANY_COLUMNS.length);
  const back = rowToCompany(row, 3);
  assert.deepEqual(back.products, [{ name: 'PP 粒', tons: '20' }]);
  assert.deepEqual(rowToCompany([], 4).products, []);
});

test('每月總噸數：數字相加，打了非數字會提醒', () => {
  assert.deepEqual(totalTons([{ name: 'A', tons: '20' }, { name: 'B', tons: '5.5' }]), { sum: 25.5, skipped: false });
  assert.deepEqual(totalTons([{ name: 'A', tons: '約 20' }, { name: 'B', tons: '看季節' }]), { sum: 20, skipped: true });
});

test('下拉選單：預設值在前，填過的新值自動加入，改名會全部公司一起改', () => {
  const a = { id: 'a', relation: '直接用戶', industry: '包裝', products: [{ name: 'PP', tons: '1' }] };
  const b = { id: 'b', relation: '代理商', industry: '包裝', products: [{ name: 'PP', tons: '2' }, { name: 'PE', tons: '' }] };
  assert.deepEqual(pickOptions([a, b], 'relation'), ['貿易商', '直接用戶', '代理商']);
  assert.deepEqual(pickOptions([a, b], PRODUCT_FIELD), ['PP', 'PE']);
  assert.equal(optionCounts([a, b], 'industry').get('包裝'), 2);
  const renamed = renameOption([a, b], 'industry', '包裝', '包裝材料', NOW);
  assert.equal(renamed.length, 2);
  assert.equal(renamed[0].industry, '包裝材料');
  const prod = renameOption([a, b], PRODUCT_FIELD, 'PP', 'PP 粒', NOW);
  assert.deepEqual(prod[1].products.map((p) => p.name), ['PP 粒', 'PE']);
  const cleared = renameOption([a, b], 'relation', '代理商', '', NOW);
  assert.equal(cleared[0].relation, '');
});

test('自訂分組：公司欄位跟著公司檔案、標籤一張可以進好幾組、沒填的放最後', () => {
  const coA = { id: 'A', relation: '直接用戶', products: [{ name: 'PP' }, { name: 'PE' }] };
  const cards = [
    { id: '1', name: '乙', company_id: 'A', tags: '展覽, 客戶' },
    { id: '2', name: '甲', company_id: '', tags: '' },
  ];
  const companyOf = (c) => (c.company_id === 'A' ? coA : null);
  const byRel = groupCards(cards, 'relation', companyOf);
  assert.deepEqual(byRel.map(([g, list]) => [g, list.map((c) => c.id)]), [['直接用戶', ['1']], [UNGROUPED, ['2']]]);
  const byTag = groupCards(cards, 'tags', companyOf);
  assert.deepEqual(byTag.map(([g]) => g).at(-1), UNGROUPED);
  assert.equal(byTag.length, 3);
  assert.deepEqual(groupCards(cards, PRODUCT_FIELD, companyOf).map(([g]) => g), ['PE', 'PP', UNGROUPED]);
});

test('搜尋會連公司檔案一起找（打產品或簡介找得到人）', () => {
  const co = { id: 'A', name: 'SFA', about: '做鋼桶的', products: [{ name: 'HDPE' }] };
  const cards = [{ id: '1', name: '王', company: 'SFA', company_id: 'A' }, { id: '2', name: '李', company: 'X' }];
  const companyOf = (c) => (c.company_id === 'A' ? co : null);
  assert.deepEqual(searchCards(cards, '鋼桶', companyOf).map((c) => c.id), ['1']);
  assert.deepEqual(searchCards(cards, 'hdpe', companyOf).map((c) => c.id), ['1']);
  assert.deepEqual(searchCompanies([co], '鋼桶').map((c) => c.id), ['A']);
});

test('通訊錄：公司欄照名片印的，全名寫進備註（待確認的字樣拿掉）', () => {
  const vcf = cardToVCard({ name: '王', company: 'SFA', photos: [] }, { full_name: 'SFA Group Co., Ltd.（待確認）' });
  assert.match(vcf, /ORG:SFA/);
  assert.ok(vcf.includes('公司全名：SFA Group Co.\\, Ltd.'));
  assert.ok(!vcf.includes('待確認'));
});

test('國籍（個人欄位）：存得回來、搜得到、能分組、選單用名片填過的值、寫進通訊錄備註', () => {
  const card = { ...makeCardFromOcr(greifOcr, 'p1', NOW), nationality: '印度', note: '不吃牛' };
  assert.equal(rowToCard(cardToRow(card), 2).nationality, '印度');
  assert.equal(rowToCard(cardToRow(card).slice(0, 21), 2).nationality, '', 'v0.3.0 的 21 欄資料讀進來國籍是空白');
  const other = { id: 'x', name: '李', nationality: '日本' };
  assert.deepEqual(searchCards([card, other], '印度').map((c) => c.name), ['Alex Chen']);
  assert.deepEqual(groupCards([card, other], 'nationality').map(([g]) => g).sort(), ['印度', '日本']);
  assert.deepEqual(pickOptions([card, other, { nationality: '印度' }], 'nationality'), ['印度', '日本']);
  assert.ok(cardToVCard(card).includes('國籍：印度'));
});

test('日曆：用手機當地日期分組、月曆格子從星期日開始', () => {
  assert.equal(localDayKey('2026-10-26T16:46:03.507Z'), '2026-10-27'); // 台灣時間 10/27 00:46（測試要用 TZ=Asia/Taipei 跑）
  assert.equal(localDayKey('壞掉的'), '');
  const grid = monthGrid('2026-10');
  assert.equal(grid.indexOf('2026-10-01'), 4); // 2026/10/1 是星期四
  assert.equal(grid.at(-1), '2026-10-31');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
});
