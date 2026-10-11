"""Fetch BOM Smithton daily rain; dates retain BOM's 9am reporting convention."""
import csv
import io
import json
import math
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


def parse_csv(text):
    rows = list(csv.reader(io.StringIO(text)))
    header = next(i for i, row in enumerate(rows) if 'Rainfall (mm)' in row)
    date_col = rows[header].index('Date')
    rain_col = rows[header].index('Rainfall (mm)')
    result = {}
    for row in rows[header + 1:]:
        try:
            day = datetime.strptime(row[date_col], '%Y-%m-%d').date().isoformat()
            rain = float(row[rain_col])
            if math.isfinite(rain) and rain >= 0:
                result[day] = rain
        except (ValueError, IndexError):
            continue  # A missing value is never a dry day.
    return result


def main(product='IDCJDW7047', station='091292', name='Smithton Aerodrome', output='smithton-rainfall.json'):
    now = datetime.now(ZoneInfo('Australia/Hobart'))
    months = sorted({now.strftime('%Y%m'), (now.date().replace(day=1)-timedelta(days=1)).strftime('%Y%m')})
    records = {}
    sources = []
    for month in months:
        url = f'https://www.bom.gov.au/climate/dwo/{month}/text/{product}.{month}.csv'
        request = urllib.request.Request(url, headers={'User-Agent': 'TOC-Smithton-Rainfall/1.0'})
        with urllib.request.urlopen(request, timeout=45) as response:
            records.update(parse_csv(response.read().decode('utf-8', errors='replace')))
        sources.append(url)
    today = now.date().isoformat()
    records = {day: rain for day, rain in records.items() if day <= today}
    if not records:
        raise RuntimeError('BOM returned no rainfall records')
    latest = max(records)
    if (now.date() - datetime.strptime(latest, '%Y-%m-%d').date()).days > 1:
        raise RuntimeError('BOM rainfall records are stale')
    data = {'station': station, 'source': 'BOM ' + name, 'period': '24 hours to 9am on the stated BOM date', 'updated': now.isoformat(), 'latest_date': latest, 'source_urls': sources, 'daily': records}
    Path(output).write_text(json.dumps(data, indent=2) + '\n')
    print('BOM rainfall updated through', latest)


if __name__ == '__main__':
    import sys
    main(*sys.argv[1:])
