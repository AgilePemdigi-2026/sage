"""Compare a browser-exported PDF with its saved canonical fixture document.

Requires Python 3 and pdfplumber. Pass the fresh test:pdf:live artifact directory.
This checks text/context/evidence and all-page headers/footers; inspect rendered
pages separately for clipping, diagram readability, fonts, and table layout.
"""
import json,re,sys,hashlib
from pathlib import Path
import pdfplumber
folder=Path(sys.argv[1]); pdf=folder/'sage-pdf21-browser-390.pdf'; expected=json.loads((folder/'expected-document.json').read_text())
with pdfplumber.open(pdf) as doc:
    pages=[p.extract_text(x_tolerance=1.5,y_tolerance=3) or '' for p in doc.pages]
    sizes=[(p.width,p.height) for p in doc.pages]
text='\n'.join(pages); compact=lambda s: re.sub(r'\s+','',str(s))
normalized=compact(text)
checks={}; missing=[]
def required(category,values):
    values=list(dict.fromkeys(str(x) for x in values if x is not None and str(x)))
    absent=[x for x in values if compact(x) not in normalized]
    checks[category]={'expected':len(values),'matched':len(values)-len(absent)}
    missing.extend({'category':category,'value':x} for x in absent)
required('metadata',[expected['title'],expected['schemaVersion'],expected['ckgSha256'],expected['configurationHash'],*expected['snapshot'].values()])
nodes=expected['softwareEngineeringDiagram']['nodes']; edges=expected['interfaceCatalog']['relations']
required('nodeIds',[x['id'] for x in nodes]); required('nodeNames',[x['name'] for x in nodes]+[x['qualifiedName'] for x in nodes])
required('nodeSignatures',[x.get('signature') for x in nodes])
required('nodeAttributes',[json.dumps(x['attributes'],sort_keys=True,ensure_ascii=False,separators=(',',':')) for x in nodes])
required('edgeIds',[x['id'] for x in edges]); required('relationFields',[x['kind'] for x in edges]+[x['resolution'] for x in edges]+[x['unresolvedReason'] for x in edges])
required('files',[x['path'] for x in expected['files']]+[x['sha256'] for x in expected['files']])
spans=[x['location'] for x in nodes if x['location']]+[s for x in edges for s in x['evidence']]
required('evidence',[x['filePath'] for x in spans]+[x['fileSha256'] for x in spans]+[f"[{x['startByte']}, {x['endByte']})" for x in spans]+[f"{x['startLine']}:{x['startColumn']}" for x in spans]+[f"{x['endLine']}:{x['endColumn']}" for x in spans])
required('limitations',[x['reason'] for x in expected['limitations']])
required('sections',['Interface Catalog','Software Engineering Diagram','UML Class Diagram','Canonical node and edge register'])
assert not missing,missing
assert '\ufffd' not in text
assert 'PDF21_RAW_SOURCE_CANARY' not in text
assert 'PDF21_URL_CANARY' not in text
assert all('SAGE Architecture Definition Document' in p for p in pages)
assert all(f'{i} / {len(pages)}' in p for i,p in enumerate(pages,1))
retry=folder/'sage-pdf21-browser-retry.pdf'
if retry.exists():
    with pdfplumber.open(retry) as document:
        retry_text='\n'.join(page.extract_text(x_tolerance=1.5,y_tolerance=3) or '' for page in document.pages)
    assert compact(retry_text)==normalized, 'Retry changed the canonical PDF text'
(folder/'extracted-text.txt').write_text(text)
report={'status':'PASS','pages':len(pages),'pageSizesPt':sorted(set(sizes)),'checks':checks,'missing':missing,'sha256':hashlib.sha256(pdf.read_bytes()).hexdigest(),'bytes':pdf.stat().st_size,'allPagesHeaderFooter':True,'canariesAbsent':True,'replacementGlyphAbsent':True,'retryCanonicalTextMatches':retry.exists(),'visualReview':'pending'}
(folder/'pdf-inspection.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
