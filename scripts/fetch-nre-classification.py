"""Fetch the current ShellMAP notice without reusing a cached PDF."""
import hashlib
import importlib.util
import io
import json
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

SOURCE_PAGE = "https://nre.tas.gov.au/aquaculture/shellmap/growing-and-harvest-areas"
CURRENT_PDF = "https://nre.tas.gov.au/SiteAssets/ShellMAP%20Current%20Harvest%20Status.pdf"
ARCHIVE_URL = "https://raw.githubusercontent.com/TOCsmithton-web/TOCsmithton-web/main/nre-current-classification.pdf"
spec = importlib.util.spec_from_file_location("extract_nre", Path(__file__).with_name("extract-nre-classification.py"))
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


class CurrentNoticeLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self.href = None
        self.label = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.href = dict(attrs).get("href")
            self.label = []

    def handle_data(self, data):
        if self.href is not None:
            self.label.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self.href is not None:
            label = re.sub(r"[\u200b-\u200f\ufeff]", "", "".join(self.label))
            label = re.sub(r"\s+", " ", label).strip().lower()
            if "current classification notice" in label:
                self.links.append(urljoin(SOURCE_PAGE, self.href))
            self.href = None


def official_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc.lower() != "nre.tas.gov.au":
        raise ValueError("Classification download must stay on the official NRE website")
    return url


def discover_pdf(html):
    parser = CurrentNoticeLinks()
    parser.feed(html)
    links = list(dict.fromkeys(parser.links))
    if len(links) != 1:
        raise ValueError("NRE current-classification link missing or ambiguous")
    url = official_url(links[0])
    if not urlsplit(url).path.lower().endswith(".pdf"):
        raise ValueError("NRE current-classification link is not a PDF")
    return url


def download_once(url):
    official_url(url)
    parts = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(parts.query) if k != "_toc_refresh"]
    query.append(("_toc_refresh", uuid.uuid4().hex))
    fresh_url = urlunsplit(parts._replace(query=urlencode(query), fragment=""))
    request = Request(fresh_url, headers={
        "Cache-Control": "no-cache, no-store, max-age=0",
        "Pragma": "no-cache",
        "User-Agent": "TOCsmithton-web ShellMAP notice monitor",
    })
    with urlopen(request, timeout=30) as response:
        official_url(response.url)
        data = response.read(10 * 1024 * 1024 + 1)
        if len(data) > 10 * 1024 * 1024:
            raise ValueError("NRE response exceeds the notice download limit")
        if int(response.headers.get("Age", "0")) > 60:
            raise ValueError("NRE returned a cached response despite the fresh-download request")
        return data, dict(response.headers)


def download(url):
    for attempt in range(3):
        try:
            return download_once(url)
        except OSError:
            if attempt == 2:
                raise
            time.sleep(2)


def parse_pdf(pdf, checked_at):
    from pypdf import PdfReader
    if not pdf.startswith(b"%PDF-"):
        raise ValueError("NRE returned a non-PDF response")
    text = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf)).pages)
    data = extractor.extract(text, checked_at)
    if not data["effectiveFrom"]:
        raise ValueError("Duck Bay effective time unavailable in the downloaded notice")
    compact = re.sub(r"\s+", " ", text)
    issued = re.search(r"classification notice takes effect on\s+(.+?),?\s+revokes", compact, re.I)
    if issued:
        data["noticeEffectiveFrom"] = issued.group(1).rstrip(",")
    return data


def notice_order(value):
    if not re.fullmatch(r"\d{4}/\d+", value or ""):
        raise ValueError("Invalid classification notice number")
    return tuple(map(int, value.split("/")))


def collect(output, archive):
    output, archive = Path(output), Path(archive)
    previous = json.loads(output.read_text()) if output.exists() else {}
    # If the index is temporarily unavailable, still check the official current-PDF
    # endpoint with a unique request. Never fall back to a saved local document.
    discovery_error = ""
    try:
        page, _ = download(SOURCE_PAGE)
    except OSError as error:
        discovery_error = str(error)
        source = CURRENT_PDF
    else:
        source = discover_pdf(page.decode("utf-8-sig"))
    pdf, headers = download(source)
    checked_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    data = parse_pdf(pdf, checked_at)
    if previous.get("classificationNotice") and notice_order(data["classificationNotice"]) < notice_order(previous["classificationNotice"]):
        raise ValueError("NRE returned an older notice; keeping the last validated notice and check time")
    data.update({
        "sourceUrl": source,
        "sourcePageUrl": SOURCE_PAGE,
        "cacheBypass": True,
        "documentSha256": hashlib.sha256(pdf).hexdigest(),
        "documentArchiveUrl": ARCHIVE_URL,
    })
    for header, field in [("last-modified", "documentLastModified"), ("etag", "documentEtag")]:
        value = next((v for k, v in headers.items() if k.lower() == header), None)
        if value:
            data[field] = value
    if discovery_error:
        data["sourceDiscoveryWarning"] = "NRE index unavailable; refreshed official current-PDF endpoint directly"
    # Publish only after the entire download, PDF extraction and regression checks pass.
    archive.write_bytes(pdf)
    output.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(data, indent=2))
    return data


if __name__ == "__main__":
    collect(*(sys.argv[1:] or ["nre-classification.json", "nre-current-classification.pdf"]))
