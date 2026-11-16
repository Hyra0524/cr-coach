/* =========================================================
   3D 아레나 — 캔버스 원근 투영으로 그리는 실시간 전술판
   좌표: 가로 0~18, 세로 0~32 타일 (0 = 상대 진영 끝)
   ========================================================= */
function Arena3D(canvas, opts){
  const ctx = canvas.getContext('2d');
  const o = Object.assign({pitch:55, camY:42, camZ:40, fov:1.36, cy:0.42}, opts||{});
  let W=0, H=0, F=0, cos=0, sin=0;
  let state = {opp:[], mine:[], recs:[], paths:[], hint:''};
  let getImg = ()=>null;

  function resize(){
    const r = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(260, Math.round(r.width)), h = Math.round(w * 1.02);
    canvas.style.width = w+'px'; canvas.style.height = h+'px';
    canvas.width = w*dpr; canvas.height = h*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
    W = w; H = h; F = H * o.fov;
    const th = o.pitch*Math.PI/180; cos = Math.cos(th); sin = Math.sin(th);
  }
  function P(X, Y, Z){
    const rx = X-9, ry = Y-o.camY, rz = (Z||0)-o.camZ;
    const depth = -(ry*cos + rz*sin);
    const up = -ry*sin + rz*cos;
    return {x: W/2 + F*rx/depth, y: H*o.cy - F*up/depth, d: depth, s: F/depth};
  }
  function quad(pts, fill, stroke){
    ctx.beginPath(); pts.forEach((p,i)=> i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.closePath();
    if (fill){ ctx.fillStyle = fill; ctx.fill(); }
    if (stroke){ ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }
  function box(x0,y0,x1,y1,h,top,side,front){
    const b = [P(x0,y0,0),P(x1,y0,0),P(x1,y1,0),P(x0,y1,0)], t = [P(x0,y0,h),P(x1,y0,h),P(x1,y1,h),P(x0,y1,h)];
    const cxm = (x0+x1)/2;
    if (cxm < 9) quad([b[1],b[2],t[2],t[1]], side); else quad([b[0],b[3],t[3],t[0]], side);
    quad([b[3],b[2],t[2],t[3]], front);
    quad(t, top, 'rgba(0,0,0,.35)');
  }
  function tower(x0,y0,x1,y1,h,team){
    const c = team==='me' ? ['#7cc0ff','#2c6fd1','#3f86e8'] : ['#ff9a8a','#c23a32','#e0574d'];
    box(x0,y0,x1,y1,h*0.55,'#cfc3a8','#8d7f63','#a99a7b');
    box(x0+0.3,y0+0.3,x1-0.3,y1-0.3,h, c[0], c[1], c[2]);
    const p = P((x0+x1)/2,(y0+y1)/2,h+0.05);
    ctx.fillStyle = team==='me' ? '#0d3b8a' : '#7a1212';
    ctx.beginPath(); ctx.arc(p.x,p.y, Math.max(3,p.s*0.35), 0, Math.PI*2); ctx.fill();
  }
  function ground(){
    const g = ctx.createLinearGradient(0,0,0,H); g.addColorStop(0,'#2a5bb5'); g.addColorStop(1,'#123275');
    ctx.fillStyle = g; ctx.fillRect(0,0,W,H);
    // 바깥 테두리 (돌길)
    quad([P(-1,-1),P(19,-1),P(19,33),P(-1,33)], '#b7a37c');
    for (let y=0;y<32;y++) for (let x=0;x<18;x++){
      const river = (y===15||y===16), bridge = river && ((x>=2&&x<=4)||(x>=13&&x<=15));
      let col;
      if (bridge) col = (x+y)%2 ? '#a8783f' : '#b5844a';
      else if (river) col = (x+y)%2 ? '#3d9be6' : '#48a6ee';
      else col = (x+y)%2 ? '#79c552' : '#6dba49';
      if (!river && y >= 17) col = (x+y)%2 ? '#7fcb57' : '#72bf4d';
      quad([P(x,y),P(x+1,y),P(x+1,y+1),P(x,y+1)], col);
    }
    // 진영 표시 라인
    ctx.setLineDash([4,4]); ctx.strokeStyle='rgba(255,255,255,.35)'; ctx.lineWidth=1.2;
    const a=P(9,0), b=P(9,32); ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke(); ctx.setLineDash([]);
  }
  function ring(x,y,r,color,t){
    const pts=[]; for (let i=0;i<24;i++){ const a=i/24*Math.PI*2; pts.push(P(x+Math.cos(a)*r, y+Math.sin(a)*r, 0.02)); }
    ctx.lineWidth = 3; quad(pts, color.replace('1)', (0.18+0.12*Math.sin(t*5)).toFixed(2)+')'), null);
    ctx.beginPath(); pts.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.closePath(); ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.stroke();
  }
  function unit(u, kind, t){
    const base = P(u.x, u.y, 0), top = P(u.x, u.y, 2.0);
    const sz = Math.max(18, base.s * (kind==='rec'?1.9:1.6));
    ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.beginPath(); ctx.ellipse(base.x, base.y, sz*0.45, sz*0.16, 0, 0, Math.PI*2); ctx.fill();
    const bob = kind==='rec' ? Math.sin(t*4)*3 : 0;
    const x = top.x - sz/2, y = top.y - sz/2 + bob;
    const col = kind==='opp' ? '#e0403a' : kind==='rec' ? '#3fdd5a' : '#3d8bff';
    ctx.globalAlpha = kind==='rec' ? 0.92 : 1;
    ctx.fillStyle = col; roundRect(x-3, y-3, sz+6, sz*1.2+6, 6); ctx.fill();
    const img = getImg(u.id);
    if (img && img.complete && img.naturalWidth){ ctx.save(); roundRect(x, y, sz, sz*1.2, 5); ctx.clip(); ctx.drawImage(img, x, y, sz, sz*1.2); ctx.restore(); }
    else { ctx.fillStyle = '#1c3470'; roundRect(x, y, sz, sz*1.2, 5); ctx.fill();
      ctx.fillStyle='#fff'; ctx.font=`900 ${Math.max(9,sz*0.26)}px "Noto Sans KR",sans-serif`; ctx.textAlign='center'; ctx.textBaseline='middle';
      const nm = (u.name||'').slice(0,4); ctx.fillText(nm, x+sz/2, y+sz*0.6); }
    ctx.globalAlpha = 1;
    // 기둥
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, y+sz*1.2+3); ctx.stroke();
    if (u.label){
      ctx.font = `900 ${Math.max(10, sz*0.32)}px "Noto Sans KR",sans-serif`; ctx.textAlign='center'; ctx.textBaseline='bottom';
      const tw = ctx.measureText(u.label).width + 10;
      ctx.fillStyle = 'rgba(6,19,53,.88)'; roundRect(top.x - tw/2, y - sz*0.42 - 4, tw, sz*0.42, 6); ctx.fill();
      ctx.fillStyle = kind==='rec' ? '#b9ff8f' : kind==='opp' ? '#ffb4b0' : '#cfe0ff';
      ctx.fillText(u.label, top.x, y - 6);
    }
  }
  function roundRect(x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
  function path(pts){
    if (!pts || pts.length < 2) return;
    ctx.setLineDash([7,5]); ctx.strokeStyle='rgba(255,90,80,.9)'; ctx.lineWidth=3; ctx.beginPath();
    pts.forEach((q,i)=>{ const p=P(q.x,q.y,0.05); i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y); }); ctx.stroke(); ctx.setLineDash([]);
  }
  function render(t){
    t = t || performance.now()/1000;
    if (!W) resize();
    ground();
    tower(7,0.5,11,4.5,2.6,'opp'); tower(2,5,5,8,2.1,'opp'); tower(13,5,16,8,2.1,'opp');
    state.paths.forEach(path);
    const items = [];
    state.recs.forEach(u=>{ ring(u.x, u.y, 1.1, 'rgba(63,221,90,1)', t); items.push([u,'rec']); });
    state.opp.forEach(u=>items.push([u,'opp']));
    state.mine.forEach(u=>items.push([u,'mine']));
    tower(2,24,5,27,2.1,'me'); tower(13,24,16,27,2.1,'me');
    tower(7,27.5,11,31.5,2.6,'me');
    items.sort((a,b)=>a[0].y-b[0].y).forEach(([u,k])=>unit(u,k,t));
    if (state.hint){
      ctx.font='900 14px "Noto Sans KR",sans-serif'; ctx.textAlign='center'; ctx.textBaseline='top';
      const tw = ctx.measureText(state.hint).width + 18;
      ctx.fillStyle='rgba(6,19,53,.85)'; roundRect(W/2-tw/2, 8, tw, 26, 9); ctx.fill();
      ctx.fillStyle='#ffe36b'; ctx.fillText(state.hint, W/2, 13);
    }
  }
  function pick(clientX, clientY){
    const r = canvas.getBoundingClientRect(); const mx = clientX - r.left, my = clientY - r.top;
    let best = null, bd = 1e9;
    for (let y=0;y<32;y++) for (let x=0;x<18;x++){ const p = P(x+0.5,y+0.5,0); const d=(p.x-mx)**2+(p.y-my)**2; if (d<bd){ bd=d; best={x:x+0.5,y:y+0.5}; } }
    return best;
  }
  window.addEventListener('resize', ()=>{ resize(); });
  return { resize, render, pick, set(s){ state = Object.assign({opp:[],mine:[],recs:[],paths:[],hint:''}, s); }, setImageSource(fn){ getImg = fn; }, project:P };
}
if (typeof module !== 'undefined') module.exports = {Arena3D};
