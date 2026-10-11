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
    zone = ZoneInfo('Australia/Hobart')
    rows = sorted(payload['observations']['data'], key=lambda r: r['aifstime_utc'], reverse=True)
    latest = rows[0]
    observed = datetime.strptime(latest['aifstime_utc'], '%Y%m%d%H%M%S').replace(tzinfo=timezone.utc).astimezone(zone)
    if not 0 <= (now-observed).total_seconds() <= 5400:
        raise RuntimeError('BOM live observation is stale or future dated')
    rain = float(latest['rain_trace'])
    if not math.isfinite(rain) or rain < 0:
        raise RuntimeError('BOM live rainfall is missing')
    # Exactly 09:00 reports the completed period; the following observation resets.
    end = observed.replace(hour=9, minute=0, second=0, microsecond=0)
    if observed > end:
        end += timedelta(days=1)
    start = end - timedelta(days=1)
    if now > end + timedelta(minutes=30):
        raise RuntimeError('Waiting for a post-9am rainfall observation')
    # Bridge the daily CSV publication delay using actual 9am observations.
    for row in rows:
        stamp = datetime.strptime(row['aifstime_utc'], '%Y%m%d%H%M%S').replace(tzinfo=timezone.utc).astimezone(zone)
        if (stamp.hour, stamp.minute, stamp.second) != (9, 0, 0):
            continue
        try:
            value = float(row['rain_trace'])
            if math.isfinite(value) and value >= 0:
                data['daily'].setdefault(stamp.date().isoformat(), value)
        except (ValueError, TypeError):
            pass
    data['live'] = {'rain_since_9am': rain, 'observed_at': observed.isoformat(),
                    'period_start': start.isoformat(), 'period_end': end.isoformat(),
                    'forecast_period_ends': [(end+timedelta(days=i)).isoformat() for i in range(7)],
                    'source_url': 'https://www.bom.gov.au/fwo/IDT60801/IDT60801.94953.json'}

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
    if station == '091292':
        try:
            request = urllib.request.Request('https://www.bom.gov.au/fwo/IDT60801/IDT60801.94953.json', headers={'User-Agent': 'TOC-Smithton-Rainfall/1.0'})
            with urllib.request.urlopen(request, timeout=45) as response:
                add_live_observations(data, json.load(response), now)
        except Exception as exc:
            data['live'] = None
            data['live_error'] = str(exc)
            print('Live rainfall unavailable:', exc)
    Path(output).write_text(json.dumps(data, indent=2) + '\n')
    print('BOM rainfall updated through', latest)


if __name__ == '__main__':
    import sys
    main(*sys.argv[1:])
