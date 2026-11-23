# 현장 웨이포인트 (Mavic 4 Pro / DJI Fly용)

스마트폰을 들고 현장 지점에 가서 **📍 등록** 버튼을 누르면 웨이포인트가 쌓이고,
DJI Fly에 넣을 수 있는 **KMZ(WPML)** 파일을 만들어 주는 웹앱입니다. 서버나 빌드 과정이 필요 없는 정적 파일입니다.

## 구성

| 파일 | 역할 |
|---|---|
| `index.html`, `css/style.css` | 화면 (등록 / 목록·지도 / 내보내기 / 가이드) |
| `js/app.js` | GPS 측정, 튜토리얼, 실시간 안내, 저장(브라우저 localStorage) |
| `js/wpml.js` | DJI WPML KMZ 생성 (템플릿 KMZ의 웨이포인트만 교체) |
| `js/zip.js` | KMZ(zip) 읽기/쓰기 (외부 라이브러리 없음) |
| `sw.js`, `manifest.webmanifest` | 홈 화면 설치(PWA), 오프라인 사용 |

## 배포 (HTTPS 필수)

휴대폰 브라우저는 **https:// 주소에서만 GPS를 허용**합니다.

이 저장소는 **GitHub Pages**(main 브랜치 루트)로 배포됩니다: **https://somyun.github.io/drone/**
main에 push하면 1~2분 뒤 자동으로 반영됩니다. 휴대폰에서 예전 화면이 보이면 새로고침을 두 번 하세요(오프라인 캐시 때문).

배포한 주소를 휴대폰에서 열고, 브라우저 메뉴 › **홈 화면에 추가**하면 앱처럼 쓸 수 있습니다.
지도는 인터넷이 필요하지만, 등록·KMZ 생성은 한 번 열어 둔 뒤엔 오프라인에서도 동작합니다.

**연습 모드**: 주소 끝에 `?demo`를 붙이면(예: `https://…/?demo`) 가짜 GPS로 실내에서 사용법을 익힐 수 있습니다.

PC에서 직접 확인할 때 (저장소 폴더에서):
```powershell
python -m http.server 8765
```
(→ http://localhost:8765/?demo)

## DJI Fly에 넣는 원리

DJI Fly에는 공식 **파일 가져오기 기능이 없습니다**. 그래서 커뮤니티에서 쓰는 방법을 그대로 따릅니다.

1. DJI Fly에서 웨이포인트 2개짜리 **더미 미션**을 만들어 저장합니다.
2. 조종기의 `Android/data/dji.go.v5/files/waypoint/<긴 이름>/<긴 이름>.kmz` 파일을 PC로 복사합니다.
3. 이 앱의 **내보내기 › 템플릿 KMZ**에 그 파일을 넣고 **KMZ 만들기**를 누르면 같은 이름의 파일이 만들어집니다.
4. 만든 파일로 원래 파일을 **덮어쓰고** DJI Fly를 다시 실행합니다.

### RC Pro 2 단독 (PC 없이)

DJI RC Pro 2는 안드로이드 11 기기라서 조종기 브라우저로 이 앱을 열 수 있습니다.
기본 파일 탐색기에서는 `Android/data`가 보이지 않으므로 **Total Commander**를 씁니다.

- **처음 한 번 설치**: 조종기에 플레이스토어가 없으므로 PC에서 `adb install`로 설치합니다. 공식 배포처인 개발자 F-Droid 저장소 `chrisgch/tca`에서 받으며, 3.62d 기준 최소 안드로이드 2.2입니다.
  - 최신 CX 파일 탐색기는 안드로이드 12L(SDK 32) 이상이 필요해서 설치되지 않습니다.
- **처음 `Android › data`를 열 때**: 시스템 화면에서 “이 폴더 사용 → 허용”을 누릅니다.
- **매번 하는 일**: 조종기로 현장 등록 → KMZ 만들기(`Download`에 저장) → Total Commander로 `waypoint/<같은 이름 폴더>`에 덮어쓰기 → DJI Fly 재실행

템플릿을 쓰면 기체 정보(`droneEnumValue`)와 WPML 버전을 DJI Fly가 만든 그대로 유지합니다.
자세한 단계는 앱의 **가이드** 탭에 조종기 종류별로 나와 있습니다.

### 실제 DJI Fly(Mavic 4 Pro + RC 2) 파일에서 확인한 형식

생성기(`js/wpml.js`)는 아래 형식에 맞춰 만듭니다.

- 네임스페이스는 `http://www.uav.com/wpmz/1.0.2`, `droneEnumValue`는 `68`
- 미션 폴더 구조: `waypoint/<UUID>/<UUID>.kmz`, `waypoint/<UUID>/image/` (지점 사진 미리보기 + `ShotSnap.json`)
- KMZ 안에는 `wpmz/template.kml`(미션 설정만)과 `wpmz/waylines.wpml`(웨이포인트 전체)이 있음
- 도착 동작: `actionGroup`(id 1, `reachPoint`, `parallel`) 하나에 `takePhoto`, `gimbalRotate`, `hover`가 함께 들어감. 지점당 여러 동작이 가능함
- 구간 짐벌: `gimbalEvenlyRotate`(id 2, i → i+1)로 다음 지점의 각도까지 천천히 회전
- 기수 방향: `waypointHeadingMode=smoothTransition` + 지점별 각도. 이 앱은 기본으로 **다음 지점 방향**을 계산해서 넣음
- 경로: `toPointAndStopWithContinuityCurvature`(지점마다 정지)

템플릿 없이 만드는 기능도 이 구조를 따라 만들지만, 실험적 기능으로 남겨 두었습니다.

## 높이 기준

- 입력하는 높이는 DJI Fly 기본값과 같은 **이륙 지점 기준(relativeToStartPoint)**입니다.
- **🛫 이륙 지점 기록**을 해 두면 현재 위치와의 지면 고도차를 참고용으로 보여 줍니다. 휴대폰 GPS 고도는 오차가 ±10m 이상이라 참고용으로만 쓰세요.

## 주의 / 첫 비행 전 확인

- 이 방식은 **비공식**입니다. DJI Fly가 업데이트되면 동작이 바뀔 수 있습니다.
- 첫 미션은 **넓고 안전한 곳에서 짧게** 시험하세요. 확인할 것은 다음과 같습니다.
  - 미션 목록에 보이는지, 지점 위치·순서·높이가 맞는지
  - 사진·대기 동작, 짐벌 각도, 기수 방향이 의도대로 실행되는지
  - **녹화 시작/종료**는 실제 DJI Fly 파일에서 아직 형식을 확인하지 못했습니다. 첫 시험 때 꼭 확인하세요.
- 비행금지·제한구역과 국내 고도 제한(150m)을 지키세요. 장애물 회피는 켜 두세요.
