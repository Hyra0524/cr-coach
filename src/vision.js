/* =========================================================
   화면 인식 엔진 v2
   - 입력: grab(영역, 가로, 세로) → RGBA 배열  (브라우저는 캔버스, 테스트는 합성 프레임)
   - 경기장 18x32 타일을 타일당 8px(144x256)로 읽어서
     1) 칸별 움직임 에너지 → 잡음에 맞춰 자동 조절되는 문턱값
     2) '직전 몇 프레임 동안 주변이 조용했는데 갑자기 생긴 것'만 배치로 판정 (걷는 유닛·전투 잔상 제외)
     3) 킹 타워에서 날아가는 투사체(파이어볼·로켓·화살·고블린 통)는 따라가서 떨어진 곳을 배치 위치로
     4) 배치 0.22·0.52·0.88초 뒤 3번 잘라서 특징을 뽑고 투표 (배치 연출 중 모습이 바뀌어도 안정)
     5) 체력바·배치 시계의 팀 색(빨강/파랑)으로 진영 판별 → 포켓 배치도 구분
   - 내 손패 4칸 + 다음 카드를 카드 그림과 비교해서 읽음 → 내가 낸 카드를 정확히 앎
   - 엘릭서 바를 열(column) 단위로 읽어 소수점까지, 2프레임 확인 + 되돌림 감지
   ========================================================= */
const VISION = (function(){
'use strict';
const GW = 18, GH = 32, TPX = 8, IW = GW*TPX, IH = GH*TPX;
const CROP = 32;                       // 4x4 타일
const STAGES = [220, 520, 880];        // 배치 후 캡처 시점(ms)
const STAGE_W = [0.30, 0.35, 0.35];
const KINGS = {top:{x:9, y:2.5}, bottom:{x:9, y:29.5}};
const TOWERS = [{x:3.5,y:6.5},{x:14.5,y:6.5},{x:3.5,y:25.5},{x:14.5,y:25.5},{x:9,y:2.5},{x:9,y:29.5}];

/* 칸별 문턱값 배수: 타워(공격 연출이 계속 움직임)·강(물결)은 둔감하게 */
const MUL = new Float32Array(GW*GH);
for (let r=0;r<GH;r++) for (let c=0;c<GW;c++){
  const rr = r < 16 ? r : 31 - r; let m = 1;
  if (rr <= 4 && c >= 6 && c <= 11) m = 2.5;
  else if (rr >= 4 && rr <= 8 && ((c >= 1 && c <= 5) || (c >= 12 && c <= 16))) m = 2.2;
  else if (r === 15 || r === 16) m = 1.5;
  MUL[r*GW+c] = m;
}
const nearTower = (x,y,d)=> TOWERS.some(t=>Math.hypot(t.x-x, t.y-y) < d);

/* ---------------- 특징 추출 (32x32 RGB + 배경) ----------------
   전경 가중치(배경과 다른 정도)로 잔디·바닥 무늬 영향을 줄이고
   색 히스토그램 + 경사 방향 히스토그램 + 공간 색 배치를 합쳐요. 좌우 반전도 같이 저장(유닛이 바라보는 방향). */
const HB = 27, GB = 128, SB = 192;
function rgb2hsv(r,g,b){
  const mx = Math.max(r,g,b), mn = Math.min(r,g,b), d = mx - mn;
  let h = 0;
  if (d > 0){ if (mx === r) h = ((g-b)/d) % 6; else if (mx === g) h = (b-r)/d + 2; else h = (r-g)/d + 4; h /= 6; if (h < 0) h += 1; }
  return [h, mx ? d/mx : 0, mx/255];
}
function l2(v){ let s=0; for (let i=0;i<v.length;i++) s+=v[i]*v[i]; s=Math.sqrt(s)||1; for (let i=0;i<v.length;i++) v[i]/=s; return v; }
function featurize(rgb, bg, flip){
  const N = CROP*CROP, m = new Float32Array(N), L = new Float32Array(N);
  const px = (i)=>{ if (!flip) return i; const y=(i/CROP)|0, x=i%CROP; return y*CROP + (CROP-1-x); };
  let msum = 0;
  for (let i=0;i<N;i++){
    const j = px(i)*3;
    const d = bg ? (Math.abs(rgb[j]-bg[j]) + Math.abs(rgb[j+1]-bg[j+1]) + Math.abs(rgb[j+2]-bg[j+2]))/3 : 40;
    const w = Math.max(0, Math.min(1, (d-10)/30)); m[i] = w; msum += w;
    L[i] = 0.299*rgb[j] + 0.587*rgb[j+1] + 0.114*rgb[j+2];
  }
  if (msum < 20) for (let i=0;i<N;i++) m[i] = Math.max(m[i], 0.35);   // 배경과 거의 같으면 전체를 약하게
  // 1) 색 히스토그램 (색상 12 x 채도 2 + 무채색 3)
  const h = new Float32Array(HB);
  for (let i=0;i<N;i++){
    if (m[i] < 0.05) continue; const j = px(i)*3;
    const [hh, s, v] = rgb2hsv(rgb[j], rgb[j+1], rgb[j+2]);
    if (s < 0.25 || v < 0.12) h[24 + Math.min(2, (v*3)|0)] += m[i];
    else h[Math.min(11,(hh*12)|0)*2 + (s < 0.6 ? 0 : 1)] += m[i];
  }
  for (let i=0;i<HB;i++) h[i] = Math.sqrt(h[i]);
  // 2) 경사 방향 히스토그램 (4x4 칸 x 8방향)
  const g = new Float32Array(GB);
  for (let y=1;y<CROP-1;y++) for (let x=1;x<CROP-1;x++){
    const i = y*CROP+x, w = m[i]; if (w < 0.05) continue;
    const gx = L[i+1]-L[i-1], gy = L[i+CROP]-L[i-CROP], mag = Math.sqrt(gx*gx+gy*gy); if (mag < 4) continue;
    let a = Math.atan2(gy, gx); if (a < 0) a += Math.PI;
    const b = Math.min(7, (a/Math.PI*8)|0), cell = ((y>>3)*4 + (x>>3));
    g[cell*8 + b] += mag*w;
  }
  for (let i=0;i<GB;i++) g[i] = Math.sqrt(g[i]);
  // 3) 8x8 공간 색 배치
  const s = new Float32Array(SB);
  for (let cy=0;cy<8;cy++) for (let cx=0;cx<8;cx++){
    let r=0, gg=0, b=0, ws=0;
    for (let y=cy*4;y<cy*4+4;y++) for (let x=cx*4;x<cx*4+4;x++){ const i=y*CROP+x, j=px(i)*3, w=m[i]; r+=rgb[j]*w; gg+=rgb[j+1]*w; b+=rgb[j+2]*w; ws+=w; }
    const k = (cy*8+cx)*3, cov = Math.min(1, ws/6);
    if (ws > 0){ s[k]=r/ws*cov; s[k+1]=gg/ws*cov; s[k+2]=b/ws*cov; }
  }
  let mean = 0; for (let i=0;i<SB;i++) mean += s[i]; mean /= SB; for (let i=0;i<SB;i++) s[i] -= mean;
  return {h:l2(h), g:l2(g), s:l2(s)};
}
const dot = (a,b)=>{ let s=0; for (let i=0;i<a.length;i++) s+=a[i]*b[i]; return s; };
function simF(a, b){ return 0.42*dot(a.h,b.h) + 0.33*dot(a.g,b.g) + 0.25*Math.max(0, dot(a.s,b.s)); }

/* ---------------- 학습 템플릿 저장소 ---------------- */
function TemplateStore(){
  let list = [];   // {id, f, ff, at}
  const CAP = 15, CAP_IGN = 40;
  let cal = null;
  /* 보정: 같은 카드끼리 / 다른 카드끼리 유사도 분포를 학습 데이터에서 직접 잼 (최대 260장 표본)
     → identify()가 점수를 '같은 카드일 가능성 대 다른 카드일 가능성' 비율로 바꿀 때 씀 */
  function calibrate(){
    const pool = list.filter(t=>t.id!=='__ignore'); const S = pool.length > 260 ? pool.filter((_,i)=>i % Math.ceil(pool.length/260) === 0) : pool;
    const g = [], im = [];
    for (let i=0;i<S.length;i++){ let bestImp = -1; const own = [];
      for (let j=0;j<S.length;j++){ if (i===j || (S[i].g != null && S[i].g === S[j].g)) continue; /* 같은 배치의 다른 캡처는 제외 */ const v = Math.max(simF(S[i].f, S[j].f), simF(S[i].f, S[j].ff)); if (S[j].id === S[i].id) own.push(v); else if (v > bestImp) bestImp = v; }
      if (own.length){ own.sort((a,b)=>b-a); g.push(own.slice(0,2).reduce((a,b)=>a+b,0)/Math.min(2,own.length)); }
      if (bestImp > -1) im.push(bestImp);
    }
    // 중앙값·MAD (배치 연출 단계가 달라 생기는 이상값에 흔들리지 않게)
    const ms = a=>{ const b = a.slice().sort((x,y)=>x-y), m = b[b.length>>1]; const d = b.map(x=>Math.abs(x-m)).sort((x,y)=>x-y)[b.length>>1]; return [m, 1.4826*d]; };
    const [gm, gs] = g.length >= 4 ? ms(g) : [0.93, 0.05], [imm, is] = im.length >= 4 ? ms(im) : [0.75, 0.07];
    // 실제 장면은 템플릿끼리보다 조금 덜 닮으니 같은 카드 분포를 넓게
    cal = {gm: gm - 0.01, gs: Math.min(0.12, Math.max(0.04, gs*1.3)), im: imm, is: Math.min(0.12, Math.max(0.035, is)), n: S.length};
    return cal;
  }
  function add(id, f, ff, group){
    cal = null;
    list.push({id, f, ff: ff || f, at: Date.now(), g: group != null ? group : null});
    const same = list.filter(t=>t.id===id), cap = id==='__ignore' ? CAP_IGN : CAP;
    if (same.length > cap) list.splice(list.indexOf(same[0]), 1);
  }
  function match(f, k){
    const per = {};
    for (const t of list){ const s = Math.max(simF(f, t.f), simF(f, t.ff)); (per[t.id] = per[t.id] || []).push(s); }
    const out = [];
    for (const id in per){ const a = per[id].sort((x,y)=>y-x), n = Math.min(k||2, a.length); let s=0; for (let i=0;i<n;i++) s+=a[i]; out.push({id, score:s/n}); }
    return out.sort((a,b)=>b.score-a.score);
  }
  // 저장: 특징을 8비트로 줄여 base64 (카드당 ~1KB)
  const q = v=>{ const o = new Int8Array(v.length); for (let i=0;i<v.length;i++) o[i] = Math.max(-127, Math.min(127, Math.round(v[i]*127))); return o; };
  const uq = (o)=>{ const v = new Float32Array(o.length); for (let i=0;i<o.length;i++) v[i] = o[i]/127; return l2(v); };
  function packF(f){ const a = new Int8Array(HB+GB+SB); a.set(q(f.h),0); a.set(q(f.g),HB); a.set(q(f.s),HB+GB); return a; }
  function unpackF(a){ return {h:uq(a.subarray(0,HB)), g:uq(a.subarray(HB,HB+GB)), s:uq(a.subarray(HB+GB))}; }
  const toB64 = a=>{ let s=''; const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i=0;i<u.length;i++) s+=String.fromCharCode(u[i]); return btoa(s); };
  const fromB64 = b=>{ const s = atob(b), u = new Uint8Array(s.length); for (let i=0;i<s.length;i++) u[i]=s.charCodeAt(i); return new Int8Array(u.buffer); };
  return {
    add, match,
    calib(){ return cal || calibrate(); },
    get list(){ return list; },
    ids(){ return new Set(list.filter(t=>t.id!=='__ignore').map(t=>t.id)); },
    count(id){ return id ? list.filter(t=>t.id===id).length : list.filter(t=>t.id!=='__ignore').length; },
    clear(){ list = []; cal = null; },
    packFeat(x){ return {f:toB64(packF(x.f)), ff:toB64(packF(x.ff))}; },
    unpackFeat(x){ return {f:unpackF(fromB64(x.f)), ff:unpackF(fromB64(x.ff))}; },
    serialize(){ return list.map(t=>({v:2, id:t.id, f:toB64(packF(t.f)), ff:toB64(packF(t.ff)), at:t.at, g:t.g})); },
    load(arr, legacy){
      list = []; cal = null;
      for (const x of arr || []){
        try{
          if (x.v === 2) list.push({id:x.id, f:unpackF(fromB64(x.f)), ff:unpackF(fromB64(x.ff)), at:x.at||0, g:x.g != null ? x.g : null});
          else if (x.raw && legacy){ const p = legacy(x.raw); if (p) list.push({id:x.id, f:p.f, ff:p.ff, at:0}); }
        }catch(e){}
      }
    },
  };
}
// 예전(24x24, 배경 없음) 학습 데이터를 새 특징으로 변환
function upscale24(raw24){
  const out = new Uint8Array(CROP*CROP*3);
  for (let y=0;y<CROP;y++) for (let x=0;x<CROP;x++){
    const sx = Math.min(23, (x*24/CROP)|0), sy = Math.min(23, (y*24/CROP)|0);
    for (let c=0;c<3;c++) out[(y*CROP+x)*3+c] = raw24[(sy*24+sx)*3+c];
  }
  return out;
}

/* ---------------- 손패 카드 특징 ----------------
   카드 그림 가운데(비용 표시·테두리 제외)를 10x12로 줄여 색/밝기/색상 분포를 비교.
   엘릭서가 모자라면 카드가 회색으로 어두워지므로 회색 버전도 함께 비교. */
const HFW = 10, HFH = 12;
function handFeat(rgba, stride, x0, y0, w, h, gray){
  const c = new Float32Array(HFW*HFH*3), l = new Float32Array(HFW*HFH), hu = new Float32Array(12); let satSum = 0;
  const ix0 = x0 + w*0.14, ix1 = x0 + w*0.86, iy0 = y0 + h*0.10, iy1 = y0 + h*0.70;
  for (let yy=0;yy<HFH;yy++) for (let xx=0;xx<HFW;xx++){
    const sx = Math.min(x0+w-1, Math.floor(ix0 + (xx+0.5)/HFW*(ix1-ix0))), sy = Math.min(y0+h-1, Math.floor(iy0 + (yy+0.5)/HFH*(iy1-iy0)));
    const k = (sy*stride + sx)*4; let r = rgba[k], g = rgba[k+1], b = rgba[k+2];
    if (gray){ const v = (0.299*r+0.587*g+0.114*b)*0.62; r = g = b = v; }
    const i = yy*HFW+xx; c[i*3]=r; c[i*3+1]=g; c[i*3+2]=b; l[i] = 0.299*r+0.587*g+0.114*b;
    const [hh, s, v] = rgb2hsv(r,g,b); satSum += s; if (s > 0.3 && v > 0.2) hu[Math.min(11,(hh*12)|0)] += s;
  }
  const center = v=>{ let m=0; for (let i=0;i<v.length;i++) m+=v[i]; m/=v.length; for (let i=0;i<v.length;i++) v[i]-=m; return l2(v); };
  let hs = 0; for (let i=0;i<12;i++) hs += hu[i];
  return {c:center(c), l:center(l), h: hs > 0.5 ? l2(hu) : null, sat: satSum/(HFW*HFH)};
}
function handSim(a, b){
  const lum = dot(a.l, b.l), col = dot(a.c, b.c);
  const hue = a.h && b.h ? dot(a.h, b.h) : (a.h || b.h ? 0.2 : 0.6);
  return 0.45*lum + 0.33*col + 0.22*hue;
}

/* ---------------- 엘릭서 바 ---------------- */
const BAR_W = 120, BAR_H = 6;
function isPink(r,g,b){ return r > 135 && b > 105 && g < 125 && r - g > 50 && b - g > 25; }
function readBar(rgba){
  const col = new Float32Array(BAR_W);
  for (let x=0;x<BAR_W;x++){ let p=0; for (let y=1;y<BAR_H-1;y++){ const k=(y*BAR_W+x)*4; if (isPink(rgba[k],rgba[k+1],rgba[k+2])) p++; } col[x] = p/(BAR_H-2); }
  // 왼쪽부터 채워진 길이: 칸 사이 어두운 줄(틈)은 허용하고, 진짜 빈 구간이 시작되는 곳을 찾음
  let filled = 0, run = 0, total = 0;
  for (let x=0;x<BAR_W;x++){ total += col[x] > 0.5 ? 1 : 0; }
  if (total < 3) return {present:false, value:0, pinkRatio: total/BAR_W};
  for (let x=0;x<BAR_W;x++){
    if (col[x] > 0.5){ filled = x+1; run = 0; }
    else if (++run > BAR_W*0.05) break;
  }
  return {present:true, value: Math.round(filled/BAR_W*100)/10, pinkRatio: total/BAR_W};
}

/* =============== 본체 =============== */
function Vision(cfg){
  let calib = null;
  const tpl = cfg.templates || TemplateStore();
  let handRefs = [];             // [{id, f, fg}]
  let handPool = null;           // 내 덱 카드 id 집합 (없으면 전체)
  let prevL = null, frameNo = 0;
  const masks = [];              // 최근 활동 마스크
  const hist = [];               // {ms, rgba} 배경용 과거 프레임
  let tracks = [], tid = 1, births = [], bid = 1, cands = [];
  const recentBirths = [], vidTrack = new Map();
  const stats = {frames:0, births:0, noise:0, thr:0, ms:0};

  /* ---- 경기장 ----
     배경 모델(유닛이 없을 때의 경기장 색)을 계속 갱신하고, 배경과 다른 칸 = 무언가 있는 칸.
     배치는 서서히 나타나기 때문에 '프레임 간 변화'가 아니라 '배경과의 차이'로 봐야 처음부터 잡혀요. */
  let BG = null, warm = 0, resetHold = 0, prevF = null;
  let lastA = null; const maskHist = [];
  function maskCells(){
    const out = new Uint8Array(GW*GH), m = cfg.mask && cfg.mask(); if (!m || !calib.arena) return out;
    const a = calib.arena;
    const c0 = Math.floor((m.x - a.x)/a.w*GW) - 1, c1 = Math.ceil((m.x + m.w - a.x)/a.w*GW) + 1;
    const r0 = Math.floor((m.y - a.y)/a.h*GH) - 1, r1 = Math.ceil((m.y + m.h - a.y)/a.h*GH) + 1;
    for (let r=Math.max(0,r0); r<Math.min(GH,r1); r++) for (let c=Math.max(0,c0); c<Math.min(GW,c1); c++) out[r*GW+c] = 1;
    return out;
  }
  const HEAT = new Float32Array(GW*GH);   // 잠깐 깜빡이고 사라지는 자리(깃발·타워 연출) → 그 자리는 둔감하게
  function arenaFrame(t, ms){
    const rgba = cfg.grab(calib.arena, IW, IH); if (!rgba) return;
    const n = IW*IH;
    hist.push({ms, rgba: new Uint8ClampedArray(rgba)}); if (hist.length > 10) hist.shift();
    if (!BG){ BG = new Float32Array(n*3); for (let i=0;i<n;i++){ BG[i*3]=rgba[i*4]; BG[i*3+1]=rgba[i*4+1]; BG[i*3+2]=rgba[i*4+2]; } warm = 0; return; }
    warm++;
    // 1) 칸별 배경 차이
    const F = new Float32Array(GW*GH);
    for (let y=0;y<IH;y++){ const ry = (y>>3)*GW, row = y*IW;
      for (let x=0;x<IW;x++){ const i=row+x, k=i*4, b=i*3;
        F[ry+(x>>3)] += (Math.abs(rgba[k]-BG[b]) + Math.abs(rgba[k+1]-BG[b+1]) + Math.abs(rgba[k+2]-BG[b+2])); } }
    for (let i=0;i<F.length;i++) F[i] /= TPX*TPX*3;
    // 2) 잡음에 맞춘 문턱값 (중앙값 + 5 x MAD)
    const sorted = Array.from(F).sort((a,b)=>a-b), med = sorted[sorted.length>>1];
    const dev = Array.from(F, v=>Math.abs(v-med)).sort((a,b)=>a-b)[F.length>>1];
    const base = cfg.sens ? cfg.sens()*0.75 : 12;
    const thr = Math.max(base, med + 5*1.4826*dev + 3);
    stats.noise = med; stats.thr = thr;
    // 가림 영역(코치 창 등): 그 칸과 최근에 가려졌던 칸은 인식하지 않고 배경만 빠르게 새로 잡음
    const MK = maskCells();
    maskHist.push(MK); if (maskHist.length > 4) maskHist.shift();
    const mkRecent = orMasks(maskHist);
    for (let i=0;i<F.length;i++) if (mkRecent[i]) F[i] = 0;
    const A = new Uint8Array(GW*GH); let fgCount = 0;
    for (let i=0;i<HEAT.length;i++) HEAT[i] *= 0.996;
    for (let i=0;i<A.length;i++){ const tt = thr*MUL[i]*(1 + Math.max(0, HEAT[i]-1)*0.7); A[i] = F[i] > tt ? (F[i] > tt*2.2 ? 2 : 1) : 0; if (A[i]) fgCount++; }
    // 화면 전체가 바뀜(전환·밝기 변화) → 배경을 새로 잡고 잠시 쉬기
    if (fgCount > GW*GH*0.4){ for (let i=0;i<n;i++){ BG[i*3]=rgba[i*4]; BG[i*3+1]=rgba[i*4+1]; BG[i*3+2]=rgba[i*4+2]; } masks.length = 0; resetHold = 3; return; }
    // 3) 덩어리 → 추적
    const blobs = components(A, i=>A[i] > 0, null);
    const fastCell = new Uint8Array(GW*GH);
    for (const b of blobs) if (b.n > 60) for (const c of b.cells) fastCell[c] = 1;     // 큰 배너·문구: 빨리 배경으로
    for (let i=0;i<fastCell.length;i++) if (mkRecent[i]) fastCell[i] = 1;
    const growth = track(blobs.filter(b=>b.n <= 60), t, ms, F, prevF);
    prevF = F;
    // 4) 배경 갱신: 빈 칸은 빠르게, 무언가 있는 칸은 아주 천천히 (오래 서 있는 건물은 결국 배경이 됨)
    for (let y=0;y<IH;y++){ const ry=(y>>3)*GW, row=y*IW;
      for (let x=0;x<IW;x++){ const c = ry+(x>>3), a = fastCell[c] ? 0.5 : A[c] ? 0.004 : (warm < 5 ? 0.5 : 0.07), i=row+x, k=i*4, b=i*3;
        BG[b] += (rgba[k]-BG[b])*a; BG[b+1] += (rgba[k+1]-BG[b+1])*a; BG[b+2] += (rgba[k+2]-BG[b+2])*a; } }
    // 5) 새로 생긴 칸: 최근 3프레임 동안 주변(1칸)에 아무것도 없던 곳
    const past = orMasks(masks.slice(-3)), d1 = dilate(past, 1), d2 = dilate(masks.length ? masks[masks.length-1] : null, 2);
    const fresh = new Uint8Array(GW*GH);
    for (let i=0;i<A.length;i++) if (A[i] && !d1[i] && !fastCell[i]) fresh[i] = 1;
    masks.push(A); if (masks.length > 4) masks.shift(); lastA = A;
    if (resetHold > 0){ resetHold--; return; }
    if (masks.length < 3 || warm < 4) return;
    const comps = components(fresh, i=>fresh[i], (i)=>A[i] > 0 && !d1[i]);
    const tr_ = cfg.trace ? [] : null, rej = (cp, why)=>{ if (tr_) tr_.push({cx:cp.cx, cy:cp.cy, n:cp.n, why}); };
    for (const cp of comps){
      const strong = cp.cells.some(i=>A[i] === 2);
      if (cp.n <= 3 && cp.cells.some(i=>d2[i]) && tracks.some(tr=>tr.last === ms && Math.hypot(tr.vx,tr.vy) > 4 && Math.hypot(tr.x-cp.cx, tr.y-cp.cy) < 2.5)){ rej(cp,'proj'); continue; }
      if (tracks.some(tr=>tr.proj && !tr.landed && Math.hypot(tr.x-cp.cx, tr.y-cp.cy) < 2.5)){ rej(cp,'inflight'); continue; }
      // 킹 타워 안쪽(깃발·대포 연출)의 작은 변화는 강할 때만
      if (cp.n <= 3 && !strong && (cp.cy < 2.5 || cp.cy > 29.5) && cp.cx > 6.5 && cp.cx < 11.5){ rej(cp,'king'); continue; }
      rej(cp, cp.n < 2 && !strong ? 'weak' : 'cand');
      cands.push({cx:cp.cx, cy:cp.cy, n:cp.n, t, ms, frame:frameNo, hits:0, cells:cp.cells, small: cp.n <= 3 && !strong});
    }
    // 이미 있던 덩어리 위에 새로 놓은 경우: 덩어리가 갑자기 커지고(+3칸) 배경 차이가 크게 늘어남 (합쳐진 경우는 제외)
    for (const g of growth){ rej(g,'grow'); cands.push({cx:g.cx, cy:g.cy, n:g.n, t, ms, frame:frameNo, hits:0, cells:g.cells, small:false, grow:true}); }
    if (cfg.trace) cfg.trace({t, thr, med, comps: tr_, E:F, A, d1});
    // 6) 후보 확인: 그 자리에 계속 남아 있어야 배치 (투사체·깜빡임은 다음 프레임에 사라지거나 멀리 감)
    //    작은 후보(1~3칸)는 2프레임, 나머지는 1프레임
    const keep = [];
    for (const c of cands){
      if (c.frame === frameNo){ keep.push(c); continue; }
      let alive = 0;
      for (const ci of c.cells){ const r=(ci/GW)|0, cc=ci%GW;
        for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++){ const rr=r+dr, c2=cc+dc; if (rr>=0&&rr<GH&&c2>=0&&c2<GW && A[rr*GW+c2] && (c.small ? (dr===0&&dc===0) || Math.abs(dr)+Math.abs(dc)===1 : true)){ alive++; } } }
      if (alive) c.hits++;
      const need = c.small ? 2 : 1;
      if (c.hits >= need){ const nb = newBirth(c.cx, c.cy, Math.max(c.n, alive), c.t, c.ms, null); if (nb) nb.src = c.grow ? 'grow' : c.small ? 'small' : 'cand'; }
      else if (frameNo - c.frame < need + 1) keep.push(c);
    }
    cands = keep;
    // 7) 배치 캡처 단계
    stageCaptures(rgba, t, ms);
  }
  function bgCrop(cx, cy){
    const out = new Uint8Array(CROP*CROP*3), x0 = Math.round(cx*TPX - CROP/2), y0 = Math.round(cy*TPX - CROP/2);
    for (let y=0;y<CROP;y++){ const sy = Math.max(0, Math.min(IH-1, y0+y));
      for (let x=0;x<CROP;x++){ const sx = Math.max(0, Math.min(IW-1, x0+x)), b=(sy*IW+sx)*3, o=(y*CROP+x)*3; out[o]=BG[b]; out[o+1]=BG[b+1]; out[o+2]=BG[b+2]; } }
    return out;
  }
  function newBirth(cx, cy, n, t, ms, kind){
    // 같은 곳에 1.2초 안에 또 잡히면 하나로
    if (recentBirths.some(b=>ms - b.ms < 1200 && Math.hypot(b.cx-cx, b.cy-cy) < 3)) return null;
    const tr = nearestTrack(cx, cy, 1.6);
    const b = {id: bid++, cx, cy, n, t, ms, stage:0, kind, bg: BG ? bgCrop(cx, cy) : null, tid: tr ? tr.id : null, acc:{}, wsum:0, feats:[], colors:{red:0, blue:0}, side:null, emitted:false};
    if (b.tid) vidTrack.set(b.id, b.tid); if (vidTrack.size > 200) vidTrack.delete(vidTrack.keys().next().value);
    births.push(b); recentBirths.push({cx, cy, ms}); while (recentBirths.length > 30) recentBirths.shift();
    stats.births++;
    return b;
  }
  function stageCaptures(rgba, t, ms){
    for (const b of births){
      while (b.stage < STAGES.length && ms - b.ms >= STAGES[b.stage]){
        const tr = b.tid ? tracks.find(x=>x.id===b.tid) : null;
        const px = tr && tr.last >= ms - 300 ? tr.x : b.cx, py = tr && tr.last >= ms - 300 ? tr.y : b.cy;
        const cur = crop(rgba, px, py);
        const moved = Math.hypot(px-b.cx, py-b.cy) > 0.7, bg = moved || !b.bg ? bgCrop(px, py) : b.bg;
        const f = featurize(cur, bg, false), ff = featurize(cur, bg, true);
        teamColor(cur, bg, b.colors);
        b.feats.push({f, ff});
        const m = tpl.match(f, 2), w = STAGE_W[b.stage];
        for (const x of m){ b.acc[x.id] = (b.acc[x.id] || 0) + x.score*w; }
        b.wsum += w;
        if (b.stage === 0){ b.rgb = cur; b.side = decideSide(b); }
        if (b.stage === STAGES.length-1 && b.kind !== 'spell'){
          // 마지막 캡처 때 그 자리에 아무것도 없으면 '깜빡임'으로 기록
          const r = Math.floor(py), c = Math.floor(px); let alive = 0;
          for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++){ const rr=r+dr, cc=c+dc; if (rr>=0&&rr<GH&&cc>=0&&cc<GW && lastA && lastA[rr*GW+cc]) alive++; }
          if (!alive) for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++){ const rr=r+dr, cc=c+dc; if (rr>=0&&rr<GH&&cc>=0&&cc<GW) HEAT[rr*GW+cc] += dr||dc ? 0.5 : 1; }
          b.ephemeral = !alive;
        }
        else if (b.stage === 1) b.side = decideSide(b);
        const out = Object.keys(b.acc).map(id=>({id, score:b.acc[id]/b.wsum})).sort((a,c)=>c.score-a.score);
        const ev = {type: b.emitted ? 'refine' : 'deploy', vid:b.id, src:b.src || b.kind, ephemeral: !!b.ephemeral, colors: {red:b.colors.red, blue:b.colors.blue}, stage:b.stage, kind:b.kind, t:b.t, side:b.side, x:px, y:py, cands:out, rgb:b.rgb, feats:b.feats};
        b.emitted = true; b.stage++;
        cfg.onEvent && cfg.onEvent(ev);
      }
    }
    births = births.filter(b=>b.stage < STAGES.length && ms - b.ms < 3000);
  }
  // 진영: 위치(위/아래 절반) + 팀 색 증거
  function teamColor(rgb, bg, acc){
    for (let i=0;i<CROP*CROP;i++){
      const j=i*3, r=rgb[j], g=rgb[j+1], b=rgb[j+2];
      const d = Math.abs(r-bg[j]) + Math.abs(g-bg[j+1]) + Math.abs(b-bg[j+2]); if (d < 60) continue;
      if (r > 150 && r-g > 70 && r-b > 60) acc.red++;
      else if (b > 150 && b-r > 60 && b-g > 15) acc.blue++;
    }
  }
  function decideSide(b){
    if (b.kind === 'spell' && b.kingSide) return b.kingSide;
    const pos = b.cy < 16 ? 1 : -1, tot = b.colors.red + b.colors.blue;
    const col = tot >= 6 ? (b.colors.red - b.colors.blue) / (tot + 4) : 0;
    return pos*1.0 + col*1.6 > 0 ? 'top' : 'bottom';
  }

  /* ---- 추적 (유닛 실시간 위치 + 킹 타워 투사체) ---- */
  function track(blobs, t, ms, F, PF){
    const used = new Set(), growth = [], claims = new Map();
    // 어떤 덩어리에 이전 추적이 몇 개 붙는지 (두 유닛이 붙어서 커진 건 배치가 아님)
    for (const tr of tracks){ if (ms - tr.last > 250) continue; let bi = -1, bd = 1e9; blobs.forEach((b,i)=>{ const d = Math.hypot(b.cx-tr.x, b.cy-tr.y); if (d < bd){ bd = d; bi = i; } }); if (bi >= 0 && bd < 2.5) claims.set(bi, (claims.get(bi)||0) + 1); }
    for (const tr of tracks){
      let best = -1, bd = 1e9;
      const px = tr.x + tr.vx*(ms - tr.last)/1000, py = tr.y + tr.vy*(ms - tr.last)/1000;
      blobs.forEach((b,i)=>{ if (used.has(i)) return; const d = Math.hypot(b.cx-px, b.cy-py); if (d < bd){ bd = d; best = i; } });
      const gate = 1.6 + Math.min(3, Math.hypot(tr.vx, tr.vy)*0.25);
      if (best >= 0 && bd < gate){
        const b = blobs[best]; used.add(best);
        if (PF && b.n - tr.n >= 3 && (claims.get(best)||0) <= 1 && ms - tr.last < 250){
          let sumNow = 0, sumPrev = 0, newCells = [];
          for (const c of b.cells){ sumNow += F[c]; sumPrev += PF[c]; if (F[c] - PF[c] > stats.thr) newCells.push(c); }
          if (sumNow > sumPrev*1.4 && newCells.length >= 2){ let gx=0, gy=0; for (const c of newCells){ gx += c%GW+0.5; gy += ((c/GW)|0)+0.5; } growth.push({cx:gx/newCells.length, cy:gy/newCells.length, n:newCells.length, cells:newCells}); }
        }
        const dt = Math.max(0.03, (ms - tr.last)/1000);
        const vx = (b.cx - tr.x)/dt, vy = (b.cy - tr.y)/dt;
        tr.vx = tr.vx*0.4 + vx*0.6; tr.vy = tr.vy*0.4 + vy*0.6;
        tr.path += Math.hypot(b.cx-tr.x, b.cy-tr.y); tr.x = b.cx; tr.y = b.cy; tr.n = b.n; tr.last = ms; tr.hits++;
        const sp = Math.hypot(tr.vx, tr.vy);
        if (tr.kingSide && sp > 5) tr.fast++;
        if (tr.kingSide && tr.fast >= 2) tr.proj = true;
        if (tr.proj && sp < 1.2 && tr.path > 4) landSpell(tr, t);
      }
    }
    blobs.forEach((b,i)=>{
      if (used.has(i)) return;
      let ks = null;
      for (const s of ['top','bottom']){ const k = KINGS[s]; if (Math.hypot(b.cx-k.x, b.cy-k.y) < 3.6) ks = s; }
      tracks.push({id: tid++, x:b.cx, y:b.cy, vx:0, vy:0, n:b.n, born:ms, bornT:t, last:ms, hits:1, path:0, kingSide:ks, fast:0, proj:false, landed:false});
    });
    // 끊긴 추적: 날아가던 주문이면 마지막 위치에 착지
    for (const tr of tracks) if (tr.proj && !tr.landed && ms - tr.last > 220 && tr.path > 4) landSpell(tr, t);
    tracks = tracks.filter(tr=>ms - tr.last < 700);
    return growth;
  }
  function landSpell(tr, t){
    if (tr.landed) return; tr.landed = true; tr.proj = false;
    if (tr.path < 4 && tr.n < 4) return;
    const b = newBirth(tr.x, tr.y, tr.n, tr.bornT, tr.last, 'spell');
    if (b){ b.kingSide = tr.kingSide; b.tid = null; }
  }
  function nearestTrack(x, y, d){ let best = null, bd = d; for (const tr of tracks){ const dd = Math.hypot(tr.x-x, tr.y-y); if (dd < bd){ bd = dd; best = tr; } } return best; }

  /* ---- 격자 도우미 ---- */
  function components(M, isSeed, canGrow){
    const seen = new Uint8Array(GW*GH), out = [];
    for (let i=0;i<GW*GH;i++){
      if (!isSeed(i) || seen[i]) continue;
      const st = [i], cells = []; seen[i] = 1; let sx=0, sy=0;
      while (st.length){
        const j = st.pop(), r = (j/GW)|0, c = j%GW; cells.push(j); sx += c+0.5; sy += r+0.5;
        for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++){
          const rr=r+dr, cc=c+dc; if (rr<0||cc<0||rr>=GH||cc>=GW) continue; const k=rr*GW+cc;
          if (!seen[k] && (isSeed(k) || (canGrow && canGrow(k)))){ seen[k]=1; st.push(k); }
        }
      }
      out.push({cells, n:cells.length, cx:sx/cells.length, cy:sy/cells.length});
    }
    return out;
  }
  function orMasks(arr){ const o = new Uint8Array(GW*GH); for (const m of arr) for (let i=0;i<o.length;i++) if (m[i]) o[i]=1; return o; }
  function dilate(M, r){
    const o = new Uint8Array(GW*GH); if (!M) return o;
    for (let i=0;i<GW*GH;i++){ if (!M[i]) continue; const y=(i/GW)|0, x=i%GW;
      for (let dy=-r;dy<=r;dy++) for (let dx=-r;dx<=r;dx++){ const yy=y+dy, xx=x+dx; if (yy>=0&&xx>=0&&yy<GH&&xx<GW) o[yy*GW+xx]=1; } }
    return o;
  }
  function crop(rgba, cx, cy){
    const out = new Uint8Array(CROP*CROP*3), x0 = Math.round(cx*TPX - CROP/2), y0 = Math.round(cy*TPX - CROP/2);
    for (let y=0;y<CROP;y++){ const sy = Math.max(0, Math.min(IH-1, y0+y));
      for (let x=0;x<CROP;x++){ const sx = Math.max(0, Math.min(IW-1, x0+x)), k=(sy*IW+sx)*4, o=(y*CROP+x)*3; out[o]=rgba[k]; out[o+1]=rgba[k+1]; out[o+2]=rgba[k+2]; } }
    return out;
  }

  /* ---- 내 손패 ----
     - 4칸을 카드 그림과 비교. 엘릭서가 모자란 카드는 회색이 되므로 '현재 엘릭서로 낼 수 있는지'와
       '보이는 색(채도)'이 맞는 카드만 후보로 → 회색 카드도 정확히 구분
     - 낸 카드 판정: 엘릭서 하락 순간에 바뀐 칸 = 낸 카드 (비용이 맞는 칸 우선), 새 카드 = 직전 '다음 카드'
     - 엘릭서 바를 못 읽는 경우에만 '칸의 카드가 2프레임 연속 다른 카드로 읽힘'으로 판정 */
  const H = {last2:[null,null,null,null], tent:[false,false,false,false], diffRun:[0,0,0,0], stable:[null,null,null,null], cnt:[0,0,0,0], last:[null,null,null,null], miss:[0,0,0,0], live:[null,null,null,null], next:null, nextStable:null, nextCnt:0, conf:0};
  const SW = 24, SH = 30;
  function matchHand(feat, E){
    let best = null, bs = -2, second = -2;
    const grayLook = feat.sat < 0.16;
    for (const r of handRefs){
      if (handPool && !handPool.has(r.id)) continue;
      if (E != null && r.cost != null){
        // 회색으로 보이면 지금 엘릭서보다 비싼 카드, 색이 있으면 낼 수 있는 카드
        if (grayLook && r.cost <= E - 0.4) continue;
        if (!grayLook && r.cost > E + 0.4) continue;
      }
      const sc = grayLook ? handSim(feat, r.fg) : Math.max(handSim(feat, r.f), handSim(feat, r.fg)*0.92);
      if (r.id === best){ if (sc > bs) bs = sc; continue; }
      if (sc > bs){ second = bs; bs = sc; best = r.id; } else if (sc > second) second = sc;
    }
    return {id:best, score:bs, margin: bs - second, gray: grayLook};
  }
  function emitMy(i, t, conf, ref){
    const prev = H.stable[i]; if (!prev) return;
    cfg.onEvent && cfg.onEvent({type:'myplay', id:prev, t, slot:i, conf, ref, newCard: H.nextStable});
    H.stable[i] = H.nextStable && !H.stable.includes(H.nextStable) ? H.nextStable : null;
    H.tent[i] = true;     // 새 카드는 '임시' → 두 번 읽히면 확정, 다르게 읽히면 바로 고침
    H.cnt[i] = 0; H.miss[i] = 0; H.nextStable = null; H.nextCnt = 0;
  }
  function handFrame(t, ms){
    if (!calib.hand || !handRefs.length) return;
    const rgba = cfg.grab(calib.hand, SW*4, SH); if (!rgba) return;
    const E = EL.present && EL.vals.length ? EL.vals[EL.vals.length-1] : null;
    const res = [];
    for (let i=0;i<4;i++){
      const f = handFeat(rgba, SW*4, i*SW, 0, SW, SH, false);
      const m = matchHand(f, E);
      const ok = m.id && m.score >= (handPool ? 0.45 : 0.6) && m.margin >= (m.gray ? 0.025 : handPool ? 0.04 : 0.06);
      res.push(ok ? m : null);
    }
    let nx = null;
    if (calib.next){ const nr = cfg.grab(calib.next, 16, 20); if (nr){ const m = matchHand(handFeat(nr, 16, 0, 0, 16, 20, false), null); if (m.id && m.score >= 0.45 && m.margin >= 0.03 && !H.stable.includes(m.id)) nx = m; } }
    if (nx && nx.id === H.next) H.nextCnt++; else H.nextCnt = nx ? 1 : 0;
    H.next = nx ? nx.id : null; if (H.nextCnt >= 2) H.nextStable = H.next;
    let sum = 0, cnt = 0;
    const barOn = !!calib.bar && EL.present;
    for (let i=0;i<4;i++){
      const r = res[i]; H.live[i] = r ? r.id : null; if (r){ sum += r.score; cnt++; }
      if (r && r.id === H.last[i]) H.cnt[i]++; else H.cnt[i] = r ? 1 : 0;
      H.last[i] = r ? r.id : null;
      H.miss[i] = H.stable[i] && H.live[i] !== H.stable[i] ? H.miss[i] + 1 : 0;
      if (!H.stable[i]){ if (r && H.cnt[i] >= 2 && !H.stable.includes(r.id)){ H.stable[i] = r.id; H.tent[i] = false; } continue; }
      if (r && r.id === H.stable[i] && H.cnt[i] >= 2) H.tent[i] = false;
      // 칸 값 바로잡기: 임시 값이 다르게 2번, 또는 확정 값이 다른 카드로 6번 연속 읽히면 (낸 게 아니라 잘못 알고 있던 것)
      H.diffRun[i] = r && r.id !== H.stable[i] && r.id === H.last2[i] ? H.diffRun[i] + 1 : (r && r.id !== H.stable[i] ? 1 : 0);
      H.last2[i] = r ? r.id : null;
      if (r && r.id !== H.stable[i] && !H.stable.some((x,j)=>j!==i && x===r.id) && (H.tent[i] ? H.diffRun[i] >= 2 : H.diffRun[i] >= 6) && !(barOn && EL.lastDrop && !EL.lastDrop.assigned && ms - EL.lastDrop.ms < 1300)){
        H.stable[i] = r.id; H.tent[i] = false; H.miss[i] = 0; continue;
      }
      // 엘릭서 바가 없을 때: 다른 카드로 2프레임 연속 확실히 읽히면 냄
      if (!barOn && r && r.id !== H.stable[i] && H.cnt[i] >= 2 && !H.stable.some((x,j)=>j!==i && x===r.id)){
        H.nextStable = r.id; emitMy(i, t - 0.15, 0.8, null);
      }
    }
    // 엘릭서 하락과 연결
    const d = EL.lastDrop;
    if (barOn && d && !d.assigned && ms - d.ms < 1300){
      const cand = [0,1,2,3].filter(i=>H.stable[i] && H.miss[i] >= 1);
      if (cand.length){
        // 우선순위: 새로 보이는 카드가 직전 '다음 카드' > 비용이 하락량과 같음 > 방금 바뀐 칸(짧은 miss)
        const costOk = i=>{ const r = handRefs.find(x=>x.id===H.stable[i]); return r && r.cost === d.cost; };
        const score = i=>(H.nextStable && H.live[i] === H.nextStable ? 4 : 0) + (costOk(i) ? 2 : 0) + (H.live[i] && H.live[i] !== H.stable[i] ? 1 : 0) - Math.min(1, H.miss[i]/20);
        const pick = cand.sort((a,b)=>score(b)-score(a))[0];
        d.assigned = true; emitMy(pick, d.t, costOk(pick) ? 0.97 : 0.75, d.ref);
      }
    }
    H.conf = cnt ? sum/cnt : 0;
    cfg.onHand && cfg.onHand({slots: H.stable.slice(), next: H.nextStable, conf: H.conf, live: H.live.slice()});
  }

  /* ---- 엘릭서 바 ---- */
  const EL = {vals:[], hist:[], pendingDrop:null, lastDrop:null, seen:0, present:false, lastSeen:0};
  function barFrame(t, ms){
    if (!calib.bar) return;
    const rgba = cfg.grab(calib.bar, BAR_W, BAR_H); if (!rgba) return;
    let r = readBar(rgba);
    if (!r.present){
      // 엘릭서 0이면 분홍색이 없음 → 방금까지 바가 보였으면 '0'으로 (1.5초 넘게 안 보이면 바 없음)
      if (EL.present && ms - EL.lastSeen < 1500) r = {present:true, value:0};
      else { EL.seen = 0; EL.present = false; cfg.onElixir && cfg.onElixir({present:false, t, ms}); return; }
    } else EL.lastSeen = ms;
    EL.seen++; EL.present = EL.seen >= 3;
    EL.vals.push(r.value); if (EL.vals.length > 3) EL.vals.shift();
    const v = EL.vals.slice().sort((a,b)=>a-b)[EL.vals.length>>1];   // 중앙값
    EL.hist.push({ms, t, v: r.value}); EL.hist = EL.hist.filter(h=>ms - h.ms < 900);
    const peak = Math.max(...EL.hist.filter(h=>ms - h.ms > 80).map(h=>h.v), -1);
    // 큰 하락이 2프레임 연속 → 카드를 냄
    if (peak >= 0 && peak - r.value >= 0.8){
      if (EL.pendingDrop && ms - EL.pendingDrop.ms < 400){
        if (!EL.lastDrop || ms - EL.lastDrop.ms > 450){
          const cost = Math.max(1, Math.min(10, Math.round(EL.pendingDrop.peak - r.value)));
          EL.lastDrop = {ms, t: EL.pendingDrop.t, cost, base: r.value, ref: 'd'+ms, assigned:false};
          EL.hist = [{ms, t, v:r.value}];
          cfg.onEvent && cfg.onEvent({type:'drop', cost, t: EL.pendingDrop.t, ref: EL.lastDrop.ref});
        }
        EL.pendingDrop = null;
      } else EL.pendingDrop = {ms, t, peak};
    } else EL.pendingDrop = null;
    // 되돌림: 1초 안에 회복 속도보다 훨씬 빨리 원래대로 → 드래그 미리보기였음
    if (EL.lastDrop && ms - EL.lastDrop.ms < 1000 && r.value - EL.lastDrop.base >= EL.lastDrop.cost - 0.35 && (ms - EL.lastDrop.ms) < 700){
      cfg.onEvent && cfg.onEvent({type:'dropUndo', ref: EL.lastDrop.ref}); EL.lastDrop = null;
    }
    cfg.onElixir && cfg.onElixir({present: EL.present, value: v, raw: r.value, t, ms});
  }

  return {
    process(t, ms){
      if (!calib) return;
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      frameNo++; stats.frames++;
      try{ barFrame(t, ms); }catch(e){}
      try{ handFrame(t, ms); }catch(e){}
      if (!cfg.arenaActive || cfg.arenaActive()) { try{ arenaFrame(t, ms); }catch(e){ stats.err = String(e && e.message || e); if (cfg.debug) throw e; } }
      stats.ms = stats.ms*0.9 + ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0)*0.1;
    },
    setCalib(c){ const ch = JSON.stringify(c) !== JSON.stringify(calib); calib = c; if (ch) this.reset(); },
    reset(){ prevL = null; BG = null; HEAT.fill(0); lastA = null; masks.length = 0; hist.length = 0; tracks = []; births = []; cands = []; recentBirths.length = 0;
      H.stable = [null,null,null,null]; H.cnt = [0,0,0,0]; H.miss = [0,0,0,0]; H.tent = [false,false,false,false]; H.diffRun = [0,0,0,0]; H.last2 = [null,null,null,null]; H.nextStable = null; EL.vals = []; EL.hist = []; EL.lastDrop = null; EL.pendingDrop = null; },
    templates: tpl,
    setHandRefs(refs){ handRefs = refs; },
    setHandPool(ids){ handPool = ids && ids.length ? new Set(ids) : null; },
    hand(){ return {slots:H.stable.slice(), next:H.nextStable, conf:H.conf}; },
    // 배치에 연결된 추적의 현재 위치 (전술판에 실제 위치 표시)
    liveTrack(vid, ms){ const id = vidTrack.get(vid); if (!id) return null; const tr = tracks.find(x=>x.id===id); return tr && (ms == null || ms - tr.last < 400) ? {x:tr.x, y:tr.y, at:tr.last} : null; },
    tracksNear(x, y, d, ms){ const tr = nearestTrack(x, y, d); return tr && (ms == null || ms - tr.last < 400) ? {x:tr.x, y:tr.y, at:tr.last} : null; },
    tracks(){ return tracks.map(t=>({id:t.id, x:t.x, y:t.y, n:t.n, proj:t.proj})); },
    stats,
  };
}

return {Vision, TemplateStore, featurize, simF, handFeat, handSim, readBar, upscale24, isPink, GW, GH, IW, IH, CROP, BAR_W, BAR_H};
})();
if (typeof module !== 'undefined') module.exports = VISION;
