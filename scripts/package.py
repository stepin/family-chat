"""Deterministic release archives for scripts/release.sh (standard library only).

  package.py tar  <dir> <out.tar.gz>   files of <dir> under the folder name <dir>
  package.py zip  <dir> <out.zip>
  package.py sums <folder>             writes <folder>/SHA256SUMS for *.tar.gz and *.zip

Every timestamp is SOURCE_DATE_EPOCH (or 0), owners are 0, entries are sorted,
the executable keeps mode 755 and the rest 644, so the same input gives the
same bytes.
"""

import gzip
import hashlib
import io
import os
import sys
import tarfile
import time
import zipfile

EPOCH = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))


def files_of(src):
    base = os.path.basename(os.path.normpath(src))
    for name in sorted(os.listdir(src)):
        path = os.path.join(src, name)
        if os.path.isfile(path):
            yield path, f"{base}/{name}", name in ("fcd", "fcd.exe")


def make_tar(src, out):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for path, arc, executable in files_of(src):
            info = tarfile.TarInfo(arc)
            info.size = os.path.getsize(path)
            info.mtime = EPOCH
            info.mode = 0o755 if executable else 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            with open(path, "rb") as f:
                tar.addfile(info, f)
    with open(out, "wb") as f:
        with gzip.GzipFile(filename="", mode="wb", fileobj=f, mtime=EPOCH, compresslevel=9) as gz:
            gz.write(raw.getvalue())


def make_zip(src, out):
    # ZIP stores local time with 2-second precision and no year before 1980.
    stamp = time.gmtime(max(EPOCH, 315532800))[:6]
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path, arc, executable in files_of(src):
            info = zipfile.ZipInfo(arc, date_time=stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = ((0o755 if executable else 0o644) | 0o100000) << 16
            with open(path, "rb") as f:
                z.writestr(info, f.read())


def write_sums(folder):
    lines = []
    for name in sorted(os.listdir(folder)):
        if name.endswith((".tar.gz", ".zip")):
            h = hashlib.sha256()
            with open(os.path.join(folder, name), "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            lines.append(f"{h.hexdigest()}  {name}\n")
    with open(os.path.join(folder, "SHA256SUMS"), "w", newline="\n") as f:
        f.writelines(lines)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "tar" and len(sys.argv) == 4:
        make_tar(sys.argv[2], sys.argv[3])
    elif cmd == "zip" and len(sys.argv) == 4:
        make_zip(sys.argv[2], sys.argv[3])
    elif cmd == "sums" and len(sys.argv) == 3:
        write_sums(sys.argv[2])
    else:
        sys.exit(__doc__)
