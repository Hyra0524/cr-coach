// 렌더러(웹앱)에 데스크톱 기능을 안전하게 노출
const { contextBridge, ipcRenderer } = require('electron');

function pickerUI(sources){
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:Noto Sans KR,sans-serif';
    const box = document.createElement('div');
    box.style.cssText = 'background:#eaf2ff;border:3px solid #0d2a63;border-radius:16px;padding:14px;max-width:900px;max-height:80vh;overflow:auto';
    box.innerHTML = '<div style="font-size:18px;font-weight:900;margin-bottom:10px">휴대폰 미러링 창을 고르세요</div>';
    const grid = document.createElement('div'); grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px';
    const score = s => /scrcpy|iphone|mirror|미러|sm-|galaxy|pixel/i.test(s.name) ? 0 : 1;
    sources.sort((a,b)=>score(a)-score(b)).forEach(s => {
      const b = document.createElement('button');
      b.style.cssText = 'background:#fff;border:2px solid #b8c8e6;border-radius:10px;padding:6px;cursor:pointer;text-align:left';
      b.innerHTML = `<img src="${s.thumb}" style="width:100%;border-radius:6px"><div style="font-size:12px;font-weight:700;margin-top:4px">${s.name.replace(/</g,'&lt;')}</div>`;
      b.onclick = () => { wrap.remove(); resolve(s.id); };
      grid.appendChild(b);
    });
    const cancel = document.createElement('button'); cancel.textContent = '취소';
    cancel.style.cssText = 'margin-top:10px;padding:6px 14px;border-radius:8px;border:2px solid #0b1530;background:#ff7b7b;color:#fff;font-weight:900;cursor:pointer';
    cancel.onclick = () => { wrap.remove(); resolve(null); };
    box.appendChild(grid); box.appendChild(cancel); wrap.appendChild(box); document.body.appendChild(wrap);
  });
}

contextBridge.exposeInMainWorld('crNative', {
  platform: 'desktop',
  fetchText: url => ipcRenderer.invoke('fetch-text', url),
  pickSource: async () => {
    const sources = await ipcRenderer.invoke('list-sources');
    const id = await pickerUI(sources);
    if (!id) throw new Error('cancel');
    await ipcRenderer.invoke('choose-source', id);
    return id;
  },
  miniMode: on => ipcRenderer.invoke('mini-mode', on),
});
