// 名片核心邏輯測試（不用瀏覽器）
// 用法：node --test C:/Users/User/projects/CardBox/tests/cards.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMNS, rowToCard, cardToRow, cleanOcrResult, makeCardFromOcr, mergeBackSide,
  isSamePerson, normalizePhone, searchCards, sortCards, cardToVCard, splitMulti, telHref, hasCjk,
} from '../js/cards.js';

const zhFront = cleanOcrResult({
  name: '王小明', company: '星辰半導體', title: '經理', mobile: '0912-345-678',
  email: 'ming@example.com', address: '台北市信義區', raw_text: '星辰半導體 王小明', is_business_card: true,
});
const enBack = cleanOcrResult({
  name: 'Ming Wang', company: 'Star Semi', title: 'Manager', mobile: '+886 912 345 678',
  email: 'MING@example.com', address: 'Taipei', website: 'star.example', raw_text: 'Star Semi Ming Wang', is_business_card: true,
});

test('Sheet 列 ↔ 名片物件可以來回轉換', () => {
  const card = makeCardFromOcr(zhFront, 'photo1');
  const row = cardToRow(card);
  assert.equal(row.length, COLUMNS.length);
  const back = rowToCard(row, 5);
  assert.equal(back.name, '王小明');
  assert.deepEqual(back.photos, ['photo1']);
  assert.equal(back._row, 5);
});

test('rowToCard：短列與壞掉的 photos JSON 不會當掉', () => {
  const card = rowToCard(['c_1', '2026-01-01'], 2);
  assert.equal(card.name, '');
  assert.deepEqual(card.photos, []);
  const bad = rowToCard(['c_2', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '{oops'], 3);
  assert.deepEqual(bad.photos, []);
});

test('手機正規化：+886 9xx 與 09xx 視為相同', () => {
  assert.equal(normalizePhone('+886 912-345-678'), '0912345678');
  assert.equal(normalizePhone('0912 345 678'), '0912345678');
});

test('同一人判斷：手機或 Email（不分大小寫）相同', () => {
  assert.ok(isSamePerson(zhFront, enBack));
  assert.ok(isSamePerson({ email: 'a@x.com' }, { email: 'b@y.com, A@X.com' }));
  assert.ok(!isSamePerson({ mobile: '0912345678' }, { mobile: '0988111222' }));
  assert.ok(!isSamePerson({ mobile: '123' }, { mobile: '123' }), '太短的號碼不算');
});

test('正反面合併：中文先到 → 中文為主、英文名進 name_alt、空欄補上', () => {
  const card = makeCardFromOcr(zhFront, 'p_zh');
  const merged = mergeBackSide(card, enBack, 'p_en');
  assert.equal(merged.name, '王小明');
  assert.equal(merged.name_alt, 'Ming Wang');
  assert.equal(merged.company, '星辰半導體');
  assert.equal(merged.website, 'star.example');
  assert.deepEqual(merged.photos, ['p_zh', 'p_en']);
});

test('正反面合併：英文先到 → 換成中文為主、中文照片排第一', () => {
  const card = makeCardFromOcr(enBack, 'p_en');
  const merged = mergeBackSide(card, zhFront, 'p_zh');
  assert.equal(merged.name, '王小明');
  assert.equal(merged.name_alt, 'Ming Wang');
  assert.equal(merged.company, '星辰半導體');
  assert.equal(merged.title, '經理');
  assert.equal(merged.address, '台北市信義區');
  assert.deepEqual(merged.photos, ['p_zh', 'p_en']);
});

test('正反面合併：自己填的備註不會被蓋掉', () => {
  const card = { ...makeCardFromOcr(zhFront, 'p1'), note: '展覽認識' };
  const merged = mergeBackSide(card, enBack, 'p2');
  assert.equal(merged.note, '展覽認識');
});

test('搜尋：多關鍵字、電話數字、備註都找得到', () => {
  const cards = [
    { ...makeCardFromOcr(zhFront, 'a'), note: 'SEMICON 認識' },
    makeCardFromOcr(cleanOcrResult({ name: '陳美玲', company: '綠野設計', mobile: '0988-111-222' }), 'b'),
  ];
  assert.equal(searchCards(cards, '星辰 經理').length, 1);
  assert.equal(searchCards(cards, '0988111').length, 1);
  assert.equal(searchCards(cards, 'semicon').length, 1);
  assert.equal(searchCards(cards, '').length, 2);
  assert.equal(searchCards(cards, '不存在').length, 0);
});

test('排序：最新在前', () => {
  const a = { name: 'A', created_at: '2026-01-01T00:00:00Z' };
  const b = { name: 'B', created_at: '2026-02-01T00:00:00Z' };
  assert.deepEqual(sortCards([a, b], 'recent').map((c) => c.name), ['B', 'A']);
});

test('vCard：特殊字元有跳脫、多個電話拆開', () => {
  const card = makeCardFromOcr(cleanOcrResult({
    name: '林;志豪', company: '海風, 餐飲', mobile: '0933-456-789 / 0911-000-111', email: 'a@x.com',
  }), 'p');
  const v = cardToVCard(card);
  assert.match(v, /FN:林\\;志豪/);
  assert.match(v, /ORG:海風\\, 餐飲/);
  assert.equal((v.match(/TEL;TYPE=CELL/g) || []).length, 2);
  assert.ok(v.startsWith('BEGIN:VCARD') && v.trimEnd().endsWith('END:VCARD'));
});

test('小工具：splitMulti、telHref、hasCjk', () => {
  assert.deepEqual(splitMulti('a@x.com, b@y.com'), ['a@x.com', 'b@y.com']);
  assert.equal(telHref('(02) 2345-6789 #321'), 'tel:0223456789');
  assert.equal(telHref('+886 2 2345 6789 分機 12'), 'tel:+886223456789');
  assert.ok(hasCjk('王小明'));
  assert.ok(!hasCjk('Ming Wang'));
});

test('cleanOcrResult：null 變空字串、預設是名片', () => {
  const r = cleanOcrResult({ name: null, mobile: ' 0912 ' });
  assert.equal(r.name, '');
  assert.equal(r.mobile, '0912');
  assert.equal(r.is_business_card, true);
  assert.equal(cleanOcrResult({ is_business_card: false }).is_business_card, false);
});
