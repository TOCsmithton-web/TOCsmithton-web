"""Renew the tide backup from BOM's published annual tables, without estimating tides."""
import hashlib
import io
import json
import re
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from bom_tides import TZ, fetch_week

ROOT = Path(__file__).resolve().parents[1]
MONTHS = 'JANUARY FEBRUARY MARCH APRIL MAY JUNE JULY AUGUST SEPTEMBER OCTOBER NOVEMBER DECEMBER'.split()
WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']


def parse_annual_pdf(content, year, station):
    from pypdf import PdfReader

    rows = []
    for page in PdfReader(io.BytesIO(content)).pages:
        text = page.extract_text()
        if 'Times and Heights of High and Low Waters' not in text:
            continue
        if station['name'].upper() not in text or str(year) not in text:
            raise ValueError('Unexpected station or year in BOM annual table')
        month = day = None
        lines = [line.strip() for line in text.splitlines()]
        for i, line in enumerate(lines):
            if line in MONTHS:
                month = MONTHS.index(line) + 1
            if re.fullmatch(r'\d{1,2}', line) and i + 1 < len(lines) and lines[i + 1] in WEEKDAYS:
                day = int(line)
            pair = re.fullmatch(r'(\d{2})(\d{2})\s+(-?\d+\.\d+)', line)
            if pair and month and day:
                local = datetime(year, month, day, int(pair[1]), int(pair[2]), tzinfo=TZ)
                height = float(pair[3])
                if not -5 <= height <= 10:
                    raise ValueError('Invalid BOM tide height')
                rows.append((local, height))
    rows.sort()
    expected = {date(year, 1, 1) + timedelta(days=i) for i in range((date(year + 1, 1, 1) - date(year, 1, 1)).days)}
    dates = {t.date() for t, _ in rows}
    if dates != expected or len(rows) < 700 or len({t for t, _ in rows}) != len(rows):
        raise ValueError('Incomplete or duplicate BOM annual predictions')
    for day in expected:
        if not 2 <= sum(t.date() == day for t, _ in rows) <= 4:
            raise ValueError('Unexpected number of BOM tide events')
    # The PDF lists successive high/low extrema; equal rounded heights still alternate.
    if rows[0][1] == rows[1][1]:
        raise ValueError('First BOM tide type is ambiguous')
    first_high = rows[0][1] > rows[1][1]
    events = []
    ambiguous_days = set()
    for i, (local, height) in enumerate(rows):
        high = first_high if i % 2 == 0 else not first_high
        neighbours = [rows[j][1] for j in (i - 1, i + 1) if 0 <= j < len(rows)]
        if not all(height >= h if high else height <= h for h in neighbours):
            raise ValueError('BOM tide heights do not alternate consistently')
        if local.replace(fold=0).utcoffset() != local.replace(fold=1).utcoffset():
            ambiguous_days.add(local.date())
        events.append({'dt': int(local.timestamp()), 'type': 'High' if high else 'Low', 'height': height})
    # A PDF local time in the repeated DST hour has two possible UTC times.
    # Obtain BOM's explicit UTC timestamps; never guess which occurrence it means.
    for day in ambiguous_days:
        try:
            resolved = fetch_week(day, station)
            resolved = [e for e in resolved if datetime.fromtimestamp(e['dt'], TZ).date() == day]
            original = [(t.strftime('%H:%M'), h) for t, h in rows if t.date() == day]
            if [(datetime.fromtimestamp(e['dt'], TZ).strftime('%H:%M'), e['height']) for e in resolved] != original:
                raise ValueError('BOM annual and UTC tide tables disagree')
        except Exception:
            # Preserve other verified dates. The coverage check will identify this gap.
            resolved = []
            print('BOM DST timestamps unavailable for', station['name'], day)
        events = [e for e in events if datetime.fromtimestamp(e['dt'], TZ).date() != day] + resolved
    return sorted(events, key=lambda e: e['dt'])


def refresh_annual_cache(start, station):
    path = ROOT / ('bom-pirates-tides.json' if station['aac'] == 'TAS_TP025' else 'bom-' + station['aac'] + '-tides.json')
    old = json.loads(path.read_text()) if path.exists() else {}
    events = {int(t): [int(t), kind, float(h)] for t, kind, h in old.get('events', [])}
    sources = {s['url']: s for s in old.get('annual_sources', [])}
    years = range((start - timedelta(days=1)).year, (start + timedelta(days=14)).year + 1)
    for year in years:
        url = f'https://www.bom.gov.au/ntc/IDO59001/IDO59001_{year}_{station["aac"]}.pdf'
        with urllib.request.urlopen(url, timeout=30) as response:
            content = response.read()
        if not content.startswith(b'%PDF-'):
            raise ValueError('BOM annual table is not a PDF')
        parsed = parse_annual_pdf(content, year, station)
        events.update({e['dt']: [e['dt'], 'L' if e['type'] == 'Low' else 'H', e['height']] for e in parsed})
        sources[url] = {'url': url, 'sha256': hashlib.sha256(content).hexdigest()}
    result = {'station': station, 'aac': station['aac'], 'source_url': 'https://www.bom.gov.au/oceanography/projects/ntc/tas_tide_tables.shtml',
              'downloaded_at': datetime.now(timezone.utc).isoformat(), 'datum': 'Lowest Astronomical Tide',
              'annual_sources': list(sources.values()), 'events': sorted(events.values())}
    path.write_text(json.dumps(result, separators=(',', ':')) + '\n')
    return result
