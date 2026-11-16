'use strict';
(function(){
const $ = id => document.getElementById(id);
const store = {
  get(k,d){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }catch(e){ return d; } },
  set(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} if (store.onSet) store.onSet(k); },
};
/* 서버에서 받아 둔 최신 덱·밸런스 데이터가 있으면 화면을 만들기 전에 먼저 적용 */
function applyDataBundle(b){
  if (!b || !b.version || !Array.isArray(b.DECKS) || String(b.version) <= String(DATA_VERSION)) return false;
  const okDeck = d => d && d.n && Array.isArray(d.c) && d.c.length === 8 && d.c.every(id => CARDS[id]);
  const decks = b.DECKS.filter(okDeck);
  if (decks.length < 10) return false;
  const cur = (()=>{ try{ const st = JSON.parse(localStorage.getItem('crc_settings')||'{}'); const d = st.myDeck!=null ? DECKS[st.myDeck] : null; return d ? {n:d.n, v:d.v} : null; }catch(e){ return null; } })();
  DECKS.splice(0, DECKS.length, ...decks);
  if (Array.isArray(b.BALANCE)) BALANCE.splice(0, BALANCE.length, ...b.BALANCE.filter(x=>Array.isArray(x) && CARDS[x[1]]));
  if (Array.isArray(b.NEWS_SNAPSHOT)) NEWS_SNAPSHOT.splice(0, NEWS_SNAPSHOT.length, ...b.NEWS_SNAPSHOT);
  if (cur){ try{ const st = JSON.parse(localStorage.getItem('crc_settings')||'{}'); const i = DECKS.findIndex(d=>d.n===cur.n && d.v===cur.v); st.myDeck = i >= 0 ? i : null; localStorage.setItem('crc_settings', JSON.stringify(st)); }catch(e){} }
  return true;
}
applyDataBundle(store.get('crc_databundle', null));
const IMG_DEFAULT = 'https://cdn.royaleapi.com/static/img/cards-150/{key}.png';
const S = {
  started:false, startAt:0, offset:0, endedAt:null,
  plays:[],   // 상대
  mine:[],    // 나
  pending:[], lane:'R', placeArm:null,
  settings: Object.assign({tts:false, triple:true, sens:16, thresh:82, auto:true, autoAccept:true, autoMine:false, unknownCost:4, myDeck:null, imgOn:true, imgTpl:IMG_DEFAULT}, store.get('crc_settings', {})),
  calib: store.get('crc_calib', null),
  vcalib: store.get('crc_vcalib', null),
  vlog: store.get('crc_vlog', []),
};
const OVL = location.hash === '#overlay';
const OV = {e:null, hist:[], lastSeen:0, lastDrop:0, ref:0, calibOn:false, mode:'panel', regen:[], shifted2:false, shifted3:false};
if (OVL){ document.body.classList.add('overlay'); try{ if (window.CRNative && !localStorage.getItem('crc_settings')){ const cfg=JSON.parse(CRNative.getConfig()||'{}'); Object.keys(cfg).forEach(k=>{ if (/^crc_/.test(k) && cfg[k]!=null) localStorage.setItem(k, cfg[k]); }); S.settings=Object.assign(S.settings, store.get('crc_settings',{})); } }catch(e){} }
let PATTERNS = learnPatterns(S.vlog);
const saveSettings = ()=> store.set('crc_settings', S.settings);
const myDeck = ()=> (S.settings.myDeck != null && DECKS[S.settings.myDeck]) ? DECKS[S.settings.myDeck] : null;
const esc = s => String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let toastTimer;
function toast(msg){ const el=$('toast'); el.textContent=msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),2000); }
function gameTime(){ return S.started ? Math.max(0,(performance.now()-S.startAt)/1000 + S.offset) : (S.endedAt||0); }
const fmt = s => { s=Math.max(0,Math.ceil(s)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); };
const fmtE = t => Math.floor(t/60)+':'+String(Math.floor(t%60)).padStart(2,'0');
const opts = ()=>({triple:S.settings.triple, unknownCost:S.settings.unknownCost});
const lastSpoken = {};
function speak(key, text){
  const ovVoice = OVL && store.get('crc_ovvoice', true);
  if (!S.settings.tts && !ovVoice) return;
  const base = key.split(':')[0], now = performance.now();
  if (lastSpoken[base] && now - lastSpoken[base] < 6000) return;
  lastSpoken[base] = now;
  if (window.CRNative && CRNative.speak){ try{ CRNative.speak(text); }catch(e){} return; }
  if (!('speechSynthesis' in window)) return;
  const capTTS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.TextToSpeech;
  if (capTTS){ capTTS.stop().catch(()=>{}).finally(()=>capTTS.speak({text, lang:'ko-KR', rate:1.15}).catch(()=>{})); return; }
  try{ speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang='ko-KR'; u.rate=1.2; speechSynthesis.speak(u); }catch(e){}
}

/* ---------- 카드 이미지 ---------- */
const imgCache = {};
// 앱 안에 카드 이미지가 들어 있으면(빌드 때 내려받음) 그걸 쓰고, 없으면 온라인 이미지
let localCards = false;
(function(){ const k = (CARDS.hog && CARDS.hog.key) || 'hog-rider', t = new Image(); t.onload = ()=>{ localCards = true; try{ renderPalette(); render(); }catch(e){} }; t.src = 'cards/' + k + '.png'; })();
function imgUrl(id){ const c = CARDS[id]; if (!c || !c.key || !S.settings.imgOn) return null; if (localCards && S.settings.imgTpl === IMG_DEFAULT) return 'cards/' + c.key + '.png'; return S.settings.imgTpl.replace('{key}', c.key); }
function imgObj(id){
  const u = imgUrl(id); if (!u) return null;
  if (!imgCache[u]){ const im = new Image(); im.crossOrigin = 'anonymous'; im.src = u; im.onerror = ()=>{ im.failed = true; }; imgCache[u] = im; }
  return imgCache[u].failed ? null : imgCache[u];
}
function typeIcon(c){
  if (c.rarity === 'ch') return '👑'; if (c.type === 's') return '✨'; if (c.type === 'b') return '🏰';
  if (c.air) return '🪽'; if (c.tags.includes('win')) return '🎯'; return '⚔️';
}
function cardEl(id, o){
  o = o || {};
  const c = CARDS[id] || CARDS.unknown;
  const el = document.createElement('div');
  el.className = `crd r-${c.rarity} t-${c.type}` + (o.mini?' mini':'') + (o.ghost?' ghost':'') + (o.sel?' selc':'');
  const cost = c.tags.includes('mirror') ? '+1' : c.cost;
  const u = imgUrl(id);
  el.innerHTML = `<div class="in"><div class="ic">${typeIcon(c)}</div>${u?`<img class="art" loading="lazy" alt="" src="${esc(u)}" onerror="this.remove()">`:''}<div class="nm${c.name.length>6?' long':''}">${esc(c.name)}</div></div><div class="dr"><b>${cost}</b></div>`
    + (o.evo ? '<span class="bdg evo">진</span>' : o.hero ? '<span class="bdg hero">히</span>' : '');
  el.title = `${c.name} · ${cost} 엘릭서`;
  if (o.onclick) el.onclick = o.onclick;
  return el;
}
function deckCardsEl(d, mini){
  const wrap = document.createElement('div'); wrap.className='cards eight';
  d.c.forEach(id=> wrap.appendChild(cardEl(id,{mini, evo:d.e.includes(id), hero:d.h.includes(id), onclick:()=>openCardModal(id)})));
  return wrap;
}

/* ---------- 탭 / 모달 ---------- */
document.querySelectorAll('.nb').forEach(nb=> nb.onclick = ()=>{
  document.querySelectorAll('.nb').forEach(x=>x.classList.toggle('on', x===nb));
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on', t.id==='tab-'+nb.dataset.tab));
  if (nb.dataset.tab === 'news') loadNews(false);
  if (nb.dataset.tab === 'video') vArena.resize();
  window.scrollTo(0,0);
});
function openModal(title, node){ $('mTitle').textContent = title; const b=$('mBody'); b.innerHTML=''; if (typeof node === 'string') b.innerHTML = node; else b.appendChild(node); $('modal').classList.add('on'); }
$('mClose').onclick = ()=> $('modal').classList.remove('on');
$('modal').onclick = e=>{ if (e.target.id==='modal') $('modal').classList.remove('on'); };
$('btnHelp').onclick = ()=>{ document.querySelector('.nb[data-tab="settings"]').click(); $('guidePanel').scrollIntoView({behavior:'smooth'}); };
$('btnInstall').onclick = ()=>{
  openModal('📲 앱 설치 안내', $('installTpl').content.cloneNode(true));
  $('mBody').querySelectorAll('[data-dl]').forEach(a=>{ const u = DOWNLOADS[a.dataset.dl]; if (u){ a.href = u; a.target='_blank'; } else a.onclick = e=>{ e.preventDefault(); toast('설치 파일은 빌드를 배포한 뒤 이 버튼에 연결돼요'); }; });
};
$('pillDecks').textContent = `덱 ${DECKS.length}종 · 카드 ${CARD_DATA.length-1}장`;

/* ---------- 설정 ---------- */
function syncSettingsUI(){
  $('sens').value=S.settings.sens; $('thresh').value=S.settings.thresh;
  $('chkAuto').checked=S.settings.auto; $('chkAutoAccept').checked=S.settings.autoAccept; $('chkAutoMine').checked=S.settings.autoMine;
  $('chkTTS').checked=S.settings.tts; $('chkTriple').checked=S.settings.triple; $('unkCost').value=S.settings.unknownCost;
  $('chkImg').checked=S.settings.imgOn; $('imgTpl').value=S.settings.imgTpl;
  $('sensV').textContent=S.settings.sens; $('threshV').textContent=S.settings.thresh+'%';
  const md = myDeck(); $('pillMine').textContent = md ? `내 덱: ${md.n}` : '내 덱 미설정';
  $('mySel').value = S.settings.myDeck == null ? '' : String(S.settings.myDeck);
}
$('mySel').innerHTML = '<option value="">선택 안 함</option>' + DECKS.map((d,i)=>`<option value="${i}">${esc(d.n)} · ${esc(d.v)}</option>`).join('');
const setMyDeck = i => { S.settings.myDeck = i; saveSettings(); syncSettingsUI(); renderDecks(); renderMyHand(); lastGuessKey=''; };
$('mySel').onchange = e=> setMyDeck(e.target.value==='' ? null : +e.target.value);
$('sens').oninput = e=>{ S.settings.sens=+e.target.value; saveSettings(); syncSettingsUI(); };
$('thresh').oninput = e=>{ S.settings.thresh=+e.target.value; saveSettings(); syncSettingsUI(); };
$('chkAuto').onchange = e=>{ S.settings.auto=e.target.checked; saveSettings(); };
$('chkAutoAccept').onchange = e=>{ S.settings.autoAccept=e.target.checked; saveSettings(); };
$('chkAutoMine').onchange = e=>{ S.settings.autoMine=e.target.checked; saveSettings(); };
$('chkTTS').onchange = e=>{ S.settings.tts=e.target.checked; saveSettings(); if (e.target.checked) speak('test','음성 안내를 켰어요'); };
$('chkTriple').onchange = e=>{ S.settings.triple=e.target.checked; saveSettings(); };
$('unkCost').onchange = e=>{ S.settings.unknownCost=Math.max(1,Math.min(9,+e.target.value||4)); saveSettings(); };
$('chkImg').onchange = e=>{ S.settings.imgOn=e.target.checked; saveSettings(); renderPalette(); renderDecks(); renderMyHand(); };
$('imgTpl').onchange = e=>{ S.settings.imgTpl = e.target.value.trim() || IMG_DEFAULT; saveSettings(); renderPalette(); renderDecks(); };
syncSettingsUI();

/* ---------- 엘릭서 막대 ---------- */
function makeBar(el, onSet){
  const segs = [];
  for (let i=0;i<10;i++){ const s=document.createElement('div'); s.className='seg'; s.innerHTML=`<div class="f"></div><span>${i+1}</span>`; el.appendChild(s); segs.push(s.firstChild); }
  el.onclick = e=>{
    if (!S.started){ toast('경기를 시작한 뒤 보정할 수 있어요'); return; }
    const r = el.getBoundingClientRect(); onSet(Math.max(0, Math.min(10, Math.round(((e.clientX-r.left)/r.width)*10*2)/2)));
  };
  return v => segs.forEach((f,i)=>{ f.style.width = Math.max(0,Math.min(1, v - i))*100 + '%'; });
}
const setOppBar = makeBar($('segbar'), v=>{ S.plays.push({t:gameTime(), corr:true, value:v}); toast(`상대 엘릭서를 ${v}로 보정`); render(); });
const setMyBar = makeBar($('segbarMe'), v=>{ S.mine.push({t:gameTime(), corr:true, value:v}); toast(`내 엘릭서를 ${v}로 보정`); render(); });

/* ---------- 경기 제어 ---------- */
function startGame(){
  S.started=true; S.startAt=performance.now(); S.offset=0; S.endedAt=null; S.plays=[]; S.mine=[]; S.pending=[];
  try{ const ka = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.KeepAwake; if (ka) ka.keepAwake(); }catch(e){}
  renderPending(); $('btnStart').textContent='🏁 경기 종료'; $('btnStart').classList.replace('gold','red');
  toast('경기 시작! 양쪽 엘릭서를 5부터 계산해요'); speak('start','경기 시작');
}
function endGame(){ S.endedAt=gameTime(); S.started=false; $('btnStart').textContent='⚔️ 경기 시작'; $('btnStart').classList.replace('red','gold'); toast('경기 종료'); }
$('btnStart').onclick = ()=> S.started ? endGame() : startGame();
$('btnMinus').onclick = ()=>{ S.offset-=1; render(); };
$('btnPlus').onclick = ()=>{ S.offset+=1; render(); };
$('btnReset').onclick = ()=>{ if (S.started) endGame(); S.endedAt=null; S.plays=[]; S.mine=[]; S.pending=[]; renderPending(); render(); };
document.querySelectorAll('.laneBtn').forEach(b=> b.onclick = ()=>{ S.lane = b.dataset.l; document.querySelectorAll('.laneBtn').forEach(x=>x.classList.toggle('on', x===b)); });
function recordPlay(id, extra){
  if (!S.started){ toast('먼저 [경기 시작]을 눌러주세요'); return; }
  const lane = (extra && extra.lane) || S.lane;
  const pos = extra && extra.x != null ? {x:extra.x, y:extra.y} : defaultDeploy(id, lane);
  const p = Object.assign({t:gameTime(), id, lane: laneOf(pos.x), x:pos.x, y:pos.y}, extra||{});
  S.plays.push(p);
  if (!extra || extra.x == null){ S.placeArm = {who:'opp', p, until:performance.now()+5000}; $('arenaHint').textContent='📍 3D 경기장에서 놓은 위치를 누르면 더 정확해져요 (5초)'; }
  render();
}
function recordMine(id, extra){
  if (!S.started){ toast('먼저 [경기 시작]을 눌러주세요'); return; }
  const p = Object.assign({t:gameTime(), id}, extra||{});
  if (p.x == null){ const r = lastRec && lastRec.recs.find(x=>x.id===id); if (r){ p.x=r.x; p.y=r.y; } else { p.x=S.lane==='L'?3.5:14.5; p.y=22; } }
  S.mine.push(p); render();
}
function recordAbility(id){
  const c = CARDS[id]; const cost = c.champAb || c.heroAb;
  if (!S.started){ toast('먼저 [경기 시작]을 눌러주세요'); return; }
  S.plays.push({t:gameTime(), ability:id, cost}); toast(`상대 ${c.name} 능력 (-${cost})`); render();
}
$('btnUndo').onclick = ()=>{ S.plays.pop(); render(); };
$('btnUnknown').onclick = ()=> recordPlay('unknown');

/* ---------- 팔레트 ---------- */
const FILTERS = [['all','전체'],['1','1'],['2','2'],['3','3'],['4','4'],['5','5'],['6','6+'],['s','주문'],['b','건물'],['win','승리 조건'],['ab','능력']];
function setupFilters(el, onChange){
  el.innerHTML = FILTERS.map(([k,l])=>`<span class="fchip${k==='all'?' on':''}" data-k="${k}">${l}</span>`).join('');
  el.onclick = e=>{ const k=e.target.dataset&&e.target.dataset.k; if(!k) return; el.querySelectorAll('.fchip').forEach(x=>x.classList.toggle('on',x.dataset.k===k)); onChange(k); };
}
function cardMatches(c, q){ if (!q) return true; const n=q.replace(/\s/g,''); return c.name.replace(/\s/g,'').includes(n) || c.alias.includes(q); }
function filterCards(q, f){
  return Object.values(CARDS).filter(c=>c.id!=='unknown' && cardMatches(c,q)).filter(c=>{
    if (f==='all') return true; if (f==='s'||f==='b') return c.type===f; if (f==='win') return c.tags.includes('win');
    if (f==='ab') return c.heroAb || c.champAb; const n=+f; return n===6 ? c.cost>=6 : c.cost===n;
  }).sort((a,b)=>a.cost-b.cost || a.name.localeCompare(b.name,'ko'));
}
let curFilter='all';
setupFilters($('filters'), k=>{ curFilter=k; renderPalette(); });
function renderPalette(){
  const pal=$('palette'); pal.innerHTML='';
  filterCards($('search').value.trim(), curFilter).forEach(c=> pal.appendChild(cardEl(c.id,{mini:true, onclick:()=>{ recordPlay(c.id); if ($('search').value){ $('search').value=''; renderPalette(); } }})));
}
$('search').oninput = renderPalette;
$('search').onkeydown = e=>{ if (e.key==='Enter'){ const b=$('palette').querySelector('.crd'); if (b) b.click(); } e.stopPropagation(); };
renderPalette();

document.addEventListener('keydown', e=>{
  if (['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
  if (e.code==='Space'){ e.preventDefault(); $('btnStart').click(); }
  else if (e.key==='z'||e.key==='Z'){ $('btnUndo').click(); }
  else if (e.key==='ArrowLeft'){ document.querySelector('.laneBtn[data-l="L"]').click(); }
  else if (e.key==='ArrowRight'){ document.querySelector('.laneBtn[data-l="R"]').click(); }
  else if (/^[1-8]$/.test(e.key) && !e.shiftKey){ const id = analyzeDeck(S.plays).known[+e.key-1]; if (id) recordPlay(id); else toast(`${e.key}번 칸은 아직 비어 있어요`); }
  else if (/^[qwertyui]$/i.test(e.key)){ const md=myDeck(); if (md){ const id = md.c['qwertyui'.indexOf(e.key.toLowerCase())]; if (id) recordMine(id); } }
});

/* ---------- 내 카드 ---------- */
function renderMyHand(){
  const el=$('myHand'); el.innerHTML='';
  const md = myDeck();
  if (!md){ el.innerHTML='<div class="muted">설정이나 덱 사전에서 <b>내 덱</b>을 고르면 내 엘릭서·손패를 계산하고 손에 있는 카드로만 추천해요.</div>'; return; }
  const h = myHandOf(md.c, S.mine);
  md.c.forEach((id,i)=>{
    const w=document.createElement('div'); w.className='slot';
    const inHand = h.known ? h.hand.includes(id) : !h.queue.includes(id);
    w.appendChild(cardEl(id,{mini:true, evo:md.e.includes(id), hero:md.h.includes(id), ghost:!inHand, onclick:()=>recordMine(id)}));
    const s=document.createElement('span'); s.className='st '+(inHand?'hand':'queue'); s.textContent = (inHand?'손패':'대기')+' · '+'QWERTYUI'[i]; w.appendChild(s);
    el.appendChild(w);
  });
}

/* ---------- 3D 아레나 ---------- */
const arena = Arena3D($('arena3d'));
arena.setImageSource(imgObj);
$('arena3d').addEventListener('click', e=>{
  const tile = arena.pick(e.clientX, e.clientY); if (!tile) return;
  if (S.placeArm && performance.now() < S.placeArm.until){
    const p = S.placeArm.p; p.x = tile.x; p.y = tile.y; p.lane = laneOf(tile.x); S.placeArm = null; $('arenaHint').textContent=''; toast('위치를 저장했어요'); render(); return;
  }
  S.lane = laneOf(tile.x); document.querySelectorAll('.laneBtn').forEach(x=>x.classList.toggle('on', x.dataset.l===S.lane));
  toast(`라인: ${S.lane==='L'?'왼쪽':'오른쪽'}`);
});

/* ---------- 정보 카드 ---------- */
function deckInfoEl(d){
  const box = document.createElement('div'); const md = myDeck(); const mu = md ? deckMatchup(md, d) : null;
  box.innerHTML = `<div class="row" style="margin:8px 0 6px"><span class="chip" style="background:${ARCH[d.a].color}">${ARCH[d.a].ko}</span><b>${esc(d.n)}</b><span class="muted">${esc(d.v)} · 평균 ${deckAvg(d).toFixed(1)}${d.wr?` · 상위권 승률 ${d.wr}%`:''}</span>
    ${mu?`<span class="chip" style="background:${mu.verdict==='good'?'#3faa25':mu.verdict==='bad'?'#d33030':'#7d8db0'}">내 덱 ${mu.verdict==='good'?'유리':mu.verdict==='bad'?'불리':'비슷'}</span>`:''}</div>`;
  box.appendChild(deckCardsEl(d, true));
  const p = document.createElement('div'); p.className='deck';
  p.innerHTML = `<p><b>운영:</b> ${esc(d.plan)}</p><p><b>상대법:</b> ${esc(d.vs)}</p>` + (md ? counterLine(d, md) : '');
  box.appendChild(p); return box;
}
function counterLine(d, md){
  const parts = deckWins(d).map(w=>{ const cc = counterCardsFor(w, md.c); return cc.length ? `${CARDS[w].name} ← ${cc.slice(0,3).map(x=>CARDS[x].name).join(', ')}` : `${CARDS[w].name} ← (내 덱에 마땅한 카드 없음: 타워+물량으로)`; });
  return parts.length ? `<p><b>내 덱 대응 카드:</b> ${esc(parts.join(' / '))}</p>` : '';
}
function openCardModal(id){
  const c = CARDS[id]; if (!c) return;
  const node = document.createElement('div');
  const top = document.createElement('div'); top.className='row'; top.appendChild(cardEl(id,{evo:false}));
  const stats = document.createElement('div'); stats.style.flex='1';
  stats.innerHTML = `<table class="t">
   <tr><th>비용</th><td>${c.tags.includes('mirror')?'직전 카드 +1':c.cost} 엘릭서</td><th>등급</th><td>${RARITY_NAME[c.rarity]}</td></tr>
   <tr><th>종류</th><td>${TYPE_NAME[c.type]}${c.air?' (비행)':''}</td><th>공격 대상</th><td>${c.type==='s'?(c.tgt==='g'?'지상만':'공중·지상'):TGT_NAME[c.tgt]||'-'}</td></tr>
   <tr><th>사거리</th><td>${c.rng ? (c.rng<=1.5?'근접':c.rng+' 타일') : '-'}</td><th>이동 속도</th><td>${SPEED_NAME[c.spd]||'-'}</td></tr>
   ${c.type==='s'?`<tr><th>위력</th><td colspan="3">${'■'.repeat(c.dps)}${'□'.repeat(5-c.dps)}${c.splash?' · 범위':''}</td></tr>`:`<tr><th>체력</th><td>${'■'.repeat(c.hp)}${'□'.repeat(5-c.hp)}</td><th>화력</th><td>${'■'.repeat(c.dps)}${'□'.repeat(5-c.dps)}${c.splash?' · 범위':' · 단일'}</td></tr>`}
   ${c.evo?'<tr><th>진화</th><td colspan="3">있음</td></tr>':''}
   ${c.heroAb?`<tr><th>히어로 능력</th><td colspan="3">${c.heroAb} 엘릭서</td></tr>`:''}${c.champAb?`<tr><th>챔피언 능력</th><td colspan="3">${c.champAb} 엘릭서</td></tr>`:''}
  </table>`;
  top.appendChild(stats); node.appendChild(top);
  const p = document.createElement('div'); p.className='deck';
  const strong = goodAgainst(id), weak = weakAgainst(id);
  const bal = BALANCE.filter(b=>b[1]===id);
  p.innerHTML = `<p><b>특성:</b> ${esc(c.note)}</p>`
    + `<p><b>이 카드로 잘 막는 카드:</b></p>`;
  node.appendChild(p);
  const s1 = document.createElement('div'); s1.className='cards'; strong.forEach(x=>s1.appendChild(cardEl(x,{mini:true, onclick:()=>openCardModal(x)}))); if (!strong.length) s1.innerHTML='<span class="muted">수비용 카드가 아니에요 (보조·공격 카드)</span>'; node.appendChild(s1);
  const p2 = document.createElement('div'); p2.className='deck'; p2.innerHTML = `<p><b>이 카드를 잘 막는 카드:</b></p>`; node.appendChild(p2);
  const s2 = document.createElement('div'); s2.className='cards'; weak.forEach(x=>s2.appendChild(cardEl(x,{mini:true, onclick:()=>openCardModal(x)}))); if (!weak.length) s2.innerHTML='<span class="muted">주문·보조 카드라 막는 대상이 아니에요</span>'; node.appendChild(s2);
  if (bal.length){ const p3=document.createElement('div'); p3.className='deck'; p3.innerHTML=`<p><b>최근 밸런스 변경:</b></p>`+bal.map(b=>`<div class="muted">${b[0]} · ${b[2]} · ${esc(b[3])}</div>`).join(''); node.appendChild(p3); }
  const used = DECKS.filter(d=>d.c.includes(id)).slice(0,6);
  if (used.length){ const p4=document.createElement('div'); p4.className='deck'; p4.innerHTML=`<p><b>이 카드를 쓰는 덱:</b> ${used.map(d=>esc(d.n+'('+d.v+')')).join(', ')}</p>`; node.appendChild(p4); }
  openModal(`${c.name}`, node);
}

/* ---------- 렌더 ---------- */
let prevTipKeys = new Set(), lastGuessKey = '', lastRec = null;
function render(){
  const t = gameTime();
  const sim = simulate(S.plays, t, opts());
  const md = myDeck();
  const simMe = simulate(S.mine, t, opts());
  if (OV.e != null && S.started) simMe.E = OV.e;
  const deck = analyzeDeck(S.plays), inf = inferDecks(deck.known);
  const ph = phaseAt(t, S.settings.triple);
  const hand = md ? myHandOf(md.c, S.mine) : null;
  const rec = S.started ? recommend({t, oppPlays:S.plays, myCards: md?md.c:null, myHand:hand, myE:simMe.E, oppE:sim.E, triple:S.settings.triple, patterns:PATTERNS}) : null;
  lastRec = rec;

  $('timer').textContent = t < 180 ? fmt(180-t) : fmt(Math.max(0,300-t));
  const pe=$('phase'); pe.textContent = S.started ? ph.label : (S.endedAt?'경기 종료':'대기 중'); pe.className='phase hd '+(S.started?ph.cls:'');
  $('elixirNum').textContent = sim.E >= 9.95 ? '10' : sim.E.toFixed(1); setOppBar(sim.E);
  $('elixirNumMe').textContent = simMe.E >= 9.95 ? '10' : simMe.E.toFixed(1); setMyBar(simMe.E);
  $('leakInfo').textContent = `낭비 ${sim.leak.toFixed(1)}` + (sim.deficit>0.5?` · 보정 ${sim.deficit.toFixed(1)}`:'');
  $('leakInfoMe').textContent = `낭비 ${simMe.leak.toFixed(1)}`;
  const diff = sim.E - simMe.E; $('ediff').textContent = S.started ? (Math.abs(diff)<0.5 ? '엘릭서 비슷' : diff>0 ? `상대가 ${diff.toFixed(1)} 앞섬` : `내가 ${(-diff).toFixed(1)} 앞섬`) : '';

  // 추천 카드
  const rb=$('recBox'); rb.innerHTML='';
  if (!S.started){ rb.innerHTML='<div class="muted">경기를 시작하면 상대 카드와 양쪽 엘릭서를 보고 낼 카드와 위치를 알려줘요.</div>'; }
  else if (!rec || !rec.recs.length){ rb.innerHTML=`<div class="recHead">${esc(rec?rec.headline:'')}</div>`; }
  else {
    rb.innerHTML = `<div class="recHead ${rec.mode}">${rec.mode==='defend'?'🛡 수비':rec.mode==='attack'?'⚔️ 공격':'♻️ 사이클'} · ${esc(rec.headline)}</div>`;
    rec.recs.forEach((r,i)=>{
      const row=document.createElement('div'); row.className='recRow'+(i===0?' best':'');
      row.appendChild(cardEl(r.id,{mini:true, onclick:()=>recordMine(r.id, {x:r.x, y:r.y})}));
      const tx=document.createElement('div'); tx.className='recTx';
      tx.innerHTML = `<b>${i+1}. ${esc(CARDS[r.id].name)}</b> <span class="chip" style="background:#2775e0">${esc(r.when)}</span>${r.inHand===false?' <span class="chip" style="background:#d33030">손에 없음</span>':''}${r.wait>0.3?` <span class="chip" style="background:#c47a00">${r.wait.toFixed(0)}초 뒤 가능</span>`:''}<br>📍 ${esc(r.how)}<br><span class="muted">${esc(r.why.join(' · '))}</span>`;
      row.appendChild(tx); rb.appendChild(row);
    });
  }

  // 3D 상태
  const oppUnits = [], paths = [];
  S.plays.filter(p=>!p.corr && !p.ability && CARDS[p.id] && t - p.t < (CARDS[p.id].type==='s' && !CARDS[p.id].tags.includes('win') ? 2.5 : 14)).forEach(p=>{
    const tp = threatPosition(p, t); if (!tp) return;
    if (CARDS[p.id].type==='t' && tp.arrived && t-p.t>9) return;
    oppUnits.push({id:p.id, name:CARDS[p.id].name, x:tp.x, y:tp.y, label: rec && rec.threat===p ? `${CARDS[p.id].name}${tp.eta>0?` · ${tp.eta.toFixed(0)}초`:''}` : ''});
    if (rec && rec.threat === p && !tp.arrived) paths.push([{x:tp.x,y:tp.y}, ...(tp.y<16 && !CARDS[p.id].air ? [{x:p.lane==='L'?3.5:14.5,y:16}] : []), {x:p.lane==='L'?3.5:14.5,y:24}]);
  });
  const mineUnits = S.mine.filter(p=>!p.corr && CARDS[p.id] && t - p.t < 8 && p.x!=null).map(p=>({id:p.id, name:CARDS[p.id].name, x:p.x, y:p.y}));
  const recs = rec ? rec.recs.slice(0,1).map(r=>({id:r.id, name:CARDS[r.id].name, x:r.x, y:r.y, label:`여기에 ${CARDS[r.id].name}`})) : [];
  arena.set({opp:oppUnits, mine:mineUnits, recs, paths, hint: rec && rec.recs.length ? `${rec.mode==='defend'?'수비':rec.mode==='attack'?'공격':'사이클'}: ${CARDS[rec.recs[0].id].name} · ${rec.recs[0].when}` : ''});
  if (S.placeArm && performance.now() > S.placeArm.until){ S.placeArm=null; $('arenaHint').textContent=''; }

  // 피드백
  const tips = buildTips({t, started:S.started, E:sim.E, myE: md||S.mine.length ? simMe.E : null, recentLeak:sim.recentLeak, deck, inf, plays:S.plays, unknownCost:S.settings.unknownCost, triple:S.settings.triple, myDeck:md, rec});
  const te=$('tips'); te.innerHTML='';
  tips.slice(0,5).forEach(tp=>{ const d=document.createElement('div'); d.className='tip '+(tp.pri>=90?'p90':tp.pri>=80?'p80':tp.pri>=70?'p70':tp.pri>=60?'p60':tp.pri>=55?'p55':''); d.textContent=tp.text; te.appendChild(d); });
  for (const tp of tips) if (tp.speak && !prevTipKeys.has(tp.key)){ speak(tp.key, tp.speak); break; }
  prevTipKeys = new Set(tips.map(x=>x.key));

  // 상대 덱 슬롯
  const sl=$('slots'); sl.innerHTML=''; $('deckCount').textContent = `${deck.known.length}/8 확인`;
  deck.known.forEach((id,i)=>{
    const c=CARDS[id], st=deck.status[id], w=document.createElement('div'); w.className='slot';
    w.appendChild(cardEl(id,{mini:true, onclick:()=>recordPlay(id)}));
    const s=document.createElement('span'); s.className='st '+(st.where==='hand'?'hand':'queue'); s.textContent = st.where==='hand' ? `손패 · ${i+1}` : (st.returnsIn?`${st.returnsIn}장 뒤`:'대기'); w.appendChild(s);
    if (c.heroAb || c.champAb){ const b=document.createElement('button'); b.className='btn sm gold ab'; b.textContent=`⚡${c.champAb||c.heroAb}`; b.title='상대가 능력을 쓰면 누르세요'; b.onclick=()=>recordAbility(id); w.appendChild(b); }
    sl.appendChild(w);
  });
  inf.predicted.forEach(p=>{ const w=document.createElement('div'); w.className='slot'; w.appendChild(cardEl(p.id,{mini:true, ghost:true})); const s=document.createElement('span'); s.className='st pred'; s.textContent=`예상 ${Math.round(p.prob*100)}%`; w.appendChild(s); sl.appendChild(w); });
  for (let i=deck.known.length+inf.predicted.length;i<8;i++){ const w=document.createElement('div'); w.className='slot'; const e=document.createElement('div'); e.className='crd mini empty'; e.innerHTML='<div class="in"><div class="ic">❔</div></div>'; w.appendChild(e); sl.appendChild(w); }
  const hn = deck.hand.map(id=>CARDS[id].name), unk = deck.seq.length>=4 ? 4-hn.length : null;
  $('handLine').textContent = deck.seq.length<4 ? '상대가 4장 이상 내면 손패를 계산해요.' : `🖐 상대 손패: ${hn.join(', ')||'—'}${unk>0?` + 모르는 ${unk}장`:''}` + (deck.next?` · 다음 복귀: ${CARDS[deck.next]?CARDS[deck.next].name:'?'}`:'');

  // 덱 추정
  const gk = inf.groups.slice(0,5).map(g=>g.n+Math.round(g.prob*100)).join('|') + (md?S.settings.myDeck:'');
  if (gk !== lastGuessKey){
    lastGuessKey = gk; const ge=$('guess'); ge.innerHTML='';
    if (!deck.known.length){ ge.innerHTML='<div class="muted">상대가 카드를 내면 덱 사전과 비교해 추정해요.</div>'; $('oppInfo').innerHTML=''; }
    else {
      inf.groups.slice(0,4).forEach(g=>{
        const d=document.createElement('div'); d.className='gitem';
        d.innerHTML=`<span><span class="chip" style="background:${ARCH[g.a].color}">${ARCH[g.a].ko}</span> <span class="nm">${esc(g.n)}</span> <span class="muted">${esc(g.best.d.v)}</span></span><span class="pct">${Math.round(g.prob*100)}%</span><div class="bar"><i style="width:${Math.round(g.prob*100)}%"></i></div>`;
        d.onclick=()=>openModal(`${g.n} · ${g.best.d.v}`, deckInfoEl(g.best.d)); ge.appendChild(d);
      });
      if (inf.bestMiss >= 2) ge.insertAdjacentHTML('beforeend', `<div class="muted">알려진 덱과 ${inf.bestMiss}장 이상 다른 변형이에요. 참고만 하세요.</div>`);
      const oi=$('oppInfo'); oi.innerHTML=''; if (inf.groups[0] && deck.known.length>=2) oi.appendChild(deckInfoEl(inf.groups[0].best.d));
    }
  }
  renderMyHand();
  // 로그
  const lg=$('log'); lg.innerHTML='';
  const all = S.plays.map((p,i)=>({p,i,who:'opp'})).concat(S.mine.map((p,i)=>({p,i,who:'me'}))).sort((a,b)=>b.p.t-a.p.t).slice(0,30);
  all.forEach(({p,i,who})=>{
    const d=document.createElement('div'); d.className='li '+who; const arr = who==='opp'?S.plays:S.mine;
    if (p.corr) d.innerHTML=`<span class="t">${fmtE(p.t)}</span><span>${who==='opp'?'상대':'내'} 엘릭서 보정 → ${p.value}</span>`;
    else if (p.ability) d.innerHTML=`<span class="t">${fmtE(p.t)}</span><span class="c">${p.cost}</span><span>⚡ 상대 ${esc(CARDS[p.ability].name)} 능력</span>`;
    else { const c=CARDS[p.id]||CARDS.unknown; d.innerHTML=`<span class="t">${fmtE(p.t)}</span><span class="who">${who==='opp'?'상대':'나'}</span>${p.thumb?`<img src="${p.thumb}">`:''}<span class="c">${playCost(arr,i,S.settings.unknownCost)}</span><span>${esc(c.name)}</span>${p.auto?`<span class="auto">자동 ${Math.round(p.score*100)}%</span>`:''}`; }
    const x=document.createElement('button'); x.className='btn sm red x'; x.textContent='✕'; x.onclick=()=>{ arr.splice(i,1); render(); };
    d.appendChild(x); lg.appendChild(d);
  });
  if (!all.length) lg.innerHTML='<div class="muted">아직 기록이 없어요.</div>';
  $('tplCount').textContent = `학습 ${templates.filter(t=>t.id!=='__ignore').length}장`;
  renderHud(sim.E, simMe.E, rec, deck);
  if (OVL) renderOverlay(sim, simMe, rec, deck, inf, tips);
}

/* ---------- 미니 창 (항상 위 HUD) ---------- */
const hud = $('miniHud');
let pipWin = null;
function renderHud(E, myE, rec, deck){
  const r = rec && rec.recs[0];
  hud.innerHTML = `<div class="hrow"><div class="hb opp"><small>상대</small><b>${E.toFixed(1)}</b></div><div class="hb me"><small>나</small><b>${myE.toFixed(1)}</b></div><div class="hb tm"><small>${S.started?phaseAt(gameTime(),S.settings.triple).label:'대기'}</small><b>${$('timer').textContent}</b></div></div>`
    + `<div class="hrec">${r ? `${rec.mode==='defend'?'🛡':rec.mode==='attack'?'⚔️':'♻️'} <b>${esc(CARDS[r.id].name)}</b> · ${esc(r.when)}<br><small>${esc(r.how)}</small>` : esc(rec?rec.headline:'경기 시작 대기')}</div>`
    + (deck.seq.length>=4 ? `<div class="hhand">상대 손패: ${esc(deck.hand.map(id=>CARDS[id].name).join(', '))}</div>` : '');
}
$('btnPip').onclick = async ()=>{
  if (window.crNative && window.crNative.miniMode){
    const on = !document.body.classList.contains('minimode');
    document.body.classList.toggle('minimode', on); hud.style.display = on ? 'block' : 'none';
    await window.crNative.miniMode(on); return;
  }
  if (window.documentPictureInPicture){
    try{
      pipWin = await documentPictureInPicture.requestWindow({width:340, height:230});
      const st = pipWin.document.createElement('style'); st.textContent = $('hudCss').textContent; pipWin.document.head.appendChild(st);
      pipWin.document.body.appendChild(hud); hud.style.display='block';
      pipWin.addEventListener('pagehide', ()=>{ $('hudHome').appendChild(hud); hud.style.display='none'; });
      return;
    }catch(e){}
  }
  hud.style.display = hud.style.display==='block' ? 'none' : 'block';
  toast('이 브라우저는 별도 창을 지원하지 않아 화면 위에 띄웠어요');
};

/* ---------- 덱 사전 & 카드 도감 ---------- */
let aFilter='all', dMode='decks';
$('afilters').innerHTML = `<span class="fchip on" data-k="all">전체</span>` + Object.entries(ARCH).map(([k,a])=>`<span class="fchip" data-k="${k}">${a.ko}</span>`).join('');
$('afilters').onclick = e=>{ const k=e.target.dataset&&e.target.dataset.k; if(!k) return; aFilter=k; $('afilters').querySelectorAll('.fchip').forEach(x=>x.classList.toggle('on',x.dataset.k===k)); renderDecks(); };
$('dsearch').oninput = ()=>renderDecks();
document.querySelectorAll('.dmode').forEach(b=> b.onclick=()=>{ dMode=b.dataset.m; document.querySelectorAll('.dmode').forEach(x=>x.classList.toggle('on',x===b)); $('afilters').style.display = dMode==='decks'?'':'none'; renderDecks(); });
function renderDecks(){
  const q = $('dsearch').value.trim(), grid=$('dgrid'); grid.innerHTML='';
  if (dMode === 'cards'){
    grid.className='cgrid';
    const list = filterCards(q, 'all');
    $('dcount').textContent = `카드 ${list.length}장 · 카드를 누르면 특성, 상성, 최근 밸런스 변경을 볼 수 있어요`;
    list.forEach(c=>{ const w=document.createElement('div'); w.className='cdex'; w.appendChild(cardEl(c.id,{onclick:()=>openCardModal(c.id)})); const tx=document.createElement('div'); tx.className='muted'; tx.textContent=c.note.split('.')[0]; w.appendChild(tx); grid.appendChild(w); });
    return;
  }
  grid.className='dgrid';
  const md = myDeck();
  const list = DECKS.map((d,i)=>({d,i})).filter(({d})=>(aFilter==='all'||d.a===aFilter) && (!q || d.n.includes(q) || d.v.includes(q) || d.c.some(id=>cardMatches(CARDS[id], q))))
    .sort((a,b)=>(b.d.pop-a.d.pop) || ((b.d.wr||0)-(a.d.wr||0)) || a.d.n.localeCompare(b.d.n,'ko'));
  $('dcount').textContent = `${list.length}개 덱 · 인기·승률 순 · 상성은 카드 특성으로 계산해요`;
  list.forEach(({d,i})=>{
    const p=document.createElement('div'); p.className='panel deck'+(S.settings.myDeck===i?' mine':'');
    p.innerHTML=`<div class="ribbon" style="background:linear-gradient(180deg,${ARCH[d.a].color},${ARCH[d.a].color}cc)"><h2>${esc(d.n)}</h2><span class="sub" style="margin-left:0">${esc(d.v)}</span><span class="avg" style="margin-left:auto">${d.wr?`<span class="wr">승률 ${d.wr}%</span>`:''}<i></i>${deckAvg(d).toFixed(1)}</span></div>`;
    const b=document.createElement('div'); b.className='body'; b.appendChild(deckCardsEl(d,true));
    const info=document.createElement('div');
    const mu = md && S.settings.myDeck!==i ? deckMatchup(md, d) : null;
    info.innerHTML=`<p><b>운영:</b> ${esc(d.plan)}</p><p><b>상대법:</b> ${esc(d.vs)}</p>`
      + `<div class="row" style="margin-top:8px"><span class="chip" style="background:${ARCH[d.a].color}">${ARCH[d.a].ko}</span><span class="muted">인기 ${'★'.repeat(d.pop)}</span>${mu?`<span class="chip" style="background:${mu.verdict==='good'?'#3faa25':mu.verdict==='bad'?'#d33030':'#7d8db0'}">내 덱 ${mu.verdict==='good'?'유리':mu.verdict==='bad'?'불리':'비슷'}</span>`:''}<span style="flex:1"></span></div>`;
    const btn=document.createElement('button'); btn.className='btn sm '+(S.settings.myDeck===i?'green':'gold'); btn.textContent=S.settings.myDeck===i?'✔ 내 덱':'내 덱으로';
    btn.onclick=()=>{ setMyDeck(S.settings.myDeck===i?null:i); toast(S.settings.myDeck===i?`내 덱: ${d.n}`:'내 덱 해제'); };
    info.querySelector('.row').appendChild(btn);
    b.appendChild(info); p.appendChild(b); grid.appendChild(p);
  });
}
renderDecks();

/* ---------- 프로 운영 ---------- */
(function(){
  const w=$('proWrap');
  PRO.forEach(sec=>{ const p=document.createElement('div'); p.className='panel pro'; p.innerHTML=`<div class="ribbon gold"><h2>${esc(sec.title)}</h2></div><div class="body"><ul>${sec.items.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`; w.appendChild(p); });
  const r=document.createElement('div'); r.className='panel';
  r.innerHTML=`<div class="ribbon"><h2>⏱ 엘릭서 규칙</h2></div><div class="body"><table class="t"><tr><th>구간</th><th>남은 시간</th><th>속도</th></tr><tr><td>일반</td><td>3:00 ~ 1:00</td><td>2.8초당 1</td></tr><tr><td>2배</td><td>1:00 ~ 0:00</td><td>1.4초당 1</td></tr><tr><td>연장 1분차</td><td>연장 2:00 ~ 1:00</td><td>2배</td></tr><tr><td>연장 2분차</td><td>연장 1:00 ~ 0:00</td><td>3배</td></tr></table><p class="muted">시작 5, 최대 10. 엘릭서 정제소는 15초마다 +1(약 1분 50초). 이벤트·2v2는 규칙이 달라요.</p></div>`;
  w.appendChild(r);
  const heroes = Object.values(CARDS).filter(c=>c.heroAb).sort((a,b)=>a.name.localeCompare(b.name,'ko')), champs = Object.values(CARDS).filter(c=>c.champAb);
  const a=document.createElement('div'); a.className='panel';
  a.innerHTML=`<div class="ribbon purple"><h2>⚡ 능력 비용 (상대가 쓰면 ⚡버튼)</h2></div><div class="body"><table class="t"><tr><th>카드</th><th>배치</th><th>능력</th></tr>${champs.map(c=>`<tr><td>👑 ${esc(c.name)}</td><td>${c.cost}</td><td>${c.champAb}</td></tr>`).join('')}${heroes.map(c=>`<tr><td>⭐ 히어로 ${esc(c.name)}</td><td>${c.cost}</td><td>${c.heroAb}</td></tr>`).join('')}</table></div>`;
  w.appendChild(a);
})();

/* ---------- 뉴스 ---------- */
const FEEDS = [
  {name:'국내 뉴스', url:'https://news.google.com/rss/search?q=%ED%81%B4%EB%9E%98%EC%8B%9C%EB%A1%9C%EC%96%84&hl=ko&gl=KR&ceid=KR:ko', type:'rss'},
  {name:'해외 뉴스', url:'https://news.google.com/rss/search?q=%22Clash%20Royale%22&hl=en-US&gl=US&ceid=US:en', type:'rss'},
  {name:'커뮤니티 인기글', url:'https://www.reddit.com/r/ClashRoyale/top.json?t=week&limit=12', type:'reddit'},
];
async function fetchText(url){
  if (window.crNative && window.crNative.fetchText) return window.crNative.fetchText(url);
  const cap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  if (cap){ const r = await cap.get({url}); return typeof r.data === 'string' ? r.data : JSON.stringify(r.data); }
  const r = await fetch(url); if (!r.ok) throw new Error(r.status); return r.text();
}
let newsLoaded = 0;
async function loadNews(force){
  if (!force && Date.now() - newsLoaded < 10*60*1000) return;
  newsLoaded = Date.now();
  const list=$('newsList'); list.innerHTML='<div class="muted">불러오는 중…</div>';
  const items = []; let ok = 0;
  await Promise.all(FEEDS.map(async f=>{
    try{
      const txt = await fetchText(f.url); ok++;
      if (f.type==='rss'){
        const doc = new DOMParser().parseFromString(txt, 'text/xml');
        [...doc.querySelectorAll('item')].slice(0,12).forEach(it=>items.push({src:f.name, title:it.querySelector('title')?.textContent||'', url:it.querySelector('link')?.textContent||'', date:new Date(it.querySelector('pubDate')?.textContent||Date.now()), body:''}));
      } else {
        const j = JSON.parse(txt); (j.data?.children||[]).forEach(c=>items.push({src:f.name, title:c.data.title, url:'https://www.reddit.com'+c.data.permalink, date:new Date(c.data.created_utc*1000), body:`👍 ${c.data.score}`}));
      }
    }catch(e){}
  }));
  list.innerHTML='';
  if (!ok){
    $('newsStatus').textContent = '이 환경에서는 실시간 뉴스를 막아둬서 최근 주요 소식을 보여드려요. 설치형 앱(PC·안드로이드·iOS)에서는 실시간으로 불러와요.';
    NEWS_SNAPSHOT.forEach(n=>items.push({src:'주요 소식', title:n.title, url:n.url, date:new Date(n.date), body:n.body}));
  } else $('newsStatus').textContent = `실시간 · ${new Date().toLocaleTimeString('ko-KR')} 업데이트`;
  items.sort((a,b)=>b.date-a.date).slice(0,40).forEach(n=>{
    const a=document.createElement('a'); a.className='news'; a.href=n.url; a.target='_blank'; a.rel='noopener';
    a.innerHTML=`<span class="chip" style="background:#2775e0">${esc(n.src)}</span> <span class="muted">${n.date.toLocaleDateString('ko-KR')}</span><div class="nt">${esc(n.title)}</div>${n.body?`<div class="muted">${esc(n.body)}</div>`:''}`;
    list.appendChild(a);
  });
}
$('btnNews').onclick = ()=>loadNews(true);

/* ---------- 학습 템플릿 ---------- */
let templates = [];
(store.get('crc_templates', [])).forEach(t=>{ try{ templates.push({id:t.id, raw:t.raw, f:featureFromRGBA(b64ToRGBA(t.raw))}); }catch(e){} });
const saveTemplates = ()=> store.set('crc_templates', templates.map(t=>({id:t.id, raw:t.raw})));
$('btnClearTpl').onclick = ()=>{ if (confirm('학습한 카드 이미지를 모두 지울까요?')){ templates=[]; saveTemplates(); renderPending(); render(); toast('지웠어요'); } };
function learnTpl(id, raw, feat){
  templates.push({id, raw, f:feat||featureFromRGBA(b64ToRGBA(raw))});
  const same=templates.filter(t=>t.id===id), cap=id==='__ignore'?40:10;
  if (same.length>cap) templates.splice(templates.indexOf(same[0]),1);
  saveTemplates();
}

/* ---------- 공용 감지기 ---------- */
function Detector(cfg){
  const ac=document.createElement('canvas'); ac.width=AW; ac.height=AH; const actx=ac.getContext('2d',{willReadFrequently:true});
  const fc=document.createElement('canvas'); fc.width=FS; fc.height=FS; const fctx=fc.getContext('2d',{willReadFrequently:true});
  const tc=document.createElement('canvas'); tc.width=64; tc.height=64; const tctx=tc.getContext('2d');
  const st = {top:{prev:null,hist:[],recent:[]}, bottom:{prev:null,hist:[],recent:[]}};
  const flashes = []; let lastFrame = -1;
  function tick(){
    const v = cfg.video(), cal = cfg.calib(); if (!v || !cal || !cfg.active()) return;
    const vw=v.videoWidth||v.width, vh=v.videoHeight||v.height; if (!vw) return;
    if (v.frameId !== undefined){ if (v.frameId === lastFrame) return; lastFrame = v.frameId; }
    for (const side of cfg.sides()){
      const s = st[side], bottom = side==='bottom';
      const sy = (cal.y + (bottom ? cal.h*(17/32) : 0))*vh;
      actx.drawImage(v, cal.x*vw, sy, cal.w*vw, cal.h*vh*RIVER, 0,0,AW,AH);
      const d=actx.getImageData(0,0,AW,AH).data, L=new Float32Array(AW*AH);
      for (let i=0;i<L.length;i++) L[i]=0.299*d[i*4]+0.587*d[i*4+1]+0.114*d[i*4+2];
      if (s.prev){
        const act=new Float32Array(GC*GR);
        for (let y=0;y<AH;y++) for (let x=0;x<AW;x++){ const i=y*AW+x; act[((y/CP)|0)*GC+((x/CP)|0)] += Math.abs(L[i]-s.prev[i]); }
        for (let i=0;i<act.length;i++) act[i]/=CP*CP;
        s.hist.push(act); if (s.hist.length>6) s.hist.shift();
        const now=performance.now(); s.recent=s.recent.filter(e=>now-e.at<1600);
        for (const ev of detectEvents(s.hist, cfg.sens(), bottom)){
          if (s.recent.some(r=>Math.hypot(r.cx-ev.cx,r.cy-ev.cy)<3.5) || s.recent.some(r=>now-r.at<300)) continue;
          ev.at=now; ev.t=cfg.time(); ev.side=side; s.recent.push(ev); setTimeout(()=>capture(ev),380);
        }
      }
      s.prev=L;
    }
  }
  function capture(ev){
    const v=cfg.video(), cal=cfg.calib(); if (!v||!cal) return;
    const vw=v.videoWidth||v.width, vh=v.videoHeight||v.height, tileW=cal.w*vw/GC, tileH=cal.h*vh/32;
    const ay = ev.side==='bottom' ? 17 + ev.cy + 0.5 : ev.cy + 0.5, ax = ev.cx + 0.5;
    const cx=cal.x*vw+ax*tileW, cy=cal.y*vh+ay*tileH, size=Math.max(tileW,tileH)*4;
    const sx=Math.max(0,cx-size/2), sy=Math.max(0,cy-size/2);
    fctx.drawImage(v,sx,sy,size,size,0,0,FS,FS);
    const rgba=fctx.getImageData(0,0,FS,FS).data, feat=featureFromRGBA(rgba), raw=rgbToB64(rgbaToRGB(rgba));
    tctx.drawImage(v,sx,sy,size,size,0,0,64,64); const thumb=tc.toDataURL('image/jpeg',0.7);
    const cands=matchTemplates(feat,templates);
    flashes.push({x:ax, y:ay, at:performance.now()});
    cfg.onEvent({t:ev.t, side:ev.side, x:ax, y:ay, thumb, raw, feat, cands});
  }
  setInterval(tick, 100);
  return {flashes, tick};
}
function CalibPreview(canvas, getVideo, getCal, setCal, detector, boxEl){
  const ctx = canvas.getContext('2d'); let mode=false, drag=null;
  const toN = e=>{ const r=canvas.getBoundingClientRect(); return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)), y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))}; };
  canvas.addEventListener('pointerdown', e=>{ if (!mode) return; drag={a:toN(e), b:toN(e)}; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e=>{ if (drag) drag.b=toN(e); });
  canvas.addEventListener('pointerup', ()=>{ if (!drag) return; const x=Math.min(drag.a.x,drag.b.x), y=Math.min(drag.a.y,drag.b.y), w=Math.abs(drag.a.x-drag.b.x), h=Math.abs(drag.a.y-drag.b.y); drag=null;
    if (w<0.05||h<0.05){ toast('영역이 너무 작아요'); return; } setCal({x,y,w,h}); mode=false; toast('경기장 영역 저장 완료'); });
  function draw(){
    const v=getVideo();
    if (v && v.videoWidth){
      const vw=v.videoWidth, vh=v.videoHeight, maxW=boxEl.clientWidth||320, maxH=520, sc=Math.min(maxW/vw, maxH/vh), cw=Math.round(vw*sc), ch=Math.round(vh*sc);
      if (canvas.width!==cw||canvas.height!==ch){ canvas.width=cw; canvas.height=ch; }
      ctx.drawImage(v,0,0,cw,ch);
      const rc = drag ? {x:Math.min(drag.a.x,drag.b.x), y:Math.min(drag.a.y,drag.b.y), w:Math.abs(drag.a.x-drag.b.x), h:Math.abs(drag.a.y-drag.b.y)} : getCal();
      if (rc){
        ctx.strokeStyle='#ffe36b'; ctx.lineWidth=2; ctx.strokeRect(rc.x*cw, rc.y*ch, rc.w*cw, rc.h*ch);
        const ry=(rc.y+rc.h*RIVER)*ch, ry2=(rc.y+rc.h*17/32)*ch;
        ctx.setLineDash([6,4]); ctx.strokeStyle='#ff8af1'; ctx.beginPath(); ctx.moveTo(rc.x*cw,ry); ctx.lineTo((rc.x+rc.w)*cw,ry); ctx.moveTo(rc.x*cw,ry2); ctx.lineTo((rc.x+rc.w)*cw,ry2); ctx.stroke(); ctx.setLineDash([]);
        const now=performance.now();
        if (detector) for (const f of detector.flashes.filter(f=>now-f.at<1200)){ ctx.strokeStyle=f.y<16?'#ff6b6b':'#6cc3ff'; ctx.lineWidth=3; ctx.beginPath(); ctx.arc((rc.x+f.x/18*rc.w)*cw, (rc.y+f.y/32*rc.h)*ch, Math.max(10,cw*0.05), 0, Math.PI*2); ctx.stroke(); }
      }
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
  return {toggle(){ mode=!mode; if (mode) toast('상대 킹 타워 위 끝 ~ 내 킹 타워 아래 끝을 드래그하세요'); return mode; }, get on(){ return mode; }};
}

/* ---------- 배틀 화면 캡처 ---------- */
const video=document.createElement('video'); video.muted=true; video.playsInline=true;
let stream=null;
async function getScreen(preferTab){
  if (window.crNative && window.crNative.pickSource) await window.crNative.pickSource();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw new Error('nosupport');
  return navigator.mediaDevices.getDisplayMedia({video:{frameRate:30}, audio:false, preferCurrentTab: !!preferTab});
}
const det = Detector({video:()=>stream?video:null, calib:()=>S.calib, active:()=>S.settings.auto && S.started && !calib.on, sides:()=>S.settings.autoMine?['top','bottom']:['top'], sens:()=>S.settings.sens, time:gameTime, onEvent:onBattleEvent});
const calib = CalibPreview($('preview'), ()=>stream?video:null, ()=>S.calib, c=>{ S.calib=c; store.set('crc_calib',c); }, det, $('previewBox'));
$('btnCapture').onclick = async ()=>{
  if (stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; capOff(); return; }
  try{
    stream = await getScreen(false); video.srcObject = stream; await video.play();
    stream.getVideoTracks()[0].addEventListener('ended', ()=>{ stream=null; capOff(); });
    $('btnCapture').textContent='연결 해제'; $('btnCapture').classList.replace('green','red'); $('previewHint').style.display='none'; $('preview').style.display='block';
    if (!S.calib){ calib.toggle(); }
    $('capStatus').textContent='연결됨';
  }catch(e){ toast(e.message==='nosupport' ? '이 환경은 화면 공유를 지원하지 않아요. PC 앱이나 PC의 Chrome/Edge를 쓰세요.' : '화면 연결이 취소됐어요'); stream=null; }
};
function capOff(){ $('btnCapture').textContent='화면 연결'; $('btnCapture').classList.replace('red','green'); $('preview').style.display='none'; $('previewHint').style.display='block'; $('capStatus').textContent=''; }
$('btnCalib').onclick = ()=>{ if (!stream){ toast('먼저 화면을 연결해주세요'); return; } $('btnCalib').classList.toggle('on', calib.toggle()); };
function onBattleEvent(ev){
  const best = ev.cands[0], th = S.settings.thresh/100;
  if (best && best.score >= th){
    if (best.id==='__ignore') return;
    if (S.settings.autoAccept){
      const extra = {auto:true, score:best.score, thumb:ev.thumb, x:ev.x, y:ev.y, lane:laneOf(ev.x)};
      if (ev.side==='top') { S.plays.push(Object.assign({t:ev.t, id:best.id}, extra)); } else { S.mine.push(Object.assign({t:ev.t, id:best.id}, extra)); }
      render(); return;
    }
  }
  S.pending.unshift(Object.assign({}, ev, {cands:ev.cands.filter(c=>c.id!=='__ignore').slice(0,3)}));
  if (S.pending.length>6) S.pending.length=6; renderPending();
}
function renderPending(){
  const el=$('pending'); el.innerHTML='';
  if (!S.pending.length){ el.innerHTML='<div class="muted">감지된 장면이 여기 나와요. 카드를 고르면 학습해서 다음부터 자동으로 기록해요.</div>'; return; }
  const deck=analyzeDeck(S.plays), inf=inferDecks(deck.known), md=myDeck();
  S.pending.forEach((pd,idx)=>{
    const box=document.createElement('div'); box.className='pend'; box.innerHTML=`<img src="${pd.thumb}"><span class="chip" style="background:${pd.side==='top'?'#d33030':'#2775e0'};align-self:flex-start">${pd.side==='top'?'상대':'나'}</span>`;
    const btns=document.createElement('div'); btns.className='btns'; const ids=[];
    pd.cands.forEach(c=>{ if(!ids.includes(c.id)) ids.push(c.id); });
    (pd.side==='top' ? deck.known.concat(inf.predicted.slice(0,3).map(p=>p.id)) : (md?md.c:[])).forEach(id=>{ if(!ids.includes(id)) ids.push(id); });
    ids.slice(0,9).forEach(id=>{ const c=CARDS[id]; if(!c) return; const sc=pd.cands.find(x=>x.id===id); const b=document.createElement('button'); b.className='btn sm'; b.textContent=c.name+(sc?` ${Math.round(sc.score*100)}%`:''); b.onclick=()=>resolveP(idx,id); btns.appendChild(b); });
    const sel=document.createElement('select'); sel.className='field'; sel.style.fontSize='12px';
    sel.innerHTML='<option value="">다른 카드…</option>'+Object.values(CARDS).filter(c=>c.id!=='unknown').sort((a,b)=>a.name.localeCompare(b.name,'ko')).map(c=>`<option value="${c.id}">${esc(c.name)} (${c.cost})</option>`).join('');
    sel.onchange=()=>{ if (sel.value) resolveP(idx,sel.value); }; btns.appendChild(sel);
    const ig=document.createElement('button'); ig.className='btn sm red'; ig.textContent='카드 아님'; ig.onclick=()=>{ learnTpl('__ignore',pd.raw,pd.feat); S.pending.splice(idx,1); renderPending(); }; btns.appendChild(ig);
    box.appendChild(btns); el.appendChild(box);
  });
}
function resolveP(idx,id){
  const pd=S.pending[idx]; if(!pd) return;
  learnTpl(id,pd.raw,pd.feat);
  const arr = pd.side==='top'?S.plays:S.mine, ex = pd.ref ? arr.find(p=>p.ref===pd.ref) : null;
  if (ex){ ex.id=id; delete ex.cost; delete ex.guess; ex.thumb=ex.thumb||pd.thumb; }
  else if (S.started){ const e={t:pd.t, id, thumb:pd.thumb, x:pd.x, y:pd.y, lane:laneOf(pd.x)}; arr.push(e); }
  S.pending.splice(idx,1); renderPending(); render(); toast(`${CARDS[id].name} 기록 + 학습`);
}

/* ---------- 영상 학습 ---------- */
const vvideo = $('vVideo'); let vstream = null, vsrc = 'none', vAnalyze = false, vMatch = 'm'+Date.now();
const capVideo = document.createElement('video'); capVideo.muted=true; capVideo.playsInline=true;
const vSource = ()=> vsrc==='file' ? vvideo : vsrc==='cap' ? capVideo : null;
const vTime = ()=> vsrc==='file' ? vvideo.currentTime : (performance.now()/1000);
const vdet = Detector({video:vSource, calib:()=>S.vcalib, active:()=>vAnalyze && (vsrc!=='file' || !vvideo.paused), sides:()=>['top','bottom'], sens:()=>S.settings.sens, time:vTime, onEvent:onVideoEvent});
const vcal = CalibPreview($('vPreview'), vSource, ()=>S.vcalib, c=>{ S.vcalib=c; store.set('crc_vcalib',c); }, vdet, $('vPreviewBox'));
$('vFile').onchange = e=>{
  const f = e.target.files[0]; if (!f) return;
  vvideo.src = URL.createObjectURL(f); vvideo.style.display='block'; $('vYT').innerHTML=''; vsrc='file'; vMatch='m'+Date.now();
  $('vPreview').style.display='block'; $('vStatus').textContent = `영상: ${f.name}`; if (!S.vcalib) vcal.toggle();
};
$('vYTBtn').onclick = ()=>{
  const u = $('vYTUrl').value.trim(); const m = u.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/);
  if (!m){ toast('유튜브 링크를 확인해주세요'); return; }
  $('vYT').innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${m[1]}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  vvideo.style.display='none'; vMatch='yt-'+m[1]; $('vStatus').textContent='유튜브 영상을 열었어요. 분석하려면 [이 탭 화면 공유]를 누르세요.';
};
$('vCapBtn').onclick = async ()=>{
  if (vstream){ vstream.getTracks().forEach(t=>t.stop()); vstream=null; vsrc='none'; $('vCapBtn').textContent='🖥 이 탭 화면 공유'; return; }
  try{ vstream = await getScreen(true); capVideo.srcObject=vstream; await capVideo.play(); vsrc='cap'; $('vPreview').style.display='block'; $('vCapBtn').textContent='공유 중지'; if (!S.vcalib) vcal.toggle();
    vstream.getVideoTracks()[0].addEventListener('ended', ()=>{ vstream=null; vsrc='none'; $('vCapBtn').textContent='🖥 이 탭 화면 공유'; });
  }catch(e){ toast('화면 공유가 취소됐거나 지원되지 않아요'); }
};
$('vCalib').onclick = ()=>{ if (!vSource()){ toast('먼저 영상을 열거나 화면을 공유하세요'); return; } vcal.toggle(); };
$('vRun').onclick = ()=>{ vAnalyze=!vAnalyze; $('vRun').textContent = vAnalyze?'⏸ 분석 중지':'▶ 자동 분석 시작'; $('vRun').classList.toggle('red', vAnalyze); if (vAnalyze && vsrc==='file') vvideo.play(); };
let vPending = [];
function onVideoEvent(ev){
  const best = ev.cands[0];
  if (best && best.score >= S.settings.thresh/100){ if (best.id==='__ignore') return; addVEvent({t:ev.t, side:ev.side==='top'?'opp':'me', id:best.id, x:ev.x, y:ev.y, auto:true}); return; }
  vPending.unshift(ev); if (vPending.length>8) vPending.length=8; renderVPending();
}
function addVEvent(e){ e.match = vMatch; S.vlog.push(e); if (S.vlog.length > 5000) S.vlog.splice(0, S.vlog.length-5000); store.set('crc_vlog', S.vlog); PATTERNS = learnPatterns(S.vlog); renderVLearn(); }
function renderVPending(){
  const el=$('vPending'); el.innerHTML='';
  if (!vPending.length){ el.innerHTML='<div class="muted">자동 분석 중 감지된 장면이 여기 나와요. 카드를 고르면 학습 데이터에 쌓여요.</div>'; return; }
  vPending.forEach((pd,idx)=>{
    const box=document.createElement('div'); box.className='pend'; box.innerHTML=`<img src="${pd.thumb}"><span class="chip" style="background:${pd.side==='top'?'#d33030':'#2775e0'};align-self:flex-start">${pd.side==='top'?'상대':'선수'}</span>`;
    const btns=document.createElement('div'); btns.className='btns';
    pd.cands.filter(c=>c.id!=='__ignore').slice(0,4).forEach(c=>{ const b=document.createElement('button'); b.className='btn sm'; b.textContent=`${CARDS[c.id].name} ${Math.round(c.score*100)}%`; b.onclick=()=>vResolve(idx,c.id); btns.appendChild(b); });
    const sel=document.createElement('select'); sel.className='field'; sel.style.fontSize='12px';
    sel.innerHTML='<option value="">카드 선택…</option>'+Object.values(CARDS).filter(c=>c.id!=='unknown').sort((a,b)=>a.name.localeCompare(b.name,'ko')).map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
    sel.onchange=()=>{ if (sel.value) vResolve(idx, sel.value); }; btns.appendChild(sel);
    const ig=document.createElement('button'); ig.className='btn sm red'; ig.textContent='카드 아님'; ig.onclick=()=>{ learnTpl('__ignore',pd.raw,pd.feat); vPending.splice(idx,1); renderVPending(); }; btns.appendChild(ig);
    box.appendChild(btns); el.appendChild(box);
  });
}
function vResolve(idx,id){ const pd=vPending[idx]; if(!pd) return; learnTpl(id,pd.raw,pd.feat); addVEvent({t:pd.t, side:pd.side==='top'?'opp':'me', id, x:pd.x, y:pd.y}); vPending.splice(idx,1); renderVPending(); }
// 수동 표시: 진영 선택 → 카드 선택 → 아레나 클릭
let vSide='opp', vSel=null, vFilter='all';
document.querySelectorAll('.vside').forEach(b=> b.onclick=()=>{ vSide=b.dataset.s; document.querySelectorAll('.vside').forEach(x=>x.classList.toggle('on',x===b)); });
setupFilters($('vFilters'), k=>{ vFilter=k; renderVPalette(); });
$('vSearch').oninput = ()=>renderVPalette();
function renderVPalette(){ const pal=$('vPalette'); pal.innerHTML=''; filterCards($('vSearch').value.trim(), vFilter).forEach(c=>pal.appendChild(cardEl(c.id,{mini:true, sel:vSel===c.id, onclick:()=>{ vSel=c.id; renderVPalette(); $('vArenaHint').textContent=`${c.name}: 경기장에서 놓은 위치를 누르세요`; }}))); }
renderVPalette();
const vArena = Arena3D($('vArena'));
vArena.setImageSource(imgObj);
$('vArena').addEventListener('click', e=>{
  const tile = vArena.pick(e.clientX, e.clientY); if (!tile) return;
  if (!vSel){ toast('먼저 카드를 고르세요'); return; }
  addVEvent({t: vsrc==='file' ? vvideo.currentTime : performance.now()/1000, side:vSide, id:vSel, x:tile.x, y:tile.y});
  toast(`${vSide==='opp'?'상대':'선수'} ${CARDS[vSel].name} 기록`); vSel=null; renderVPalette(); $('vArenaHint').textContent='';
});
let vHeatId = null;
function renderVLearn(){
  const evs = S.vlog;
  $('vCount').textContent = `학습한 플레이 ${evs.length}개 · 영상 ${new Set(evs.map(e=>e.match)).size}개`;
  const rows = [];
  Object.entries(PATTERNS).forEach(([th, m])=> Object.entries(m).forEach(([r, v])=> rows.push({th, r, v})));
  rows.sort((a,b)=>b.v.n-a.v.n);
  $('vPatterns').innerHTML = rows.length ? rows.slice(0,40).map(x=>`<div class="li"><span class="who" style="background:#d33030">상대</span><b>${esc(CARDS[x.th]?.name||x.th)}</b> → <span class="who">선수</span><b>${esc(CARDS[x.r]?.name||x.r)}</b><span class="muted">${x.v.n}회${x.v.pn?` · 평균 위치 (${x.v.x.toFixed(1)}, ${x.v.y.toFixed(1)})`:''}</span></div>`).join('') : '<div class="muted">아직 학습한 대응이 없어요. 영상을 분석하거나 직접 표시하면 "상대가 X를 내면 선수가 Y로 막았다"는 패턴이 쌓여요.</div>';
  const ids = [...new Set(evs.filter(e=>e.side==='me').map(e=>e.id))];
  $('vHeatSel').innerHTML = '<option value="">카드별 배치 위치 보기…</option>' + ids.map(id=>`<option value="${id}" ${id===vHeatId?'selected':''}>${esc(CARDS[id]?.name||id)}</option>`).join('');
  drawVArena();
}
$('vHeatSel').onchange = e=>{ vHeatId = e.target.value || null; drawVArena(); };
function drawVArena(){
  const recent = S.vlog.slice(-6).map(e=>({id:e.id, name:CARDS[e.id]?.name, x:e.x, y:e.y}));
  const heat = vHeatId ? S.vlog.filter(e=>e.id===vHeatId && e.side==='me').map(e=>({id:e.id, name:CARDS[e.id]?.name, x:e.x, y:e.y})) : [];
  vArena.set({opp:recent.filter((_,i)=>S.vlog.slice(-6)[i].side==='opp'), mine: vHeatId ? [] : recent.filter((_,i)=>S.vlog.slice(-6)[i].side==='me'), recs: heat, hint: vHeatId ? `선수의 ${CARDS[vHeatId]?.name} 배치 ${heat.length}회` : '최근 기록'});
}
$('vExport').onclick = ()=>{ const blob=new Blob([JSON.stringify({vlog:S.vlog, templates:templates.map(t=>({id:t.id, raw:t.raw}))})],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='cr-coach-학습데이터.json'; a.click(); };
$('vImport').onchange = async e=>{ const f=e.target.files[0]; if(!f) return; try{ const j=JSON.parse(await f.text()); (j.vlog||[]).forEach(x=>S.vlog.push(x)); store.set('crc_vlog',S.vlog); (j.templates||[]).forEach(t=>learnTpl(t.id,t.raw)); PATTERNS=learnPatterns(S.vlog); renderVLearn(); toast('학습 데이터를 합쳤어요'); }catch(err){ toast('파일을 읽지 못했어요'); } };
$('vClear').onclick = ()=>{ if (confirm('영상에서 학습한 플레이 기록을 모두 지울까요?')){ S.vlog=[]; store.set('crc_vlog',[]); PATTERNS={}; renderVLearn(); } };
renderVPending(); renderVLearn();

/* ================= 휴대폰 실시간 코치 =================
   본 앱: [📱 휴대폰 실시간 코치 시작] → 화면 녹화 허락 → 게임 위에 코치 창이 뜸
   코치 창(#overlay): 네이티브가 보내는 화면 프레임을 읽어
   - 상대 카드 감지(위쪽 절반) → 상대 엘릭서·덱·손패
   - 내 엘릭서 바를 직접 읽음(정확한 값) → 엘릭서가 뚝 떨어지면 내가 카드를 낸 것으로 기록
   - 아래쪽 절반 감지 → 내가 낸 위치·카드 확인
   - 엘릭서 바가 보이면 경기 시작, 6초 이상 안 보이면 경기 종료 → 기록을 본 앱으로 넘김
   사용자는 게임 중 아무것도 입력하지 않아도 됨 */
const PCAL_DEFAULT = {x:0.02, y:0.075, w:0.96, h:0.70};
const ECAL_DEFAULT = {x:0.27, y:0.948, w:0.70, h:0.022};
S.pcalib = store.get('crc_pcalib', null) || PCAL_DEFAULT;
S.ecalib = store.get('crc_ecalib', null) || ECAL_DEFAULT;
const frameCv = document.createElement('canvas'); frameCv.width = 360; frameCv.height = 780; frameCv.frameId = 0;
const frameCtx = frameCv.getContext('2d', {willReadFrequently:true});
let frameReady = false, lastFrameUrl = null;

function readElixir(){
  const W = frameCv.width, H = frameCv.height, r = S.ecalib;
  const x0 = Math.round(r.x*W), x1 = Math.round((r.x+r.w)*W), y0 = Math.max(0, Math.round(r.y*H)), y1 = Math.min(H-1, Math.round((r.y+r.h)*H));
  if (x1 - x0 < 10) return null;
  const d = frameCtx.getImageData(x0, y0, x1-x0, Math.max(1,y1-y0+1)).data, w = x1-x0, h = Math.max(1,y1-y0+1);
  const rows = [Math.floor(h*0.3), Math.floor(h*0.5), Math.floor(h*0.7)];
  const N = 50; let right = -1, cnt = 0;
  for (let i=0;i<N;i++){
    const x = Math.floor((i+0.5)/N*w); let pink = 0;
    for (const ry of rows){ const k = (ry*w + x)*4, R=d[k], G=d[k+1], B=d[k+2]; if (R>150 && B>130 && G<130 && R-G>60) pink++; }
    if (pink >= 2){ right = i; cnt++; }
  }
  if (cnt < 1) return {present:false, value:0};
  return {present:true, value: Math.round((right+1)/N*100)/10};
}
function myCardForCost(cost){
  const md = myDeck(); if (!md) return {id:'unknown', guess:false};
  const hand = myHandOf(md.c, S.mine);
  const pool = (hand && hand.hand.length ? hand.hand : md.c).filter(id=>CARDS[id] && !CARDS[id].tags.includes('mirror') && CARDS[id].cost===cost);
  if (pool.length === 1) return {id:pool[0], guess:false};
  if (pool.length > 1) return {id:pool[0], guess:true, alts:pool};
  const any = md.c.filter(id=>CARDS[id] && CARDS[id].cost===cost);
  return any.length ? {id:any[0], guess:true, alts:any} : {id:'unknown', guess:false};
}
function ovFrameTick(){
  if (OV.calibOn) return;
  const now = performance.now(), r = readElixir(); if (!r) return;
  if (r.present){
    OV.lastSeen = now; OV.seen = (OV.seen||0) + 1;
    if (!S.started && OV.seen < 3) return;      // 3프레임 연속 보여야 경기 시작
    if (!S.started){
      startGame(); OV.hist = []; OV.regen = []; OV.shifted2 = OV.shifted3 = false;
      if (r.value > 5.2) S.offset = Math.min(20, (r.value-5)*2.8);   // 늦게 켰을 때 대략 보정
    }
    const e = r.value; OV.hist.push({t:now, e}); if (OV.hist.length > 4) OV.hist.shift();
    const prevMax = Math.max(...OV.hist.slice(0,-1).map(h=>h.e), -1);
    const drop = prevMax - e;
    if (drop >= 0.8 && now - OV.lastDrop > 450 && S.started){
      OV.lastDrop = now; const cost = Math.max(1, Math.min(9, Math.round(drop)));
      const g = myCardForCost(cost), ref = 'm' + (++OV.ref);
      const p = {t:gameTime(), id:g.id, ref, auto:true, score:g.guess?0.5:0.9, fromElixir:true};
      if (g.id === 'unknown') p.cost = cost; if (g.guess) p.guess = g.alts;
      S.mine.push(p); OV.hist = [{t:now, e}]; OV.regen = [];
    } else {
      // 2배·3배 엘릭서 구간을 내 엘릭서 회복 속도로 자동 맞춤
      if (e < 9.8){ OV.regen.push({t:now, e}); OV.regen = OV.regen.filter(x=>now-x.t < 3500); }
      else OV.regen = [];
      if (OV.regen.length >= 12){
        const a = OV.regen[0], b = OV.regen[OV.regen.length-1], rate = (b.e-a.e)/((b.t-a.t)/1000), gt = gameTime();
        if (!OV.shifted2 && rate > 0.55 && rate < 0.9 && gt < 116){ S.offset += 120-gt; OV.shifted2 = true; }
        if (!OV.shifted3 && rate > 0.95 && gt < 236 && gt > 150 && S.settings.triple){ S.offset += 240-gt; OV.shifted3 = true; }
      }
    }
    OV.e = e;
  } else if ((OV.seen = 0, S.started) && now - OV.lastSeen > 6000){
    endGame(); OV.e = null; ovFinishMatch();
  }
}
window.__crFrame = (url, w, h)=>{
  const im = new Image();
  im.onload = ()=>{
    if (frameCv.width !== w || frameCv.height !== h){ frameCv.width = w; frameCv.height = h; }
    frameCtx.drawImage(im, 0, 0, w, h); frameCv.frameId++; frameReady = true; lastFrameUrl = url;
    ovFrameTick(); ovDet.tick();
  };
  im.src = url;
};
function onOverlayEvent(ev){
  const best = ev.cands[0], th = S.settings.thresh/100;
  if (ev.side === 'top'){
    if (best && best.id === '__ignore' && best.score >= th) return;
    const ok = best && best.id !== '__ignore' && best.score >= th;
    const ref = 'o' + (++OV.ref);
    S.plays.push({t:ev.t, id: ok ? best.id : 'unknown', ref, auto:true, score: best ? best.score : 0, thumb:ev.thumb, x:ev.x, y:ev.y, lane:laneOf(ev.x)});
    if (!ok){ S.pending.unshift(Object.assign({}, ev, {ref, cands:ev.cands.filter(c=>c.id!=='__ignore').slice(0,3)})); if (S.pending.length > 12) S.pending.length = 12; }
    else if (CARDS[best.id]) speak('opp:'+best.id, `상대 ${CARDS[best.id].name}`);
  } else {
    // 내 진영: 방금 엘릭서가 줄어든 카드에 위치(와 카드 확인)를 붙임
    const p = S.mine.slice().reverse().find(m=>m.fromElixir && m.x == null && ev.t - m.t < 2.5 && ev.t - m.t > -0.5);
    if (!p) return;
    p.x = ev.x; p.y = ev.y; p.lane = laneOf(ev.x); p.thumb = ev.thumb;
    if (best && best.id !== '__ignore' && best.score >= th && (!p.guess || p.guess.includes(best.id) || p.id === 'unknown')){ p.id = best.id; delete p.guess; delete p.cost; p.score = best.score; }
    else if (p.guess || p.id === 'unknown'){ S.pending.unshift(Object.assign({}, ev, {ref:p.ref, cands:ev.cands.filter(c=>c.id!=='__ignore').slice(0,3)})); if (S.pending.length > 12) S.pending.length = 12; }
  }
  render();
}
const ovDet = Detector({video:()=>OVL && frameReady ? frameCv : null, calib:()=>S.pcalib, active:()=>OVL && S.started && !OV.calibOn, sides:()=>['top','bottom'], sens:()=>S.settings.sens, time:gameTime, onEvent:onOverlayEvent});
function ovFinishMatch(){
  const slim = a => a.map(p=>{ const q = Object.assign({}, p); delete q.feat; return q; });
  const result = {at:Date.now(), plays:slim(S.plays), mine:slim(S.mine), endedAt:S.endedAt,
    pending: S.pending.map(p=>({t:p.t, side:p.side, x:p.x, y:p.y, thumb:p.thumb, raw:p.raw, ref:p.ref, cands:p.cands}))};
  store.set('crc_ovresult', result);
  try{ if (window.CRNative) CRNative.saveShared(JSON.stringify(result)); }catch(e){}
  speak('end', S.pending.length ? `경기 종료. 확인할 장면 ${S.pending.length}개는 앱에서 골라주세요` : '경기 종료');
}

/* ---- 코치 창 화면 ---- */
function ovSetMode(m){ OV.mode = m; document.body.dataset.ov = m; try{ if (window.CRNative) CRNative.setMode(m); }catch(e){} }
function buildOverlay(){
  const root = document.createElement('div'); root.id = 'ovRoot';
  root.innerHTML = `
  <div id="ovBubble"><b id="ovBE">5</b><small>상대</small></div>
  <div id="ovPanel">
    <div class="ovBar" id="ovDrag"><span class="dot" id="ovDot"></span><b>CR 코치</b><span id="ovTime" class="tm">대기</span>
      <button id="ovVoice" title="음성">🔊</button><button id="ovMore" title="자세히">▾</button><button id="ovCal" title="영역 맞추기">⚙</button><button id="ovMin" title="접기">–</button><button id="ovX" title="끄기">✕</button></div>
    <div class="ovE"><div class="eb opp"><small>상대</small><b id="ovOE">5.0</b></div><div class="eb me"><small>나</small><b id="ovME">5.0</b></div><div class="eb df"><small>차이</small><b id="ovDE">0</b></div></div>
    <div id="ovRec" class="ovRec">게임을 시작하면 자동으로 따라가요</div>
    <div id="ovHand" class="ovHand"></div>
    <div id="ovMoreBox" class="ovMore"></div>
  </div>
  <div id="ovCalib">
    <canvas id="ovCalCv"></canvas>
    <div class="ovCalBar"><div id="ovCalMsg"></div>
      <div class="row"><button class="btn sm" id="ovCalReset">기본값</button><button class="btn sm red" id="ovCalCancel">취소</button><button class="btn sm green" id="ovCalNext">다음</button></div></div>
  </div>`;
  document.body.appendChild(root);
  ovSetMode('panel');
  // 끌어서 옮기기 (창이 손가락을 따라오도록 누른 위치 기준으로 이동)
  const dragEl = $('ovDrag'), bub = $('ovBubble');
  function makeDrag(el, onTap){
    let st = null, moved = 0, raf = 0, pend = {x:0, y:0};
    el.addEventListener('pointerdown', e=>{ if (e.target.tagName === 'BUTTON') return; st = {x:e.clientX, y:e.clientY}; moved = 0; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', e=>{ if (!st) return; const dx = e.clientX-st.x, dy = e.clientY-st.y; moved += Math.abs(dx)+Math.abs(dy);
      pend = {x:dx*devicePixelRatio, y:dy*devicePixelRatio};
      if (!raf) raf = requestAnimationFrame(()=>{ raf = 0; try{ if (window.CRNative) CRNative.moveBy(pend.x, pend.y); }catch(err){} }); });
    el.addEventListener('pointerup', ()=>{ if (st && moved < 8 && onTap) onTap(); st = null; });
  }
  makeDrag(dragEl, null); makeDrag(bub, ()=>ovSetMode(OV.more ? 'tall' : 'panel'));
  $('ovMin').onclick = ()=> ovSetMode('bubble');
  $('ovX').onclick = ()=>{ if (S.started){ endGame(); ovFinishMatch(); } try{ CRNative.close(); }catch(e){} };
  $('ovMore').onclick = ()=>{ OV.more = !OV.more; ovSetMode(OV.more ? 'tall' : 'panel'); $('ovMore').textContent = OV.more ? '▴' : '▾'; };
  const vb = $('ovVoice'); const setV = ()=> vb.textContent = store.get('crc_ovvoice', true) ? '🔊' : '🔇'; setV();
  vb.onclick = ()=>{ store.set('crc_ovvoice', !store.get('crc_ovvoice', true)); setV(); };
  // 영역 맞추기: 1) 경기장 2) 내 엘릭서 바
  const cv = $('ovCalCv'), cx = cv.getContext('2d'); let step = 0, tmp = null, drag = null; const bg = new Image();
  function draw(){
    if (!OV.calibOn) return;
    cv.width = innerWidth; cv.height = innerHeight; cx.clearRect(0,0,cv.width,cv.height);
    if (bg.complete && bg.naturalWidth) cx.drawImage(bg, 0, 0, cv.width, cv.height); else { cx.fillStyle = '#0b1f4d'; cx.fillRect(0,0,cv.width,cv.height); }
    const rc = drag ? {x:Math.min(drag.a.x,drag.b.x), y:Math.min(drag.a.y,drag.b.y), w:Math.abs(drag.a.x-drag.b.x), h:Math.abs(drag.a.y-drag.b.y)} : tmp[step];
    const other = tmp[1-step];
    cx.lineWidth = 2; cx.setLineDash([5,4]); cx.strokeStyle = 'rgba(255,255,255,.5)'; cx.strokeRect(other.x*cv.width, other.y*cv.height, other.w*cv.width, other.h*cv.height); cx.setLineDash([]);
    cx.lineWidth = 3; cx.strokeStyle = step === 0 ? '#ffe36b' : '#ff8af1'; cx.strokeRect(rc.x*cv.width, rc.y*cv.height, rc.w*cv.width, rc.h*cv.height);
    if (step === 0){ const ry = (rc.y+rc.h*RIVER)*cv.height, ry2 = (rc.y+rc.h*17/32)*cv.height; cx.setLineDash([6,4]); cx.strokeStyle = '#ff8af1'; cx.beginPath(); cx.moveTo(rc.x*cv.width, ry); cx.lineTo((rc.x+rc.w)*cv.width, ry); cx.moveTo(rc.x*cv.width, ry2); cx.lineTo((rc.x+rc.w)*cv.width, ry2); cx.stroke(); cx.setLineDash([]); }
    requestAnimationFrame(draw);
  }
  const msg = ()=> ($('ovCalMsg').parentNode.classList.toggle('s2', step === 1), $('ovCalMsg').innerHTML = step === 0
    ? '<b>1/2 경기장</b> — 상대 킹 타워 위 끝부터 내 킹 타워 아래 끝까지 드래그하세요. 분홍 점선 두 줄이 강의 위·아래에 오면 정확해요.'
    : '<b>2/2 엘릭서 바</b> — 화면 맨 아래 분홍색 엘릭서 바(숫자 오른쪽 막대)만 감싸도록 드래그하세요.');
  const toN = e=>({x:Math.max(0,Math.min(1,e.clientX/innerWidth)), y:Math.max(0,Math.min(1,e.clientY/innerHeight))});
  cv.addEventListener('pointerdown', e=>{ drag = {a:toN(e), b:toN(e)}; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e=>{ if (drag) drag.b = toN(e); });
  cv.addEventListener('pointerup', ()=>{ if (!drag) return; const rc = {x:Math.min(drag.a.x,drag.b.x), y:Math.min(drag.a.y,drag.b.y), w:Math.abs(drag.a.x-drag.b.x), h:Math.abs(drag.a.y-drag.b.y)}; drag = null;
    if (rc.w > 0.1 && rc.h > (step === 0 ? 0.2 : 0.005)) tmp[step] = rc; });
  $('ovCal').onclick = ()=>{
    OV.calibOn = true; step = 0; tmp = [Object.assign({}, S.pcalib), Object.assign({}, S.ecalib)];
    if (lastFrameUrl) bg.src = lastFrameUrl; ovSetMode('full'); msg(); $('ovCalNext').textContent = '다음'; requestAnimationFrame(draw);
  };
  $('ovCalReset').onclick = ()=>{ tmp[step] = Object.assign({}, step === 0 ? PCAL_DEFAULT : ECAL_DEFAULT); };
  $('ovCalCancel').onclick = ()=>{ OV.calibOn = false; ovSetMode(OV.more ? 'tall' : 'panel'); };
  $('ovCalNext').onclick = ()=>{
    if (step === 0){ step = 1; msg(); $('ovCalNext').textContent = '완료'; return; }
    S.pcalib = tmp[0]; S.ecalib = tmp[1]; store.set('crc_pcalib', S.pcalib); store.set('crc_ecalib', S.ecalib);
    OV.calibOn = false; ovSetMode(OV.more ? 'tall' : 'panel'); toast('영역 저장 완료');
  };
}
function renderOverlay(sim, simMe, rec, deck, inf, tips){
  if (!$('ovRoot')) return;
  const t = gameTime(), E = sim.E, myE = simMe.E, d = myE - E;
  $('ovBE').textContent = E >= 9.95 ? '10' : E.toFixed(1);
  $('ovOE').textContent = E >= 9.95 ? '10' : E.toFixed(1);
  $('ovME').textContent = myE >= 9.95 ? '10' : myE.toFixed(1);
  $('ovDE').textContent = (d >= 0 ? '+' : '') + d.toFixed(1); $('ovDE').parentNode.className = 'eb df ' + (d > 0.4 ? 'good' : d < -0.4 ? 'bad' : '');
  $('ovDot').className = 'dot ' + (S.started ? 'on' : frameReady ? 'wait' : '');
  $('ovTime').textContent = S.started ? `${$('timer').textContent} · ${phaseAt(t, S.settings.triple).label}` : (frameReady ? '경기 대기' : '화면 연결 대기');
  const r = rec && rec.recs[0], box = $('ovRec');
  if (!S.started) box.innerHTML = S.endedAt ? '경기 종료 — 앱에서 기록을 확인하세요' : '게임을 시작하면 자동으로 따라가요';
  else if (!r) box.innerHTML = `<span>${esc(rec ? rec.headline : '')}</span>`;
  else {
    const u = imgUrl(r.id);
    box.innerHTML = `${u ? `<img src="${esc(u)}" onerror="this.remove()">` : ''}<div><b>${rec.mode==='defend'?'🛡':rec.mode==='attack'?'⚔️':'♻️'} ${esc(CARDS[r.id].name)}</b> <span class="when">${esc(r.when)}</span><br><small>📍 ${esc(r.how)}</small></div>`;
    box.className = 'ovRec ' + rec.mode;
  }
  $('ovHand').textContent = deck.seq.length >= 4 ? `상대 손패: ${deck.hand.map(id=>CARDS[id].name).join(', ')}` : deck.known.length ? `상대 카드: ${deck.known.map(id=>CARDS[id].name).join(', ')}` : '';
  if (OV.more){
    const g = inf.groups[0];
    $('ovMoreBox').innerHTML = (g ? `<div><b>상대 덱 추정</b> ${esc(g.n)} ${Math.round(g.prob*100)}%</div>` : '')
      + (inf.predicted.length ? `<div class="muted">아직 안 나온 카드 예상: ${inf.predicted.slice(0,3).map(p=>esc(CARDS[p.id].name)).join(', ')}</div>` : '')
      + tips.slice(0,3).map(tp=>`<div class="tip">${esc(tp.text)}</div>`).join('');
  }
}
if (OVL) buildOverlay();

/* ---- 본 앱(안드로이드): 시작 버튼 + 경기 후 기록 가져오기 ---- */
const SC = (()=>{ try{ const C = window.Capacitor; return !OVL && C && C.getPlatform && C.getPlatform() === 'android' && C.registerPlugin ? C.registerPlugin('ScreenCoach') : null; }catch(e){ return null; } })();
if (SC){
  const b = document.createElement('button'); b.className = 'btn gold'; b.id = 'btnPhoneCoach'; b.textContent = '📱 휴대폰 실시간 코치 시작';
  $('btnCapture').parentNode.insertBefore(b, $('btnCapture'));
  $('previewHint').textContent = '[휴대폰 실시간 코치 시작] → "다른 앱 위에 표시" 허용 → 화면 녹화 "시작"을 누르고 클래시로얄을 켜세요. 게임 중엔 아무것도 누르지 않아도 돼요.';
  b.onclick = async ()=>{
    try{
      let p = await SC.hasOverlayPermission();
      if (p.running){ await SC.stop(); toast('실시간 코치를 껐어요'); return; }
      if (!p.granted){ toast('"다른 앱 위에 표시"를 허용해주세요'); p = await SC.requestOverlayPermission(); if (!p.granted){ toast('권한이 없으면 게임 위에 코치 창을 띄울 수 없어요'); return; } }
      const cfg = {}; ['crc_settings','crc_pcalib','crc_ecalib','crc_ovvoice'].forEach(k=>{ const v = localStorage.getItem(k); if (v != null) cfg[k] = v; });
      await SC.start({config: JSON.stringify(cfg), width: 360, fps: 8});
    }catch(e){ toast(String(e && e.message || e) === 'denied' ? '화면 녹화를 허용해야 해요' : '시작하지 못했어요: ' + (e && e.message || e)); }
  };
}
function importOverlayResult(res){
  if (!res || !res.at || res.at <= store.get('crc_ovseen', 0)) return;
  store.set('crc_ovseen', res.at);
  if (S.started) return;
  S.plays = res.plays || []; S.mine = res.mine || []; S.endedAt = res.endedAt || 0;
  S.pending = (res.pending || []).map(p=>Object.assign({}, p));
  templates = store.get('crc_templates', []).map(t=>({id:t.id, raw:t.raw, f:featureFromRGBA(b64ToRGBA(t.raw))}));
  try{ ACC.dirty.templates = Date.now(); saveAcc(); }catch(e){}
  renderPending(); render();
  toast(S.pending.length ? `방금 경기 기록을 가져왔어요 · 확인할 장면 ${S.pending.length}개` : '방금 경기 기록을 가져왔어요');
}
if (!OVL) document.addEventListener('visibilitychange', async ()=>{
  if (document.visibilityState !== 'visible') return;
  let res = store.get('crc_ovresult', null);
  if (SC){ try{ const sh = await SC.getShared(); if (sh && sh.json){ const j = JSON.parse(sh.json); if (!res || j.at > res.at) res = j; } }catch(e){} }
  importOverlayResult(res);
});


/* ================= 계정 · 동기화 (서버 1단계) =================
   로그인하면 카드 인식 학습(templates), 영상 학습 기록(vlog), 영역 설정(calib), 앱 설정(settings)을
   서버에 올리고 다른 기기와 합쳐요. 서버가 꺼져 있거나 로그인 안 해도 앱은 지금처럼 동작해요. */
const ACC = Object.assign({server: SERVER_URL || '', access:null, refresh:null, user:null, ver:{}, dirty:{}, lastSync:0}, store.get('crc_account', {}));
const saveAcc = ()=>{ try{ localStorage.setItem('crc_account', JSON.stringify(ACC)); }catch(e){} };
const KIND_OF = {crc_templates:'templates', crc_vlog:'vlog', crc_calib:'calib', crc_vcalib:'calib', crc_pcalib:'calib', crc_ecalib:'calib', crc_settings:'settings'};
let syncTimer = null, syncing = false, applyingRemote = false;
store.onSet = k=>{
  const kind = KIND_OF[k]; if (!kind || applyingRemote) return;
  ACC.dirty[kind] = Date.now(); saveAcc();
  if (ACC.refresh && !OVL){ clearTimeout(syncTimer); syncTimer = setTimeout(()=>syncAll(false), 15000); }
};
const deviceName = ()=>{ const ua = navigator.userAgent; return /iPhone|iPad/.test(ua) ? 'iPhone·iPad' : /Android/.test(ua) ? '안드로이드' : window.crNative ? 'PC 앱' : '브라우저'; };
class ApiErr extends Error { constructor(st, j){ super((j && j.message) || '서버에 연결하지 못했어요'); this.status = st; this.code = j && j.error; this.body = j; } }
async function rawApi(method, p, body, token){
  if (!ACC.server) throw new ApiErr(0, {message:'서버 주소가 없어요. 아래 [서버 주소]에 넣어주세요'});
  let r;
  try{
    r = await fetch(ACC.server.replace(/\/+$/,'') + '/api/v1' + p, {method, headers: Object.assign({'content-type':'application/json'}, token ? {authorization:'Bearer '+token} : {}), body: body ? JSON.stringify(body) : undefined});
  }catch(e){ throw new ApiErr(0, {message:'서버에 연결하지 못했어요 (인터넷·서버 주소 확인)'}); }
  let j = null; try{ j = await r.json(); }catch(e){}
  if (!r.ok && r.status !== 409) throw new ApiErr(r.status, j);
  return {status:r.status, body:j};
}
let refreshing = null;
async function api(method, p, body){
  try{ return await rawApi(method, p, body, ACC.access); }
  catch(e){
    if (e.status !== 401 || !ACC.refresh) throw e;
    refreshing = refreshing || rawApi('POST', '/auth/refresh', {refresh: ACC.refresh}).then(r=>{ ACC.access = r.body.access; ACC.refresh = r.body.refresh; ACC.user = r.body.user; saveAcc(); })
      .catch(err=>{ if (err.status === 401){ localLogout(); toast('로그인이 만료됐어요. 다시 로그인해주세요'); } throw err; })
      .finally(()=>{ refreshing = null; });
    await refreshing;
    return rawApi(method, p, body, ACC.access);
  }
}
/* --- 기기의 현재 값 읽기 / 서버 값과 합치기 --- */
function localOf(kind){
  if (kind === 'templates') return store.get('crc_templates', []);
  if (kind === 'vlog') return store.get('crc_vlog', []);
  if (kind === 'calib') return {calib:store.get('crc_calib',null), vcalib:store.get('crc_vcalib',null), pcalib:store.get('crc_pcalib',null), ecalib:store.get('crc_ecalib',null)};
  const st = Object.assign({}, S.settings), md = myDeck(); delete st.myDeck; st.myDeckKey = md ? {n:md.n, v:md.v} : null; return st;
}
function mergeKind(kind, remote, local){
  if (remote == null) return local;
  if (kind === 'templates'){
    const seen = new Set(), out = [];
    for (const t of remote.concat(local)) { if (!t || !t.id || !t.raw) continue; const k = t.id+'|'+t.raw.slice(0,64)+t.raw.length; if (seen.has(k)) continue; seen.add(k); out.push({id:t.id, raw:t.raw}); }
    const cnt = {}, keep = [];   // 카드마다 최신 10장(카드 아님은 40장)만
    for (let i = out.length-1; i >= 0; i--){ const id = out[i].id, cap = id==='__ignore'?40:10; cnt[id] = (cnt[id]||0)+1; if (cnt[id] <= cap) keep.unshift(out[i]); }
    return keep;
  }
  if (kind === 'vlog'){
    const seen = new Set(), out = [];
    for (const e of remote.concat(local)) { if (!e) continue; const k = [e.match,e.t,e.id,e.side,e.x,e.y].join('|'); if (seen.has(k)) continue; seen.add(k); out.push(e); }
    return out.slice(-5000);
  }
  return local;   // 설정·영역: 이 기기에서 방금 바꾼 값이 이김
}
const same = (a,b)=> JSON.stringify(a) === JSON.stringify(b);
function applyLocal(kind, v){
  applyingRemote = true;
  try{
    if (kind === 'templates'){ store.set('crc_templates', v); templates = v.map(t=>{ try{ return {id:t.id, raw:t.raw, f:featureFromRGBA(b64ToRGBA(t.raw))}; }catch(e){ return null; } }).filter(Boolean); }
    else if (kind === 'vlog'){ S.vlog = v; store.set('crc_vlog', v); PATTERNS = learnPatterns(S.vlog); renderVLearn(); }
    else if (kind === 'calib'){ ['calib','vcalib','pcalib','ecalib'].forEach(k=>{ if (v[k]){ store.set('crc_'+k, v[k]); S[k] = v[k]; } }); }
    else {
      const st = Object.assign({}, v), key = st.myDeckKey; delete st.myDeckKey;
      Object.assign(S.settings, st);
      if (key !== undefined){ const i = key ? DECKS.findIndex(d=>d.n===key.n && d.v===key.v) : -1; S.settings.myDeck = i >= 0 ? i : null; }
      saveSettings(); syncSettingsUI(); renderDecks(); renderMyHand();
    }
  } finally { applyingRemote = false; }
}
async function syncKind(kind, remoteVer){
  for (let attempt = 0; attempt < 3; attempt++){
    const local = localOf(kind), dirty = !!ACC.dirty[kind];
    let base = ACC.ver[kind] || 0, merged = local;
    if (remoteVer !== base){
      const g = await api('GET', '/sync/'+kind);
      base = g.body.version;
      if (g.body.data != null){
        merged = (kind === 'calib' || kind === 'settings') && !dirty ? g.body.data : mergeKind(kind, g.body.data, local);
        if (!same(merged, local)) applyLocal(kind, merged);
      }
      if (g.body.data != null && same(merged, g.body.data)){ ACC.ver[kind] = base; delete ACC.dirty[kind]; return; }
    } else if (!dirty) return;
    const r = await api('PUT', '/sync/'+kind, {baseVersion: base, data: merged});
    if (r.status === 409){ remoteVer = r.body.version; ACC.ver[kind] = base; continue; }
    ACC.ver[kind] = r.body.version; delete ACC.dirty[kind]; return;
  }
}
async function syncAll(manual){
  if (!ACC.refresh || syncing || OVL) return;
  syncing = true; renderAcct('동기화 중…');
  try{
    const st = await api('GET', '/sync');
    for (const kind of ['settings','calib','templates','vlog']) await syncKind(kind, (st.body.kinds[kind]||{}).version || 0);
    ACC.lastSync = Date.now(); saveAcc(); renderPending(); render();
    if (manual) toast('동기화 완료');
  }catch(e){ if (manual) toast(e.message); }
  finally{ syncing = false; saveAcc(); renderAcct(); }
}
/* --- 최신 덱 데이터 받기 --- */
async function checkDataUpdate(){
  if (!ACC.server || OVL) return;
  try{
    const v = await rawApi('GET', '/data/version');
    const have = (store.get('crc_databundle', null) || {}).version || DATA_VERSION;
    if (!v.body.version || String(v.body.version) <= String(have)) return;
    const b = await rawApi('GET', '/data/latest');
    if (b.body && b.body.version){ store.set('crc_databundle', b.body); toast(`새 덱 데이터(${b.body.version})를 받았어요. 앱을 다시 열면 적용돼요`); }
  }catch(e){}
}
/* --- 화면 --- */
function localLogout(){ ACC.access = ACC.refresh = ACC.user = null; ACC.ver = {}; saveAcc(); renderAcct(); }
let joinMode = false;
function renderAcct(status){
  if (!$('acctPanel')) return;
  const inn = !!(ACC.refresh && ACC.user);
  $('acctIn').style.display = inn ? '' : 'none'; $('acctOut').style.display = inn ? 'none' : '';
  $('acServer').value = ACC.server || '';
  $('acJoinRow').style.display = joinMode ? '' : 'none';
  $('acLogin').textContent = joinMode ? '가입하기' : '로그인'; $('acJoin').textContent = joinMode ? '로그인으로' : '회원가입';
  $('acPw').autocomplete = joinMode ? 'new-password' : 'current-password';
  if (inn){
    $('acName').textContent = ACC.user.nickname + (ACC.user.role === 'admin' ? ' (관리자)' : '');
    $('acMail').textContent = ACC.user.email || '';
    const t = store.get('crc_templates', []).filter(x=>x.id!=='__ignore').length, v = store.get('crc_vlog', []).length;
    $('acSyncInfo').textContent = status || (`카드 인식 학습 ${t}장 · 영상 학습 ${v}개 · ` + (ACC.lastSync ? `마지막 동기화 ${new Date(ACC.lastSync).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}` : '아직 동기화 안 함') + (Object.keys(ACC.dirty).length ? ' · 올릴 변경 있음' : ''));
    $('acctSub').textContent = '로그인됨';
  } else $('acctSub').textContent = '로그인하면 학습 데이터가 내 모든 기기에 맞춰져요';
}
function afterLogin(r){
  ACC.access = r.access; ACC.refresh = r.refresh; ACC.user = r.user;
  // 학습 데이터는 이 기기 것과 서버 것을 합치고, 설정·영역은 서버에 있으면 서버 것을, 없으면 이 기기 것을 올림
  ACC.ver = {calib:-1, settings:-1}; delete ACC.dirty.calib; delete ACC.dirty.settings;
  ['templates','vlog'].forEach(k=>{ ACC.dirty[k] = ACC.dirty[k] || Date.now(); });
  saveAcc(); $('acPw').value = ''; renderAcct(); toast(`${r.user.nickname}님, 환영해요`); syncAll(false);
}
if ($('acctPanel')){
  $('acJoin').onclick = ()=>{ joinMode = !joinMode; $('acMsg').textContent = ''; renderAcct(); };
  $('acLogin').onclick = async ()=>{
    const email = $('acEmail').value.trim(), password = $('acPw').value;
    $('acMsg').textContent = '';
    try{
      const r = joinMode
        ? await rawApi('POST', '/auth/register', {email, password, nickname:$('acNick').value.trim(), age14:$('acAge').checked, device:deviceName()})
        : await rawApi('POST', '/auth/login', {email, password, device:deviceName()});
      joinMode = false; afterLogin(r.body);
    }catch(e){ $('acMsg').textContent = e.message; }
  };
  $('acPw').addEventListener('keydown', e=>{ if (e.key === 'Enter') $('acLogin').click(); });
  $('acSync').onclick = ()=> syncAll(true);
  $('acLogout').onclick = async ()=>{ try{ await rawApi('POST', '/auth/logout', {refresh: ACC.refresh}); }catch(e){} localLogout(); toast('로그아웃했어요. 이 기기의 학습 데이터는 그대로 남아요'); };
  $('acNickBtn').onclick = async ()=>{
    const n = prompt('새 닉네임 (2~16자)', ACC.user.nickname); if (!n) return;
    try{ const r = await api('PATCH', '/me', {nickname:n}); ACC.user = r.body.user; saveAcc(); renderAcct(); toast('닉네임을 바꿨어요'); }catch(e){ toast(e.message); }
  };
  $('acPwBtn').onclick = async ()=>{
    const o = prompt('현재 비밀번호'); if (!o) return; const n = prompt('새 비밀번호 (8자 이상)'); if (!n) return;
    try{ await api('POST', '/me/password', {oldPassword:o, newPassword:n}); toast('비밀번호를 바꿨어요. 다른 기기는 로그아웃돼요'); }catch(e){ toast(e.message); }
  };
  $('acDelete').onclick = async ()=>{
    if (!confirm('탈퇴하면 서버에 올린 학습 데이터가 지워지고, 30일 뒤 계정 정보도 완전히 삭제돼요. 이 기기의 데이터는 남아요. 탈퇴할까요?')) return;
    try{ await api('DELETE', '/me'); localLogout(); toast('탈퇴 처리했어요'); }catch(e){ toast(e.message); }
  };
  $('acServerSave').onclick = ()=>{ ACC.server = $('acServer').value.trim().replace(/\/+$/,''); saveAcc(); toast('서버 주소를 저장했어요'); checkDataUpdate(); };
  $('acServerTest').onclick = async ()=>{ ACC.server = $('acServer').value.trim().replace(/\/+$/,''); saveAcc(); try{ await rawApi('GET', '/health'); toast('서버 연결 OK'); }catch(e){ toast(e.message); } };
  renderAcct();
  if (!OVL){
    if (ACC.refresh) setTimeout(()=>syncAll(false), 1500);
    setTimeout(checkDataUpdate, 2500);
    document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState === 'visible' && ACC.refresh && Date.now() - ACC.lastSync > 60000) syncAll(false); });
  }
}
/* ---------- 데모 (#demo) ---------- */
const hash = location.hash.slice(1);
if (hash==='demo'){
  setMyDeck(DECKS.findIndex(d=>d.n==='순호'));
  startGame(); S.startAt -= 72000;
  [[9,'pekka',3.5,10],[30,'battleram',14.5,12],[38,'zap',14.5,22],[52,'ewiz',14.5,13],[61,'fireball',3.5,25],[70,'bandit',3.5,12]].forEach(([t,id,x,y])=>S.plays.push({t,id,x,y,lane:laneOf(x)}));
  [[12,'cannon',8.5,21],[33,'skeletons',13,22],[50,'icegolem',3.5,30],[57,'hog',14.5,17]].forEach(([t,id,x,y])=>S.mine.push({t,id,x,y}));
} else if (['decks','pro','settings','news','video'].includes(hash)){ const nb=document.querySelector(`.nb[data-tab="${hash}"]`); if (nb) nb.click(); }
renderPending(); render();
setInterval(render, 250);
hud.addEventListener('dblclick', ()=>{ if (document.body.classList.contains('minimode')) $('btnPip').click(); });
(function loop(){ if ($('tab-battle').classList.contains('on')) arena.render(); if ($('tab-video').classList.contains('on')) vArena.render(); requestAnimationFrame(loop); })();
})();
