"""Read the same seven-day tide tables used by BOM's public website."""
from datetime import datetime, timedelta
from html.parser import HTMLParser
from concurrent.futures import ThreadPoolExecutor
import urllib.parse, urllib.request
from zoneinfo import ZoneInfo
TZ=ZoneInfo('Australia/Hobart')
BASE='https://www.bom.gov.au/australia/tides/'
STATION={'name':'Pirates Bay','aac':'TAS_TP025','latitude':-43.0333,'longitude':147.9667,'reference_only':True}
class TideParser(HTMLParser):
    def __init__(self):
        super().__init__();self.events=[];self.pending=None;self.capture=False;self.value='';self.heading=False;self.title=''
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag=='h2':self.heading=True
        if tag!='td':return
        if a.get('data-time-utc'):
            kind='Low' if 'low-tide' in a.get('class','') else 'High' if 'high-tide' in a.get('class','') else None
            if kind:
                utc=datetime.fromisoformat(a['data-time-utc'].replace('Z','+00:00'))
                local=datetime.fromisoformat(a['data-time-local'])
                if utc.timestamp()!=local.timestamp():raise ValueError('Inconsistent BOM timezone')
                self.pending={'dt':int(utc.timestamp()),'type':kind,'time_local':local.isoformat()}
        if 'height' in a.get('class','').split():self.capture=True;self.value=''
    def handle_data(self,data):
        if self.heading:self.title+=data
        if self.capture:self.value+=data
    def handle_endtag(self,tag):
        if tag=='h2':self.heading=False
        if tag=='td' and self.capture:
            self.capture=False
            if self.pending:
                height=float(self.value.strip().removesuffix('m').strip())
                if not -5<=height<=10:raise ValueError('Invalid BOM height')
                self.events.append({**self.pending,'height':height});self.pending=None

def parse_table(html,start,station=STATION):
    parser=TideParser();parser.feed(html)
    if station['name'] not in parser.title:raise ValueError('Unexpected BOM station')
    dates={datetime.fromtimestamp(x['dt'],TZ).date() for x in parser.events}
    expected={start+timedelta(days=i) for i in range(7)}
    if dates!=expected or len(parser.events)<14:raise ValueError('Incomplete BOM seven-day table')
    return parser.events

def fetch_week(start,station=STATION):
    q={'type':'tide','aac':station['aac'],'date':start.strftime('%d-%m-%Y'),'days':7,'region':'TAS','offset':0,'offsetName':'','tz':'Australia/Hobart','tz_js':datetime.combine(start,datetime.min.time(),TZ).tzname()}
    url=BASE+'scripts/getTidesTable.php?'+urllib.parse.urlencode(q)
    with urllib.request.urlopen(url,timeout=30) as r:html=r.read().decode('utf-8')
    return parse_table(html,start,station)

def fetch_bom_tides(start,station=STATION):
    starts=[start,start+timedelta(days=7)]
    if station.get('time_offset_minutes'):starts.insert(0,start-timedelta(days=7))
    with ThreadPoolExecutor(max_workers=3) as pool:weeks=list(pool.map(lambda day: fetch_week(day,station),starts))
    events=sorted([event for week in weeks for event in week],key=lambda e:e['dt'])
    if len({e['dt'] for e in events})!=len(events):raise ValueError('Duplicate BOM events')
    return {'source':'Bureau of Meteorology — '+station['name']+' (reference)', 'source_url':BASE+'?aac='+station['aac'],'station':station,'datum':'BOM prediction datum','extremes':events,'coverage_start':start.isoformat(),'coverage_end':(start+timedelta(days=13)).isoformat(),'weather_adjusted':False,'copyright':'© Commonwealth of Australia, Bureau of Meteorology','notice':'Reference port predictions; lease times and heights may differ. Weather effects are not included.'}

def cached_bom_tides(start,station=STATION):
    """Use verified, published astronomical tables when BOM rejects runner requests."""
    import json
    from pathlib import Path
    cache=json.loads((Path(__file__).resolve().parents[1]/('bom-'+station['aac']+'-tides.json' if station['aac']!=STATION['aac'] else 'bom-pirates-tides.json')).read_text())
    end=start+timedelta(days=13)
    events=[{'dt':int(t),'type':'Low' if kind=='L' else 'High','height':float(h)} for t,kind,h in cache['events'] if start-timedelta(days=1 if station.get('time_offset_minutes') else 0)<=datetime.fromtimestamp(t,TZ).date()<=end]
    dates={datetime.fromtimestamp(e['dt'],TZ).date() for e in events}
    expected={start+timedelta(days=i) for i in range(14)}
    # Retain only actual BOM events. When the cache ends, unsupported days stay blank.
    if not events:raise ValueError('BOM cache has no dates in requested period')
    return {'source':'Bureau of Meteorology — '+station['name']+' (reference)','source_url':BASE+'?aac='+station['aac'],'station':station,'datum':'BOM prediction datum','extremes':events,'coverage_start':min(dates).isoformat(),'coverage_end':max(dates).isoformat(),'weather_adjusted':False,'copyright':'© Commonwealth of Australia, Bureau of Meteorology','notice':'Reference port predictions; lease times and heights may differ. Weather effects are excluded.','using_stored_tables':True,'source_downloaded_at':cache['downloaded_at'],'complete_14_days':dates==expected}
