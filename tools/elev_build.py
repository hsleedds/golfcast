#!/usr/bin/env python3
"""Roundcast — 골프장 높이(표고) 파일 만들기  (GitHub Actions에서 자동 실행)

- 공유 야디지(course_yd)에 있는 골프장마다, 홀 지점들(그린 앞·뒤, 경계, 벙커·해저드, 기준점) 둘레 400m 범위의
  높이 격자를 만들어 elev/<골프장키 해시>.json 으로 저장합니다.
- 높이 원본: Copernicus DEM GLO-30 (약 30m 격자, 유럽우주국·EU, 상업 이용 가능·출처 표시)
  © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS
  by the European Union and ESA; all rights reserved.
- 이용자의 위치는 쓰지 않습니다. 골프장 시설 좌표(공유 야디지)만 씁니다.
- 국내 공개제한 정밀 표고(국토지리정보원·브이월드 3D)는 쓰지 않습니다.
"""
import base64, hashlib, json, math, os, sys, urllib.request

SB_URL = "https://dpuhpcgtkddsxoeinzxp.supabase.co"
SB_KEY = "sb_publishable_KqqOrGi2cTEek45SYz88hQ_Mtpm1Zcl"  # 앱에 이미 들어 있는 공개(읽기용) 키
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "elev")
MARGIN_M = 400
COP = "https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif"


def file_key(club_key: str) -> str:
    return hashlib.sha256(club_key.encode("utf-8")).hexdigest()[:16]


def pts_of(d):
    """공유 야디지 data 한 줄에서 위경도 점들을 뽑음"""
    out = []
    def add(q):
        try:
            la, lo = float(q["lat"]), float(q["lon"])
            if 33 <= la <= 39 and 124 <= lo <= 132:
                out.append((la, lo))
        except Exception:
            pass
    if not isinstance(d, dict):
        return out
    for k in ("front", "back", "area"):
        if d.get(k):
            add(d[k])
    for h in d.get("hz") or []:
        if isinstance(h, dict):
            add(h.get("a") or {}); add(h.get("b") or {})
    bd = d.get("bd") or {}
    for k in ("L", "R"):
        for q in bd.get(k) or []:
            add(q)
    return out


def bbox(pts, m=MARGIN_M):
    la = [p[0] for p in pts]; lo = [p[1] for p in pts]
    dla = m / 111320; dlo = m / (111320 * math.cos(math.radians(sum(la) / len(la))))
    return (min(lo) - dlo, min(la) - dla, max(lo) + dlo, max(la) + dla)  # W,S,E,N


def tiles_for(b):
    W, S, E, N = b
    for la in range(math.floor(S), math.floor(N) + 1):
        for lo in range(math.floor(W), math.floor(E) + 1):
            yield f"Copernicus_DSM_COG_10_N{la:02d}_00_E{lo:03d}_00_DEM"


def read_grid(b):
    """Copernicus 타일에서 범위만 읽음 (HTTP 부분 읽기). 반환: (2차원 배열 m, 북쪽 위도, 서쪽 경도, 위도 간격, 경도 간격)"""
    import rasterio
    from rasterio.merge import merge
    dss = []
    for n in tiles_for(b):
        try:
            dss.append(rasterio.open(COP.format(n=n)))
        except Exception as e:  # 바다 등 타일 없음
            print("  타일 없음:", n, str(e)[:80])
    if not dss:
        return None
    try:
        arr, tr = merge(dss, bounds=b, nodata=-9999)
    finally:
        for d in dss:
            d.close()
    return arr[0], tr.f, tr.c, -tr.e, tr.a


def encode(grid, n, w, dy, dx, sig):
    import numpy as np
    g = np.where(grid < -500, -32768, np.round(grid * 10)).astype("<i2")  # 0.1m 단위
    return {
        "v": 1, "src": "Copernicus DEM GLO-30",
        "attr": "Copernicus DEM © DLR e.V. 2010-2014, © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the EU and ESA",
        "n": round(n, 7), "w": round(w, 7), "dy": dy, "dx": dx,
        "H": int(g.shape[0]), "W": int(g.shape[1]), "sig": sig,
        "z": base64.b64encode(g.tobytes()).decode("ascii"),
    }


def covers(old, b):
    try:
        W, S, E, N = b
        oW, oN = old["w"], old["n"]; oE = oW + old["W"] * old["dx"]; oS = oN - old["H"] * old["dy"]
        m = 100 / 111320  # 100m 여유 안쪽이면 다시 만들 필요 없음
        return oW <= W + m and oE >= E - m and oS <= S + m and oN >= N - m
    except Exception:
        return False


def fetch_rows():
    req = urllib.request.Request(SB_URL + "/rest/v1/course_yd?select=club_key,data", headers={"apikey": SB_KEY})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def build(rows, reader=read_grid, out=OUT):
    os.makedirs(out, exist_ok=True)
    by = {}
    for r in rows:
        k = str(r.get("club_key") or "")
        if k:
            by.setdefault(k, []).extend(pts_of(r.get("data")))
    made = 0
    for k, pts in sorted(by.items()):
        if not pts:
            continue
        b = bbox(pts)
        path = os.path.join(out, file_key(k) + ".json")
        if os.path.exists(path):
            try:
                if covers(json.load(open(path)), b):
                    continue
            except Exception:
                pass
        print("골프장", file_key(k), f"점 {len(pts)}개")
        g = reader(b)
        if g is None:
            continue
        grid, n, w, dy, dx = g
        sig = hashlib.sha256(json.dumps([round(x, 4) for x in b]).encode()).hexdigest()[:8]
        json.dump(encode(grid, n, w, dy, dx, sig), open(path, "w"), separators=(",", ":"))
        made += 1
    print(f"만든 파일 {made}개")
    return made


if __name__ == "__main__":
    build(fetch_rows())
