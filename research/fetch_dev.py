"""Read the embedded DEV GET link; never log its signed URL."""
from collections import Counter
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request

from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'data' / 'dev'
PDF = Path(r'C:/Users/user/Downloads/Telegram Desktop/CQA_Hackathon_Student_Guide_v3 1.pdf')


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    # All files in this directory may contain private data or signed audio URLs.
    (DEST / '.gitignore').write_text('*\n!.gitignore\n', encoding='utf-8')
    matches = []
    for annotation in PdfReader(PDF).pages[2].get('/Annots', []):
        action = annotation.get_object().get('/A')
        uri = action.get_object().get('/URI') if action else None
        if uri and urllib.parse.parse_qs(urllib.parse.urlsplit(str(uri)).query).get('group_id') == ['DEV']:
            matches.append(str(uri))
    if len(matches) != 1:
        result = {'status': 'failed', 'reason': 'DEV_link_count_not_one', 'count': len(matches)}
        write_json(ROOT / 'research' / 'dev-fetch-status.json', result)
        print(json.dumps(result))
        return 1
    url = matches[0]
    parsed_url = urllib.parse.urlsplit(url)
    manifest = {
        'retrieved_at_utc': datetime.now(timezone.utc).isoformat(),
        'method': 'GET', 'source_pdf': PDF.name, 'source_pdf_sha256': sha256(PDF.read_bytes()).hexdigest(),
        'source_page_one_based': 3, 'host': parsed_url.hostname,
        'query_parameter_names': sorted(urllib.parse.parse_qs(parsed_url.query)),
        'dataset_group_requested': 'DEV', 'signed_url_saved': False,
    }
    try:
        req = urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': 'CQA-DEV-ReadOnly/1.0'})
        with urllib.request.urlopen(req, timeout=45) as response:
            raw = response.read()
            manifest.update({'http_status': response.status, 'content_type': response.headers.get('Content-Type')})
    except urllib.error.HTTPError as exc:
        # Do not include exception repr or body: these can echo the signed URL.
        manifest.update({'status': 'failed', 'reason': 'HTTP_error', 'http_status': exc.code})
        write_json(ROOT / 'research' / 'dev-fetch-status.json', manifest)
        print(json.dumps(manifest, ensure_ascii=False))
        return 1
    except (urllib.error.URLError, TimeoutError, ssl.SSLError) as exc:
        reason = getattr(exc, 'reason', exc)
        manifest.update({'status': 'failed', 'reason': 'transport_error', 'exception_type': type(exc).__name__, 'underlying_type': type(reason).__name__})
        if isinstance(reason, ssl.SSLCertVerificationError):
            manifest['certificate_verification_code'] = reason.verify_code
            manifest['certificate_verification_message'] = reason.verify_message
        write_json(ROOT / 'research' / 'dev-fetch-status.json', manifest)
        print(json.dumps(manifest, ensure_ascii=False))
        return 1
    (DEST / 'api-response.json').write_bytes(raw)
    manifest.update({'byte_count': len(raw), 'sha256': sha256(raw).hexdigest(), 'raw_path': 'data/dev/api-response.json'})
    try:
        obj = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        manifest.update({'status': 'failed', 'reason': 'response_not_valid_JSON'})
        write_json(ROOT / 'research' / 'dev-fetch-status.json', manifest)
        print(json.dumps(manifest, ensure_ascii=False))
        return 1
    data = obj.get('data') if isinstance(obj, dict) else None
    records = data.get('records') if isinstance(data, dict) else None
    manifest.update({'isSuccess': obj.get('isSuccess') if isinstance(obj, dict) else None,
                     'status': 'downloaded' if isinstance(records, list) and obj.get('isSuccess') is True else 'unexpected_response_schema',
                     'top_level_keys': sorted(obj) if isinstance(obj, dict) else [],
                     'data_keys': sorted(data) if isinstance(data, dict) else [],
                     'record_count': len(records) if isinstance(records, list) else None})
    write_json(ROOT / 'research' / 'dev-fetch-status.json', manifest)
    write_json(DEST / 'download-manifest.json', manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0 if manifest['status'] == 'downloaded' else 1


if __name__ == '__main__':
    raise SystemExit(main())
