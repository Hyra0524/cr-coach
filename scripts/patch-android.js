// npx cap add android 뒤에 실행: 화면 실시간 코치(네이티브) 코드와 권한을 안드로이드 프로젝트에 넣는다.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const dst = path.join(root, 'android/app/src/main/java/com/crcoach/app');
fs.mkdirSync(dst, {recursive: true});
for (const f of fs.readdirSync(path.join(root, 'android-src'))) {
  if (f.endsWith('.java')) fs.copyFileSync(path.join(root, 'android-src', f), path.join(dst, f));
}
const mf = path.join(root, 'android/app/src/main/AndroidManifest.xml');
let m = fs.readFileSync(mf, 'utf8');
const perms = ['android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION', 'android.permission.POST_NOTIFICATIONS',
  'android.permission.WAKE_LOCK'];
for (const p of perms) if (!m.includes(p)) m = m.replace('</manifest>', `    <uses-permission android:name="${p}" />\n</manifest>`);
if (!m.includes('ScreenCoachService')) {
  m = m.replace('</application>', '        <service android:name=".ScreenCoachService" android:exported="false" android:foregroundServiceType="mediaProjection" />\n    </application>');
}
fs.writeFileSync(mf, m);
const gf = path.join(root, 'android/app/build.gradle');
let g = fs.readFileSync(gf, 'utf8');
if (!g.includes('androidx.webkit:webkit')) {
  g = g.replace(/dependencies\s*\{/, 'dependencies {\n    implementation "androidx.webkit:webkit:1.12.1"');
}
fs.writeFileSync(gf, g);
console.log('patch-android: native screen coach installed');
