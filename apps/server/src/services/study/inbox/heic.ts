import { spawn } from "child_process";

/**
 * HEIC/HEIF (HEVC-coded) → raw interleaved RGB(A) pixels.
 *
 * Why not sharp: the prebuilt sharp 0.33 libvips ships libheif WITHOUT an HEVC decoder (patents),
 * so `sharp(heic).jpeg()` fails with "No decoding plugin installed for this compression format"
 * (checked locally and on prod: `sharp.format.heif.input.fileSuffix` is only `.avif`). ffmpeg 6.1
 * cannot read HEIF image items (iPhone photos are tiled grids). No heic npm package is in the
 * lockfile/cache.
 *
 * What prod DOES have (2026-10-05, read-only check): the system libheif 1.17.6 with its libde265
 * HEVC plugin (`/usr/lib/x86_64-linux-gnu/libheif/plugins/libheif-libde265.so`, pulled in by
 * libgd3) and python3 3.12 — but no `heif-convert` CLI. So a tiny python ctypes shim drives
 * libheif directly: HEIC on stdin → `<u32 width><u32 height><u32 channels>` + packed rows on
 * stdout. libheif applies the irot/imir transforms itself, so the pixels are already upright and
 * carry no metadata at all. Nothing is installed; the script is inline, so `dist/` needs no asset.
 */

export const HEIC_DECODE_TIMEOUT_MS = 30_000;
/** 48 MP ProRAW-class stills fit; anything bigger is refused before decoding. */
export const HEIC_MAX_PIXELS = 100_000_000;

export class HeicDecodeError extends Error {
  constructor(message: string, public unavailable = false) {
    super(message);
  }
}

export const HEIC_PY = String.raw`
import ctypes, ctypes.util, struct, sys
class E(ctypes.Structure):
    _fields_ = [("code", ctypes.c_int), ("subcode", ctypes.c_int), ("message", ctypes.c_char_p)]
def die(msg, code=2):
    sys.stderr.write(msg + "\n"); sys.stderr.flush(); sys.exit(code)
try:
    h = ctypes.CDLL(ctypes.util.find_library("heif") or "libheif.so.1")
except OSError as e:
    die("NO_LIBHEIF " + str(e), 3)
V = ctypes.c_void_p
for fn, res, args in [
    ("heif_init", E, [V]), ("heif_context_alloc", V, []), ("heif_context_free", None, [V]),
    ("heif_context_read_from_memory_without_copy", E, [V, V, ctypes.c_size_t, V]),
    ("heif_context_get_primary_image_handle", E, [V, ctypes.POINTER(V)]),
    ("heif_image_handle_has_alpha_channel", ctypes.c_int, [V]),
    ("heif_image_handle_get_width", ctypes.c_int, [V]), ("heif_image_handle_get_height", ctypes.c_int, [V]),
    ("heif_decode_image", E, [V, ctypes.POINTER(V), ctypes.c_int, ctypes.c_int, V]),
    ("heif_image_get_plane_readonly", ctypes.POINTER(ctypes.c_uint8), [V, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]),
    ("heif_image_get_width", ctypes.c_int, [V, ctypes.c_int]), ("heif_image_get_height", ctypes.c_int, [V, ctypes.c_int]),
    ("heif_image_release", None, [V]), ("heif_image_handle_release", None, [V]),
]:
    f = getattr(h, fn, None)
    if f is None:
        if fn == "heif_init": continue
        die("NO_SYMBOL " + fn, 3)
    f.restype = res; f.argtypes = args
def chk(e, what):
    if e.code != 0: die("DECODE_FAILED %s: %s" % (what, (e.message or b"").decode("utf8", "replace")))
if hasattr(h, "heif_init"): chk(h.heif_init(None), "init")
data = sys.stdin.buffer.read()
buf = ctypes.create_string_buffer(data, len(data))
ctx = h.heif_context_alloc()
chk(h.heif_context_read_from_memory_without_copy(ctx, buf, len(data), None), "read")
hd = V(); chk(h.heif_context_get_primary_image_handle(ctx, ctypes.byref(hd)), "primary")
w0, h0 = h.heif_image_handle_get_width(hd), h.heif_image_handle_get_height(hd)
if w0 <= 0 or h0 <= 0 or w0 * h0 > int(sys.argv[1]): die("TOO_LARGE %dx%d" % (w0, h0))
alpha = h.heif_image_handle_has_alpha_channel(hd) != 0
ch = 4 if alpha else 3
img = V(); chk(h.heif_decode_image(hd, ctypes.byref(img), 1, 11 if alpha else 10, None), "decode")
stride = ctypes.c_int(0)
p = h.heif_image_get_plane_readonly(img, 10, ctypes.byref(stride))
if not p: die("DECODE_FAILED no plane")
w, hh = h.heif_image_get_width(img, 10), h.heif_image_get_height(img, 10)
row = w * ch; base = ctypes.addressof(p.contents)
out = sys.stdout.buffer
out.write(struct.pack("<III", w, hh, ch))
for y in range(hh):
    out.write(ctypes.string_at(base + y * stride.value, row))
out.flush()
h.heif_image_release(img); h.heif_image_handle_release(hd); h.heif_context_free(ctx)
`;

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
}

export function decodeHeic(input: Buffer, opts: { timeoutMs?: number; python?: string } = {}): Promise<RawImage> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(opts.python ?? "python3", ["-c", HEIC_PY, String(HEIC_MAX_PIXELS)], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e: any) {
      return reject(new HeicDecodeError(`python3 unavailable: ${e?.message}`, true));
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new HeicDecodeError("HEIC decode timed out")));
    }, opts.timeoutMs ?? HEIC_DECODE_TIMEOUT_MS);
    const cap = HEIC_MAX_PIXELS * 4 + 12;
    child.stdout.on("data", (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > cap) {
        child.kill("SIGKILL");
        return finish(() => reject(new HeicDecodeError("HEIC decode output too large")));
      }
      out.push(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      if (err.length < 2000) err += c.toString("utf8");
    });
    child.on("error", (e: any) => finish(() => reject(new HeicDecodeError(`python3 unavailable: ${e?.message}`, true))));
    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) return reject(new HeicDecodeError(err.trim() || `decoder exited ${code}`, code === 3));
        const all = Buffer.concat(out);
        if (all.length < 12) return reject(new HeicDecodeError("HEIC decoder returned no pixels"));
        const width = all.readUInt32LE(0);
        const height = all.readUInt32LE(4);
        const channels = all.readUInt32LE(8);
        const data = all.subarray(12);
        if ((channels !== 3 && channels !== 4) || data.length !== width * height * channels)
          return reject(new HeicDecodeError("HEIC decoder returned a malformed frame"));
        resolve({ data, width, height, channels });
      });
    });
    child.stdin.on("error", () => undefined); // EPIPE when the decoder rejects early
    child.stdin.end(input);
  });
}
