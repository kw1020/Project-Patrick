"""Find the streamer's face / webcam in a stretch of video (v1.9.0 layouts). OpenCV's bundled Haar cascades, no downloads.

Usage:
  python detect_cam.py VIDEO START LENGTH [--frames 10]
  python detect_cam.py --summarize < faces.json     # {"frame": [w, h], "faces": [[[x, y, w, h], ...], ...], "times": [...]}

Prints one JSON object on the last line:
  {frame: [w, h], times: [...], faces: [[[x, y, w, h] px, ...] per frame], ms,
   found, faceBox: [x, y, w, h] (fractions, median), hitRate, faceAreaFrac, region: corner|center|large|null,
   camBox: [x, y, w, h] fractions | null, snapped: number of camBox sides snapped to a visible edge,
   track: [[t, cx, cy], ...] (face centre per hit frame, fractions; t = seconds into the window)}
Never fails on "no face": found=false. Exits non-zero only when the video can't be read at all.
"""
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

DETECT_W = 640  # frames are scaled to this width for detection (speed)
MIN_HIT_RATE = 0.4  # the face must be in the same place in at least this share of the sampled frames to count
LARGE_FACE = 0.04  # face area >= 4% of the frame = a face-cam / Just Chatting shot


def median(v):
    s = sorted(v)
    n = len(s)
    if not n:
        return 0.0
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def cluster_faces(faces, fw, fh):
    """Group boxes from different frames that sit in the same place. Returns the biggest group as [(frame_i, box)]."""
    groups = []  # each: list of (i, box)
    for i, boxes in enumerate(faces):
        for b in boxes:
            cx, cy = b[0] + b[2] / 2.0, b[1] + b[3] / 2.0
            best = None
            for g in groups:
                gx = median([x[1][0] + x[1][2] / 2.0 for x in g])
                gy = median([x[1][1] + x[1][3] / 2.0 for x in g])
                gw = median([x[1][2] for x in g])
                if abs(cx - gx) <= max(gw, b[2]) * 0.9 and abs(cy - gy) <= max(gw, b[3]) * 0.9 and 0.5 < b[2] / gw < 2.0:
                    best = g
                    break
            if best is None:
                groups.append([(i, b)])
            elif not any(x[0] == i for x in best):
                best.append((i, b))
    if not groups:
        return []
    # Most frames first; ties -> bigger face (the streamer is usually the biggest steady face).
    groups.sort(key=lambda g: (len(g), median([x[1][2] for x in g])), reverse=True)
    return groups[0]


def region_of(cx, cy, area):
    """large = face-cam shot; corner = small face near a corner/edge (a webcam box over gameplay); else center."""
    if area >= LARGE_FACE:
        return "large"
    near_x = cx < 0.3 or cx > 0.7
    near_y = cy < 0.35 or cy > 0.65
    edge = cx < 0.2 or cx > 0.8 or cy < 0.2 or cy > 0.8
    return "corner" if (near_x and near_y) or edge else "center"


def expand_cam(face, fw, fh):
    """Typical webcam around a face: ~3.6x the face width, 16:9, face centred across and a bit above the middle.
    Pixels in, pixels out, kept inside the frame by shifting (shrunk only if the frame is too small)."""
    x, y, w, h = face
    cw = min(fw, w * 3.6)
    ch = min(fh, cw * 9 / 16.0)
    if ch < h * 1.9:  # keep the whole head + shoulders in
        ch = min(fh, h * 1.9)
    cx = x + w / 2.0
    cy = y + h / 2.0
    left = cx - cw / 2.0
    top = cy - ch * 0.45
    left = max(0.0, min(fw - cw, left))
    top = max(0.0, min(fh - ch, top))
    return [left, top, cw, ch]


def snap_edges(cam, face, edge_avg, fw, fh):
    """Move each side of the estimated cam box to a straight edge that stays put across the sampled frames (the webcam's
    border / where the cam meets the moving game), searching a band around that side. edge_avg = mean Canny map (0..1),
    in DETECT_W-scaled pixels; cam/face in source pixels. Returns (box, sides snapped)."""
    import numpy as np

    sx = edge_avg.shape[1] / float(fw)
    sy = edge_avg.shape[0] / float(fh)
    L, T, W, H = cam
    R, B = L + W, T + H
    fx, fy, fwid, fhei = face
    margin_x, margin_y = fwid * 0.6, fhei * 0.6  # the face must keep this much room inside the box
    pad = edge_avg  # each frame's edges were already widened by 1 px (borders are 1-3 px thick, the scale isn't exact)

    def line_strength_row(yy, x0, x1):
        r = int(round(yy * sy))
        a, b = int(max(0, x0 * sx)), int(min(edge_avg.shape[1], x1 * sx))
        if r < 0 or r >= edge_avg.shape[0] or b - a < 8:
            return 0.0
        return float((pad[r, a:b] >= 0.6).mean())

    def line_strength_col(xx, y0, y1):
        c = int(round(xx * sx))
        a, b = int(max(0, y0 * sy)), int(min(edge_avg.shape[0], y1 * sy))
        if c < 0 or c >= edge_avg.shape[1] or b - a < 8:
            return 0.0
        return float((pad[a:b, c] >= 0.6).mean())

    def search(lo, hi, step, fn):
        """The outermost line in [lo, hi] that is a persistent straight edge over >= 55% of the side."""
        n = int(abs(hi - lo) / step) + 1
        pts = [lo + (hi - lo) * k / max(1, n - 1) for k in range(n)]
        best = None
        for p in pts:
            if fn(p) >= 0.55:
                best = p
                break
        return best

    snapped = 0
    snapped_l = snapped_r = snapped_t = snapped_b = False
    step_x, step_y = 1.0 / sx, 1.0 / sy
    band_x, band_y = W * 0.5, H * 0.5
    # left side: outer end = further left
    v = search(max(0.0, L - band_x), min(fx - margin_x, L + band_x), step_x, lambda p: line_strength_col(p, T, B))
    if v is not None:
        L = v
        snapped += 1
        snapped_l = True
    elif L - 0 < W * 0.08:
        L = 0.0  # flush with the frame edge
    v = search(min(float(fw - 1), R + band_x), max(fx + fwid + margin_x, R - band_x), step_x, lambda p: line_strength_col(p, T, B))
    if v is not None:
        R = v + 1
        snapped += 1
        snapped_r = True
    elif fw - R < W * 0.08:
        R = float(fw)
    v = search(max(0.0, T - band_y), min(fy - margin_y * 0.5, T + band_y), step_y, lambda p: line_strength_row(p, L, R))
    if v is not None:
        T = v
        snapped += 1
        snapped_t = True
    elif T < H * 0.08:
        T = 0.0
    v = search(min(float(fh - 1), B + band_y), max(fy + fhei + margin_y, B - band_y), step_y, lambda p: line_strength_row(p, L, R))
    if v is not None:
        B = v + 1
        snapped += 1
        snapped_b = True
    elif fh - B < H * 0.08:
        B = float(fh)
    # A found edge is the border's OUTER side (edges are widened by 1 px): step in a little so no game shows at the rim.
    ix, iy = fw * 0.006, fh * 0.01
    if snapped_l:
        L += ix
    if snapped_r:
        R -= ix
    if snapped_t:
        T += iy
    if snapped_b:
        B -= iy
    W2, H2 = R - L, B - T
    # Sanity: a webcam is roughly 1:1 .. 2.4:1 and not most of the frame; else keep the plain estimate.
    if W2 <= 0 or H2 <= 0 or not (0.75 <= W2 / H2 <= 2.4) or W2 * H2 > fw * fh * 0.5:
        return cam, 0
    return [L, T, W2, H2], snapped


def summarize(frame, faces, times, edge_avg=None):
    fw, fh = frame
    n = max(1, len(faces))
    group = cluster_faces(faces, fw, fh)
    out = {"frame": [fw, fh], "times": times, "faces": faces, "found": False, "faceBox": None, "hitRate": round(len(group) / n, 3),
           "faceAreaFrac": 0.0, "region": None, "camBox": None, "snapped": 0, "track": []}
    if not group or len(group) / n < MIN_HIT_RATE:
        return out
    bx = [median([g[1][k] for g in group]) for k in range(4)]
    area = (bx[2] * bx[3]) / float(fw * fh)
    cx, cy = (bx[0] + bx[2] / 2.0) / fw, (bx[1] + bx[3] / 2.0) / fh
    region = region_of(cx, cy, area)
    cam = expand_cam(bx, fw, fh)
    snapped = 0
    if region == "corner" and edge_avg is not None:
        cam, snapped = snap_edges(cam, bx, edge_avg, fw, fh)
    r4 = lambda v: round(v, 4)
    out.update({
        "found": True,
        "faceBox": [r4(bx[0] / fw), r4(bx[1] / fh), r4(bx[2] / fw), r4(bx[3] / fh)],
        "faceAreaFrac": r4(area), "region": region,
        "camBox": [r4(cam[0] / fw), r4(cam[1] / fh), r4(cam[2] / fw), r4(cam[3] / fh)], "snapped": snapped,
        "track": [[round(times[i], 2) if i < len(times) else i, r4((b[0] + b[2] / 2.0) / fw), r4((b[1] + b[3] / 2.0) / fh)] for i, b in sorted(group)],
    })
    return out


def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
                       capture_output=True, text=True, timeout=30)
    w, h = [int(float(x)) for x in r.stdout.strip().split("\n")[0].split(",")[:2]]
    return w, h


def grab(path, t, dw, dh):
    """One BGR frame at t seconds, scaled to dw x dh (ffmpeg input seek = fast)."""
    import numpy as np

    r = subprocess.run(["ffmpeg", "-v", "error", "-ss", "%.3f" % t, "-i", path, "-frames:v", "1", "-vf", "scale=%d:%d" % (dw, dh),
                        "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], capture_output=True, timeout=30)
    n = dw * dh * 3
    if len(r.stdout) < n:
        return None
    return np.frombuffer(r.stdout[:n], dtype=np.uint8).reshape(dh, dw, 3)


def detect(path, start, length, nframes):
    import cv2
    import numpy as np

    t0 = time.time()
    fw, fh = probe(path)
    dw = min(DETECT_W, fw)
    dw -= dw % 2
    dh = int(round(fh * dw / float(fw)))
    dh -= dh % 2
    k = fw / float(dw)
    times = [start + length * (i + 0.5) / nframes for i in range(nframes)]
    with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2)) as ex:
        frames = list(ex.map(lambda t: grab(path, t, dw, dh), times))
    front = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    prof = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")
    min_face = max(14, dw // 45)
    faces, kept_times, edges = [], [], []
    kernel = np.ones((3, 3), np.uint8)
    for t, bgr in zip(times, frames):
        if bgr is None:
            continue
        g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        eq = cv2.equalizeHist(g)
        found = front.detectMultiScale(eq, scaleFactor=1.1, minNeighbors=5, minSize=(min_face, min_face))
        boxes = [list(map(int, b)) for b in found] if len(found) else []
        if not boxes:  # turned head: profile cascade, both directions
            p = prof.detectMultiScale(eq, scaleFactor=1.1, minNeighbors=5, minSize=(min_face, min_face))
            boxes = [list(map(int, b)) for b in p] if len(p) else []
            if not boxes:
                p = prof.detectMultiScale(cv2.flip(eq, 1), scaleFactor=1.1, minNeighbors=5, minSize=(min_face, min_face))
                boxes = [[dw - int(b[0]) - int(b[2]), int(b[1]), int(b[2]), int(b[3])] for b in p] if len(p) else []
        faces.append([[round(b[0] * k), round(b[1] * k), round(b[2] * k), round(b[3] * k)] for b in boxes])
        kept_times.append(round(t - start, 2))
        # Edges in any colour channel (a dark cam border next to a dark-blue game has no contrast in gray alone).
        blur = cv2.GaussianBlur(bgr, (3, 3), 0)
        e = np.zeros(g.shape, np.uint8)
        for ch in cv2.split(blur):
            e |= cv2.Canny(ch, 60, 160)
        edges.append((cv2.dilate(e, kernel) > 0).astype(np.float32))
    if not faces:
        raise SystemExit("could not read any frames from %s" % path)
    edge_avg = np.mean(edges, axis=0) if edges else None
    out = summarize([fw, fh], faces, kept_times, edge_avg)
    out["ms"] = int((time.time() - t0) * 1000)
    return out


def main(argv):
    if len(argv) >= 2 and argv[1] == "--summarize":
        j = json.loads(sys.stdin.read())
        print(json.dumps(summarize(j["frame"], j["faces"], j.get("times") or list(range(len(j["faces"]))))))
        return
    if len(argv) < 4:
        raise SystemExit(__doc__)
    nframes = 10
    if "--frames" in argv:
        nframes = max(3, min(30, int(argv[argv.index("--frames") + 1])))
    print(json.dumps(detect(argv[1], float(argv[2]), float(argv[3]), nframes)))


if __name__ == "__main__":
    main(sys.argv)
