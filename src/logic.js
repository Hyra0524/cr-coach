/* =========================================================
   로직 (순수 함수)
   좌표계: 경기장 가로 0~18, 세로 0~32 타일. 0이 상대 진영 끝, 32가 내 진영 끝.
   강 15~17, 다리 x=3.5 / x=14.5. 내 프린세스 타워 (3.5,25.5)/(14.5,25.5), 킹 (9,29).
   ========================================================= */
const _D = (typeof module !== 'undefined' && typeof require !== 'undefined' && typeof CARDS === 'undefined') ? require('./data.js') : null;
const _CARDS = _D ? _D.CARDS : CARDS;
const _DECKS = _D ? _D.DECKS : DECKS;
const _ARCH = _D ? _D.ARCH : ARCH;

const LANE_X = {L:3.5, R:14.5};
const MY_TOWER = {L:{x:3.5,y:25.5}, R:{x:14.5,y:25.5}, K:{x:9,y:29}};
const OPP_TOWER = {L:{x:3.5,y:6.5}, R:{x:14.5,y:6.5}, K:{x:9,y:3}};
const SPEED_TPS = {s:0.75, m:1.0, f:1.5, vf:2.0, '-':0};
const laneOf = x => (x < 9 ? 'L' : 'R');
const other = l => (l === 'L' ? 'R' : 'L');

/* ---------- 엘릭서 ---------- */
function rateAt(t, triple){
  if (t < 120) return 1/2.8;
  if (t < 240) return 2/2.8;
  return (triple ? 3 : 2)/2.8;
}
function phaseAt(t, triple){
  if (t < 120) return {label:'1배 엘릭서', cls:'x1', mult:1};
  if (t < 180) return {label:'2배 엘릭서', cls:'x2', mult:2};
  if (t < 240) return {label:'연장 · 2배', cls:'x2', mult:2};
  return triple ? {label:'연장 · 3배', cls:'x3', mult:3} : {label:'연장 · 2배', cls:'x2', mult:2};
}
function playCost(plays, idx, unknownCost){
  const p = plays[idx];
  if (p.corr) return 0;
  if (p.ability) return p.cost || 0;
  const c = _CARDS[p.id];
  if (!c || p.id === 'unknown') return p.cost != null ? p.cost : unknownCost;
  if (c.tags.includes('mirror')){
    for (let j = idx-1; j >= 0; j--){
      if (plays[j].corr || plays[j].ability) continue;
      return Math.min(10, playCost(plays, j, unknownCost) + 1);
    }
    return unknownCost;
  }
  return c.cost;
}
/* 구간별 회복량을 해석적으로 계산 (시간 간격을 잘게 쪼개는 반복 없이 정확한 값)
   0~120초 2.8초당 1, 120~240초 2배, 240초~ 3배(설정) */
function phaseList(triple){ return [[0,120,1/2.8],[120,240,2/2.8],[240,1e9,(triple?3:2)/2.8]]; }
function regenBetween(t0, t1, triple){
  let g = 0;
  for (const [a,b,r] of phaseList(triple)){ const s = Math.max(a,t0), e = Math.min(b,t1); if (e > s) g += (e-s)*r; }
  return g;
}
// t0부터 need 만큼 회복되는 시각
function timeToGain(t0, need, triple){
  if (need <= 0) return t0;
  let t = t0;
  for (const [a,b,r] of phaseList(triple)){
    if (b <= t) continue;
    const s = Math.max(a,t), cap = (b-s)*r;
    if (need <= cap) return s + need/r;
    need -= cap; t = b;
  }
  return Infinity;
}
/* 한 번 낸 카드의 비용과 비용 범위 [lo, hi]
   - 아는 카드: 고정 / 미러: 직전 카드 +1 / 모르는 카드: 화면 인식 후보·덱 추정으로 좁힌 범위(p.costLo~p.costHi) */
function playCostRange(plays, idx, unknownCost){
  const p = plays[idx];
  if (p.corr) return {c:0, lo:0, hi:0};
  if (p.ability){ const c = p.cost || 0; return {c, lo:c, hi:c}; }
  const C = _CARDS[p.id];
  if (!C || p.id === 'unknown'){
    const c = p.cost != null ? p.cost : unknownCost;
    return {c, lo: p.costLo != null ? p.costLo : Math.min(c, 1), hi: p.costHi != null ? p.costHi : Math.max(c, 7)};
  }
  if (C.tags.includes('mirror')){
    for (let j = idx-1; j >= 0; j--){
      if (plays[j].corr || plays[j].ability) continue;
      const r = playCostRange(plays, j, unknownCost);
      return {c:Math.min(10, r.c+1), lo:Math.min(10, r.lo+1), hi:Math.min(10, r.hi+1)};
    }
    return {c:unknownCost, lo:2, hi:9};
  }
  return {c:C.cost, lo:C.cost, hi:C.cost};
}
/* 엘릭서 시뮬레이션 (점 추정 E + 가능한 범위 [lo, hi])
   - 범위는 '모르는 카드 비용', '자동 감지 시각 오차'에서 생기고, 엘릭서가 10에 막히면 저절로 좁혀져요
   - 카드를 냈다는 건 그 순간 엘릭서가 최소 그 비용만큼 있었다는 뜻 → 하한을 끌어올려 스스로 보정
   - 엘릭서 정제소: 배치 1초 뒤부터 15초마다 +1, 7회 (2026년 10월 밸런스 기준 수명 1분 50초) */
const DETECT_JITTER = 0.15;
function simulate(plays, tNow, opts){
  const triple = !!opts.triple, unk = opts.unknownCost != null ? opts.unknownCost : 4;
  const evs = [];
  plays.forEach((p,i)=>{
    if (p.t > tNow + 1e-9) return;
    evs.push({t:p.t, p, i});
    if (p.id === 'collector' && !p.corr && !p.ability) for (let k=1;k<=7;k++){ const te = p.t + 1 + 15*k; if (te <= tNow) evs.push({t:te, add:1, sure:k<=2}); }
  });
  evs.sort((a,b)=>a.t-b.t || (a.add?1:0)-(b.add?1:0));
  let E = 5, lo = 5, hi = 5, t = 0, leak = 0, recentLeak = 0, deficit = 0, fullSince = null;
  const w0 = tNow - 5;
  const advance = t1=>{
    if (t1 <= t) return;
    const g = regenBetween(t, t1, triple);
    if (E + g > 10){
      const tc = timeToGain(t, 10 - E, triple);
      leak += E + g - 10;
      if (t1 > w0) recentLeak += regenBetween(Math.max(tc, w0), t1, triple);
      if (fullSince == null) fullSince = tc;
      E = 10;
    } else { E += g; if (E < 9.999) fullSince = null; }
    lo = Math.min(10, lo + g); hi = Math.min(10, hi + g);
    t = t1;
  };
  for (const ev of evs){
    advance(ev.t);
    if (ev.add){ E = Math.min(10, E+1); hi = Math.min(10, hi+1); if (ev.sure) lo = Math.min(10, lo+1); continue; }
    const p = ev.p;
    if (p.corr){ E = lo = hi = Math.max(0, Math.min(10, p.value)); continue; }
    const r = playCostRange(plays, ev.i, unk);
    // 실제로 냈으니 그 순간 엘릭서는 최소 r.lo 이상이었음
    if (hi < r.lo){ deficit += r.lo - hi; hi = r.lo; }
    lo = Math.max(lo, r.lo);
    if (E < r.c){ if (r.lo === r.hi) deficit += r.c - E; E = Math.min(hi, Math.max(E, r.lo)); }
    E = Math.max(0, E - Math.min(r.c, E));
    lo = Math.max(0, lo - r.hi); hi = Math.max(0, hi - r.lo);
    if (p.auto){ lo = Math.max(0, lo - DETECT_JITTER); hi = Math.min(10, hi + DETECT_JITTER); }
    if (E < lo) E = lo; if (E > hi) E = hi;
    fullSince = null;
  }
  advance(tNow);
  if (E < lo) E = lo; if (E > hi) E = hi;
  return {E, lo, hi, leak, recentLeak, deficit, fullFor: fullSince != null ? tNow - fullSince : 0, rate: rateAt(tNow, triple)};
}
// 엘릭서 e가 되기까지 남은 시간 (현재 E 기준)
function secondsUntil(E, target, tNow, triple){ return target <= E ? 0 : timeToGain(tNow, target - E, triple) - tNow; }

/* ---------- 카드 사이클 ---------- */
function analyzeDeck(plays){
  const seq = plays.filter(p=>!p.corr && !p.ability).slice().sort((a,b)=>a.t-b.t);
  const known = [];
  for (const p of seq){ if (p.id !== 'unknown' && _CARDS[p.id] && !known.includes(p.id) && known.length < 8) known.push(p.id); }
  const last4 = seq.slice(-4).map(p=>p.id);
  const status = {};
  for (const id of known){
    const idx = last4.lastIndexOf(id);
    if (idx >= 0) status[id] = {where:'queue', returnsIn: idx + 1 + (4 - last4.length)};
    else status[id] = seq.length >= 4 ? {where:'hand'} : {where:'queue', returnsIn:null};
  }
  return {seq, known, last4, status, hand: known.filter(id=>status[id].where==='hand'), next: seq.length>=4 ? last4[0] : null, full: known.length===8};
}
/* 손패 확률 모델
   덱 8장 = 손패 4 + 대기열 4. 방금 낸 4장은 대기열에 있고(다시 나오려면 4장을 더 내야 함),
   나머지 8 - min(4, n)장 중 4장이 손에 있어요. → 아직 안 낸 카드가 손에 있을 확률 = 4 / (8 - min(4,n)) */
function handModel(plays, inf){
  const deck = analyzeDeck(plays);
  const n = deck.seq.length, recent = new Set(deck.last4.filter(id=>id !== 'unknown'));
  const free = 8 - Math.min(4, n), pIn = Math.min(1, 4/free);
  const cards = {};
  for (const id of deck.known) cards[id] = recent.has(id) ? {p:0, returnsIn: deck.status[id].returnsIn} : {p:pIn};
  const unseen = 8 - deck.known.length;
  if (inf && inf.predicted) for (const pr of inf.predicted) cards[pr.id] = {p: pIn * pr.prob, predicted:true};
  return {cards, pIn, unseen, n, deck};
}
/* 상대가 방금 낸 카드가 무엇일지 '문맥' 확률 (화면 인식 결과와 곱해서 최종 판정)
   - 대기열에 있는(최근 4장) 카드는 낼 수 없음 → 아주 낮게 (감지 실수 대비 0.02)
   - 손에 있을 카드 → 높게, 아직 안 나온 카드는 덱 추정 확률로 나눔
   - 엘릭서 상한보다 비싼 카드 → 낮게 */
function contextPrior(plays, inf, oppHi){
  const hm = handModel(plays, inf), P = {}, CY = {};
  const all = Object.keys(_CARDS).filter(k=>k!=='unknown' && !k.endsWith('_air'));
  const known = hm.deck.known.length;
  const unseenMass = known >= 8 ? 0.02 : Math.max(0.08, hm.unseen / (8 - Math.min(4, hm.n)));
  let predSum = 0; for (const id in hm.cards) if (hm.cards[id].predicted) predSum += hm.cards[id].p;
  for (const id of all){
    let w;
    const c = hm.cards[id];
    if (c && !c.predicted){ w = 1; CY[id] = c.p > 0 ? 1 : 0.05; }
    else if (c && c.predicted) w = unseenMass * 0.75 * (c.p / (predSum || 1)) * 4;
    else w = unseenMass * (known >= 8 ? 0.2 : 0.35) * 4 / all.length;
    if (oppHi != null && _CARDS[id].cost > oppHi + 1.2 && !_CARDS[id].tags.includes('mirror')) w *= 0.15;
    P[id] = w * (CY[id] != null ? CY[id] : 1);
  }
  let s = 0; for (const id in P) s += P[id];
  for (const id in P) P[id] /= s;
  // 사이클(대기열에 있어서 못 냄)은 게임 규칙이라 완화하지 않도록 따로 표시
  Object.defineProperty(P, 'cycle', {value: CY, enumerable: false});
  return P;
}
/* 화면 인식 유사도 + 문맥 확률 → 최종 확률
   cands: [{id, score}] (학습한 카드만), score는 0~1 유사도
   학습 안 된 카드는 '기본 유사도'로 취급해서 문맥만으로도 후보가 될 수 있게 */
/* 외형 증거 (항상 '닮을수록 증거가 커지는' 단조 함수)
   학습된 카드 c: 30 x (c 점수 - 다른 학습 카드 최고 점수) + 20 x (c 점수 - 기준점)
     기준점 = '같은 카드' 평균과 '다른 카드 중 가장 닮은 것' 평균의 중간 (학습 데이터에서 잼)
   학습 안 된 카드: 0 (외형으로는 판단 불가 → 문맥으로)
   학습은 됐는데 점수가 없으면: 아주 낮게 */
function identify(cands, prior, opts){
  opts = opts || {};
  const cal = opts.calib || {gm:0.85, im:0.75};
  const mid = (cal.gm + cal.im)/2;
  const sims = {}; let ignore = null;
  for (const c of cands || []){ if (c.id === '__ignore'){ ignore = c.score; continue; } if (_CARDS[c.id]) sims[c.id] = c.score; }
  const learned = opts.learned || new Set(Object.keys(sims));
  const sv = Object.entries(sims).sort((a,b)=>b[1]-a[1]);
  const top1 = sv[0] ? sv[0][1] : null, top2 = sv[1] ? sv[1][1] : (top1 != null ? top1 - 0.1 : null);
  const evOf = id=>{ const sc = sims[id]; const other = sv[0] && sv[0][0] === id ? top2 : top1; return Math.max(-9, Math.min(10, 30*(sc - other) + 38*(sc - mid))); };
  const ids = prior ? Object.keys(prior) : Object.keys(sims);
  const lg = {}; let mx = -1e9;
  for (const id of ids){
    const pr = prior ? prior[id] : 1; if (!pr) continue;
    const hasTpl = sims[id] != null, isL = learned.has(id);
    const ev = hasTpl ? evOf(id) : isL ? -6 : 0;
    // 문맥 확률은 덱 DB가 완전하지 않아 과신하기 쉬움 → 0.55제곱으로 완화
    const cy = prior && prior.cycle && prior.cycle[id] != null ? prior.cycle[id] : 1;
    const v = ev + 0.55*Math.log(pr/cy) + Math.log(cy);
    lg[id] = {v, hasTpl, s: hasTpl ? sims[id] : null, ev}; if (v > mx) mx = v;
  }
  // '카드 아님'으로 학습된 장면과 가장 닮았으면 그 가능성도 후보로
  if (ignore != null){ const ev = Math.max(-9, Math.min(9, 30*(ignore - (top1 != null ? top1 : 0.5)) + 20*(ignore - mid))); const v = ev + Math.log(0.08); lg.__ignore = {v, hasTpl:true, s:ignore, ev}; if (v > mx) mx = v; }
  let z = 0; for (const id in lg){ lg[id].e = Math.exp(lg[id].v - mx); z += lg[id].e; }
  const out = [];
  for (const id in lg) out.push({id, p: lg[id].e / z, sim: lg[id].s, tpl: lg[id].hasTpl, ev: lg[id].ev});
  out.sort((a,b)=>b.p-a.p);
  const list = out.filter(x=>x.id !== '__ignore');
  return {list: list.slice(0, 8), ignore: lg.__ignore ? lg.__ignore.e/z : 0, best: out[0] || null};
}
/* 진영 보정: 화면 위치·색만으로 애매한 경우를 '내가 실제로 낸 카드'(엘릭서 하락·손패 변화)로 확정
   myEvents: 내 플레이 [{t, id?}] — 한 플레이는 배치 하나만 가져갈 수 있어요(claimed)
   - 내 진영(아래)에 생겼는데 가져갈 내 플레이가 없음 → 상대 주문 또는 포켓 배치
   - 상대 진영(위)에 생겼는데 그 시각 내가 낸 '주문'이 아직 배치를 못 찾음 → 내 주문 */
function myPlayWindow(m){ const c = m.id && _CARDS[m.id]; return c && c.type === 's' ? 2.8 : 0.9; }
function resolveSide(ev, myEvents){
  const free = (myEvents || []).filter(m=>!m.claimed && ev.t - m.t > -0.5 && ev.t - m.t < myPlayWindow(m));
  if (ev.side === 'bottom'){
    if (!free.length){
      // 작고 애매한 변화(타워 화살 착지 등)는 상대 빨간색이 보일 때만 상대 것으로, 아니면 버림
      const red = ev.colors ? ev.colors.red : 0, blue = ev.colors ? ev.colors.blue : 0;
      if (ev.src === 'small' && !(red >= 6 && red > blue*1.5)) return {side:'none', why:'noise'};
      return {side:'top', why:'no-my-play'};
    }
    const m = free.sort((a,b)=>Math.abs(ev.t-a.t)-Math.abs(ev.t-b.t))[0]; m.claimed = true;
    return {side:'bottom', why:'my-play', mine:m};
  }
  const sp = free.find(m=>m.id && _CARDS[m.id] && _CARDS[m.id].type === 's' && ev.t - m.t > 0.3);
  if (sp){ sp.claimed = true; return {side:'bottom', why:'my-spell', mine:sp}; }
  return {side: ev.side, why:'vision'};
}
// 엘릭서 하락(drop)과 손패 변화(myplay)를 하나의 '내 플레이' 목록으로
function mergeMyEvents(drops, myplays){
  const out = myplays.map(m=>({t:m.t, id:m.id, ref:m.ref}));
  for (const d of drops) if (!myplays.some(m=>m.ref === d.ref || Math.abs(m.t - d.t) < 0.25)) out.push({t:d.t, cost:d.cost, ref:d.ref});
  return out.sort((a,b)=>a.t-b.t);
}
// 후보 확률로 비용 기대값·범위 계산 (모르는 카드의 엘릭서 계산용)
function costFromPosterior(list){
  let ev = 0, ps = 0, lo = 99, hi = 0;
  for (const x of list){ const c = _CARDS[x.id]; if (!c || c.tags.includes('mirror')) continue; ev += c.cost * x.p; ps += x.p; if (x.p >= 0.08){ lo = Math.min(lo, c.cost); hi = Math.max(hi, c.cost); } }
  if (!ps) return null;
  return {c: Math.round(ev/ps*2)/2, lo: lo === 99 ? 1 : lo, hi: hi || 9};
}
// 내 덱 손패: 4장 이상 내면 정확, 그 전엔 낸 카드만 대기열
function myHandOf(deckCards, myPlays){
  if (!deckCards) return null;
  const seq = myPlays.filter(p=>!p.corr && !p.ability).sort((a,b)=>a.t-b.t).map(p=>p.id);
  const last4 = seq.slice(-4);
  if (seq.length >= 4) return {known:true, hand: deckCards.filter(c=>!last4.includes(c)), queue:last4};
  return {known:false, hand: deckCards.filter(c=>!last4.includes(c)), queue:last4};
}

/* ---------- 덱 추정 ---------- */
const MISS_PENALTY = 0.035;
function inferDecks(known, decks){
  decks = decks || _DECKS;
  if (!known.length) return {variants:[], groups:[], predicted:[], bestMiss:null};
  const scored = []; let bestMiss = 99;
  decks.forEach((d, idx)=>{
    const hits = known.filter(c=>d.c.includes(c)).length;
    if (!hits) return;
    const miss = known.length - hits; bestMiss = Math.min(bestMiss, miss);
    scored.push({idx, d, hits, miss, score:(d.pop||1) * Math.pow(MISS_PENALTY, miss)});
  });
  const total = scored.reduce((s,x)=>s+x.score, 0) || 1;
  scored.forEach(x=>x.prob = x.score/total); scored.sort((a,b)=>b.prob-a.prob);
  const gmap = {};
  for (const x of scored){
    const g = gmap[x.d.n] || (gmap[x.d.n] = {n:x.d.n, a:x.d.a, prob:0, best:x});
    g.prob += x.prob; if (x.prob > g.best.prob) g.best = x;
  }
  const groups = Object.values(gmap).sort((a,b)=>b.prob-a.prob);
  const pmap = {};
  for (const x of scored) for (const c of x.d.c) if (!known.includes(c)) pmap[c] = (pmap[c]||0) + x.prob;
  const predicted = Object.entries(pmap).map(([id,prob])=>({id, prob:Math.min(0.97,prob)})).sort((a,b)=>b.prob-a.prob).slice(0, Math.max(0, 8-known.length));
  return {variants:scored, groups, predicted, bestMiss: bestMiss===99?null:bestMiss};
}

/* ---------- 카드 상성 (특성 기반) ---------- */
function canHit(c, T){
  if (!c || !T) return false;
  if (c.type === 's') return T.air ? c.tgt.includes('a') : true;
  if (c.tgt === 'b') return false;
  if (T.air) return c.tgt.includes('a');
  return true;
}
const isSwarm = c => c.hp <= 1 && c.type !== 's';
const isTank = c => c.hp >= 5;
// my 카드로 상대 threat 카드를 막을 때 점수 (높을수록 좋음)
function counterScore(myId, threatId){
  const c = _CARDS[myId], T0 = _CARDS[threatId];
  if (!c || !T0) return -9;
  const spellWin = T0.type === 's';
  const T = spellWin ? Object.assign({}, T0, {air:false, hp:1, tgt:'g', type:'t', rng:1}) : T0;
  if (c.tags.includes('pump') || c.tags.includes('mirror') || ['rage','clone','healspirit','royaldelivery'].includes(c.id) && !(c.id==='royaldelivery' && T.hp<=2)) return -6;
  if (c.tags.includes('win') && c.type === 'b') return -6;
  const STUN = ['zap','elecspirit','ewiz','zappies','edragon','icespirit','snowball'];
  const SWARM = ['skeletons','skarmy','goblins','gobgang','bats','minions','minionhorde','speargob','guards','barbarians'];
  let f = 0; const why = [];
  if (STUN.includes(c.id) && ['inferno','infernodragon','sparky'].includes(threatId)){ why.push('충전·빔 초기화'); return {score: 4.5 + (T0.cost - c.cost)*0.2, f:4.5, why}; }
  if (c.type === 's'){
    if (c.id === 'log' && T.air) return -9;
    if (['log','barbbarrel','earthquake','graveyard','goblinbarrel'].includes(c.id) && T.air) return -9;
    if (c.tags.includes('spellS')){
      if (T.hp <= 1){ f += 3.5; why.push('물량을 한 번에 정리'); if (spellWin) f += 1; }
      else if (T.hp >= 3) f -= 2.5;
      if (c.id === 'tornado' && T.tgt === 'b' && !T.air){ f += 1.5; why.push('킹 타워 쪽으로 끌기'); }
      if (c.id === 'vines' && T.air){ f += 1.5; why.push('공중 유닛을 땅으로'); }
      if (c.id === 'earthquake' && T.type === 'b'){ f += 4; why.push('건물에 큰 피해'); }
    } else if (c.tags.includes('spellB')){
      if (T.hp <= 2){ f += 3; why.push('한 방에 처리'); } else if (T.hp === 3) f += 0.3; else f -= 3;
      if (c.id === 'void' && T.hp >= 4){ f += 4; why.push('단일 대상에 큰 피해'); }
      if (['rocket','lightning'].includes(c.id) && T.type === 'b'){ f += 3; why.push('건물 파괴'); }
    } else return -6;
  } else if (c.type === 'b'){
    if (T.type === 'b') return -6;
    if (c.tgt === '-' || c.dps === 0){ if (T.tgt === 'b' && !T.air){ f += 2.5; why.push('건물 타겟을 끌어당김'); } else return -6; }
    else if (T.tgt === 'b' && !T.air){ f += 3.2; why.push('중앙으로 끌어 타워와 협공'); }
    else if (T.tgt === 'b' && T.air){ f += c.tgt.includes('a') ? 3 : 1; why.push(c.tgt.includes('a') ? '공중 건물 타겟을 끌고 공격' : '어그로만 끌기'); }
    else if (canHit(c, T)) f += 0.8; else return -9;
    if (c.dps >= 5 && T.hp >= 4){ f += 2; why.push('탱커를 빔으로 녹임'); }
    if (c.splash && T.hp <= 1){ f += 2; why.push('범위로 물량 정리'); }
  } else {
    if (T.type === 'b'){
      if (c.hp >= 4){ f += 3; why.push('탱커로 공성 건물을 받아내며 파괴'); }
      else if (c.dps >= 4 && c.rng <= 1.5){ f += 2.5; why.push('붙어서 빠르게 건물 파괴'); }
      else if (c.dps >= 3) f += 1.2;
    } else if (!canHit(c, T)){
      if (T.tgt === 'b') f -= 1; else return -9;
    } else {
      if (!T.tgt.includes('a') && c.air && T.tgt !== 'b'){ f += 2.5; why.push('공중이라 반격받지 않음'); }
      if (T.hp <= 1){ if (c.splash){ f += 3; why.push('범위 공격으로 물량 정리'); } else if (c.hp >= 3) f -= 1.5; }
      if (T.hp >= 4){
        if (c.dps >= 5){ f += 3; why.push('높은 화력으로 탱커 처리'); }
        else if (SWARM.includes(c.id) && !T.splash){ f += 2.6; why.push('물량으로 감싸서 녹임'); }
        else if (c.dps <= 2) f -= 1;
      }
      if (T.tgt === 'b' && !T.air && c.dps >= 3){ f += 1; why.push('건물만 노리니 반격 없이 처리'); }
      if (T.air && c.tgt.includes('a') && c.rng >= 4){ f += 1.5; why.push('사거리 긴 대공'); }
      if (T.air && T.hp >= 4 && c.tgt.includes('a') && c.dps >= 3){ f += 1.5; why.push('공중 탱커를 녹이는 화력'); }
      if (!T.air && T.rng <= 1.5 && c.rng >= 4 && T.tgt !== 'b' && T.hp >= 2){ f += 1; why.push('원거리에서 근접 유닛 견제'); }
    }
    if (T.splash && c.hp <= 1) f -= 3;
    if (['balloon','giantskeleton','golem','lavahound'].includes(threatId) && SWARM.includes(c.id)) f -= 1.5;
    if (threatId === 'ronin' && c.rng <= 1.5 && !c.air) f -= 3.5;
    if (threatId === 'ronin' && (c.rng >= 4 || c.hp <= 1 || c.air)){ f += 1.5; why.push('낭인 패리를 피함'); }
    if (threatId === 'egiant' && c.hp <= 1) f -= 3;
    if (c.tgt === 'b') f -= 2;
  }
  if (threatId === 'egiant' && (c.id === 'inferno' || c.id === 'infernodragon')) f += 1;
  return {score: f + (T0.cost - c.cost) * 0.2, f, why};
}
function cscore(a,b){ const r = counterScore(a,b); return typeof r === 'number' ? r : r.score; }
function counterCardsFor(threatId, pool){
  const list = (pool || Object.keys(_CARDS).filter(k=>k!=='unknown' && !k.endsWith('_air'))).map(id=>{ const r=counterScore(id, threatId); return {id, s: typeof r==='number'?-9:r.score, f: typeof r==='number'?-9:r.f}; }).filter(x=>x.f >= 2).sort((a,b)=>b.s-a.s);
  return list.map(x=>x.id);
}
function weakAgainst(cardId){
  const c0=_CARDS[cardId]; if (!c0 || (c0.type==='s' && !c0.tags.includes('win')) || c0.tags.includes('mirror')) return [];
  return Object.keys(_CARDS).filter(k=>k!=='unknown').map(id=>({id, s:cscore(id, cardId)})).filter(x=>x.s>=2.3).sort((a,b)=>b.s-a.s).slice(0,8).map(x=>x.id);
}
function goodAgainst(cardId){
  return Object.keys(_CARDS).filter(k=>k!=='unknown').map(id=>({id, s:cscore(cardId, id)})).filter(x=>x.s>=2.3).sort((a,b)=>b.s-a.s).slice(0,8).map(x=>x.id);
}
// 덱 vs 덱 (특성 기반 계산)
function deckWins(d){ return d.c.filter(id=>_CARDS[id] && _CARDS[id].tags.includes('win')); }
function attackPower(A, B){
  const wins = deckWins(A); if (!wins.length) return 1;
  let total = 0;
  for (const w of wins){ const def = B.c.filter(b=>cscore(b, w) >= 2.3).length; total += Math.max(0, 3 - def); }
  return total / wins.length;
}
function deckMatchup(A, B){
  if (!A || !B) return null;
  const diff = attackPower(A,B) - attackPower(B,A);
  return {diff, verdict: diff > 0.5 ? 'good' : diff < -0.5 ? 'bad' : 'even'};
}

/* ---------- 상대 유닛 위치 추정 ---------- */
function defaultDeploy(id, lane){
  const c = _CARDS[id] || _CARDS.unknown;
  if (c.type === 's' && c.tags.includes('win')) return {x:LANE_X[lane], y:25.5};
  if (['miner','goblindrill','mightyminer'].includes(id)) return {x:LANE_X[lane], y:24};
  if (c.tgt === 'b' && c.spd === 's') return {x:lane==='L'?7:11, y:2};
  return {x:LANE_X[lane], y:12};
}
// 시간에 따른 상대 유닛 위치 (내 타워 쪽으로 이동)
function threatPosition(play, tNow){
  const c = _CARDS[play.id]; if (!c) return null;
  const lane = play.lane || laneOf(play.x);
  // 화면에서 실제로 따라가고 있는 위치가 있으면 그 위치에서 출발 (배치 지연 1초는 이미 지남)
  const live = play.live && tNow - play.live.t < 0.8 ? play.live : null;
  const start = live ? {x:live.x, y:live.y} : {x:play.x, y:play.y};
  const tower = MY_TOWER[lane];
  const dtm = live ? Math.max(0, tNow - live.t) : Math.max(0, tNow - play.t - 1);
  const v = SPEED_TPS[c.spd] || 0;
  if (c.type !== 't' || !v) return {x:start.x, y:start.y, eta:0, lane, arrived:true};
  const path = [];
  if (c.air || start.y >= 17) path.push({x:tower.x, y:tower.y-1.5});
  else { path.push({x:LANE_X[lane], y:16}); path.push({x:tower.x, y:tower.y-1.5}); }
  let pos = {x:start.x, y:start.y}, remain = dtm * v, total = 0;
  let prev = start;
  for (const p of path){ total += Math.hypot(p.x-prev.x, p.y-prev.y); prev = p; }
  prev = start;
  for (const p of path){
    const seg = Math.hypot(p.x-prev.x, p.y-prev.y);
    if (remain <= seg){ const r = seg ? remain/seg : 0; pos = {x:prev.x+(p.x-prev.x)*r, y:prev.y+(p.y-prev.y)*r}; remain = -1; break; }
    remain -= seg; prev = p; pos = {x:p.x, y:p.y};
  }
  const eta = Math.max(0, (total - dtm*v) / v);
  return {x:pos.x, y:pos.y, eta, lane, arrived: eta <= 0, total};
}

/* ---------- 배치 위치 ---------- */
function placementFor(myId, T, tp, lane){
  const c = _CARDS[myId]; const L = lane || (tp ? tp.lane : 'L');
  const cx = L === 'L' ? 8 : 10, side = L === 'L' ? 1 : -1, tx = LANE_X[L];
  if (!c) return {x:cx, y:22, how:''};
  if (c.type === 's'){
    if (!tp) return {x:tx, y:20, how:'다리 근처'};
    const lead = Math.min(tp.eta, 1.2) * (SPEED_TPS[T.spd]||1);
    const y = Math.min(24, tp.y + (tp.y < 17 ? lead : 0.5));
    return {x:tp.x, y, how:'상대 유닛 위치에 정확히'};
  }
  if (c.type === 'b'){
    if (T.air) return {x:L==='L'?6:12, y:22, how:'타워 안쪽 대각선 (공중 경로 위)'};
    return {x:cx+ (L==='L'?0.5:-0.5), y:21, how:'강에서 4칸 아래 중앙 (양쪽 타워 사이로 끌기)'};
  }
  if (T.tgt === 'b' && !T.air && c.rng <= 1.5) return {x:tx + side*1.5, y:22, how:'타워 앞, 다리를 건너오는 경로 위'};
  if (isSwarm(c) && tp) return {x:tp.x, y:Math.max(18, Math.min(24, tp.y + 1)), how:'상대 유닛 바로 밑 (감싸기)'};
  if (c.rng >= 4) return {x:tx + side*2, y:26.5, how:'타워 옆 뒤쪽 (타워와 함께 사격)'};
  if (T.tgt !== 'b' && c.rng <= 1.5) return {x:cx, y:20.5, how:'중앙 쪽으로 끌어 양 타워가 같이 공격'};
  return {x:tx + side*1.5, y:22, how:'타워 앞'};
}
function attackPlacement(myId, lane){
  const c = _CARDS[myId], tx = LANE_X[lane];
  if (['miner','goblindrill','mightyminer'].includes(myId)) return {x:tx + (lane==='L'?1.5:-1.5), y:5, how:'상대 타워 바로 옆'};
  if (['graveyard','goblinbarrel'].includes(myId)) return {x:tx + (lane==='L'?1.5:-1.5), y:6, how:'상대 타워 안쪽 위'};
  if (c.type === 'b' && c.tags.includes('win')) return {x:tx + (lane==='L'?1:-1), y:17.5, how:'다리 바로 앞 (내 진영)'};
  if (c.spd === 's' && c.hp >= 5) return {x:lane==='L'?7:11, y:30.5, how:'킹 타워 뒤 (엘릭서를 모으며 빌드업)'};
  return {x:tx, y:17.5, how:'다리 바로 앞'};
}

/* ---------- 추천 엔진 ---------- */
function recommend(ctx){
  const {t, oppPlays, myCards, myHand, myE, oppE, triple, patterns, oppDeck} = ctx;
  const rate = rateAt(t, triple);
  const pool = myCards && myCards.length ? myCards : null;
  const cards = pool || Object.keys(_CARDS).filter(k=>k!=='unknown' && !k.endsWith('_air'));
  const handSet = myHand && myHand.known ? new Set(myHand.hand) : null;
  // 위협 찾기
  const recent = oppPlays.filter(p=>!p.ability && !p.corr && p.id !== 'unknown' && _CARDS[p.id] && t - p.t < 14).sort((a,b)=>b.t-a.t);
  let threat = null, tp = null;
  for (const p of recent){
    const c = _CARDS[p.id];
    if (c.type === 's' && !c.tags.includes('win')) continue;
    const pos = threatPosition(p, t);
    if (!pos) continue;
    if (c.type === 't' && pos.arrived && t - p.t > 9) continue;
    threat = p; tp = pos; break;
  }
  const res = {mode:'wait', threat, tp, recs:[], headline:''};
  if (threat && pool){
    const T = _CARDS[threat.id];
    if (T.hp >= 5 && T.spd === 's' && tp && tp.eta > 7){
      const lane = other(tp.lane);
      const w = pool.filter(id=>_CARDS[id].tags.includes('win') && (!handSet || handSet.has(id)) && _CARDS[id].cost <= myE + 0.3).sort((a,b)=>_CARDS[a].cost-_CARDS[b].cost)[0];
      if (w){
        const pl = attackPlacement(w, lane);
        res.mode = 'attack';
        res.recs = [{id:w, x:pl.x, y:pl.y, how:pl.how, when:'지금', why:[`상대가 뒤에서 ${T.name}(${T.cost})를 꺼냈어요`, '반대 라인을 압박하면 상대가 둘 다 막기 어려워요'], inHand: handSet?true:null}];
        res.headline = `${T.name} 뒤 출현 → 반대 라인 ${_CARDS[w].name}`;
        return res;
      }
    }
  }
  if (threat){
    const T = _CARDS[threat.id];
    const scored = cards.map(id=>{
      const r = counterScore(id, threat.id); if (typeof r === 'number') return null;
      let s = r.score; const f = r.f; const why = r.why.slice();
      const pat = patterns && patterns[threat.id] && patterns[threat.id][id];
      if (pat){ s += 1.2 * Math.min(3, pat.n); why.push(`프로 영상에서 ${pat.n}번 쓴 대응`); }
      const inHand = handSet ? handSet.has(id) : null;
      if (inHand === true) s += 1.5; else if (inHand === false) s -= 2.5;
      const c = _CARDS[id];
      const wait = c.cost > myE ? (c.cost - myE)/rate : 0;
      if (wait > (tp ? tp.eta + 1 : 2)) s -= 2;
      return {id, s, f, why, inHand, wait};
    }).filter(x=>x && x.f >= 1.5 && x.s > 0.5).sort((a,b)=>b.s-a.s).slice(0,3);
    res.mode = 'defend';
    res.recs = scored.map(x=>{
      let pl = placementFor(x.id, T, tp);
      const pat = patterns && patterns[threat.id] && patterns[threat.id][x.id];
      if (pat && pat.n >= 2){ const mx = tp.lane==='R' ? 18 - pat.x : pat.x; pl = {x:mx, y:pat.y, how:'프로가 실제로 놓은 위치(학습)'}; }
      const when = _CARDS[x.id].type==='s' ? (tp.y < 17 ? '다리를 건널 때' : '지금') : (_CARDS[x.id].type==='b' ? (tp.eta > 3 ? `${Math.max(0,Math.round(tp.eta-2.5))}초 뒤 (다리 건너기 직전)` : '지금 바로') : (tp.eta > 4 ? '다리를 건너면' : '지금 바로'));
      return {id:x.id, score:x.s, x:pl.x, y:pl.y, how:pl.how, when, why:x.why, inHand:x.inHand, wait:x.wait};
    });
    res.headline = res.recs.length ? `${T.name} → ${_CARDS[res.recs[0].id].name}` : `${T.name}: 타워로 받으며 엘릭서를 아끼세요`;
    return res;
  }
  // 공격 판단
  const lastOpp = oppPlays.filter(p=>!p.ability && !p.corr && _CARDS[p.id] && _CARDS[p.id].type==='t').slice(-1)[0];
  const atkLane = lastOpp ? other(lastOpp.lane || laneOf(lastOpp.x)) : 'R';
  const wins = (pool || []).filter(id=>_CARDS[id].tags.includes('win'));
  const avail = id => !handSet || handSet.has(id);
  const winsAvail = wins.filter(avail);
  if (winsAvail.length && (oppE <= 3.5 || (rate > 0.5 && myE >= 8))){
    const w = winsAvail.sort((a,b)=>_CARDS[a].cost-_CARDS[b].cost)[0];
    if (_CARDS[w].cost <= myE + 0.3){
      const pl = attackPlacement(w, atkLane);
      res.mode = 'attack';
      res.recs = [{id:w, x:pl.x, y:pl.y, how:pl.how, when:'지금', why:[oppE <= 3.5 ? `상대 엘릭서 ${oppE.toFixed(1)}로 수비가 어려워요` : '엘릭서가 충분해요', `${atkLane==='L'?'왼쪽':'오른쪽'} 라인 (상대가 최근 쓰지 않은 쪽)`], inHand: handSet?true:null}];
      const sup = (pool||[]).filter(id=>id!==w && avail(id) && _CARDS[id].type==='t' && _CARDS[id].rng>=4 && _CARDS[id].cost + _CARDS[w].cost <= myE + 0.3)[0];
      if (sup) res.recs.push({id:sup, x:LANE_X[atkLane], y:19.5, how:'승리 조건 뒤 지원', when:'바로 뒤에', why:['원거리 지원으로 수비 유닛 견제'], inHand:true});
      res.headline = `공격 기회: ${_CARDS[w].name}`;
      return res;
    }
  }
  if (myE >= 9.3 && pool){
    const cheap = pool.filter(avail).filter(id=>_CARDS[id].type==='t').sort((a,b)=>_CARDS[a].cost-_CARDS[b].cost)[0];
    if (cheap){
      res.mode = 'cycle';
      res.recs = [{id:cheap, x:atkLane==='L'?6.5:11.5, y:30.5, how:'킹 타워 뒤 구석 (사이클)', when:'지금', why:['엘릭서가 꽉 차서 낭비 중이에요'], inHand:handSet?true:null}];
      res.headline = '엘릭서 낭비 방지: 사이클';
      return res;
    }
  }
  res.headline = myE < 4 ? '엘릭서를 모으세요' : '상대 움직임을 기다리세요';
  return res;
}

/* ---------- 실시간 피드백 문장 ---------- */
function buildTips(ctx){
  const {t, started, E, myE, recentLeak, deck, inf, plays, myDeck, rec} = ctx;
  const tips = [];
  const add = (key, pri, text, speak) => tips.push({key, pri, text, speak});
  if (!started){ add('idle', 10, '경기 카운트다운이 끝나면 Space 또는 [경기 시작]을 누르세요.'); return tips; }
  if (rec && rec.recs.length){
    const r = rec.recs[0], c = _CARDS[r.id];
    if (rec.mode === 'defend') add('rec:'+rec.threat.t+r.id, 95, `${_CARDS[rec.threat.id].name} → ${c.name} · ${r.when} · ${r.how}`, `${c.name}, ${r.when}`);
    if (rec.mode === 'attack') add('rec:atk'+Math.floor(t/8), 92, `${rec.headline} · ${r.how}`, `공격 기회, ${c.name}`);
    if (rec.mode === 'cycle') add('rec:cyc'+Math.floor(t/10), 50, `${c.name}을(를) ${r.how}에`);
  }
  const seq = deck.seq, last = seq[seq.length-1], sinceLast = last ? t - last.t : 99;
  if (E <= 2.5 && t > 8) add('low', 90, `상대 엘릭서 ${E.toFixed(1)}! 지금 반대 라인을 공격하세요`, '상대 엘릭서 부족, 지금 공격');
  else if (E <= 4 && t > 8) add('mid', 55, `상대 엘릭서 ${E.toFixed(1)}: 아직 큰 카드는 못 내요`);
  if (E >= 9.7) add('full', 70, '상대 엘릭서가 가득 찼어요. 큰 공격에 대비해 수비 카드를 남겨두세요', '상대 엘릭서 가득');
  if (myE != null && myE >= 9.7) add('myfull', 68, '내 엘릭서가 가득 찼어요! 뭐라도 내서 낭비를 막으세요', '내 엘릭서 가득');
  if (myE != null && E - myE >= 3) add('gap', 66, `상대가 엘릭서 ${(E-myE).toFixed(1)} 앞서요. 무리한 공격은 금지, 수비 후 역공`);
  if (myE != null && myE - E >= 3) add('gap2', 64, `내가 엘릭서 ${(myE-E).toFixed(1)} 앞서요. 압박하기 좋은 타이밍`);
  if (recentLeak > 0.3) add('leak', 45, `상대가 엘릭서를 버리는 중 (+${recentLeak.toFixed(1)}). 큰 공격을 준비하는 중일 수 있어요`);
  if (last && sinceLast < 5 && last.id !== 'unknown'){
    const c = _CARDS[last.id], cost = playCost(plays, plays.indexOf(last), ctx.unknownCost);
    if (c && cost >= 6) add('big:'+last.t, 85, `상대가 ${c.name}(${cost})을(를) 냈어요. 엘릭서가 빈 지금 반대 라인을 압박하세요!`, `${c.name}, 반대 라인 압박`);
  }
  const lastAb = plays.filter(p=>p.ability).slice(-1)[0];
  if (lastAb && t - lastAb.t < 3) add('ab:'+lastAb.t, 65, `상대가 ${_CARDS[lastAb.ability] ? _CARDS[lastAb.ability].name : ''} 능력을 썼어요 (-${lastAb.cost})`);
  const spellsOut = [];
  for (const id of deck.known){
    const c = _CARDS[id]; if (!c || !c.tags.some(x=>x==='spellB'||x==='spellS')) continue;
    const st = deck.status[id]; if (st.where==='queue' && st.returnsIn) spellsOut.push(`${c.name}(${st.returnsIn}장 뒤)`);
  }
  if (spellsOut.length) add('spells', 60, `상대 주문이 사이클 밖: ${spellsOut.join(', ')}. 그 주문에 약한 카드를 낼 기회예요`);
  for (const w of deck.known.filter(id=>_CARDS[id] && _CARDS[id].tags.includes('win'))){
    const st = deck.status[w];
    if (st.where==='queue' && st.returnsIn && st.returnsIn >= 2) add('winout:'+w, 62, `상대 ${_CARDS[w].name}이(가) 손에 없어요 (${st.returnsIn}장 뒤). 공격에 집중해도 돼요`);
    else if (st.where==='hand') add('winin:'+w, 48, `상대 손에 ${_CARDS[w].name}이(가) 있어요. 수비 카드를 남겨두세요`);
  }
  const top = inf.groups[0];
  if (top && deck.known.length >= 2){
    const d = top.best.d;
    add('arch', top.prob > 0.5 ? 58 : 40, `상대는 '${top.n}' 덱(${_ARCH[d.a].ko})일 가능성이 ${Math.round(top.prob*100)}%` + (inf.predicted.length?` · 예상 카드: ${inf.predicted.slice(0,3).map(p=>_CARDS[p.id].name).join(', ')}`:''));
    if (top.prob > 0.45 && d.vs) add('vs:'+top.n, 57, `${top.n} 상대법: ${d.vs}`);
    if (myDeck){
      const m = deckMatchup(myDeck, d);
      if (m && m.verdict === 'bad') add('mu', 56, `내 덱이 ${top.n} 상대로 불리해요. 수비에 집중하고 타워 교환을 피하세요`);
      if (m && m.verdict === 'good') add('mu', 42, `내 덱이 ${top.n} 상대로 유리해요. 정석대로 압박하세요`);
    }
  }
  if (deck.full) add('hand', 52, `상대 손패: ${deck.hand.map(id=>_CARDS[id].name).join(', ')}` + (deck.next?` · 다음: ${_CARDS[deck.next]?_CARDS[deck.next].name:'?'}`:''));
  if (t >= 108 && t < 120) add('x2soon', 75, '곧 2배 엘릭서! 엘릭서를 8 이상 모아두세요', '곧 2배 엘릭서');
  if (t >= 228 && t < 240 && ctx.triple) add('x3soon', 75, '곧 3배 엘릭서!', '곧 3배 엘릭서');
  if (!seq.length && t > 12) add('wait', 30, '상대가 아직 카드를 안 냈어요. 킹 타워 뒤에 싼 카드부터 내서 사이클을 돌리세요');
  tips.sort((a,b)=>b.pri-a.pri);
  return tips;
}

/* ---------- 영상 학습 ---------- */
// events: {t, side:'opp'|'me', id, x, y}
function learnPatterns(events, base){
  const P = base ? JSON.parse(JSON.stringify(base)) : {};
  const ev = events.slice().sort((a,b)=>a.t-b.t);
  for (let i=0;i<ev.length;i++){
    const o = ev[i]; if (o.side !== 'opp' || !_CARDS[o.id]) continue;
    const r = ev.slice(i+1).find(e=>e.side==='me' && e.t - o.t > 0.2 && e.t - o.t <= 6);
    if (!r || !_CARDS[r.id]) continue;
    const mirror = (o.x != null && o.x >= 9);
    const rx = r.x == null ? null : (mirror ? 18 - r.x : r.x);
    const slot = ((P[o.id] = P[o.id] || {})[r.id] = P[o.id][r.id] || {n:0, x:0, y:0, pn:0});
    slot.n += 1;
    if (rx != null && r.y != null){ slot.x = (slot.x*slot.pn + rx)/(slot.pn+1); slot.y = (slot.y*slot.pn + r.y)/(slot.pn+1); slot.pn += 1; }
  }
  return P;
}
function heatmapFor(events, id, side){
  const grid = Array.from({length:32},()=>new Array(18).fill(0));
  events.filter(e=>e.id===id && (!side || e.side===side) && e.x!=null).forEach(e=>{
    const x = Math.max(0,Math.min(17,Math.floor(e.x))), y = Math.max(0,Math.min(31,Math.floor(e.y))); grid[y][x]++;
  });
  return grid;
}

/* ---------- 이미지 특징 / 템플릿 매칭 ---------- */
const FS = 24;
function featureFromRGBA(data){
  const n = FS*FS, f = new Float32Array(n*3); let mean = 0;
  for (let i=0;i<n;i++){ f[i*3]=data[i*4]; f[i*3+1]=data[i*4+1]; f[i*3+2]=data[i*4+2]; }
  for (let i=0;i<f.length;i++) mean += f[i]; mean /= f.length;
  let norm = 0; for (let i=0;i<f.length;i++){ f[i]-=mean; norm += f[i]*f[i]; }
  norm = Math.sqrt(norm) || 1; for (let i=0;i<f.length;i++) f[i]/=norm;
  return f;
}
function cosine(a,b){ let s=0; for (let i=0;i<a.length;i++) s+=a[i]*b[i]; return s; }
function matchTemplates(feat, templates){
  const best = {};
  for (const tp of templates){ const s = cosine(feat, tp.f); if (best[tp.id]===undefined || s > best[tp.id]) best[tp.id] = s; }
  return Object.entries(best).map(([id,score])=>({id,score})).sort((a,b)=>b.score-a.score);
}
function rgbToB64(rgb){ let s=''; for (let i=0;i<rgb.length;i++) s+=String.fromCharCode(rgb[i]); return btoa(s); }
function b64ToRGBA(b64){ const s=atob(b64), n=s.length/3, out=new Uint8ClampedArray(n*4); for (let i=0;i<n;i++){ out[i*4]=s.charCodeAt(i*3); out[i*4+1]=s.charCodeAt(i*3+1); out[i*4+2]=s.charCodeAt(i*3+2); out[i*4+3]=255; } return out; }
function rgbaToRGB(d){ const n=d.length/4, o=new Uint8Array(n*3); for (let i=0;i<n;i++){ o[i*3]=d[i*4]; o[i*3+1]=d[i*4+1]; o[i*3+2]=d[i*4+2]; } return o; }

/* ---------- 화면 변화 감지 (반쪽 진영 18x15 격자) ---------- */
const GC = 18, GR = 15, CP = 4, AW = GC*CP, AH = GR*CP, RIVER = 15/32;
function isTowerCell(c, r, bottom){
  if (bottom) r = GR - 1 - r;
  if (r <= 4 && c >= 6 && c <= 11) return true;
  if (r >= 4 && r <= 8 && ((c >= 1 && c <= 5) || (c >= 12 && c <= 16))) return true;
  return false;
}
function detectEvents(hist, T, bottom){
  if (hist.length < 4) return [];
  const cur = hist[hist.length-1], prevs = hist.slice(-4,-1), quiet = T*0.4, seed = new Uint8Array(GC*GR);
  for (let r=0;r<GR;r++) for (let c=0;c<GC;c++){
    const i = r*GC+c; if (cur[i] < T || isTowerCell(c,r,bottom)) continue;
    let calm = true;
    for (const pv of prevs){
      for (let dr=-1;dr<=1&&calm;dr++) for (let dc=-1;dc<=1;dc++){ const rr=r+dr, cc=c+dc; if (rr<0||cc<0||rr>=GR||cc>=GC) continue; if (pv[rr*GC+cc] >= quiet){ calm=false; break; } }
      if (!calm) break;
    }
    if (calm) seed[i] = 1;
  }
  const seen = new Uint8Array(GC*GR), events = [];
  for (let i=0;i<seed.length;i++){
    if (!seed[i] || seen[i]) continue;
    const stack=[i]; seen[i]=1; let n=0,sx=0,sy=0;
    while (stack.length){ const j=stack.pop(), r=(j/GC)|0, c=j%GC; n++; sx+=c; sy+=r;
      for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++){ const rr=r+dr, cc=c+dc; if (rr<0||cc<0||rr>=GR||cc>=GC) continue; const k=rr*GC+cc; if (!seen[k] && cur[k] >= T*0.6){ seen[k]=1; stack.push(k); } } }
    if (n >= 2 && n <= 60) events.push({cx:sx/n, cy:sy/n, size:n});
  }
  return events;
}
function deckAvg(d){ return d.c.reduce((s,id)=>s+(_CARDS[id]?_CARDS[id].cost:0),0)/d.c.length; }

if (typeof module !== 'undefined') module.exports = {resolveSide, mergeMyEvents, regenBetween, timeToGain, playCostRange, secondsUntil, handModel, contextPrior, identify, costFromPosterior, rateAt, phaseAt, playCost, simulate, analyzeDeck, myHandOf, inferDecks, counterScore, cscore, counterCardsFor, weakAgainst, goodAgainst, deckMatchup, threatPosition, placementFor, attackPlacement, recommend, buildTips, learnPatterns, heatmapFor, detectEvents, deckAvg, defaultDeploy, laneOf, GC, GR};
