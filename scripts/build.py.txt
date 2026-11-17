# src/ 의 원본을 합쳐 www/index.html (단일 파일 웹앱)을 만들어요.
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
s = root/'src'
t = (s/'index.tpl.html').read_text(encoding='utf-8')
for k,f in [('/*STYLE*/','style.css'),('/*DATA*/','data.js'),('/*VISION*/','vision.js'),('/*LOGIC*/','logic.js'),('/*ARENA*/','arena3d.js'),('/*UI*/','ui.js')]:
    t = t.replace(k,(s/f).read_text(encoding='utf-8'))
(root/'www').mkdir(exist_ok=True)
(root/'www'/'index.html').write_text(t, encoding='utf-8')
print('www/index.html', len(t))
