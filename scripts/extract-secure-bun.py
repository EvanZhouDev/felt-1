import hashlib
import pathlib
import sys
import zipfile

archive, destination, member, expected = sys.argv[1:]
content = pathlib.Path(archive).read_bytes()
if hashlib.sha256(content).hexdigest() != expected:
    raise SystemExit("Bun archive SHA256 mismatch")
with zipfile.ZipFile(archive) as source:
    executable = source.read(member)
target = pathlib.Path(destination)
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(executable)
target.chmod(0o755)
