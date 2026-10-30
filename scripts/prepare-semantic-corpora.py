"""Fetch pinned source archives without installing dependencies or executing repository code."""
import json, pathlib, subprocess, tarfile, io, hashlib
root=pathlib.Path(__file__).resolve().parents[1]
manifest=json.loads((root/'docs/evidence/semantic/oracle.json').read_text())
base=root/'artifacts/semantic/corpora'
base.mkdir(parents=True,exist_ok=True)
for spec in manifest['snapshots']:
    name=spec['repository'].split('/')[-1]
    target=base/name
    if target.exists():
        saved=json.loads((target/'.snapshot.json').read_text())
        if saved['commit']!=spec['commit']: raise RuntimeError('Refuse overwrite of another snapshot')
        print(name, 'already prepared'); continue
    if spec['repository']=='AgilePemdigi-2026/sage':
        raw=subprocess.run(['git','archive','--format=tar',spec['commit']],cwd=root,check=True,stdout=subprocess.PIPE).stdout
        strip=False
    else:
        raw=subprocess.run(['gh','api',f"repos/{spec['repository']}/tarball/{spec['commit']}"],check=True,stdout=subprocess.PIPE).stdout
        strip=True
    target.mkdir(mode=0o700)
    count=0; total=0
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r:*') as archive:
        for entry in archive:
            if not entry.isfile(): continue
            parts=pathlib.PurePosixPath(entry.name).parts[(1 if strip else 0):]
            if not parts or any(p in ('..','node_modules','vendor','.git','.next','generated','storage','artifacts') for p in parts): continue
            path=pathlib.Path(*parts)
            if path.name.startswith('.env') or path.suffix.lower() not in ('.php','.ts','.tsx','.js','.jsx','.mjs','.cjs','.prisma','.json'): continue
            if path.name.endswith('lock.json') or entry.size>1024*1024: continue
            data=archive.extractfile(entry).read()
            dest=target/path; dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
            count+=1; total+=len(data)
    (target/'.snapshot.json').write_text(json.dumps({**spec,'files':count,'sourceBytes':total,'archiveSha256':hashlib.sha256(raw).hexdigest()},indent=2))
    print(name,count,total)
