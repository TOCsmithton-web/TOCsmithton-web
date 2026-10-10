"""Fetch forecasts without exposing credentials in the published artifact."""
import json, os, math, urllib.request, urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from bom_tides import fetch_bom_tides
ROOT=Path(__file__).resolve().parents[1]
LAT,LON=-42.88,147.86

def get(url, payload=None, headers=None):
    req=urllib.request.Request(url,data=json.dumps(payload).encode() if payload else None,headers=headers or {})
    with urllib.request.urlopen(req,timeout=35) as r:return json.load(r)

def main():
    now=datetime.now(timezone.utc)
    data={'updated_at':now.isoformat(),'location':{'name':'Boomer Bay','latitude':LAT,'longitude':LON},'weather':None,'marine':None,'tides':None,'tide_mode':'bom','ai':{'status':'not_connected'},'errors':[]}
    common={'latitude':LAT,'longitude':LON,'forecast_days':16,'timezone':'Australia/Hobart','timeformat':'unixtime'}
    try:
        data['weather']=get('https://api.open-meteo.com/v1/forecast?'+urllib.parse.urlencode({**common,'wind_speed_unit':'kn','hourly':'pressure_msl,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation,is_day','daily':'sunrise,sunset'}))
    except Exception:data['errors'].append('Weather feed unavailable')
    try:
        data['tides']=fetch_bom_tides(now.astimezone(ZoneInfo('Australia/Hobart')).date())
    except Exception:
        data['errors'].append('BOM reference tide predictions unavailable')
    # AI explains only supplied facts; it cannot change the deterministic work windows.
    endpoint=os.environ.get('PLANNER_AI_ENDPOINT','')
    key=os.environ.get('PLANNER_AI_API_KEY','')
    model=os.environ.get('PLANNER_AI_MODEL','')
    if endpoint and key and model and data['weather']:
        try:
            w=data['weather']['hourly'];brief=[]
            for i in range(0,len(w['time']),6):
                brief.append({k:w[k][i] for k in ['time','pressure_msl','wind_speed_10m','wind_gusts_10m','wind_direction_10m']})
            prompt='Explain this Boomer Bay oyster-lease forecast in at most 120 words. Work is around daylight low tides. Give planning observations on wind and pressure only; do not invent tide times, heights, lease limits, safe access, harvest permission, or probability/confidence percentages. BOM tide predictions are for nearby Pirates Bay, not Boomer Bay. Do not treat the reference tide times or heights as lease measurements. Weather effects are excluded from BOM predictions. Days 8-14 are tentative. Data: '+json.dumps({'weather':brief,'local_tides':data['tides'],'provisional_marine':bool(data['marine'])})
            r=get(endpoint,{'model':model,'messages':[{'role':'user','content':prompt}],'max_tokens':250}, {'Authorization':'Bearer '+key,'Content-Type':'application/json'})
            summary=r['choices'][0]['message']['content']
            if not isinstance(summary,str) or not summary.strip():raise ValueError('Empty AI reply')
            data['ai']={'status':'available','model':model,'summary':summary[:1800]}
        except Exception:data['ai']={'status':'unavailable'}
    (ROOT/'boomer-planner.json').write_text(json.dumps(data,separators=(',',':'))+'\n')
    print('Planner snapshot saved; weather:',bool(data['weather']),'marine:',bool(data['marine']),'local tides:',bool(data['tides']),'AI:',data['ai']['status'])
if __name__=='__main__':main()
