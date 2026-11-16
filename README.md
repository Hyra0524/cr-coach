# CR 코치 — 앱 빌드 안내

하나의 웹앱(`src/`)으로 안드로이드(APK), iOS(IPA), Windows(EXE), macOS(DMG)를 모두 만들어요.

## 폴더 구조
- `src/` — 앱 원본 (데이터·로직·3D 아레나·화면). 수정은 여기서.
- `scripts/build.py` — `src/`를 합쳐 `www/index.html`(단일 파일)을 만들어요.
- `android-src/` + `scripts/patch-android.js` — 안드로이드 휴대폰 화면 실시간 코치(화면 녹화 + 게임 위 코치 창). 빌드 때 자동으로 들어가요.
- `scripts/fetch-cards.js` — 빌드 때 카드 이미지를 내려받아 앱에 넣어요(오프라인에서도 카드 그림 표시).
- `electron/` — Windows·macOS 데스크톱 앱 (미러링 창 선택, 항상 위 미니 창, 뉴스 실시간 수집).
- `capacitor.config.json` — 안드로이드·iOS 앱 설정.
- `.github/workflows/build.yml` — GitHub에 올리면 4종 설치 파일을 자동으로 빌드.

## 가장 쉬운 방법: GitHub 자동 빌드
1. GitHub에 새 저장소를 만들고 이 폴더 전체를 올려요.
2. 저장소 → Actions 탭 → "앱 빌드" → **Run workflow**를 누르면 약 15~25분 뒤 Artifacts에 `CR-Coach.apk`, `CR-Coach.ipa`, `CR-Coach-Setup.exe`, `CR-Coach.dmg`가 생겨요.
3. `v1.0.0` 같은 태그를 올리면 Releases 페이지에 설치 파일이 자동으로 올라가요. 그 주소를 `src/data.js`의 `DOWNLOADS`에 넣으면 앱 안 [📲 앱 설치] 버튼이 연결돼요.

## 플랫폼별 메모
| 플랫폼 | 결과물 | 비고 |
|---|---|---|
| Android | `CR-Coach.apk` | 기본은 디버그 서명(바로 설치 가능). 스토어 배포용은 저장소 Secrets에 `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`를 넣으면 릴리스 서명돼요. |
| iOS | `CR-Coach.ipa` | 서명 없는 테스트용 IPA. PC/Mac의 Sideloadly(또는 AltStore)에 끌어놓고 무료 Apple ID로 설치 → 설정에서 개발자 '신뢰' + 개발자 모드 켜기. 무료 ID는 7일마다 재설치. 정식 배포(Ad-hoc·TestFlight)는 Apple 개발자 계정(연 99달러) 서명 단계를 추가해야 해요. |
| Windows | `CR-Coach-Setup.exe` | 코드 서명 인증서가 없으면 SmartScreen 경고가 떠요([추가 정보] → [실행]). |
| macOS | `CR-Coach.dmg` | 공증(notarize)이 없으면 처음 실행 시 우클릭 → [열기]. 화면 기록 권한 필요. |

## 기능 차이
- **PC 앱(추천)**: 휴대폰 미러링 창 자동 인식, 항상 위 미니 창, 실시간 뉴스.
- **안드로이드 앱**: [📱 휴대폰 실시간 코치 시작] → 같은 휴대폰 화면을 초당 8장 읽어서 게임 위 코치 창에 상대·내 엘릭서, 낼 카드와 위치를 띄우고 음성으로 알려줘요. 게임 중 입력 없음. 내 엘릭서는 화면의 엘릭서 바를 직접 읽고, 엘릭서가 줄어든 양으로 내가 낸 카드를 기록해요. 경기가 끝나면 확신이 낮았던 장면만 앱에서 골라주면 다음부터 자동 인식돼요.
- **iOS 앱**: 지금 버전은 같은 휴대폰 화면 읽기가 없어요. iOS도 '화면 기록 방송(ReplayKit) 확장'으로 화면을 읽는 건 가능하지만, 다른 앱 위에 창을 띄울 수는 없어서 음성 코칭 전용이 돼요. 다음 단계에서 추가할 수 있어요.

## 로컬에서 직접 빌드하려면
```bash
npm install
python3 scripts/build.py
npm start                 # PC 앱 실행
npm run dist:win          # Windows 설치 파일 (Windows에서)
npm run dist:mac          # macOS DMG (Mac에서)
npx cap add android && npm run android:debug   # Android Studio + JDK 21 필요
npx cap add ios && npx cap open ios            # Xcode 필요 (Mac)
```

이 앱은 팬이 만든 비공식 도구이며 Supercell과 제휴·후원·승인 관계가 없습니다.
