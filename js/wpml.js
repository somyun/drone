// DJI WPML(KMZ) 생성기 — DJI Fly(RC 2)가 실제로 만든 파일 형식에 맞춤
//
// 권장 방식: DJI Fly에서 만든 '더미 미션' KMZ를 템플릿으로 읽어서
//   - 기체 정보(droneEnumValue), WPML 네임스페이스/버전, 파일 구조는 그대로 두고
//   - 웨이포인트(Placemark)만 우리 데이터로 교체한다.
//
// 실제 DJI Fly(Mavic 4 Pro, RC 2) 파일에서 확인한 형식:
//   - 네임스페이스 http://www.uav.com/wpmz/1.0.2, droneEnumValue 68
//   - 도착 동작은 actionGroup(id 1, reachPoint, parallel) 하나에 takePhoto + gimbalRotate + hover 를 함께 넣음
//   - 구간 사이 짐벌 각도는 gimbalEvenlyRotate(id 2, i → i+1)로 다음 지점 각도까지 천천히 회전
//   - 기수 방향은 waypointHeadingMode=smoothTransition + 지점별 각도
//   - actionId는 파일 전체에서 1부터 차례로 증가

import { readZip, writeZip } from './zip.js';

const KML_NS = 'http://www.opengis.net/kml/2.2';
const DEFAULT_WPML_NS = 'http://www.uav.com/wpmz/1.0.2';
export const DEFAULT_DRONE_ENUM = '68'; // RC 2 + Mavic 4 Pro로 만든 실제 미션에서 확인된 값

export const ACTIONS = {
  none: '동작 없음',
  photo: '사진 촬영',
  startRecord: '녹화 시작',
  stopRecord: '녹화 종료',
  hover: '호버링(대기)',
};

// ---------- 거리/방위 ----------
const toRad = (d) => (d * Math.PI) / 180;
export function distanceM(a, b) {
  const R = 6371008.8;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
/** a → b 방위각 (-180 ~ 180, 북=0, 동=90) */
export function bearing(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  let d = (Math.atan2(y, x) * 180) / Math.PI;
  if (d > 180) d -= 360;
  return d;
}

export function missionStats(mission) {
  const pts = mission.points;
  let dist = 0;
  for (let i = 1; i < pts.length; i++) {
    const h = distanceM(pts[i - 1], pts[i]);
    const v = (pts[i].height ?? 0) - (pts[i - 1].height ?? 0);
    dist += Math.sqrt(h * h + v * v);
  }
  const speed = Math.max(0.5, Number(mission.settings.speed) || 5);
  const stopPenalty = mission.settings.pathMode === 'curve' ? 0 : 3; // 지점마다 감속·정지 대략치
  const hover = pts.reduce((s, p) => s + (p.action === 'hover' ? Number(p.hoverSec) || 0 : 0), 0);
  const duration = dist / speed + pts.length * stopPenalty + hover;
  const maxH = pts.reduce((m, p) => Math.max(m, Number(p.height) || 0), 0);
  return { dist, duration, maxH };
}

// ---------- 템플릿 읽기 ----------
function decode(u8) { return new TextDecoder().decode(u8); }

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('KML/WPML 파싱 실패: ' + err.textContent.slice(0, 120));
  return doc;
}

function detectWpmlNs(doc) {
  const root = doc.documentElement;
  for (const a of root.attributes) if (a.name === 'xmlns:wpml') return a.value;
  for (const el of doc.getElementsByTagName('*')) if (el.prefix === 'wpml') return el.namespaceURI;
  return DEFAULT_WPML_NS;
}

/** 템플릿 KMZ(ArrayBuffer) 분석 */
export async function parseTemplate(buffer, filename) {
  const files = await readZip(buffer);
  const tpl = files.find((f) => /(^|\/)template\.kml$/i.test(f.name));
  const wl = files.find((f) => /(^|\/)waylines\.wpml$/i.test(f.name));
  if (!tpl && !wl) throw new Error('KMZ 안에 wpmz/template.kml 또는 wpmz/waylines.wpml이 없습니다. DJI Fly에서 만든 웨이포인트 파일인지 확인하세요.');
  const mainDoc = parseXml(decode((wl || tpl).data));
  const ns = detectWpmlNs(mainDoc);
  const txt = (local) => mainDoc.getElementsByTagNameNS(ns, local)[0]?.textContent?.trim() ?? null;
  const placemarks = mainDoc.getElementsByTagNameNS(KML_NS, 'Placemark').length;
  return {
    filename,
    files: files.map((f) => ({ name: f.name, data: f.data })),
    info: {
      wpmlNs: ns,
      wpmlVersion: (ns.match(/wpmz\/([\d.]+)/) || [])[1] || '?',
      droneEnum: txt('droneEnumValue'),
      droneSubEnum: txt('droneSubEnumValue'),
      heightMode: txt('executeHeightMode'),
      placemarks,
      author: txt('author'),
      fileList: files.map((f) => f.name),
    },
  };
}

// ---------- XML 조작 도우미 ----------
function childW(el, ns, local) {
  for (const c of el.children) if (c.namespaceURI === ns && c.localName === local) return c;
  return null;
}
function setChildW(el, ns, local, value) {
  const c = el && childW(el, ns, local);
  if (c) c.textContent = String(value);
  return !!c;
}
function setAllW(doc, ns, local, value) {
  for (const e of doc.getElementsByTagNameNS(ns, local)) e.textContent = String(value);
}
function fragment(doc, ns, xml) {
  const wrap = parseXml(`<r xmlns="${KML_NS}" xmlns:wpml="${ns}">${xml}</r>`);
  return [...wrap.documentElement.children].map((n) => doc.importNode(n, true));
}
const fmt = (n, d = 8) => Number(n).toFixed(d).replace(/\.?0+$/, '') || '0';
const hasVal = (v) => v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v));

// ---------- 동작(Action) XML : DJI Fly 형식 ----------
function actionXml(id, func, paramXml) {
  return `<wpml:action><wpml:actionId>${id}</wpml:actionId><wpml:actionActuatorFunc>${func}</wpml:actionActuatorFunc><wpml:actionActuatorFuncParam>${paramXml}</wpml:actionActuatorFuncParam></wpml:action>`;
}
const PAYLOAD = '<wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>';
function gimbalRotateXml(id, pitch) {
  return actionXml(id, 'gimbalRotate',
    '<wpml:gimbalHeadingYawBase>aircraft</wpml:gimbalHeadingYawBase>' +
    '<wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>' +
    `<wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable><wpml:gimbalPitchRotateAngle>${fmt(pitch, 1)}</wpml:gimbalPitchRotateAngle>` +
    '<wpml:gimbalRollRotateEnable>1</wpml:gimbalRollRotateEnable><wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>' +
    '<wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable><wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>' +
    '<wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable><wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>' + PAYLOAD);
}
function gimbalEvenlyXml(id, pitch) {
  return actionXml(id, 'gimbalEvenlyRotate',
    `<wpml:gimbalPitchRotateAngle>${fmt(pitch, 1)}</wpml:gimbalPitchRotateAngle><wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>` + PAYLOAD);
}
function mainActionXml(id, p) {
  switch (p.action) {
    case 'photo': return actionXml(id, 'takePhoto', PAYLOAD + '<wpml:useGlobalPayloadLensIndex>0</wpml:useGlobalPayloadLensIndex>');
    case 'startRecord': return actionXml(id, 'startRecord', PAYLOAD + '<wpml:useGlobalPayloadLensIndex>0</wpml:useGlobalPayloadLensIndex>');
    case 'stopRecord': return actionXml(id, 'stopRecord', PAYLOAD);
    default: return '';
  }
}
function groupXml(groupId, start, end, trigger, actions) {
  return `<wpml:actionGroup><wpml:actionGroupId>${groupId}</wpml:actionGroupId>` +
    `<wpml:actionGroupStartIndex>${start}</wpml:actionGroupStartIndex><wpml:actionGroupEndIndex>${end}</wpml:actionGroupEndIndex>` +
    '<wpml:actionGroupMode>parallel</wpml:actionGroupMode>' +
    `<wpml:actionTrigger><wpml:actionTriggerType>${trigger}</wpml:actionTriggerType></wpml:actionTrigger>` +
    actions + '</wpml:actionGroup>';
}

const TURN = {
  straight: { mode: 'toPointAndStopWithDiscontinuityCurvature', straight: 1 },
  curve: { mode: 'toPointAndPassWithContinuityCurvature', straight: 0 },
};

// DJI Fly가 만든 Placemark와 같은 모양 (템플릿 없이 만들 때 사용)
function defaultPlacemarkXml() {
  return '<Placemark><Point><coordinates>0,0</coordinates></Point>' +
    '<wpml:index>0</wpml:index><wpml:executeHeight>30</wpml:executeHeight><wpml:waypointSpeed>2.5</wpml:waypointSpeed>' +
    '<wpml:waypointHeadingParam><wpml:waypointHeadingMode>smoothTransition</wpml:waypointHeadingMode>' +
    '<wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle><wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>' +
    '<wpml:waypointHeadingAngleEnable>1</wpml:waypointHeadingAngleEnable><wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>' +
    '<wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex></wpml:waypointHeadingParam>' +
    '<wpml:waypointTurnParam><wpml:waypointTurnMode>toPointAndStopWithContinuityCurvature</wpml:waypointTurnMode><wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist></wpml:waypointTurnParam>' +
    '<wpml:useStraightLine>0</wpml:useStraightLine>' +
    '<wpml:waypointGimbalHeadingParam><wpml:waypointGimbalPitchAngle>0</wpml:waypointGimbalPitchAngle><wpml:waypointGimbalYawAngle>0</wpml:waypointGimbalYawAngle></wpml:waypointGimbalHeadingParam>' +
    '</Placemark>';
}

/** 지점별 기수 방향(진행 방향) */
function headingFor(pts, i) {
  if (hasVal(pts[i].heading)) return Number(pts[i].heading);
  if (pts.length < 2) return 0;
  return i < pts.length - 1 ? bearing(pts[i], pts[i + 1]) : bearing(pts[i - 1], pts[i]);
}

/** 하나의 KML/WPML 문서에서 Placemark들을 미션 데이터로 교체 */
function rewriteDoc(doc, mission, opts) {
  const ns = detectWpmlNs(doc);
  const s = mission.settings;
  const speed = Math.max(0.5, Math.min(15, Number(s.speed) || 5));

  // 미션 공통 설정
  setAllW(doc, ns, 'updateTime', Date.now());
  setAllW(doc, ns, 'globalTransitionalSpeed', speed);
  setAllW(doc, ns, 'autoFlightSpeed', speed);
  if (s.finishAction) setAllW(doc, ns, 'finishAction', s.finishAction);
  if (s.rcLost === 'continue') setAllW(doc, ns, 'exitOnRCLost', 'goContinue');
  else if (s.rcLost) {
    setAllW(doc, ns, 'exitOnRCLost', 'executeLostAction');
    setAllW(doc, ns, 'executeRCLostAction', s.rcLost);
  }

  const placemarks = [...doc.getElementsByTagNameNS(KML_NS, 'Placemark')];
  if (!placemarks.length && !opts.forceFolder) return false; // DJI Fly의 template.kml에는 웨이포인트가 없음

  let folder = placemarks[0]?.parentNode || doc.getElementsByTagNameNS(KML_NS, 'Folder')[0];
  if (!folder) {
    const docEl = doc.getElementsByTagNameNS(KML_NS, 'Document')[0];
    folder = doc.createElementNS(KML_NS, 'Folder');
    docEl.appendChild(folder);
  }
  const proto = placemarks[0] ? placemarks[0].cloneNode(true) : fragment(doc, ns, defaultPlacemarkXml())[0];
  for (const pm of placemarks) pm.parentNode.removeChild(pm);

  const pts = mission.points;
  const pitchOf = (p) => (hasVal(p.gimbal) ? Number(p.gimbal) : hasVal(s.defaultGimbal) ? Number(s.defaultGimbal) : null);
  let actionId = 1;

  pts.forEach((p, i) => {
    const pm = proto.cloneNode(true);
    const last = i === pts.length - 1;

    // 좌표 (경도,위도)
    const coord = pm.getElementsByTagNameNS(KML_NS, 'coordinates')[0];
    if (coord) coord.textContent = `${fmt(p.lng, 9)},${fmt(p.lat, 9)}`;
    setChildW(pm, ns, 'index', i);
    const h = Number(p.height) || 0;
    setChildW(pm, ns, 'executeHeight', h);
    setChildW(pm, ns, 'height', h);
    setChildW(pm, ns, 'ellipsoidHeight', h);
    setChildW(pm, ns, 'useGlobalHeight', 0);
    setChildW(pm, ns, 'waypointSpeed', speed);
    setChildW(pm, ns, 'useGlobalSpeed', 0);

    // 기수 방향: 'path' = 다음 지점을 바라봄 (템플릿을 그대로 복제하면 모든 지점이 첫 지점 방향이 되어버림)
    const hp = childW(pm, ns, 'waypointHeadingParam');
    if (hp && s.headingMode !== 'keep') {
      setChildW(hp, ns, 'waypointHeadingMode', 'smoothTransition');
      setChildW(hp, ns, 'waypointHeadingAngle', fmt(headingFor(pts, i), 1));
      setChildW(hp, ns, 'waypointHeadingAngleEnable', 1);
    }

    // 경로 방식 (keep = 템플릿/DJI Fly 기본값 유지)
    const turn = TURN[s.pathMode];
    if (turn && !(s.pathMode === 'curve' && (i === 0 || last))) {
      setChildW(childW(pm, ns, 'waypointTurnParam'), ns, 'waypointTurnMode', turn.mode);
      setChildW(pm, ns, 'useStraightLine', turn.straight);
    }

    // 동작 재구성 (템플릿의 기존 동작은 모두 제거)
    for (const ag of [...pm.getElementsByTagNameNS(ns, 'actionGroup')]) ag.parentNode.removeChild(ag);
    let reach = '';
    const main = mainActionXml(actionId, p);
    if (main) { reach += main; actionId++; }
    const pitch = pitchOf(p);
    if (i === 0 && pitch !== null) reach += gimbalRotateXml(actionId++, pitch); // 첫 지점에서 짐벌 맞춤
    if (p.action === 'hover') reach += actionXml(actionId++, 'hover', `<wpml:hoverTime>${Math.max(1, Number(p.hoverSec) || 5)}</wpml:hoverTime>`);
    let groups = '';
    if (reach) groups += groupXml(1, i, i, 'reachPoint', reach);
    const nextPitch = last ? null : pitchOf(pts[i + 1]);
    if (nextPitch !== null) groups += groupXml(2, i, i + 1, 'reachPoint', gimbalEvenlyXml(actionId++, nextPitch)); // 다음 지점까지 짐벌 천천히 회전
    if (groups) {
      const before = childW(pm, ns, 'waypointGimbalHeadingParam');
      for (const g of fragment(doc, ns, groups)) pm.insertBefore(g, before);
    }
    folder.appendChild(pm);
  });
  return true;
}

function serialize(doc) {
  const xml = new XMLSerializer().serializeToString(doc);
  return xml.startsWith('<?xml') ? xml : '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;
}

// ---------- 템플릿 없이 생성 (실제 DJI Fly 파일 구조를 흉내냄) ----------
function missionConfigXml(droneEnum) {
  const drone = hasVal(droneEnum)
    ? `<wpml:droneInfo><wpml:droneEnumValue>${droneEnum}</wpml:droneEnumValue><wpml:droneSubEnumValue>0</wpml:droneSubEnumValue></wpml:droneInfo>` : '';
  return '<wpml:missionConfig><wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode><wpml:finishAction>goHome</wpml:finishAction>' +
    '<wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost><wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>' +
    `<wpml:globalTransitionalSpeed>2.5</wpml:globalTransitionalSpeed>${drone}</wpml:missionConfig>`;
}
function scratchFiles(droneEnum) {
  const now = Date.now();
  const head = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="${KML_NS}" xmlns:wpml="${DEFAULT_WPML_NS}"><Document>`;
  const template = head + `<wpml:author>fly</wpml:author><wpml:createTime>${now}</wpml:createTime><wpml:updateTime>${now}</wpml:updateTime>` +
    missionConfigXml(droneEnum) + '</Document></kml>';
  const waylines = head + missionConfigXml(droneEnum) +
    '<Folder><wpml:templateId>0</wpml:templateId><wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>' +
    '<wpml:waylineId>0</wpml:waylineId><wpml:distance>0</wpml:distance><wpml:duration>0</wpml:duration><wpml:autoFlightSpeed>2.5</wpml:autoFlightSpeed>' +
    defaultPlacemarkXml() + '</Folder></Document></kml>';
  return [
    { name: 'wpmz/template.kml', data: new TextEncoder().encode(template) },
    { name: 'wpmz/waylines.wpml', data: new TextEncoder().encode(waylines) },
  ];
}

/** 미션 → KMZ Blob */
export async function buildKmz(mission, template, { droneEnum = DEFAULT_DRONE_ENUM } = {}) {
  if (mission.points.length < 2) throw new Error('웨이포인트가 2개 이상 필요합니다.');
  const srcFiles = template ? template.files : scratchFiles(droneEnum);
  const hasWl = srcFiles.some((x) => /(^|\/)waylines\.wpml$/i.test(x.name));
  const out = [];
  let replaced = 0;
  for (const f of srcFiles) {
    const isWl = /(^|\/)waylines\.wpml$/i.test(f.name);
    const isTpl = /(^|\/)template\.kml$/i.test(f.name);
    if (!isWl && !isTpl) { out.push({ name: f.name, data: f.data }); continue; }
    const doc = parseXml(decode(f.data));
    if (rewriteDoc(doc, mission, { forceFolder: isWl || (isTpl && !hasWl) })) replaced++;
    out.push({ name: f.name, data: serialize(doc) });
  }
  if (!replaced) throw new Error('템플릿에서 웨이포인트 영역을 찾지 못했습니다.');
  const blob = await writeZip(out);
  let filename = template?.filename || `${(mission.name || 'mission').replace(/[\\/:*?"<>|]/g, '_')}.kmz`;
  if (!/\.kmz$/i.test(filename)) filename += '.kmz';
  return { blob, filename, files: out };
}
