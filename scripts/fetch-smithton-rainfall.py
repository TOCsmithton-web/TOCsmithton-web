"""Fetch BOM Smithton daily rain; dates retain BOM's 9am reporting convention."""
import csv
import io
import json
import math
import urllib.request
from datetime import datetime, timedelta, timezone
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



def add_live_observations(data, payload, now):
    """Use observed BOM rain only; never synthesize dry days or totals."""
    zone = ZoneInfo('Australia/Hobart')
    raw = payload.get('observations', {}).get('data', [])
    rows = []
    for row in raw:
        try:
            stamp = datetime.strptime(str(row['aifstime_utc']), '%Y%m%d%H%M%S').replace(
                tzinfo=timezone.utc).astimezone(zone)
            value = float(row['rain_trace'])
            if math.isfinite(value) and value >= 0:
                rows.append((stamp, value))
        except (KeyError, ValueError, TypeError):
            continue
    rows.sort(key=lambda item: item[0], reverse=True)
    if not rows:
        raise RuntimeError('BOM has no numeric Smithton rain observations')
    observed, rain = rows[0]
    age = (now - observed).total_seconds()
    if not 0 <= age <= 5400:
        raise RuntimeError('Latest BOM Smithton rain observation is stale or future dated')

    # Work in Hobart local time; the BOM reporting day ends at 9am.
    end = observed.replace(hour=9, minute=0, second=0, microsecond=0)
    if observed > end:
        end += timedelta(days=1)
    start = end - timedelta(days=1)
    if now > end + timedelta(minutes=30):
        raise RuntimeError('Awaiting a new post-9am observation from BOM')

    # Recover delayed daily CSV reports from the last valid observation BEFORE
    # each 9am boundary. The BOM rain_trace at exactly 09:00 may already have
    # reset to zero, so it must not be used for the preceding reporting day.
    for offset in range(4):
        cutoff = now.replace(hour=9, minute=0, second=0, microsecond=0) - timedelta(days=offset)
        if cutoff > now:
            continue
        preceding = [(stamp, value) for stamp, value in rows
                     if cutoff-timedelta(minutes=90) <= stamp < cutoff]
        if preceding:
            _, amount = max(preceding, key=lambda item: item[0])
            data['daily'].setdefault(cutoff.date().isoformat(), amount)

    data['live'] = {
        'rain_since_9am': rain, 'observed_at': observed.isoformat(),
        'period_start': start.isoformat(), 'period_end': end.isoformat(),
        'forecast_period_ends': [(end+timedelta(days=i)).isoformat() for i in range(7)],
        'source_url': 'https://www.bom.gov.au/fwo/IDT60801/IDT60801.94953.json'
    }


def main(product='IDCJDW7047', station='091292', name='Smithton Aerodrome',
         output='smithton-rainfall.json'):
    now = datetime.now(ZoneInfo('Australia/Hobart'))
    path = Path(output)
    months = sorted({now.strftime('%Y%m'),
                     (now.date().replace(day=1)-timedelta(days=1)).strftime('%Y%m')})
    records = {}
    sources = []
    problems = []

    # Retain known, numeric, originally observed readings when BOM is delayed.
    # An old reading is not promoted to current, and missing days stay missing.
    if path.exists():
        try:
            previous = json.loads(path.read_text())
            if str(previous.get('station')) == str(station):
                for day, value in previous.get('daily', {}).items():
                    if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0:
                        records[day] = float(value)
        except (OSError, ValueError, TypeError) as exc:
            problems.append('Unable to load previous confirmed readings: ' + str(exc))

    for month in months:
        url = f'https://www.bom.gov.au/climate/dwo/{month}/text/{product}.{month}.csv'
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'TOC-Smithton-Rainfall/1.0'})
            with urllib.request.urlopen(request, timeout=35) as response:
                new_daily = parse_csv(response.read().decode('utf-8', errors='replace'))
            if not new_daily:
                raise ValueError('No numeric daily rainfall rows')
            records.update(new_daily)
            sources.append(url)
        except (OSError, ValueError, StopIteration) as exc:
            problems.append('BOM daily ' + month + ': ' + str(exc))

    today = now.date().isoformat()
    records = {day: value for day, value in records.items() if day <= today}
    data = {'station': station, 'source': 'BOM ' + name,
            'period': '24 hours to 9am on the stated BOM date',
            'updated': now.isoformat(), 'source_urls': sources, 'daily': records}

    if station == '091292':
        try:
            request = urllib.request.Request(
                'https://www.bom.gov.au/fwo/IDT60801/IDT60801.94953.json',
                headers={'User-Agent': 'TOC-Smithton-Rainfall/1.0'})
            with urllib.request.urlopen(request, timeout=35) as response:
                add_live_observations(data, json.load(response), now)
        except (OSError, ValueError, TypeError, KeyError, RuntimeError) as exc:
            data['live'] = None
            data['live_error'] = str(exc)
            problems.append('BOM live observations: ' + str(exc))

    latest = max(data['daily'], default=None)
    data['latest_date'] = latest
    # Mark outdated evidence clearly rather than pretending the missing days are zero.
    if latest is None or (now.date() - datetime.strptime(latest, '%Y-%m-%d').date()).days > 1:
        problems.append('Confirmed BOM daily rainfall is older than one day')
    data['source_errors'] = problems
    data['collection_status'] = 'ok' if not problems else 'degraded'
    path.write_text(json.dumps(data, indent=2) + '\n')
    print('BOM rainfall last confirmed', latest, 'live:', bool(data.get('live')),
          'issues:', '; '.join(problems) if problems else 'none')


if __name__ == '__main__':
    import sys
    main(*sys.argv[1:])
