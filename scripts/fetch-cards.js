// 빌드 때 카드 이미지를 내려받아 www/cards/ 에 넣는다 → 앱이 오프라인에서도 카드 그림을 보여줌
// 사용: node scripts/fetch-cards.js   (www/index.html 이 먼저 만들어져 있어야 함)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/data.js'), 'utf8');
const m = {exports: {}};
new Function('module', 'exports', src + '\n;module.exports = {CARD_DATA: typeof CARD_DATA!=="undefined"?CARD_DATA:null};')(m, m.exports);
const keys = [...new Set((m.exports.CARD_DATA || []).map(r => r[10]).filter(Boolean))];
const out = path.join(root, 'www/cards');
fs.mkdirSync(out, {recursive: true});
const BASES = ['https://cdn.royaleapi.com/static/img/cards-150/', 'https://cdn.royaleapi.com/static/img/cards/'];
(async () => {
  let ok = 0, fail = [];
  for (const k of keys) {
    let done = false;
    for (const b of BASES) {
      try {
        const r = await fetch(b + k + '.png');
        if (!r.ok) continue;
        fs.writeFileSync(path.join(out, k + '.png'), Buffer.from(await r.arrayBuffer()));
        done = true; ok++; break;
      } catch (e) {}
    }
    if (!done) fail.push(k);
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({count: ok, missing: fail, at: new Date().toISOString()}));
  console.log(`cards: ${ok}/${keys.length} downloaded` + (fail.length ? `, missing: ${fail.join(', ')}` : ''));
})();
