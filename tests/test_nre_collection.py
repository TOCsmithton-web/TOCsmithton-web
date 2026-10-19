import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit

spec = importlib.util.spec_from_file_location("fetch_nre", Path(__file__).parents[1] / "scripts/fetch-nre-classification.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

PAGE = b'<a href="/SiteAssets/Replacement%20Notice.pdf">Read the current classification notice.</a>'
DATA = {"classificationNotice": "2026/059", "effectiveFrom": "0800hrs 16/10/2026", "statusLabel": "OPEN"}


class Response:
    def __init__(self, url, body=b"test", headers=None):
        self.url, self.body, self.headers = url, body, headers or {}

    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, size): return self.body[:size]


class CollectionTests(unittest.TestCase):
    def test_discovers_replaced_pdf_and_ignores_archive_links(self):
        html = '<a href="/SiteAssets/Old.pdf">Revoked notice</a><a href="/SiteAssets/New.pdf"><span>Read the current classification notice.</span>\u200b</a>'
        self.assertEqual(module.discover_pdf(html), "https://nre.tas.gov.au/SiteAssets/New.pdf")

    def test_rejects_missing_ambiguous_and_non_official_links(self):
        for html in ["", PAGE.decode() + '<a href="/other.pdf">current classification notice</a>', '<a href="https://example.com/x.pdf">current classification notice</a>']:
            with self.subTest(html=html), self.assertRaises(ValueError):
                module.discover_pdf(html)

    def test_each_download_bypasses_cache_and_preserves_source_query(self):
        requests = []
        def open_url(request, timeout):
            requests.append(request)
            return Response(request.full_url)
        with patch.object(module, "urlopen", side_effect=open_url):
            for _ in range(2): module.download(module.CURRENT_PDF + "?version=2#page=6")
        first, second = [parse_qs(urlsplit(r.full_url).query) for r in requests]
        self.assertNotEqual(first["_toc_refresh"], second["_toc_refresh"])
        self.assertEqual(first["version"], ["2"])
        self.assertEqual(urlsplit(requests[0].full_url).fragment, "")
        self.assertIn("no-cache", dict(requests[0].header_items())["Cache-control"])

    def test_rejects_cached_response_and_official_site_redirect(self):
        for response in [Response(module.CURRENT_PDF, headers={"Age": "500"}), Response("https://example.com/test.pdf")]:
            with patch.object(module, "urlopen", return_value=response), self.assertRaises(ValueError):
                module.download(module.CURRENT_PDF)

    def test_transient_download_failure_is_retried_with_a_new_request(self):
        requests = []
        def open_url(request, timeout):
            requests.append(request.full_url)
            if len(requests) == 1:
                raise URLError("temporary outage")
            return Response(request.full_url)
        with patch.object(module, "urlopen", side_effect=open_url), patch.object(module.time, "sleep"):
            module.download(module.CURRENT_PDF)
        self.assertEqual(len(requests), 2)
        self.assertNotEqual(requests[0], requests[1])

    def run_collection(self, previous, data=DATA, downloads=None):
        with tempfile.TemporaryDirectory() as folder:
            output, archive = Path(folder) / "notice.json", Path(folder) / "notice.pdf"
            output.write_text(json.dumps(previous))
            archive.write_bytes(b"previous PDF")
            old_json = output.read_bytes()
            with patch.object(module, "download", side_effect=downloads or [(PAGE, {}), (b"%PDF-test", {"Last-Modified": "Mon, 19 Oct 2026 00:00:00 GMT"})]), patch.object(module, "parse_pdf", return_value=dict(data)), redirect_stdout(io.StringIO()):
                try:
                    result = module.collect(output, archive)
                except Exception:
                    self.assertEqual(output.read_bytes(), old_json)
                    self.assertEqual(archive.read_bytes(), b"previous PDF")
                    raise
            self.assertEqual(archive.read_bytes(), b"%PDF-test")
            self.assertEqual(json.loads(output.read_text()), result)
            return result

    def test_publishes_new_notice_with_fresh_download_evidence(self):
        result = self.run_collection({"classificationNotice": "2026/058"})
        self.assertEqual(result["classificationNotice"], "2026/059")
        self.assertEqual(result["sourceUrl"], "https://nre.tas.gov.au/SiteAssets/Replacement%20Notice.pdf")
        self.assertTrue(result["cacheBypass"])
        self.assertEqual(len(result["documentSha256"]), 64)
        self.assertIn("documentLastModified", result)

    def test_older_notice_does_not_overwrite_newer_notice_or_check_time(self):
        with self.assertRaisesRegex(ValueError, "older notice"):
            self.run_collection({"classificationNotice": "2026/060", "checkedAt": "2026-10-19T19:02:00Z"})

    def test_numeric_notice_order_and_year_rollover(self):
        self.assertGreater(module.notice_order("2026/100"), module.notice_order("2026/99"))
        self.assertGreater(module.notice_order("2027/001"), module.notice_order("2026/999"))

    def test_index_outage_still_refreshes_official_endpoint(self):
        result = self.run_collection({}, downloads=[URLError("NRE index unavailable"), (b"%PDF-test", {})])
        self.assertEqual(result["sourceUrl"], module.CURRENT_PDF)
        self.assertIn("sourceDiscoveryWarning", result)

    def test_download_failure_keeps_last_notice_untouched(self):
        with self.assertRaises(URLError):
            self.run_collection({}, downloads=[(PAGE, {}), URLError("PDF unavailable")])

    def test_html_error_page_is_not_a_notice(self):
        with self.assertRaisesRegex(ValueError, "non-PDF"):
            module.parse_pdf(b"<html>service unavailable</html>", "2026-10-19T20:00:00Z")


if __name__ == "__main__": unittest.main()
