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
  settings: Object.assign({bgm:true, sfx:true, sndVol:50, tts:false, triple:true, sens:16, thresh:60, auto:true, autoAccept:true, autoMine:false, autoStart:true, visV:0, unknownCost:4, myDeck:null, imgOn:true, imgTpl:IMG_DEFAULT}, store.get('crc_settings', {})),
  calib: store.get('crc_calib', null),
  vcalib: store.get('crc_vcalib', null),
  vlog: store.get('crc_vlog', []),
};
// 인식 엔진 v2: '일치 기준'이 확률(%)로 바뀜 → 예전 기본값(82)은 새 기본값(60)으로
if (S.settings.visV < 2){ if (S.settings.thresh >= 80) S.settings.thresh = 60; S.settings.visV = 2; try{ localStorage.setItem('crc_settings', JSON.stringify(S.settings)); }catch(e){} }
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
  try{ if (window.SND) SND.duck(); }catch(e){}
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
  if (c.rarity === 'ch') return '챔피언'; if (c.type === 's') return '주문'; if (c.type === 'b') return '건물';
  if (c.air) return '공중'; if (c.tags.includes('win')) return '승리'; return '유닛';
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
  openModal('앱 설치 안내', $('installTpl').content.cloneNode(true));
  $('mBody').querySelectorAll('[data-dl]').forEach(a=>{ const u = DOWNLOADS[a.dataset.dl]; if (u){ a.href = u; a.target='_blank'; } else a.onclick = e=>{ e.preventDefault(); toast('설치 파일은 빌드를 배포한 뒤 이 버튼에 연결돼요'); }; });
};
$('pillDecks').textContent = `덱 ${DECKS.length}종 · 카드 ${CARD_DATA.length-1}장`;

/* ---------- 설정 ---------- */
function syncSettingsUI(){
  $('sens').value=S.settings.sens; $('thresh').value=S.settings.thresh;
  $('chkAuto').checked=S.settings.auto; $('chkAutoAccept').checked=S.settings.autoAccept; $('chkAutoMine').checked=S.settings.autoMine; $('chkAutoStart').checked=S.settings.autoStart;
  $('chkTTS').checked=S.settings.tts; $('chkTriple').checked=S.settings.triple; $('unkCost').value=S.settings.unknownCost;
  $('chkImg').checked=S.settings.imgOn; $('imgTpl').value=S.settings.imgTpl;
  $('sensV').textContent=S.settings.sens; $('threshV').textContent=S.settings.thresh+'%';
  try{ syncSoundUI(); if (window.SND) SND.apply(); }catch(e){}
  const md = myDeck(); $('pillMine').textContent = md ? `내 덱: ${md.n}` : '내 덱 미설정';
  $('mySel').value = S.settings.myDeck == null ? '' : String(S.settings.myDeck);
}
$('mySel').innerHTML = '<option value="">선택 안 함</option>' + DECKS.map((d,i)=>`<option value="${i}">${esc(d.n)} · ${esc(d.v)}</option>`).join('');
const setMyDeck = i => { S.settings.myDeck = i; saveSettings(); syncSettingsUI(); renderDecks(); renderMyHand(); lastGuessKey=''; try{ refreshHandPool(); }catch(e){} };
$('mySel').onchange = e=> setMyDeck(e.target.value==='' ? null : +e.target.value);
$('sens').oninput = e=>{ S.settings.sens=+e.target.value; saveSettings(); syncSettingsUI(); };
$('thresh').oninput = e=>{ S.settings.thresh=+e.target.value; saveSettings(); syncSettingsUI(); };
$('chkAuto').onchange = e=>{ S.settings.auto=e.target.checked; saveSettings(); };
$('chkAutoAccept').onchange = e=>{ S.settings.autoAccept=e.target.checked; saveSettings(); };
$('chkAutoMine').onchange = e=>{ S.settings.autoMine=e.target.checked; saveSettings(); };
$('chkAutoStart').onchange = e=>{ S.settings.autoStart=e.target.checked; saveSettings(); };
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
  const rng = document.createElement('div'); rng.className = 'rng'; el.appendChild(rng);
  el.onclick = e=>{
    if (!S.started){ toast('경기를 시작한 뒤 보정할 수 있어요'); return; }
    const r = el.getBoundingClientRect(); onSet(Math.max(0, Math.min(10, Math.round(((e.clientX-r.left)/r.width)*10*2)/2)));
  };
  return (v, lo, hi) => {
    segs.forEach((f,i)=>{ f.style.width = Math.max(0,Math.min(1, v - i))*100 + '%'; });
    if (lo != null && hi - lo >= 0.3){ rng.style.display = 'block'; rng.style.left = lo*10 + '%'; rng.style.width = (hi-lo)*10 + '%'; } else rng.style.display = 'none';
  };
}
function paintElixir(sim, simMe){
  $('elixirNum').textContent = sim.E >= 9.95 ? '10' : sim.E.toFixed(1); setOppBar(sim.E, sim.lo, sim.hi);
  $('elixirNumMe').textContent = simMe.E >= 9.95 ? '10' : simMe.E.toFixed(1); setMyBar(simMe.E, simMe.lo, simMe.hi);
  const diff = sim.E - simMe.E;
  $('ediff').textContent = S.started ? (Math.abs(diff)<0.5 ? '엘릭서 비슷' : diff>0 ? `상대가 ${diff.toFixed(1)} 앞섬` : `내가 ${(-diff).toFixed(1)} 앞섬`) : '';
  $('ediff').className = 'ediff ' + (!S.started || Math.abs(diff) < 0.5 ? '' : diff > 0 ? 'bad' : 'good');
}
// 숫자만 빠르게 (초당 15번): 엘릭서가 실제로 차오르는 게 부드럽게 보이도록
let fastLast = 0;
function fastTick(now){
  if (S.started && now - fastLast > 66){
    fastLast = now; const t = gameTime();
    const sim = simulate(S.plays, t, opts()), simMe = simulate(S.mine, t, opts());
    const live = myLiveE(); if (live != null){ simMe.E = live; simMe.lo = simMe.hi = live; }
    paintElixir(sim, simMe);
    $('timer').textContent = t < 180 ? fmt(180-t) : fmt(Math.max(0,300-t));
    if (OVL && $('ovRoot')){ $('ovOE').textContent = fmtE1(sim.E); $('ovBE').textContent = fmtE1(sim.E); $('ovME').textContent = fmtE1(simMe.E); setEBar($('ovOBar'), sim.E, sim.lo, sim.hi); setEBar($('ovMBar'), simMe.E, simMe.E, simMe.E); }
  }
  requestAnimationFrame(fastTick);
}
requestAnimationFrame(fastTick);
const setOppBar = makeBar($('segbar'), v=>{ S.plays.push({t:gameTime(), corr:true, value:v}); toast(`상대 엘릭서를 ${v}로 보정`); render(); });
const setMyBar = makeBar($('segbarMe'), v=>{ S.mine.push({t:gameTime(), corr:true, value:v}); toast(`내 엘릭서를 ${v}로 보정`); render(); });

/* ---------- 경기 제어 ---------- */
function startGame(){
  try{ if (window.SND) SND.fx('start'); }catch(e){}
  S.started=true; S.startAt=performance.now(); S.offset=0; S.endedAt=null; S.plays=[]; S.mine=[]; S.pending=[]; S.handLive=null; S.autoDeck=[]; VIS.forEach(v=>v.reset());
  try{ const ka = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.KeepAwake; if (ka) ka.keepAwake(); }catch(e){}
  renderPending(); $('btnStart').textContent='경기 종료'; $('btnStart').classList.replace('gold','red');
  toast('경기 시작! 양쪽 엘릭서를 5부터 계산해요'); speak('start','경기 시작');
}
function endGame(){ try{ if (window.SND) SND.fx('end'); }catch(e){} S.endedAt=gameTime(); S.started=false; $('btnStart').textContent='경기 시작'; $('btnStart').classList.replace('red','gold'); toast('경기 종료'); }
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
  if (!extra || extra.x == null){ S.placeArm = {who:'opp', p, until:performance.now()+5000}; $('arenaHint').textContent='전술판에서 놓은 위치를 누르면 더 정확해져요 (5초)'; }
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
  const h = liveHand(md);
  md.c.forEach((id,i)=>{
    const w=document.createElement('div'); w.className='slot';
    const inHand = h.known ? h.hand.includes(id) : !h.queue.includes(id);
    if (h.live && h.next === id){ w.title = '다음에 들어올 카드'; }
    w.appendChild(cardEl(id,{mini:true, evo:md.e.includes(id), hero:md.h.includes(id), ghost:!inHand, onclick:()=>recordMine(id)}));
    const s=document.createElement('span'); s.className='st '+(inHand?'hand':'queue'); s.textContent = (inHand?'손패':(h.live && h.next===id ? '다음' : '대기'))+' · '+'QWERTYUI'[i]; w.appendChild(s);
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
let prevTipKeys = new Set(), lastGuessKey = '', lastRec = null, lastSim = null;
function myLiveE(){ return S.started && S.myLive && performance.now() - S.myLive.at < 800 ? S.myLive.v : null; }
function liveHand(md){
  const h = S.handLive && performance.now() - S.handLive.at < 2500 ? S.handLive : null;
  if (h && h.slots.filter(Boolean).length >= 3) return {known:true, hand:h.slots.filter(Boolean), next:h.next, live:true};
  return md ? myHandOf(md.c, S.mine) : null;
}
const myCardsNow = md=> md ? md.c : (S.autoDeck.length === 8 ? S.autoDeck : null);
function render(){
  const t = gameTime();
  syncLivePositions();
  const sim = simulate(S.plays, t, opts());
  const md = myDeck();
  const simMe = simulate(S.mine, t, opts());
  const live = myLiveE(); if (live != null){ simMe.E = live; simMe.lo = simMe.hi = live; }
  const deck = analyzeDeck(S.plays), inf = inferDecks(deck.known);
  const ph = phaseAt(t, S.settings.triple);
  const hand = liveHand(md);
  const rec = S.started ? recommend({t, oppPlays:S.plays, myCards: myCardsNow(md), myHand:hand, myE:simMe.E, oppE:sim.E, triple:S.settings.triple, patterns:PATTERNS}) : null;
  lastRec = rec; lastSim = {sim, simMe};

  $('timer').textContent = t < 180 ? fmt(180-t) : fmt(Math.max(0,300-t));
  const pe=$('phase'); pe.textContent = S.started ? ph.label : (S.endedAt?'경기 종료':'대기 중'); pe.className='phase hd '+(S.started?ph.cls:'');
  paintElixir(sim, simMe);
  $('leakInfo').textContent = (sim.hi - sim.lo >= 0.3 ? `범위 ${sim.lo.toFixed(1)}~${sim.hi.toFixed(1)} · ` : '정확 · ') + `낭비 ${sim.leak.toFixed(1)}`;
  $('leakInfoMe').textContent = (live != null ? '화면에서 읽는 중 · ' : '') + `낭비 ${simMe.leak.toFixed(1)}`;

  // 추천 카드
  const rb=$('recBox'); rb.innerHTML='';
  if (!S.started){ rb.innerHTML='<div class="muted">경기를 시작하면 상대 카드와 양쪽 엘릭서를 보고 낼 카드와 위치를 알려줘요.</div>'; }
  else if (!rec || !rec.recs.length){ rb.innerHTML=`<div class="recHead">${esc(rec?rec.headline:'')}</div>`; }
  else {
    rb.innerHTML = `<div class="recHead ${rec.mode}">${rec.mode==='defend'?'수비':rec.mode==='attack'?'공격':'사이클'} · ${esc(rec.headline)}</div>`;
    rec.recs.forEach((r,i)=>{
      const row=document.createElement('div'); row.className='recRow'+(i===0?' best':'');
      row.appendChild(cardEl(r.id,{mini:true, onclick:()=>recordMine(r.id, {x:r.x, y:r.y})}));
      const tx=document.createElement('div'); tx.className='recTx';
      tx.innerHTML = `<b>${i+1}. ${esc(CARDS[r.id].name)}</b> <span class="chip" style="background:#2775e0">${esc(r.when)}</span>${r.inHand===false?' <span class="chip" style="background:#d33030">손에 없음</span>':''}${r.wait>0.3?` <span class="chip" style="background:#c47a00">${r.wait.toFixed(0)}초 뒤 가능</span>`:''}<br>${esc(r.how)}<br><span class="muted">${esc(r.why.join(' · '))}</span>`;
      row.appendChild(tx); rb.appendChild(row);
    });
  }

  // 3D 상태: 위치 + 속도(전술판이 프레임마다 부드럽게 이어서 그림), 화면에서 실제로 추적 중이면 live
  const oppUnits = [], paths = [], nowMs = performance.now();
  // 실제로 본 것만 그림: 화면에서 지금 따라가는 위치(live), 또는 방금 놓은 자리(1.5초). 예상 경로로 '상상해서' 움직이지 않음
  S.plays.filter(p=>!p.corr && !p.ability && CARDS[p.id]).forEach(p=>{
    const age = t - p.t, live = p.live && t - p.live.t < 0.6 ? p.live : null;
    if (!live && age > 1.5) return;
    const pos = live || (p.x != null ? {x:p.x, y:p.y} : null); if (!pos) return;
    const isThreat = rec && rec.threat === p, tp = isThreat ? threatPosition(p, t) : null;
    const name = p.id === 'unknown' ? (p.guess && CARDS[p.guess] ? CARDS[p.guess].name+'?' : '?') : CARDS[p.id].name;
    oppUnits.push({id:p.id, name, x:pos.x, y:pos.y, at:nowMs, live:!!live, eta: tp && !tp.arrived ? tp.eta : null, born: age,
      cost: age < 1.4 ? playCost(S.plays, S.plays.indexOf(p), S.settings.unknownCost) : null,
      label: isThreat ? `${name}${tp && tp.eta>0.5?` · ${tp.eta.toFixed(0)}초`:''}` : ''});
  });
  const mineUnits = S.mine.filter(p=>!p.corr && CARDS[p.id] && t - p.t < 1.5 && p.x!=null).map(p=>({id:p.id, name:CARDS[p.id].name, x:p.x, y:p.y, at:nowMs, born:t-p.t, cost: t - p.t < 1.4 ? (CARDS[p.id].cost) : null}));
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
  $('handLine').textContent = deck.seq.length<4 ? '상대가 4장 이상 내면 손패를 계산해요.' : `상대 손패: ${hn.join(', ')||'—'}${unk>0?` + 모르는 ${unk}장`:''}` + (deck.next?` · 다음 복귀: ${CARDS[deck.next]?CARDS[deck.next].name:'?'}`:'');

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
  $('tplCount').textContent = `학습 ${TPL.count()}장`;
  renderHud(sim.E, simMe.E, rec, deck);
  if (OVL) renderOverlay(sim, simMe, rec, deck, inf, tips);
}

/* ---------- 미니 창 (항상 위 HUD) ---------- */
const hud = $('miniHud');
let pipWin = null;
function renderHud(E, myE, rec, deck){
  const r = rec && rec.recs[0];
  hud.innerHTML = `<div class="hrow"><div class="hb opp"><small>상대</small><b>${E.toFixed(1)}</b></div><div class="hb me"><small>나</small><b>${myE.toFixed(1)}</b></div><div class="hb tm"><small>${S.started?phaseAt(gameTime(),S.settings.triple).label:'대기'}</small><b>${$('timer').textContent}</b></div></div>`
    + `<div class="hrec">${r ? `<b>${esc(CARDS[r.id].name)}</b> · ${esc(r.when)}<br><small>${esc(r.how)}</small>` : esc(rec?rec.headline:'경기 시작 대기')}</div>`
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

/* ---------- 학습 템플릿 (모든 화면이 함께 씀) ---------- */
const TPL = VISION.TemplateStore();
function legacyTpl(raw){
  try{ const a = b64ToRGBA(raw), rgb = new Uint8Array(24*24*3); for (let i=0;i<576;i++){ rgb[i*3]=a[i*4]; rgb[i*3+1]=a[i*4+1]; rgb[i*3+2]=a[i*4+2]; }
    const up = VISION.upscale24(rgb); return {f:VISION.featurize(up,null,false), ff:VISION.featurize(up,null,true)}; }catch(e){ return null; }
}
function loadTemplates(){ TPL.load(store.get('crc_templates', []), legacyTpl); }
loadTemplates();
const saveTemplates = ()=> store.set('crc_templates', TPL.serialize());
function learnFeats(id, feats, group){ if (!feats || !feats.length || !id) return; for (const f of feats) TPL.add(id, f.f, f.ff, group); saveTemplates(); }
$('btnClearTpl').onclick = ()=>{ if (confirm('학습한 카드 인식 데이터를 모두 지울까요?')){ TPL.clear(); saveTemplates(); renderPending(); render(); toast('지웠어요'); } };

const thumbCv = document.createElement('canvas'); thumbCv.width = thumbCv.height = 32; const thumbCx = thumbCv.getContext('2d');
function rgbThumb(rgb){
  if (!rgb) return '';
  const im = thumbCx.createImageData(32, 32);
  for (let i=0;i<1024;i++){ im.data[i*4]=rgb[i*3]; im.data[i*4+1]=rgb[i*3+1]; im.data[i*4+2]=rgb[i*3+2]; im.data[i*4+3]=255; }
  thumbCx.putImageData(im, 0, 0); return thumbCv.toDataURL('image/jpeg', 0.85);
}
/* 영상/캔버스의 일부를 w x h로 줄여 RGBA로. 크게 줄일 때는 2배 크기를 한 번 거쳐 계단 잡음을 줄임 */
function makeGrabber(getSrc){
  const cv = document.createElement('canvas'), cx = cv.getContext('2d', {willReadFrequently:true});
  const mid = document.createElement('canvas'), mx = mid.getContext('2d');
  return (r, w, h)=>{
    const v = getSrc(); if (!v || !r) return null;
    const vw = v.videoWidth || v.width, vh = v.videoHeight || v.height; if (!vw || !vh) return null;
    const sx = r.x*vw, sy = r.y*vh, sw = r.w*vw, sh = r.h*vh;
    if (cv.width !== w || cv.height !== h){ cv.width = w; cv.height = h; }
    if (sw > w*3 || sh > h*3){ const w2 = w*2, h2 = h*2; if (mid.width !== w2 || mid.height !== h2){ mid.width = w2; mid.height = h2; } mx.drawImage(v, sx, sy, sw, sh, 0, 0, w2, h2); cx.drawImage(mid, 0, 0, w, h); }
    else cx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
    return cx.getImageData(0, 0, w, h).data;
  };
}

/* ---------- 손패 카드 기준 그림 ---------- */
const HANDREF = {list:[], done:new Set()};
function cardImgUrl(key){ return (localCards && S.settings.imgTpl === IMG_DEFAULT) ? 'cards/'+key+'.png' : S.settings.imgTpl.replace('{key}', key); }
function handRefFrom(id, img, evo){
  const c = document.createElement('canvas'); c.width = 60; c.height = 72; const x = c.getContext('2d', {willReadFrequently:true});
  x.drawImage(img, 0, 0, 60, 72); let d; try{ d = x.getImageData(0, 0, 60, 72).data; }catch(e){ return null; }
  const C = CARDS[id];
  return {id, evo, cost: C.tags.includes('mirror') ? null : C.cost, f: VISION.handFeat(d,60,0,0,60,72,false), fg: VISION.handFeat(d,60,0,0,60,72,true)};
}
function loadHandRefs(ids){
  ids.forEach(id=>{
    const C = CARDS[id]; if (!C || !C.key || HANDREF.done.has(id)) return; HANDREF.done.add(id);
    [[C.key,false],[C.key+'-ev1',true]].forEach(([k,evo])=>{
      const im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = ()=>{ const r = handRefFrom(id, im, evo); if (r){ HANDREF.list.push(r); VIS.forEach(v=>v.setHandRefs(HANDREF.list)); } };
      im.src = cardImgUrl(k);
    });
  });
}
const handPool = ()=>{ const md = myDeck(); return md ? md.c : null; };
function refreshHandPool(){
  const pool = handPool();
  loadHandRefs(pool || []);
  if (!pool) setTimeout(()=>loadHandRefs(Object.keys(CARDS).filter(k=>k!=='unknown' && !k.endsWith('_air'))), 1500);
  VIS.forEach(v=>v.setHandPool(pool));
}

/* ---------- 인식 엔진 연결 ---------- */
const VIS = [], VISMAP = {};
const LIVE = {barAt:0, barSeen:0, firstV:null, regen:[], shift2:false, shift3:false, myOn:0};
function newVision(name, grab, extra){
  const v = VISION.Vision(Object.assign({grab, templates:TPL, sens:()=>S.settings.sens,
    onEvent:e=>onVisionEvent(e, name), onElixir:e=>onElixir(e, name), onHand:h=>onHand(h, name)}, extra||{}));
  v.setHandRefs(HANDREF.list); v.setHandPool(handPool());
  VIS.push(v); VISMAP[name] = v; return v;
}
const visionOK = ()=> S.settings.auto;
let playRef = 0;
const nextRef = p=> (p||'v') + (++playRef) + '_' + Date.now().toString(36);
// 화면 인식 결과로 상대 카드 판정 (외형 + 덱·사이클·엘릭서 문맥)
function judgeOpp(ev, exclude){
  const plays = S.plays.filter(p=>p !== exclude && p.t <= ev.t + 0.01);
  const deck = analyzeDeck(plays), inf = inferDecks(deck.known);
  const hi = simulate(plays, ev.t, opts()).hi;
  const R = identify(ev.cands, contextPrior(plays, inf, hi), {learned: TPL.ids(), calib: TPL.calib()});
  const th = Math.max(0.5, S.settings.thresh/100);
  const best = R.best;
  const noise = best && best.id === '__ignore' && best.p >= 0.7;
  const top = R.list[0] || null;
  const ok = !noise && top && top.p >= th && (top.tpl || top.p >= 0.9);
  return {R, ok, noise, top};
}
function applyOppJudge(p, J){
  p.post = J.R.list.slice(0, 4).map(x=>({id:x.id, p:x.p}));
  if (J.ok){ p.id = J.top.id; p.score = J.top.p; delete p.cost; delete p.costLo; delete p.costHi; delete p.guess; }
  else {
    p.id = 'unknown'; p.score = J.top ? J.top.p : 0; p.guess = J.top ? J.top.id : null;
    const c = costFromPosterior(J.R.list); if (c){ p.cost = c.c; p.costLo = c.lo; p.costHi = c.hi; }
  }
}
function myEventsForSide(t){
  return S.mine.filter(m=>!m.corr && !m.ability && Math.abs(m.t - t) < 4).map(m=>({t:m.t, id: m.id !== 'unknown' ? m.id : null, claimed: !!m.vid, _p:m}));
}
const myTrackingOn = ()=> performance.now() - LIVE.barAt < 3000;
function onVisionEvent(ev, src){
  if (ev.type === 'deploy' || ev.type === 'refine') return onDeploy(ev, src);
  if (!S.started) return;
  if (ev.type === 'myplay') return onMyPlay(ev);
  if (ev.type === 'drop') return onMyDrop(ev);
  if (ev.type === 'dropUndo'){ const i = S.mine.findIndex(m=>m.ref === ev.ref && !m.fromHand); if (i >= 0){ S.mine.splice(i, 1); render(); } }
}
function findByVid(vid, src){
  for (const arr of [S.plays, S.mine]){ const p = arr.find(x=>x.vid === vid && x.vsrc === src); if (p) return {arr, p}; }
  return null;
}
function onDeploy(ev, src){
  if (!S.started || src === 'video') return src === 'video' ? onVideoEvent(ev) : undefined;
  if (!visionOK()) return;
  const last = ev.stage === 2;
  let cur = findByVid(ev.vid, src);
  // 0.9초 만에 사라진 작은 것 = 깜빡임·효과 → 기록 취소
  if (ev.cancel){ if (cur){ cur.arr.splice(cur.arr.indexOf(cur.p), 1); render(); } return; }
  const thumb = ev.stage === 0 || !cur ? rgbThumb(ev.rgb) : null;
  // 진영: 화면 + 내가 실제로 낸 카드로 확정 (내 엘릭서 바를 읽고 있을 때)
  let side = ev.side, mineRef = null;
  if (myTrackingOn()){
    const r = resolveSide(ev, myEventsForSide(ev.t).filter(m=>!(cur && m._p === cur.p)));
    side = r.side; if (r.mine) mineRef = r.mine._p;
  } else if (ev.side === 'bottom' && !S.settings.autoMine) side = 'none';
  if (side === 'none'){ if (cur){ cur.arr.splice(cur.arr.indexOf(cur.p), 1); render(); } return; }
  if (side === 'bottom'){
    // 내 카드: 위치·썸네일만 붙임 (카드 이름은 손패/엘릭서로 이미 앎)
    if (cur && cur.arr === S.plays){ S.plays.splice(S.plays.indexOf(cur.p), 1); cur = null; }
    const m = cur ? cur.p : (mineRef || S.mine.slice().reverse().find(x=>!x.vid && !x.corr && Math.abs(ev.t - x.t) < 1.2));
    if (m){ m.vid = ev.vid; m.vsrc = src; m.x = ev.x; m.y = ev.y; m.lane = laneOf(ev.x); if (thumb) m.thumb = thumb; }
    else if (!myTrackingOn() && S.settings.autoMine){
      const J = judgeMine(ev);
      S.mine.push({t:ev.t, id:J.id, vid:ev.vid, vsrc:src, x:ev.x, y:ev.y, lane:laneOf(ev.x), auto:true, score:J.p, thumb, ref:nextRef('m')});
    }
    render(); return;
  }
  // 상대 카드
  if (cur && cur.arr === S.mine){ delete cur.p.vid; cur = null; }
  const p = cur ? cur.p : {t:ev.t, id:'unknown', ref:nextRef('o'), vid:ev.vid, vsrc:src, auto:true, x:ev.x, y:ev.y, lane:laneOf(ev.x), thumb, src:ev.src};
  const before = p.id;
  const J = judgeOpp(ev, p);
  if (J.noise){ if (cur) S.plays.splice(S.plays.indexOf(p), 1); render(); return; }
  // 상대가 이 시각에 카드를 낼 수가 없는 상황(최대 엘릭서 < 1)인데 확실하지도 않음 → 기록하지 않고 확인 목록으로만
  if (!cur && !J.ok && simulate(S.plays, ev.t, opts()).hi < 1){
    if (last) addPending({ref:nextRef('o'), side:'top', t:ev.t, x:ev.x, y:ev.y, thumb:rgbThumb(ev.rgb), feats:ev.feats, cands:J.R.list.slice(0,4).map(x=>({id:x.id, score:x.p}))});
    return;
  }
  applyOppJudge(p, J);
  p.x = ev.x; p.y = ev.y; p.lane = laneOf(ev.x);
  if (!cur) S.plays.push(p);
  if (p.id !== 'unknown' && p.id !== before) speak('opp:'+p.id, `상대 ${CARDS[p.id].name}`);
  if (last){
    p.feats = ev.feats;
    if (p.id === 'unknown') addPending({ref:p.ref, side:'top', t:ev.t, x:ev.x, y:ev.y, thumb:p.thumb, feats:ev.feats, cands:(p.post||[]).map(x=>({id:x.id, score:x.p}))});
    // 아주 확실하면 스스로 학습 (카드당 15장까지)
    else if (J.top.p >= 0.97 && J.top.tpl && TPL.count(p.id) < 15) learnFeats(p.id, ev.feats, 'a'+p.ref);
  }
  render();
}
function judgeMine(ev){
  const md = myDeck(); const pool = md ? md.c : null;
  const pri = pool ? Object.fromEntries(Object.keys(CARDS).filter(k=>k!=='unknown').map(k=>[k, pool.includes(k) ? 1 : 0.001])) : null;
  const R = identify(ev.cands, pri, {learned:TPL.ids(), calib:TPL.calib()});
  const top = R.list[0];
  return top && top.p >= 0.6 ? {id:top.id, p:top.p} : {id:'unknown', p: top ? top.p : 0};
}
function onMyPlay(ev){
  LIVE.myOn = performance.now();
  let m = S.mine.find(x=>(ev.ref && x.ref === ev.ref) || (!x.fromHand && !x.corr && Math.abs(x.t - ev.t) < 0.45));
  if (m){ m.id = ev.id; m.fromHand = true; m.score = ev.conf; delete m.guess; delete m.cost; if (ev.ref) m.ref = ev.ref; }
  else { m = {t:ev.t, id:ev.id, auto:true, fromHand:true, score:ev.conf, ref: ev.ref || nextRef('h')}; S.mine.push(m); }
  render();
}
function onMyDrop(ev){
  LIVE.myOn = performance.now();
  if (S.mine.some(x=>x.ref === ev.ref || (x.fromHand && Math.abs(x.t - ev.t) < 0.45))) return;
  const g = myCardForCost(ev.cost);
  const p = {t:ev.t, id:g.id, ref:ev.ref, auto:true, score:g.guess?0.5:0.9, fromElixir:true};
  if (g.id === 'unknown') p.cost = ev.cost; if (g.guess) p.guess = g.alts;
  S.mine.push(p); render();
}
function onHand(h){
  S.handLive = h.slots.filter(Boolean).length >= 3 ? {slots:h.slots, next:h.next, at:performance.now()} : S.handLive;
  // 내 덱을 고르지 않았으면 손패에서 본 카드로 덱을 자동으로 모음
  if (!myDeck()) h.slots.forEach(id=>{ if (id && !S.autoDeck.includes(id) && S.autoDeck.length < 8) S.autoDeck.push(id); });
}
S.autoDeck = [];
/* 엘릭서 바: 내 엘릭서(정확한 값) + 경기 자동 시작·끝 + 2배/3배 시점 맞추기 */
function onElixir(e){
  const now = performance.now();
  if (e.present){
    LIVE.barAt = now; LIVE.barSeen++;
    S.myLive = {v:e.value, at:now};
    const autoOn = OVL || S.settings.autoStart;
    if (!S.started && autoOn){
      // 카운트다운 중엔 5에서 멈춰 있음 → 실제로 차오르기 시작할 때 시작 (엘릭서 5 = 0초)
      if (LIVE.firstV == null) LIVE.firstV = e.value;
      if (LIVE.barSeen >= 3 && (e.value - LIVE.firstV > 0.12 || e.value > 5.6)){
        startGame(); S.offset = Math.max(0, Math.min(20, (e.value - 5)*2.8));
        LIVE.regen = []; LIVE.shift2 = LIVE.shift3 = false; LIVE.firstV = null;
        S.autoStarted = true;
      }
    }
    if (S.started) regenSync(e.value, now);
  } else {
    LIVE.barSeen = 0; LIVE.firstV = null;
    if (S.started && S.autoStarted && LIVE.barAt && now - LIVE.barAt > 6000){ endGame(); S.autoStarted = false; LIVE.barAt = 0; if (OVL) ovFinishMatch(); }
  }
}
// 내 엘릭서가 차오르는 속도로 2배·3배 구간 시작을 자동으로 맞춤
//  - 2.5초 이상, 15개 이상의 값으로 선형 회귀 기울기를 구하고, 두 번 연속 같은 결론일 때만 옮김
function regenSync(v, now){
  const hs = LIVE.regen;
  if (v < 9.7 && (!hs.length || v >= hs[hs.length-1].v - 0.15)) hs.push({t:now, v}); else { LIVE.regen = []; LIVE.vote = 0; return; }
  while (hs.length && now - hs[0].t > 4000) hs.shift();
  if (hs.length < 15 || now - hs[0].t < 2500) return;
  let mt = 0, mv = 0; for (const h of hs){ mt += h.t; mv += h.v; } mt /= hs.length; mv /= hs.length;
  let num = 0, den = 0; for (const h of hs){ num += (h.t-mt)*(h.v-mv); den += (h.t-mt)*(h.t-mt); }
  const rate = den ? num/den*1000 : 0, gt = gameTime();
  const want2 = !LIVE.shift2 && rate > 0.6 && rate < 0.9 && gt < 116;
  const want3 = !LIVE.shift3 && rate > 0.95 && gt > 150 && gt < 236 && S.settings.triple;
  LIVE.vote = (want2 || want3) ? (LIVE.vote||0) + 1 : 0;
  if (LIVE.vote >= 2){
    if (want2){ S.offset += 120 - gt; LIVE.shift2 = true; }
    else if (want3){ S.offset += 240 - gt; LIVE.shift3 = true; }
    LIVE.vote = 0; LIVE.regen = [];
  }
  LIVE.rate = rate;
}
function myCardForCost(cost){
  const md = myDeck(), deckIds = md ? md.c : (S.autoDeck.length ? S.autoDeck : null);
  if (!deckIds) return {id:'unknown', guess:false};
  const live = S.handLive && performance.now() - S.handLive.at < 2000 ? S.handLive.slots.filter(Boolean) : null;
  const hand = live && live.length ? live : (md ? myHandOf(md.c, S.mine).hand : deckIds);
  const pool = hand.filter(id=>CARDS[id] && !CARDS[id].tags.includes('mirror') && CARDS[id].cost === cost);
  if (pool.length === 1) return {id:pool[0], guess:false};
  if (pool.length > 1) return {id:pool[0], guess:true, alts:pool};
  const any = deckIds.filter(id=>CARDS[id] && CARDS[id].cost === cost);
  return any.length ? {id:any[0], guess:true, alts:any} : {id:'unknown', guess:false};
}
// 전술판: 화면에서 따라가고 있는 실제 위치
function syncLivePositions(){
  const now = performance.now(), gt = gameTime();
  for (const p of S.plays){
    if (!p.vid || !VISMAP[p.vsrc]) continue;
    const lt = VISMAP[p.vsrc].liveTrack(p.vid, now);
    if (lt) p.live = {x:lt.x, y:lt.y, t: gt - (now - lt.at)/1000};
  }
}

/* ---------- 영역 맞추기 (경기장 · 엘릭서 바 · 내 카드 4장 · 다음 카드) ---------- */
const CAL_STEPS = [
  {key:'arena', label:'경기장', taps:true, msg:'① 위쪽(상대) 왼편 작은 타워 한가운데를 누르고 ② 아래쪽(내) 오른편 작은 타워 한가운데를 누르세요. 노란 네모 6개가 타워 위에, 분홍 띠가 강 위에 오면 정확해요. 다시 누르면 처음부터.', color:'#ffd84d', minH:0.2},
  {key:'bar', label:'엘릭서 바', msg:'화면 맨 아래 분홍색 엘릭서 바(숫자 오른쪽 막대)만 감싸세요. 눈금 10칸이 바의 칸과 맞으면 정확해요.', color:'#ff7bd5', minH:0.005},
  {key:'hand', label:'내 카드 4장', msg:'아래쪽 내 카드 4장을 한 번에 감싸세요. 세로선 3개가 카드 사이 틈에 오면 정확해요.', color:'#6fd3ff', minH:0.03},
  {key:'next', label:'다음 카드', msg:'왼쪽 아래 작은 \'다음\' 카드만 감싸세요. 없으면 [건너뛰기].', color:'#8dff7a', minH:0.02, optional:true},
];
const CAL_DEFAULT = {arena:{x:0.177, y:0.10, w:0.645, h:0.66}, bar:{x:0.27, y:0.948, w:0.70, h:0.022}};
function calDefault(key, rects){
  if (CAL_DEFAULT[key]) return Object.assign({}, CAL_DEFAULT[key]);
  const b = (rects && rects.bar) || CAL_DEFAULT.bar;
  if (key === 'hand') return {x:Math.max(0, b.x - 0.02), y:Math.max(0, b.y - 0.118), w:Math.min(1 - b.x + 0.02, b.w + 0.03), h:0.10};
  if (key === 'next') return {x:0.035, y:Math.max(0, b.y - 0.085), w:0.13, h:0.075};
  return null;
}
function drawCalGuides(ctx, key, rc, W, H, active){
  const x = rc.x*W, y = rc.y*H, w = rc.w*W, h = rc.h*H, st = CAL_STEPS.find(s=>s.key===key);
  ctx.save();
  if (!active){ ctx.setLineDash([5,4]); ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, w, h); ctx.restore(); return; }
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, W, y); ctx.fillRect(0, y+h, W, H-y-h); ctx.fillRect(0, y, x, h); ctx.fillRect(x+w, y, W-x-w, h);
  ctx.strokeStyle = st.color; ctx.lineWidth = 2.5; ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([6,4]); ctx.lineWidth = 1.5;
  if (key === 'arena'){
    // 강(15~17칸) 띠 + 타워 6개 위치
    ctx.setLineDash([]); ctx.fillStyle = 'rgba(255,138,241,.22)'; ctx.fillRect(x, y+h*15/32, w, h*2/32);
    ctx.strokeStyle = '#ff8af1'; ctx.lineWidth = 1.5; [15/32, 17/32].forEach(f=>{ ctx.beginPath(); ctx.moveTo(x, y+h*f); ctx.lineTo(x+w, y+h*f); ctx.stroke(); });
    ctx.strokeStyle = '#ffd84d'; ctx.lineWidth = 2;
    [[2,5,5,8],[13,5,16,8],[2,24,5,27],[13,24,16,27],[7,1,11,5],[7,27,11,31]].forEach(([a,b,c,d])=>ctx.strokeRect(x+w*a/18, y+h*b/32, w*(c-a)/18, h*(d-b)/32));
  } else if (key === 'bar'){
    ctx.setLineDash([]); ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1;
    for (let i=1;i<10;i++){ ctx.beginPath(); ctx.moveTo(x+w*i/10, y); ctx.lineTo(x+w*i/10, y+h); ctx.stroke(); }
  } else if (key === 'hand'){
    ctx.strokeStyle = st.color; for (let i=1;i<4;i++){ ctx.beginPath(); ctx.moveTo(x+w*i/4, y); ctx.lineTo(x+w*i/4, y+h); ctx.stroke(); }
  }
  ctx.restore();
}
/* 단계별 영역 맞추기: canvas 위에서 드래그. ui = {msg, title, prev, next, reset, cancel} 요소 */
/* 두 타워를 눌러 경기장 계산: 상대 왼쪽 공주 타워 = (3.5, 6.5)칸, 내 오른쪽 공주 타워 = (14.5, 25.5)칸
   → 가로 11칸, 세로 19칸 차이로 칸 크기를 구하고 18x32 경기장 전체를 정함. 그 뒤 화면에서 강을 찾아 위아래 위치를 보정 */
function arenaFromTaps(a, b){
  const tw = (b.x - a.x)/11, th = (b.y - a.y)/19;
  if (tw <= 0.005 || th <= 0.005) return null;
  return {x: a.x - 3.5*tw, y: a.y - 6.5*th, w: 18*tw, h: 32*th};
}
function refineArenaByRiver(rc, src){
  try{
    const vw = src && (src.videoWidth || src.naturalWidth || src.width), vh = src && (src.videoHeight || src.naturalHeight || src.height);
    if (!vw || !vh) return rc;
    const th = rc.h/32, y0 = Math.max(0, rc.y + th*11), y1 = Math.min(1, rc.y + th*21), W = 120, H = 80;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', {willReadFrequently:true});
    x.drawImage(src, (rc.x + rc.w*0.08)*vw, y0*vh, rc.w*0.84*vw, (y1-y0)*vh, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H).data, row = [];
    for (let yy=0; yy<H; yy++){ let n = 0; for (let xx=0; xx<W; xx++){ const k=(yy*W+xx)*4, r=d[k], g=d[k+1], bb=d[k+2]; if (bb > 120 && bb > r + 35 && g > r) n++; } row.push(n/W); }
    // 강은 두께가 있으니 3줄 평균이 가장 큰 곳
    let best = -1, bv = 0; for (let yy=1; yy<H-1; yy++){ const v = (row[yy-1]+row[yy]+row[yy+1])/3; if (v > bv){ bv = v; best = yy; } }
    if (best < 0 || bv < 0.25) return rc;
    let top = best, bot = best; while (top > 0 && row[top-1] > bv*0.5) top--; while (bot < H-1 && row[bot+1] > bv*0.5) bot++;
    const riverC = y0 + ((top + bot + 1)/2)/H*(y1 - y0);
    return Object.assign({}, rc, {y: riverC - rc.h*16/32, river: true});
  }catch(e){ return rc; }
}
function CalibFlow(o){
  let on = false, step = 0, tmp = null, drag = null, taps = [];
  const ui = o.ui, CAL_STEPS_ = o.steps || CAL_STEPS;
  const toN = e=>{ const r = o.canvas.getBoundingClientRect(); return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)), y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))}; };
  o.canvas.addEventListener('pointerdown', e=>{ if (!on) return; e.preventDefault();
    const st = CAL_STEPS_[step];
    if (st.taps){
      if (taps.length >= 2) taps = [];
      taps.push(toN(e));
      if (taps.length === 2){
        const rc = arenaFromTaps(taps[0], taps[1]);
        if (!rc){ toast('위쪽 왼편 타워 → 아래쪽 오른편 타워 순서로 눌러주세요'); taps = []; return; }
        const rf = refineArenaByRiver(rc, o.frame && o.frame());
        tmp.arena = {x:rf.x, y:rf.y, w:rf.w, h:rf.h};
        toast(rf.river ? '강 위치로 자동 보정했어요. 노란 네모가 타워에 맞는지 확인하세요' : '노란 네모가 타워에, 분홍 띠가 강에 맞는지 확인하세요');
      } else ui.msg.textContent = '② 이제 아래쪽(내) 오른편 작은 타워 한가운데를 누르세요.';
      return;
    }
    drag = {a:toN(e), b:toN(e)}; o.canvas.setPointerCapture(e.pointerId); });
  o.canvas.addEventListener('pointermove', e=>{ if (drag) drag.b = toN(e); });
  o.canvas.addEventListener('pointerup', ()=>{ if (!drag) return; const rc = {x:Math.min(drag.a.x,drag.b.x), y:Math.min(drag.a.y,drag.b.y), w:Math.abs(drag.a.x-drag.b.x), h:Math.abs(drag.a.y-drag.b.y)}; drag = null;
    const st = CAL_STEPS_[step]; if (rc.w > 0.04 && rc.h > st.minH) tmp[st.key] = rc; else toast('영역이 너무 작아요'); });
  function sync(){
    const st = CAL_STEPS_[step];
    ui.title.textContent = `${step+1}/${CAL_STEPS_.length} ${st.label}`; ui.msg.textContent = st.msg;
    ui.prev.style.visibility = step ? 'visible' : 'hidden';
    ui.next.textContent = step === CAL_STEPS_.length-1 ? '완료' : (st.optional && !tmp[st.key] ? '건너뛰기' : '다음');
  }
  ui.prev.onclick = ()=>{ if (step > 0){ step--; taps = []; sync(); } };
  ui.next.onclick = ()=>{ if (step < CAL_STEPS_.length-1){ if (!tmp[CAL_STEPS_[step].key] && !CAL_STEPS_[step].optional) tmp[CAL_STEPS_[step].key] = calDefault(CAL_STEPS_[step].key, tmp); step++; if (!tmp[CAL_STEPS_[step].key] && !CAL_STEPS_[step].optional) tmp[CAL_STEPS_[step].key] = calDefault(CAL_STEPS_[step].key, tmp); sync(); return; } on = false; o.save(tmp); o.end && o.end(true); };
  ui.reset.onclick = ()=>{ const k = CAL_STEPS_[step].key; tmp[k] = calDefault(k, tmp); taps = []; };
  ui.cancel.onclick = ()=>{ on = false; o.end && o.end(false); };
  return {
    start(){ on = true; step = 0; taps = []; tmp = Object.assign({}, o.rects()); if (!tmp.arena) tmp.arena = calDefault('arena'); sync(); },
    get on(){ return on; },
    draw(ctx, W, H){
      if (!on) return;
      const cur = CAL_STEPS_[step].key;
      for (const st of CAL_STEPS_){ if (st.key === cur) continue; if (tmp[st.key]) drawCalGuides(ctx, st.key, tmp[st.key], W, H, false); }
      const rc = drag ? {x:Math.min(drag.a.x,drag.b.x), y:Math.min(drag.a.y,drag.b.y), w:Math.abs(drag.a.x-drag.b.x), h:Math.abs(drag.a.y-drag.b.y)} : tmp[cur];
      if (rc && !(CAL_STEPS_[step].taps && taps.length === 1)) drawCalGuides(ctx, cur, rc, W, H, true);
      if (CAL_STEPS_[step].taps) taps.forEach((t,i)=>{ ctx.save(); ctx.strokeStyle = '#ffd84d'; ctx.fillStyle = 'rgba(255,216,77,.35)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(t.x*W, t.y*H, 9, 0, Math.PI*2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = '900 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i+1), t.x*W, t.y*H); ctx.restore(); });
    },
  };
}

/* ---------- PC: 미러링 창 캡처 ---------- */
const video = document.createElement('video'); video.muted = true; video.playsInline = true;
let stream = null;
S.calib2 = store.get('crc_calib2', {});
async function getScreen(preferTab){
  if (window.crNative && window.crNative.pickSource) await window.crNative.pickSource();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw new Error('nosupport');
  return navigator.mediaDevices.getDisplayMedia({video:{frameRate:30}, audio:false, preferCurrentTab: !!preferTab});
}
const pcRects = ()=>({arena:S.calib, bar:S.calib2.bar || null, hand:S.calib2.hand || null, next:S.calib2.next || null});
const pcVis = newVision('pc', makeGrabber(()=>stream ? video : null), {arenaActive:()=>S.started && visionOK()});
const calBar = document.createElement('div'); calBar.className = 'calBar'; calBar.style.display = 'none';
calBar.innerHTML = '<div class="calTop"><b class="calT"></b><span class="calM"></span></div><div class="row"><button class="btn sm calR">기본값</button><button class="btn sm calC">취소</button><span style="flex:1"></span><button class="btn sm calP">이전</button><button class="btn sm green calN">다음</button></div>';
$('previewBox').after(calBar);
const pcCal = CalibFlow({canvas:$('preview'), rects:pcRects, frame:()=>stream ? video : null,
  ui:{title:calBar.querySelector('.calT'), msg:calBar.querySelector('.calM'), prev:calBar.querySelector('.calP'), next:calBar.querySelector('.calN'), reset:calBar.querySelector('.calR'), cancel:calBar.querySelector('.calC')},
  save:r=>{ S.calib = r.arena; S.calib2 = {bar:r.bar, hand:r.hand, next:r.next}; store.set('crc_calib', S.calib); store.set('crc_calib2', S.calib2); toast('영역 저장 완료'); },
  end:()=>{ calBar.style.display = 'none'; $('btnCalib').classList.remove('on'); }});
function startPcCal(){ calBar.style.display = 'block'; $('btnCalib').classList.add('on'); pcCal.start(); }
(function previewLoop(){
  const cv = $('preview'), ctx = cv.getContext('2d');
  if (stream && video.videoWidth){
    const vw = video.videoWidth, vh = video.videoHeight, maxW = $('previewBox').clientWidth || 320, maxH = 560, sc = Math.min(maxW/vw, maxH/vh), cw = Math.round(vw*sc), ch = Math.round(vh*sc);
    if (cv.width !== cw || cv.height !== ch){ cv.width = cw; cv.height = ch; }
    ctx.drawImage(video, 0, 0, cw, ch);
    if (pcCal.on) pcCal.draw(ctx, cw, ch);
    else if (S.calib){
      const r = S.calib, now = performance.now();
      ctx.strokeStyle = 'rgba(255,216,77,.8)'; ctx.lineWidth = 1.5; ctx.strokeRect(r.x*cw, r.y*ch, r.w*cw, r.h*ch);
      ['bar','hand','next'].forEach(k=>{ const q = S.calib2[k]; if (q){ ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.strokeRect(q.x*cw, q.y*ch, q.w*cw, q.h*ch); } });
      // 감지 표시: 최근 배치 위치
      for (const p of S.plays.concat(S.mine)){ if (!p.vid || gameTime() - p.t > 1.6) continue;
        const a = 1 - (gameTime() - p.t)/1.6; ctx.strokeStyle = S.plays.includes(p) ? `rgba(255,90,90,${a})` : `rgba(90,170,255,${a})`; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc((r.x + p.x/18*r.w)*cw, (r.y + p.y/32*r.h)*ch, Math.max(10, cw*0.05), 0, Math.PI*2); ctx.stroke(); }
    }
  }
  requestAnimationFrame(previewLoop);
})();
// 프레임마다 처리 (영상 프레임 콜백이 있으면 새 프레임이 올 때만)
function pcProcess(){
  if (!stream || pcCal.on || !S.calib) return;
  pcVis.setCalib(pcRects());
  pcVis.process(gameTime(), performance.now());
}
if ('requestVideoFrameCallback' in HTMLVideoElement.prototype){
  let lastAt = 0;
  const onVF = (now)=>{ if (now - lastAt >= 66){ lastAt = now; pcProcess(); } if (stream) video.requestVideoFrameCallback(onVF); };
  video.addEventListener('playing', ()=> video.requestVideoFrameCallback(onVF));
} else setInterval(pcProcess, 80);
$('btnCapture').onclick = async ()=>{
  if (stream){ stream.getTracks().forEach(t=>t.stop()); stream = null; capOff(); return; }
  try{
    stream = await getScreen(false); video.srcObject = stream; await video.play();
    stream.getVideoTracks()[0].addEventListener('ended', ()=>{ stream = null; capOff(); });
    $('btnCapture').textContent = '연결 해제'; $('btnCapture').classList.replace('green','red'); $('previewHint').style.display = 'none'; $('preview').style.display = 'block';
    if (!S.calib) startPcCal();
    $('capStatus').textContent = '연결됨';
  }catch(e){ toast(e.message === 'nosupport' ? '이 환경은 화면 공유를 지원하지 않아요. PC 앱이나 PC의 Chrome/Edge를 쓰세요.' : '화면 연결이 취소됐어요'); stream = null; }
};
function capOff(){ $('btnCapture').textContent = '화면 연결'; $('btnCapture').classList.replace('red','green'); $('preview').style.display = 'none'; $('previewHint').style.display = 'block'; $('capStatus').textContent = ''; calBar.style.display = 'none'; }
$('btnCalib').onclick = ()=>{ if (!stream){ toast('먼저 화면을 연결해주세요'); return; } if (pcCal.on) calBar.querySelector('.calC').click(); else startPcCal(); };

/* ---------- 확인이 필요한 장면 (경기 후 골라주면 학습) ---------- */
function addPending(pd){
  if (S.pending.some(x=>x.ref === pd.ref)) return;
  S.pending.unshift(pd); if (S.pending.length > 16) S.pending.length = 16; renderPending();
}
function renderPending(){
  const el = $('pending'); el.innerHTML = '';
  if (!S.pending.length){ el.innerHTML = '<div class="muted">자동으로 확신하지 못한 장면이 여기 쌓여요. 카드를 골라주면 학습해서 다음부터 바로 알아봐요.</div>'; return; }
  const deck = analyzeDeck(S.plays), inf = inferDecks(deck.known), md = myDeck();
  S.pending.forEach((pd, idx)=>{
    const box = document.createElement('div'); box.className = 'pend';
    box.innerHTML = `<img src="${pd.thumb||''}" alt=""><span class="side ${pd.side==='top'?'opp':'me'}">${pd.side==='top'?'상대':'나'}</span>`;
    const btns = document.createElement('div'); btns.className = 'btns'; const ids = [];
    (pd.cands||[]).forEach(c=>{ if (c.id !== '__ignore' && !ids.includes(c.id)) ids.push(c.id); });
    (pd.side==='top' ? deck.known.concat(inf.predicted.slice(0,3).map(p=>p.id)) : (md?md.c:[])).forEach(id=>{ if (!ids.includes(id)) ids.push(id); });
    ids.slice(0,8).forEach(id=>{ const c = CARDS[id]; if (!c) return; const sc = (pd.cands||[]).find(x=>x.id===id); const b = document.createElement('button'); b.className = 'btn sm'; b.innerHTML = esc(c.name) + (sc && sc.score >= 0.05 ? ` <small>${Math.round(sc.score*100)}%</small>` : ''); b.onclick = ()=>resolveP(idx, id); btns.appendChild(b); });
    const sel = document.createElement('select'); sel.className = 'field sm';
    sel.innerHTML = '<option value="">다른 카드…</option>' + Object.values(CARDS).filter(c=>c.id!=='unknown').sort((a,b)=>a.name.localeCompare(b.name,'ko')).map(c=>`<option value="${c.id}">${esc(c.name)} (${c.cost})</option>`).join('');
    sel.onchange = ()=>{ if (sel.value) resolveP(idx, sel.value); }; btns.appendChild(sel);
    const ig = document.createElement('button'); ig.className = 'btn sm red'; ig.textContent = '카드 아님';
    ig.onclick = ()=>{ learnFeats('__ignore', pd.feats, 'i'+pd.ref); const arr = pd.side==='top' ? S.plays : S.mine, i = arr.findIndex(p=>p.ref===pd.ref); if (i >= 0) arr.splice(i, 1); S.pending.splice(idx, 1); renderPending(); render(); };
    btns.appendChild(ig);
    box.appendChild(btns); el.appendChild(box);
  });
}
function resolveP(idx, id){
  const pd = S.pending[idx]; if (!pd) return;
  learnFeats(id, pd.feats, 'u'+pd.ref);
  const arr = pd.side==='top' ? S.plays : S.mine, ex = pd.ref ? arr.find(p=>p.ref===pd.ref) : null;
  if (ex){ ex.id = id; delete ex.cost; delete ex.costLo; delete ex.costHi; delete ex.guess; ex.score = 1; }
  else if (S.started) arr.push({t:pd.t, id, thumb:pd.thumb, x:pd.x, y:pd.y, lane:laneOf(pd.x), ref:pd.ref});
  S.pending.splice(idx, 1); renderPending(); render(); toast(`${CARDS[id].name} 기록 + 학습`);
}

/* ---------- 영상 학습 ---------- */
const vvideo = $('vVideo'); let vstream = null, vsrc = 'none', vAnalyze = false, vMatch = 'm'+Date.now();
const capVideo = document.createElement('video'); capVideo.muted=true; capVideo.playsInline=true;
const vSource = ()=> vsrc==='file' ? vvideo : vsrc==='cap' ? capVideo : null;
const vTime = ()=> vsrc==='file' ? vvideo.currentTime : (performance.now()/1000);
const vVis = newVision('video', makeGrabber(vSource), {arenaActive:()=>vAnalyze && (vsrc!=='file' || !vvideo.paused)});
const vCalBar = document.createElement('div'); vCalBar.className = 'calBar'; vCalBar.style.display = 'none';
vCalBar.innerHTML = calBar.innerHTML; $('vPreviewBox').after(vCalBar);
const vcal = CalibFlow({canvas:$('vPreview'), steps:[CAL_STEPS[0]], rects:()=>({arena:S.vcalib}), frame:vSource,
  ui:{title:vCalBar.querySelector('.calT'), msg:vCalBar.querySelector('.calM'), prev:vCalBar.querySelector('.calP'), next:vCalBar.querySelector('.calN'), reset:vCalBar.querySelector('.calR'), cancel:vCalBar.querySelector('.calC')},
  save:r=>{ S.vcalib = r.arena; store.set('crc_vcalib', S.vcalib); toast('경기장 영역 저장 완료'); },
  end:()=>{ vCalBar.style.display = 'none'; }});
vcal.toggle = ()=>{ vCalBar.style.display = 'block'; vcal.start(); };
let vLastMs = 0;
setInterval(()=>{
  const src = vSource(); if (!vAnalyze || !src || !S.vcalib || vcal.on) return;
  const ms = vsrc === 'file' ? vvideo.currentTime*1000 : performance.now();
  if (ms < vLastMs - 500) vVis.reset(); vLastMs = ms;
  vVis.setCalib({arena:S.vcalib}); vVis.process(vTime(), ms);
}, 83);
(function vPreviewLoop(){
  const cv = $('vPreview'), ctx = cv.getContext('2d'), v = vSource();
  if (v && v.videoWidth){
    const vw = v.videoWidth, vh = v.videoHeight, maxW = $('vPreviewBox').clientWidth || 320, sc = Math.min(maxW/vw, 520/vh), cw = Math.round(vw*sc), ch = Math.round(vh*sc);
    if (cv.width !== cw || cv.height !== ch){ cv.width = cw; cv.height = ch; }
    ctx.drawImage(v, 0, 0, cw, ch);
    if (vcal.on) vcal.draw(ctx, cw, ch);
    else if (S.vcalib){ const r = S.vcalib; ctx.strokeStyle = 'rgba(255,216,77,.8)'; ctx.lineWidth = 1.5; ctx.strokeRect(r.x*cw, r.y*ch, r.w*cw, r.h*ch);
      for (const f of vFlash.filter(f=>performance.now() - f.at < 1200)){ ctx.strokeStyle = f.y < 16 ? '#ff6b6b' : '#6cc3ff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc((r.x + f.x/18*r.w)*cw, (r.y + f.y/32*r.h)*ch, Math.max(10, cw*0.05), 0, Math.PI*2); ctx.stroke(); } }
  }
  requestAnimationFrame(vPreviewLoop);
})();
const vFlash = [];
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
  if (vstream){ vstream.getTracks().forEach(t=>t.stop()); vstream=null; vsrc='none'; $('vCapBtn').textContent='이 탭 화면 공유'; return; }
  try{ vstream = await getScreen(true); capVideo.srcObject=vstream; await capVideo.play(); vsrc='cap'; $('vPreview').style.display='block'; $('vCapBtn').textContent='공유 중지'; if (!S.vcalib) vcal.toggle();
    vstream.getVideoTracks()[0].addEventListener('ended', ()=>{ vstream=null; vsrc='none'; $('vCapBtn').textContent='이 탭 화면 공유'; });
  }catch(e){ toast('화면 공유가 취소됐거나 지원되지 않아요'); }
};
$('vCalib').onclick = ()=>{ if (!vSource()){ toast('먼저 영상을 열거나 화면을 공유하세요'); return; } vcal.toggle(); };
$('vRun').onclick = ()=>{ vAnalyze=!vAnalyze; $('vRun').textContent = vAnalyze?'분석 중지':'자동 분석 시작'; $('vRun').classList.toggle('red', vAnalyze); if (vAnalyze && vsrc==='file') vvideo.play(); };
let vPending = [];
function onVideoEvent(ev){
  if (ev.stage === 0) vFlash.push({x:ev.x, y:ev.y, at:performance.now()}), vFlash.length > 20 && vFlash.shift();
  if (ev.stage !== 2) return;
  const R = identify(ev.cands, null, {learned:TPL.ids(), calib:TPL.calib()}), top = R.list[0];
  if (R.best && R.best.id === '__ignore' && R.best.p >= 0.7) return;
  const side = ev.side === 'top' ? 'opp' : 'me';
  if (top && top.tpl && top.p >= Math.max(0.6, S.settings.thresh/100)){ addVEvent({t:ev.t, side, id:top.id, x:ev.x, y:ev.y, auto:true}); return; }
  vPending.unshift({t:ev.t, side:ev.side, x:ev.x, y:ev.y, thumb:rgbThumb(ev.rgb), feats:ev.feats, ref:'vv'+ev.vid+'_'+Date.now(), cands:R.list.filter(c=>c.tpl).slice(0,4).map(c=>({id:c.id, score:c.p}))});
  if (vPending.length > 8) vPending.length = 8; renderVPending();
}
function addVEvent(e){ e.match = vMatch; S.vlog.push(e); if (S.vlog.length > 5000) S.vlog.splice(0, S.vlog.length-5000); store.set('crc_vlog', S.vlog); PATTERNS = learnPatterns(S.vlog); renderVLearn(); }
function renderVPending(){
  const el=$('vPending'); el.innerHTML='';
  if (!vPending.length){ el.innerHTML='<div class="muted">자동 분석 중 감지된 장면이 여기 나와요. 카드를 고르면 학습 데이터에 쌓여요.</div>'; return; }
  vPending.forEach((pd,idx)=>{
    const box=document.createElement('div'); box.className='pend'; box.innerHTML=`<img src="${pd.thumb}"><span class="chip" style="background:${pd.side==='top'?'#d33030':'#2775e0'};align-self:flex-start">${pd.side==='top'?'상대':'선수'}</span>`;
    const btns=document.createElement('div'); btns.className='btns';
    (pd.cands||[]).filter(c=>c.id!=='__ignore' && CARDS[c.id]).slice(0,4).forEach(c=>{ const b=document.createElement('button'); b.className='btn sm'; b.innerHTML=`${esc(CARDS[c.id].name)} <small>${Math.round(c.score*100)}%</small>`; b.onclick=()=>vResolve(idx,c.id); btns.appendChild(b); });
    const sel=document.createElement('select'); sel.className='field'; sel.style.fontSize='12px';
    sel.innerHTML='<option value="">카드 선택…</option>'+Object.values(CARDS).filter(c=>c.id!=='unknown').sort((a,b)=>a.name.localeCompare(b.name,'ko')).map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
    sel.onchange=()=>{ if (sel.value) vResolve(idx, sel.value); }; btns.appendChild(sel);
    const ig=document.createElement('button'); ig.className='btn sm red'; ig.textContent='카드 아님'; ig.onclick=()=>{ learnFeats('__ignore', pd.feats, 'i'+pd.ref); vPending.splice(idx,1); renderVPending(); }; btns.appendChild(ig);
    box.appendChild(btns); el.appendChild(box);
  });
}
function vResolve(idx,id){ const pd=vPending[idx]; if(!pd) return; learnFeats(id, pd.feats, 'u'+pd.ref); addVEvent({t:pd.t, side:pd.side==='top'?'opp':'me', id, x:pd.x, y:pd.y}); vPending.splice(idx,1); renderVPending(); }
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
function importTemplates(arr){ const tmp = VISION.TemplateStore(); tmp.load(arr, legacyTpl); for (const t of tmp.list) TPL.add(t.id, t.f, t.ff, t.g); saveTemplates(); }
$('vExport').onclick = ()=>{ const blob=new Blob([JSON.stringify({vlog:S.vlog, templates:TPL.serialize()})],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='cr-coach-학습데이터.json'; a.click(); };
$('vImport').onchange = async e=>{ const f=e.target.files[0]; if(!f) return; try{ const j=JSON.parse(await f.text()); (j.vlog||[]).forEach(x=>S.vlog.push(x)); store.set('crc_vlog',S.vlog); importTemplates(j.templates||[]); PATTERNS=learnPatterns(S.vlog); renderVLearn(); toast('학습 데이터를 합쳤어요'); }catch(err){ toast('파일을 읽지 못했어요'); } };
$('vClear').onclick = ()=>{ if (confirm('영상에서 학습한 플레이 기록을 모두 지울까요?')){ S.vlog=[]; store.set('crc_vlog',[]); PATTERNS={}; renderVLearn(); } };
renderVPending(); renderVLearn();

/* ================= 휴대폰 실시간 코치 =================
   본 앱: [📱 휴대폰 실시간 코치 시작] → 화면 녹화 허락 → 게임 위에 코치 창이 뜸
   코치 창(#overlay): 네이티브가 보내는 화면 프레임(캡처 시각 포함)을 인식 엔진에 넣음
   - 상대 배치 감지 → 상대 엘릭서·덱·사이클 / 내 엘릭서 바·손패 → 내 엘릭서(정확값)·내가 낸 카드
   - 엘릭서 바가 차오르기 시작하면 경기 시작, 6초 이상 안 보이면 종료 → 기록을 본 앱으로 넘김
   - 코치 창 자체는 캡처에서 검게 나오므로 그 영역은 인식에서 뺌 */
S.pcalib = store.get('crc_pcalib', null) || Object.assign({}, CAL_DEFAULT.arena);
S.ecalib = store.get('crc_ecalib', null) || Object.assign({}, CAL_DEFAULT.bar);
S.hcalib = store.get('crc_hcalib', {});
const frameCv = document.createElement('canvas'); frameCv.width = 400; frameCv.height = 866;
const frameCtx = frameCv.getContext('2d', {willReadFrequently:true});
let frameReady = false, lastFrameUrl = null, ovMask = null;
const ovRects = ()=>({arena:S.pcalib, bar:S.ecalib, hand:S.hcalib.hand || calDefault('hand', {bar:S.ecalib}), next:S.hcalib.next || null});
const ovVis = OVL ? newVision('ov', makeGrabber(()=>frameReady ? frameCv : null), {arenaActive:()=>S.started && !OV.calibOn && visionOK(), mask:()=>ovMask}) : null;
const gameTimeAt = ms=> S.started ? Math.max(0, (ms - S.startAt)/1000 + S.offset) : 0;
const OVSTAT = {frames:0, lastAt:0, fps:0, lagMs:0};
window.__crFrame = (url, w, h, age, mx, my, mw, mh)=>{
  const recv = performance.now(), im = new Image();
  im.onload = ()=>{
    if (frameCv.width !== w || frameCv.height !== h){ frameCv.width = w; frameCv.height = h; }
    frameCtx.drawImage(im, 0, 0, w, h); frameReady = true; lastFrameUrl = url;
    ovMask = mw > 0 ? {x:mx, y:my, w:mw, h:mh} : null;
    const now = performance.now(), lag = (+age || 0) + (now - recv), at = now - lag;
    OVSTAT.frames++; OVSTAT.fps = OVSTAT.lastAt ? OVSTAT.fps*0.9 + 100/(now - OVSTAT.lastAt) : 0; OVSTAT.lastAt = now; OVSTAT.lagMs = OVSTAT.lagMs*0.9 + lag*0.1;
    if (OV.calibOn || !ovVis) return;
    ovVis.setCalib(ovRects());
    ovVis.process(gameTimeAt(at), at);
  };
  im.src = url;
};
function ovFinishMatch(){
  const slim = a => a.map(p=>{ const q = Object.assign({}, p); delete q.feats; delete q.live; delete q.post; return q; });
  const result = {at:Date.now(), plays:slim(S.plays), mine:slim(S.mine), endedAt:S.endedAt,
    pending: S.pending.map(p=>({t:p.t, side:p.side, x:p.x, y:p.y, thumb:p.thumb, ref:p.ref, cands:p.cands, feats:(p.feats||[]).map(f=>TPL.packFeat(f))}))};
  store.set('crc_ovresult', result);
  try{ if (window.CRNative) CRNative.saveShared(JSON.stringify(result)); }catch(e){}
  speak('end', S.pending.length ? `경기 종료. 확인할 장면 ${S.pending.length}개는 앱에서 골라주세요` : '경기 종료');
}

/* ---- 코치 창 화면 ---- */
const ICON = {
  vol:'<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path class="w" d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>',
  mute:'<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path class="w" d="M17 9l5 6M22 9l-5 6"/></svg>',
  more:'<svg viewBox="0 0 24 24"><path class="w" d="M6 9l6 6 6-6"/></svg>',
  less:'<svg viewBox="0 0 24 24"><path class="w" d="M6 15l6-6 6 6"/></svg>',
  cal:'<svg viewBox="0 0 24 24"><path class="w" d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><circle cx="12" cy="12" r="2.5"/></svg>',
  min:'<svg viewBox="0 0 24 24"><path class="w" d="M6 12h12"/></svg>',
  x:'<svg viewBox="0 0 24 24"><path class="w" d="M7 7l10 10M17 7L7 17"/></svg>',
};
function ovSetMode(m){ OV.mode = m; document.body.dataset.ov = m; try{ if (window.CRNative) CRNative.setMode(m); }catch(e){} }
function buildOverlay(){
  const root = document.createElement('div'); root.id = 'ovRoot';
  root.innerHTML = `
  <div id="ovBubble"><svg class="ring" viewBox="0 0 64 64"><circle cx="32" cy="32" r="27" class="bg"/><circle cx="32" cy="32" r="27" class="fg" id="ovBRing"/></svg><b id="ovBE">5</b><small>상대</small></div>
  <div id="ovPanel">
    <div class="ovBar" id="ovDrag"><span class="dot" id="ovDot"></span><b class="tm" id="ovTime">대기</b><span class="ph" id="ovPhase"></span><span class="sp"></span>
      <button id="ovVoice" title="음성"></button><button id="ovMore" title="자세히">${ICON.more}</button><button id="ovCal" title="영역 맞추기">${ICON.cal}</button><button id="ovMin" title="접기">${ICON.min}</button><button id="ovX" title="끄기">${ICON.x}</button></div>
    <div class="ovE">
      <div class="erow opp"><div class="drop"><b id="ovOE">5.0</b></div><div class="emeta"><div class="elab"><span>상대</span><em id="ovORange"></em></div><div class="ebar" id="ovOBar"></div></div></div>
      <div class="erow me"><div class="drop"><b id="ovME">5.0</b></div><div class="emeta"><div class="elab"><span>나</span><em id="ovDE"></em></div><div class="ebar" id="ovMBar"></div></div></div>
    </div>
    <div class="ovDeck" id="ovDeck"></div>
    <div id="ovRec" class="ovRec">게임을 시작하면 자동으로 따라가요</div>
    <div id="ovMoreBox" class="ovMore"></div>
  </div>
  <div id="ovCalib">
    <canvas id="ovCalCv"></canvas>
    <div class="ovCalBar"><div class="calTop"><b id="ovCalT"></b><span id="ovCalMsg"></span></div>
      <div class="row"><button class="btn sm" id="ovCalReset">기본값</button><button class="btn sm" id="ovCalCancel">취소</button><span class="sp"></span><button class="btn sm" id="ovCalPrev">이전</button><button class="btn sm green" id="ovCalNext">다음</button></div></div>
  </div>`;
  document.body.appendChild(root);
  // 엘릭서 칸 10개
  ['ovOBar','ovMBar'].forEach(id=>{ const el = $(id); for (let i=0;i<10;i++){ const s = document.createElement('i'); s.innerHTML = '<u></u>'; el.appendChild(s); } const r = document.createElement('span'); r.className = 'rng'; el.appendChild(r); });
  ovSetMode('panel');
  // 끌어서 옮기기
  const dragEl = $('ovDrag'), bub = $('ovBubble');
  function makeDrag(el, onTap){
    let st = null, moved = 0, raf = 0, pend = {x:0, y:0};
    el.addEventListener('pointerdown', e=>{ if (e.target.closest('button')) return; st = {x:e.clientX, y:e.clientY}; moved = 0; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', e=>{ if (!st) return; const dx = e.clientX-st.x, dy = e.clientY-st.y; moved += Math.abs(dx)+Math.abs(dy);
      pend = {x:dx*devicePixelRatio, y:dy*devicePixelRatio};
      if (!raf) raf = requestAnimationFrame(()=>{ raf = 0; try{ if (window.CRNative) CRNative.moveBy(pend.x, pend.y); }catch(err){} }); });
    el.addEventListener('pointerup', ()=>{ if (st && moved < 8 && onTap) onTap(); st = null; });
  }
  makeDrag(dragEl, null); makeDrag(bub, ()=>ovSetMode(OV.more ? 'tall' : 'panel'));
  $('ovMin').onclick = ()=> ovSetMode('bubble');
  $('ovX').onclick = ()=>{ if (S.started){ endGame(); ovFinishMatch(); } try{ CRNative.close(); }catch(e){} };
  $('ovMore').onclick = ()=>{ OV.more = !OV.more; ovSetMode(OV.more ? 'tall' : 'panel'); $('ovMore').innerHTML = OV.more ? ICON.less : ICON.more; };
  const vb = $('ovVoice'); const setV = ()=> vb.innerHTML = store.get('crc_ovvoice', true) ? ICON.vol : ICON.mute; setV();
  vb.onclick = ()=>{ store.set('crc_ovvoice', !store.get('crc_ovvoice', true)); setV(); };
  // 영역 맞추기 (경기장 → 엘릭서 바 → 내 카드 4장 → 다음 카드)
  const cv = $('ovCalCv'), cx = cv.getContext('2d'), bg = new Image();
  const flow = CalibFlow({canvas:cv, frame:()=>frameReady ? frameCv : null, rects:()=>({arena:S.pcalib, bar:S.ecalib, hand:S.hcalib.hand || null, next:S.hcalib.next || null}),
    ui:{title:$('ovCalT'), msg:$('ovCalMsg'), prev:$('ovCalPrev'), next:$('ovCalNext'), reset:$('ovCalReset'), cancel:$('ovCalCancel')},
    save:r=>{ S.pcalib = r.arena; S.ecalib = r.bar; S.hcalib = {hand:r.hand, next:r.next}; store.set('crc_pcalib', S.pcalib); store.set('crc_ecalib', S.ecalib); store.set('crc_hcalib', S.hcalib); toast('영역 저장 완료'); },
    end:()=>{ OV.calibOn = false; ovSetMode(OV.more ? 'tall' : 'panel'); }});
  function draw(){
    if (!OV.calibOn) return;
    if (cv.width !== innerWidth || cv.height !== innerHeight){ cv.width = innerWidth; cv.height = innerHeight; }
    cx.clearRect(0, 0, cv.width, cv.height);
    if (bg.complete && bg.naturalWidth) cx.drawImage(bg, 0, 0, cv.width, cv.height); else { cx.fillStyle = '#0a1430'; cx.fillRect(0, 0, cv.width, cv.height); }
    flow.draw(cx, cv.width, cv.height);
    requestAnimationFrame(draw);
  }
  $('ovCal').onclick = ()=>{ OV.calibOn = true; if (lastFrameUrl) bg.src = lastFrameUrl; ovSetMode('full'); flow.start(); requestAnimationFrame(draw); };
}
const fmtE1 = v=> v >= 9.95 ? '10' : v.toFixed(1);
function setEBar(el, E, lo, hi){
  const segs = el.children;
  for (let i=0;i<10;i++) segs[i].firstChild.style.width = Math.max(0, Math.min(1, E - i))*100 + '%';
  const r = el.lastChild;
  if (hi - lo >= 0.3){ r.style.display = 'block'; r.style.left = lo*10 + '%'; r.style.width = (hi - lo)*10 + '%'; } else r.style.display = 'none';
}
function renderOverlay(sim, simMe, rec, deck, inf, tips){
  if (!$('ovRoot')) return;
  const t = gameTime(), E = sim.E, myE = simMe.E, d = myE - E;
  $('ovBE').textContent = fmtE1(E);
  const ring = $('ovBRing'); ring.style.strokeDasharray = `${(E/10)*169.6} 169.6`;
  $('ovOE').textContent = fmtE1(E); $('ovME').textContent = fmtE1(myE);
  $('ovORange').textContent = sim.hi - sim.lo >= 0.3 ? `${sim.lo.toFixed(1)}~${sim.hi.toFixed(1)}` : '정확';
  const de = $('ovDE'); de.textContent = S.started ? (Math.abs(d) < 0.5 ? '비슷' : (d > 0 ? `+${d.toFixed(1)} 앞섬` : `${d.toFixed(1)} 뒤짐`)) : ''; de.className = d > 0.4 ? 'good' : d < -0.4 ? 'bad' : '';
  setEBar($('ovOBar'), E, sim.lo, sim.hi); setEBar($('ovMBar'), myE, myE, myE);
  $('ovDot').className = 'dot ' + (S.started ? 'on' : frameReady ? 'wait' : '');
  $('ovTime').textContent = S.started ? $('timer').textContent : (frameReady ? '경기 대기' : '화면 연결 대기');
  const ph = S.started ? phaseAt(t, S.settings.triple) : null; $('ovPhase').textContent = ph ? ph.label.replace('엘릭서','').trim() : ''; $('ovPhase').className = 'ph ' + (ph ? ph.cls : '');
  // 상대 덱 8칸: 손패(밝게) / 대기열(어둡게 + 몇 장 뒤) / 아직 모름(예상 카드 흐리게)
  const dk = $('ovDeck'); let html = '';
  const slots = deck.known.map(id=>({id, st:deck.status[id]}));
  inf.predicted.slice(0, 8 - slots.length).forEach(p=>slots.push({id:p.id, pred:p.prob}));
  while (slots.length < 8) slots.push({});
  for (const sl of slots){
    if (!sl.id){ html += '<i class="c empty">?</i>'; continue; }
    const u = imgUrl(sl.id), nm = esc(CARDS[sl.id].name.slice(0,3));
    const cls = sl.pred != null ? 'pred' : sl.st.where === 'hand' ? (deck.seq.length >= 4 ? 'hand' : 'maybe') : 'queue';
    const badge = sl.pred != null ? `${Math.round(sl.pred*100)}` : sl.st.where === 'queue' && sl.st.returnsIn ? sl.st.returnsIn : '';
    html += `<i class="c ${cls}">${u ? `<img src="${esc(u)}" onerror="this.remove()">` : ''}<span class="n">${nm}</span>${badge !== '' ? `<em>${badge}</em>` : ''}</i>`;
  }
  dk.innerHTML = html;
  const r = rec && rec.recs[0], box = $('ovRec');
  if (!S.started){ box.className = 'ovRec'; box.innerHTML = S.endedAt ? '경기 종료 · 앱에서 기록을 확인하세요' : (frameReady ? '경기가 시작되면 자동으로 따라가요' : '화면 연결을 기다리는 중'); }
  else if (!r){ box.className = 'ovRec'; box.innerHTML = `<span>${esc(rec ? rec.headline : '')}</span>`; }
  else {
    const u = imgUrl(r.id);
    box.className = 'ovRec ' + rec.mode;
    box.innerHTML = `${u ? `<img src="${esc(u)}" onerror="this.remove()">` : ''}<div class="tx"><b>${esc(CARDS[r.id].name)}</b><span class="when">${esc(r.when)}</span><small>${esc(r.how)}</small></div><span class="mode">${rec.mode==='defend'?'수비':rec.mode==='attack'?'공격':'사이클'}</span>`;
  }
  if (OV.more){
    const g = inf.groups[0];
    $('ovMoreBox').innerHTML = (g ? `<div class="row1"><b>상대 덱 추정</b><span>${esc(g.n)} ${Math.round(g.prob*100)}%</span></div>` : '')
      + tips.slice(0,3).map(tp=>`<div class="tip">${esc(tp.text)}</div>`).join('')
      + `<div class="diag">인식 ${OVSTAT.fps.toFixed(0)}fps · 지연 ${Math.round(OVSTAT.lagMs)}ms · 처리 ${ovVis ? ovVis.stats.ms.toFixed(0) : 0}ms · 학습 ${TPL.count()}장</div>`;
  }
}
if (OVL) buildOverlay();

/* ---- 본 앱(iPhone·iPad): 애플 정책상 앱 안에서 다른 앱 화면을 읽을 수 없어요 → 직접 입력 모드로 안내 ---- */
const IOS_APP = (()=>{ try{ const C = window.Capacitor; return !OVL && !!(C && C.getPlatform && C.getPlatform() === 'ios'); }catch(e){ return false; } })();
if (IOS_APP){
  const IOS_MSG = '아이폰·아이패드 앱은 애플 정책 때문에 클래시로얄 화면을 읽을 수 없어요. 상대가 낸 카드를 아래 [상대가 낸 카드]에서 눌러 기록하세요.';
  $('previewHint').innerHTML = '아이폰·아이패드에서는 <b>화면 자동 인식이 안 돼요</b><br>(애플이 앱끼리 화면을 읽는 걸 막아요)'
    + '<br><br><b>이렇게 쓰세요</b>: 게임은 휴대폰으로 하고, 이 화면에서<br>상대가 낸 카드를 <b>[상대가 낸 카드]</b>에서 눌러 주세요.<br>엘릭서 계산·덱 추정·코칭은 그대로 돼요.'
    + '<br><br>자동 인식이 필요하면 <b>PC 앱 + 휴대폰 미러링</b>이나 <b>안드로이드 앱</b>을 쓰세요.';
  $('btnCapture').textContent = '사용 방법';
  $('btnCapture').onclick = ()=> toast(IOS_MSG);
  $('btnCalib').style.display = 'none';
  // 자동 감지용 옵션(체크박스·감도)은 아이폰에서 쓸 수 없으니 숨김. 저장된 설정값은 그대로 둬서 PC와 동기화해도 안 바뀜
  ['chkAuto','sens'].forEach(id=>{ const r = $(id) && $(id).closest('.row'); if (r) r.style.display = 'none'; });
  $('capStatus').textContent = '직접 입력 모드';
  const pend = $('pending') && $('pending').closest('.panel'); if (pend) pend.style.display = 'none';   // 자동 감지 결과 확인 칸

  const cap = $('capStatus').closest('.panel'); if (cap){ const h = cap.querySelector('.ribbon h2'); if (h) h.textContent = '아이폰·아이패드 안내'; }
}

/* ---- 본 앱(안드로이드): 시작 버튼 + 경기 후 기록 가져오기 ---- */
const SC = (()=>{ try{ const C = window.Capacitor; return !OVL && C && C.getPlatform && C.getPlatform() === 'android' && C.registerPlugin ? C.registerPlugin('ScreenCoach') : null; }catch(e){ return null; } })();
if (SC){
  const b = document.createElement('button'); b.className = 'btn gold'; b.id = 'btnPhoneCoach'; b.textContent = '휴대폰 실시간 코치 시작';
  $('btnCapture').parentNode.insertBefore(b, $('btnCapture'));
  $('previewHint').textContent = '[휴대폰 실시간 코치 시작] → "다른 앱 위에 표시" 허용 → 화면 녹화 "시작"을 누르고 클래시로얄을 켜세요. 게임 중엔 아무것도 누르지 않아도 돼요.';
  b.onclick = async ()=>{
    try{
      let p = await SC.hasOverlayPermission();
      if (p.running){ await SC.stop(); toast('실시간 코치를 껐어요'); return; }
      if (!p.granted){ toast('"다른 앱 위에 표시"를 허용해주세요'); p = await SC.requestOverlayPermission(); if (!p.granted){ toast('권한이 없으면 게임 위에 코치 창을 띄울 수 없어요'); return; } }
      const cfg = {}; ['crc_settings','crc_pcalib','crc_ecalib','crc_hcalib','crc_ovvoice'].forEach(k=>{ const v = localStorage.getItem(k); if (v != null) cfg[k] = v; });
      // 400px · 초당 12장: 손패·작은 유닛까지 읽을 해상도와 실시간성의 균형
      await SC.start({config: JSON.stringify(cfg), width: 400, fps: 12});
    }catch(e){ toast(String(e && e.message || e) === 'denied' ? '화면 녹화를 허용해야 해요' : '시작하지 못했어요: ' + (e && e.message || e)); }
  };
}
function importOverlayResult(res){
  if (!res || !res.at || res.at <= store.get('crc_ovseen', 0)) return;
  store.set('crc_ovseen', res.at);
  if (S.started) return;
  S.plays = res.plays || []; S.mine = res.mine || []; S.endedAt = res.endedAt || 0;
  S.pending = (res.pending || []).map(p=>Object.assign({}, p, {feats:(p.feats||[]).map(f=>{ try{ return TPL.unpackFeat(f); }catch(e){ return null; } }).filter(Boolean)}));
  loadTemplates();   // 코치 창이 경기 중 스스로 학습한 것 반영
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
const KIND_OF = {crc_templates:'templates', crc_vlog:'vlog', crc_calib:'calib', crc_vcalib:'calib', crc_pcalib:'calib', crc_ecalib:'calib', crc_calib2:'calib', crc_hcalib:'calib', crc_settings:'settings'};
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
  if (kind === 'calib') return {calib:store.get('crc_calib',null), vcalib:store.get('crc_vcalib',null), pcalib:store.get('crc_pcalib',null), ecalib:store.get('crc_ecalib',null), calib2:store.get('crc_calib2',null), hcalib:store.get('crc_hcalib',null)};
  const st = Object.assign({}, S.settings), md = myDeck(); delete st.myDeck; st.myDeckKey = md ? {n:md.n, v:md.v} : null; return st;
}
function mergeKind(kind, remote, local){
  if (remote == null) return local;
  if (kind === 'templates'){
    const seen = new Set(), out = [];
    for (const t of remote.concat(local)) { if (!t || !t.id || !(t.raw || t.f)) continue; const body = t.f || t.raw; const k = t.id+'|'+body.slice(0,48)+body.length; if (seen.has(k)) continue; seen.add(k); out.push(t); }
    out.sort((a,b)=>(a.at||0)-(b.at||0));
    const cnt = {}, keep = [];   // 카드마다 최신 15장(카드 아님은 40장)만
    for (let i = out.length-1; i >= 0; i--){ const id = out[i].id, cap = id==='__ignore'?40:15; cnt[id] = (cnt[id]||0)+1; if (cnt[id] <= cap) keep.unshift(out[i]); }
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
    if (kind === 'templates'){ store.set('crc_templates', v); loadTemplates(); }
    else if (kind === 'vlog'){ S.vlog = v; store.set('crc_vlog', v); PATTERNS = learnPatterns(S.vlog); renderVLearn(); }
    else if (kind === 'calib'){ ['calib','vcalib','pcalib','ecalib','calib2','hcalib'].forEach(k=>{ if (v[k]){ store.set('crc_'+k, v[k]); S[k] = v[k]; } }); }
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
setTimeout(refreshHandPool, 400);
if (/[?&]debug/.test(location.search)) window.__crDebug = {S, TPL, VIS, VISMAP, HANDREF, render, LIVE};
setInterval(render, 250);
hud.addEventListener('dblclick', ()=>{ if (document.body.classList.contains('minimode')) $('btnPip').click(); });
(function loop(){ if ($('tab-battle').classList.contains('on')) arena.render(); if ($('tab-video').classList.contains('on')) vArena.render(); requestAnimationFrame(loop); })();

/* ================= 배경음악 · 효과음 =================
   음원 파일 없이 Web Audio로 직접 합성하는 이 앱만의 오리지널 곡·효과음이에요(저작권 걱정 없음, 오프라인 OK).
   브라우저 정책상 첫 클릭/키 입력 뒤에 소리가 나기 시작해요. 게임 위 코치 창(#overlay)에서는 소리를 내지 않아요. */
const SND = (()=>{
  const AC = window.AudioContext || window.webkitAudioContext;
  if (OVL || !AC) return {fx(){}, duck(){}, apply(){}, unlock(){}};
  let ctx = null, master, bgmBus, sfxBus, timer = null, step = 0, nextT = 0, duckUntil = 0, noiseBuf = null;
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const vol = () => Math.max(0, Math.min(1, (S.settings.sndVol == null ? 50 : S.settings.sndVol) / 100));
  function init(){
    if (ctx) return true;
    try{ ctx = new AC(); }catch(e){ return false; }
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4; comp.connect(ctx.destination);
    master = ctx.createGain(); master.connect(comp);
    bgmBus = ctx.createGain(); bgmBus.gain.value = 0; bgmBus.connect(master);
    sfxBus = ctx.createGain(); sfxBus.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    apply(); return true;
  }
  /* --- 악기 --- */
  function env(g, t, a, peak, dec){ g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec); }
  function pluck(bus, m, t, dur, v){            // 류트·하프 느낌의 뜯는 소리
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o1.type = 'triangle'; o2.type = 'square'; o1.frequency.value = mtof(m); o2.frequency.value = mtof(m) * 1.003;
    const g2 = ctx.createGain(); g2.gain.value = 0.18;
    f.type = 'lowpass'; f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(700, t + dur);
    o1.connect(f); o2.connect(g2); g2.connect(f); f.connect(g); g.connect(bus);
    env(g, t, 0.006, v, dur); o1.start(t); o2.start(t); o1.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  }
  function tone(bus, type, m, t, dur, v, slideTo){
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.setValueAtTime(mtof(m), t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(mtof(slideTo), t + dur);
    o.connect(g); g.connect(bus); env(g, t, 0.01, v, dur); o.start(t); o.stop(t + dur + 0.05);
  }
  function pad(bus, notes, t, dur, v){          // 부드러운 현악 화음
    const f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = 'lowpass'; f.frequency.value = 1100; f.connect(g); g.connect(bus);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.35); g.gain.linearRampToValueAtTime(v * 0.7, t + dur - 0.1); g.gain.linearRampToValueAtTime(0.0001, t + dur);
    notes.forEach((m, i)=>{ const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = (i - 1) * 6; o.connect(f); o.start(t); o.stop(t + dur + 0.05); });
  }
  function noise(bus, t, dur, v, type, freq){
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; f.type = type; f.frequency.value = freq; s.connect(f); f.connect(g); g.connect(bus);
    env(g, t, 0.002, v, dur); s.start(t); s.stop(t + dur + 0.05);
  }
  function kick(bus, t, v){ const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.14); o.connect(g); g.connect(bus); env(g, t, 0.003, v, 0.18); o.start(t); o.stop(t + 0.25); }

  /* --- 오리지널 곡: 경쾌한 중세 행진곡 풍, 8마디 반복 (F장조, 118BPM) --- */
  const BPM = 118, EIGHTH = 60 / BPM / 2, _ = null;
  const MEL = [
    72,_,69,72, 77,76,74,72,   76,_,72,76, 79,77,76,74,   74,_,69,74, 77,76,74,72,   70,72,74,77, 76,_,74,_,
    72,_,69,72, 77,79,81,77,   79,_,76,79, 84,_,79,_,     79,77,76,74, 72,74,76,79,   77,_,72,_, 65,_,_,_ ];
  const CH = [[53,57,60],[48,52,55],[50,53,57],[46,50,53],[53,57,60],[48,52,55],[55,58,62],[53,57,60]];   // F C Dm Bb F C Gm F
  const BASS = [[41,48],[36,43],[38,45],[34,41],[41,48],[36,43],[43,36],[41,36]];
  function schedule(t, i){
    const bar = Math.floor(i / 8) % 8, s = i % 8, m = MEL[i % 64];
    if (m != null) pluck(bgmBus, m, t, EIGHTH * 1.6, 0.16);
    if (s % 2 === 0 && (s === 2 || s === 6)) pluck(bgmBus, CH[bar][1] + 12, t, EIGHTH * 1.2, 0.05);   // 뒷박 반주
    if (s === 0) pad(bgmBus, CH[bar], t, EIGHTH * 8, 0.035);
    if (s === 0 || s === 4) tone(bgmBus, 'triangle', BASS[bar][s === 0 ? 0 : 1], t, EIGHTH * 1.8, 0.22);
    if (s === 0 || s === 4) kick(bgmBus, t, 0.35);
    if (s === 2 || s === 6) noise(bgmBus, t, 0.09, 0.12, 'bandpass', 1800);
    if (bar === 7 && s >= 4) noise(bgmBus, t + EIGHTH / 2, 0.06, 0.07, 'bandpass', 2000);   // 마지막 마디 작은북 롤
    noise(bgmBus, t, 0.03, s % 2 ? 0.05 : 0.025, 'highpass', 7000);
  }
  function tick(){
    if (!ctx) return;
    while (nextT < ctx.currentTime + 0.2){ schedule(nextT, step); step++; nextT += EIGHTH; }
    // 음성 안내 중이거나 경기 중이면 배경음악을 작게
    const target = vol() * 1.1 * (ctx.currentTime < duckUntil ? 0.25 : S.started ? 0.45 : 1);
    bgmBus.gain.setTargetAtTime(target, ctx.currentTime, 0.25);
  }
  function apply(){
    if ($('btnSnd')){ $('btnSnd').textContent = S.settings.bgm ? '음악 켬' : '음악 끔'; $('btnSnd').style.opacity = S.settings.bgm ? '1' : '0.6'; }
    if (!ctx) return;
    sfxBus.gain.value = vol() * 0.9;
    const want = S.settings.bgm && document.visibilityState !== 'hidden';
    if (want && !timer){ step = 0; nextT = ctx.currentTime + 0.1; timer = setInterval(tick, 40); }
    if (!want && timer){ clearInterval(timer); timer = null; bgmBus.gain.setTargetAtTime(0, ctx.currentTime, 0.1); }
  }
  function unlock(){ if (!init()) return; if (ctx.state === 'suspended') ctx.resume().catch(()=>{}); apply(); }

  /* --- 효과음 (전부 오리지널 합성) --- */
  function fx(kind){
    if (!S.settings.sfx || !ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.005;
    if (kind === 'click'){ tone(sfxBus, 'sine', 81, t, 0.07, 0.35, 88); noise(sfxBus, t, 0.015, 0.08, 'highpass', 4000); }
    else if (kind === 'card'){ tone(sfxBus, 'triangle', 57, t, 0.12, 0.45, 45); tone(sfxBus, 'sine', 93, t + 0.02, 0.1, 0.12); noise(sfxBus, t, 0.05, 0.12, 'lowpass', 900); }
    else if (kind === 'tab'){ tone(sfxBus, 'sine', 76, t, 0.06, 0.25); tone(sfxBus, 'sine', 83, t + 0.05, 0.08, 0.22); }
    else if (kind === 'toggle'){ tone(sfxBus, 'triangle', 79, t, 0.05, 0.25); tone(sfxBus, 'triangle', 86, t + 0.045, 0.07, 0.22); }
    else if (kind === 'start'){ [65,69,72,77].forEach((m,i)=>pluck(sfxBus, m, t + i * 0.08, 0.35, 0.3)); pad(sfxBus, [65,69,72,77], t + 0.32, 0.7, 0.06); kick(sfxBus, t + 0.32, 0.5); noise(sfxBus, t + 0.32, 0.4, 0.08, 'highpass', 5000); }
    else if (kind === 'end'){ [77,72,69,65].forEach((m,i)=>pluck(sfxBus, m, t + i * 0.11, 0.4, 0.26)); }
  }
  function duck(){ if (ctx) duckUntil = ctx.currentTime + 3; }

  ['pointerdown','keydown','touchstart'].forEach(ev => document.addEventListener(ev, unlock, {capture:true, passive:true}));
  document.addEventListener('visibilitychange', ()=>{ if (ctx) apply(); });
  // 누르는 것마다 효과음: 카드 > 탭 > 체크박스 > 버튼
  document.addEventListener('click', e=>{
    const el = e.target.closest && e.target.closest('.crd, .nb, input[type=checkbox], button, .btn, .chip, .slot, .gitem, .deck, select');
    if (!el || el.id === 'btnStart') return;   // 경기 시작은 팡파르가 따로 나와요
    fx(el.matches('.crd, .slot') ? 'card' : el.matches('.nb') ? 'tab' : el.matches('input[type=checkbox]') ? 'toggle' : 'click');
  }, true);
  return {fx, duck, apply, unlock};
})();
window.SND = SND;
function syncSoundUI(){
  if (!$('chkBgm')) return;
  $('chkBgm').checked = !!S.settings.bgm; $('chkSfx').checked = !!S.settings.sfx;
  $('sndVol').value = S.settings.sndVol; $('sndVolV').textContent = S.settings.sndVol + '%';
}
if ($('chkBgm')){
  syncSoundUI();
  $('chkBgm').onchange = e=>{ S.settings.bgm = e.target.checked; saveSettings(); SND.unlock(); SND.apply(); };
  $('chkSfx').onchange = e=>{ S.settings.sfx = e.target.checked; saveSettings(); };
  $('sndVol').oninput = e=>{ S.settings.sndVol = +e.target.value; $('sndVolV').textContent = S.settings.sndVol + '%'; SND.apply(); };
  $('sndVol').onchange = ()=> saveSettings();
}
if ($('btnSnd')) $('btnSnd').onclick = ()=>{ S.settings.bgm = !S.settings.bgm; saveSettings(); syncSoundUI(); SND.unlock(); SND.apply(); toast(S.settings.bgm ? '배경음악을 켰어요' : '배경음악을 껐어요'); };
SND.apply();

})();
