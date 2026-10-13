"""Extract only Duck Bay's classification and effective date from ShellMAP text."""
import json
import hashlib
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


def extract(text, checked_at=None):
    compact = re.sub(r"\s+", " ", text)
    notice = re.search(r"Classification Notice No\.\s*(\d{4}/\d+)", compact)
    start = compact.find("Duck Bay Harvest Area (Duck Bay)")
    end = compact.find("Kemps Bay Harvest Area (Duck Bay)", start)
    if not notice or start < 0 or end < 0:
        raise ValueError("Duck Bay classification boundaries or notice number unavailable")
    block = compact[start:end]
    if len(block) > 5000:
        raise ValueError("Duck Bay classification block unexpectedly large")
    status = re.search(r"^Duck Bay Harvest Area \(Duck Bay\)\s+(OPEN(?:\s*\(CONDITIONAL\))?|CLOSED)(?=\s|$)", block)
    if not status:
        raise ValueError("Duck Bay classification status unavailable")
    status_label = status.group(1)
    conditional = "CONDITIONAL" in status_label
    status_label = "OPEN (CONDITIONAL)" if conditional else status_label
    # OPEN subject to conditions is the normal wording of a conditional notice.
    effective = re.search(r"Duck Bay Harvest Area is\s+(?:CONDITIONALLY\s+)?(?:OPEN|CLOSED).*?from\s+([0-9]{3,4}\s*hrs\s+[0-9]{2}/[0-9]{2}/[0-9]{4})", block, re.I)
    details_match = re.search(r"Current harvest status\s+(.*)", block)
    details = details_match.group(1) if details_match else block
    # Remove PDF page footers, which can sit between Duck Bay and Kemps Bay.
    details = re.split(r"Page \d+ of \d+|Primary Produce Safety \(Seafood\) Regulations", details)[0].strip()
    return {
        "source": "NRE Tasmania ShellMAP current harvest status",
        "sourceUrl": "https://nre.tas.gov.au/SiteAssets/ShellMAP%20Current%20Harvest%20Status.pdf",
        "area": "Duck Bay Harvest Area",
        "status": "OPEN" if status_label == "OPEN" else "CLOSED",
        "statusLabel": status_label,
        "conditional": conditional,
        "classificationNotice": notice.group(1),
        "effectiveFrom": effective.group(1) if effective else "",
        "details": details,
        "checkedAt": checked_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


if __name__ == "__main__":
    data = extract(Path(sys.argv[1]).read_text(encoding="utf-8", errors="ignore"))
    if len(sys.argv)>3:
        data['documentSha256']=hashlib.sha256(Path(sys.argv[3]).read_bytes()).hexdigest()
        data['documentArchiveUrl']='https://raw.githubusercontent.com/TOCsmithton-web/TOCsmithton-web/main/nre-current-classification.pdf'
    Path(sys.argv[2]).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(data, indent=2))
