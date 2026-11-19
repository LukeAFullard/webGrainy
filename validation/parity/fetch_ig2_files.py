"""Extract selected files from the remote IG2_data.zip (Zenodo 17866827) with HTTP Range
requests, without downloading the whole archive.

Usage: python3 -I validation/parity/fetch_ig2_files.py <out_dir> <path-in-zip> [...]
"""
import os, struct, sys, urllib.request, zlib

URL = "https://zenodo.org/records/17866827/files/IG2_data.zip?download=1"

def get(start, end):
    req = urllib.request.Request(URL, headers={"Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req) as r:
        return r.read()

def size():
    req = urllib.request.Request(URL, method="HEAD")
    with urllib.request.urlopen(req) as r:
        return int(r.headers["Content-Length"])

def central_directory():
    n = size()
    tail = get(max(0, n - 65557), n - 1)
    i = tail.rfind(b"PK\x05\x06")
    cd_size, cd_off = struct.unpack("<II", tail[i + 12:i + 20])
    if cd_off == 0xFFFFFFFF:  # ZIP64
        j = tail.rfind(b"PK\x06\x06")
        cd_size, cd_off = struct.unpack("<QQ", tail[j + 40:j + 56])
    cd = get(cd_off, cd_off + cd_size - 1)
    pos, out = 0, {}
    while pos + 46 <= len(cd) and cd[pos:pos + 4] == b"PK\x01\x02":
        method, = struct.unpack("<H", cd[pos + 10:pos + 12])
        csize, usize = struct.unpack("<II", cd[pos + 20:pos + 28])
        nlen, elen, clen = struct.unpack("<HHH", cd[pos + 28:pos + 34])
        loff, = struct.unpack("<I", cd[pos + 42:pos + 46])
        name = cd[pos + 46:pos + 46 + nlen].decode("utf-8", "replace")
        extra = cd[pos + 46 + nlen:pos + 46 + nlen + elen]
        k = 0  # ZIP64 extended info
        while k + 4 <= len(extra):
            hid, hl = struct.unpack("<HH", extra[k:k + 4])
            if hid == 1:
                vals = list(struct.unpack("<" + "Q" * (hl // 8), extra[k + 4:k + 4 + hl]))
                if usize == 0xFFFFFFFF: usize = vals.pop(0)
                if csize == 0xFFFFFFFF: csize = vals.pop(0)
                if loff == 0xFFFFFFFF: loff = vals.pop(0)
            k += 4 + hl
        out[name] = (method, csize, usize, loff)
        pos += 46 + nlen + elen + clen
    return out

def main():
    out_dir, wanted = sys.argv[1], sys.argv[2:]
    os.makedirs(out_dir, exist_ok=True)
    cd = central_directory()
    for w in wanted:
        key = next((k for k in cd if k.endswith("/" + w) or k == w), None)
        if key is None:
            print("missing", w); continue
        method, csize, usize, loff = cd[key]
        hdr = get(loff, loff + 29)
        nlen, elen = struct.unpack("<HH", hdr[26:30])
        data = get(loff + 30 + nlen + elen, loff + 30 + nlen + elen + csize - 1)
        if method == 8:
            data = zlib.decompress(data, -15)
        dst = os.path.join(out_dir, w.replace("/", "__"))
        open(dst, "wb").write(data)
        print("ok", key, len(data))

if __name__ == "__main__":
    main()
