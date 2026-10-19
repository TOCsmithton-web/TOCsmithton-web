import json
import sys
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from bom_tides import TZ, cached_bom_tides, load_bom_tides

STATIONS = [
    {'name': 'Burnie', 'aac': 'TAS_TP001', 'reference_only': True, 'time_offset_minutes': 60},
    {'name': 'Hobart', 'aac': 'TAS_TP003', 'reference_only': True},
]


class TideCoverageTests(unittest.TestCase):
    def test_backup_covers_all_fourteen_days_after_old_table_expiry(self):
        for station in STATIONS:
            for start in (date(2026, 10, 20), date(2026, 12, 25), date(2027, 6, 15)):
                with self.subTest(station=station['name'], start=start):
                    data = cached_bom_tides(start, station)
                    self.assertTrue(data['complete_14_days'])
                    self.assertEqual(data['missing_dates'], [])
                    lows = {(datetime.fromtimestamp(e['dt'], TZ) + timedelta(minutes=station.get('time_offset_minutes', 0))).date()
                            for e in data['extremes'] if e['type'] == 'Low'}
                    self.assertTrue({start + timedelta(days=i) for i in range(14)} <= lows)

    def test_early_and_last_day_lows_keep_bounding_extrema(self):
        data = cached_bom_tides(date(2026, 10, 24), STATIONS[0])
        dates = [datetime.fromtimestamp(e['dt'] + 3600, TZ).date() for e in data['extremes']]
        self.assertLess(min(dates), date(2026, 10, 24))
        self.assertGreater(max(dates), date(2026, 11, 6))
        # BOM Burnie 24 October 03:49 / 16:25, with the farm's one-hour adjustment.
        lows = [(datetime.fromtimestamp(e['dt'] + 3600, TZ).strftime('%H:%M'), e['height'])
                for e in data['extremes'] if e['type'] == 'Low' and datetime.fromtimestamp(e['dt'] + 3600, TZ).date() == date(2026, 10, 24)]
        self.assertEqual(lows, [('04:49', 1.03), ('17:25', 1.03)])

    def test_complete_published_backup_works_when_live_bom_is_blocked(self):
        with patch('bom_tides.fetch_bom_tides', side_effect=RuntimeError('HTTP 403')) as live:
            data = load_bom_tides(date(2026, 10, 24), STATIONS[0])
        self.assertTrue(data['complete_14_days'])
        live.assert_not_called()

    def test_incomplete_backup_triggers_renewal_and_retains_missing_dates(self):
        partial = {'complete_14_days': False, 'missing_dates': ['2026-10-24']}
        with patch('bom_tides.cached_bom_tides', return_value=partial), \
             patch('annual_bom_tides.refresh_annual_cache', side_effect=RuntimeError('offline')) as renew, \
             patch('bom_tides.fetch_bom_tides', side_effect=RuntimeError('HTTP 403')):
            self.assertEqual(load_bom_tides(date(2026, 10, 24), STATIONS[0]), partial)
        renew.assert_called_once()

    def test_repeated_daylight_saving_hour_uses_verified_bom_utc(self):
        data = cached_bom_tides(date(2027, 4, 4), STATIONS[0])
        early = [e for e in data['extremes'] if e['type'] == 'Low' and e['dt'] == 1806770700]
        self.assertEqual(len(early), 1)
        self.assertEqual(datetime.fromtimestamp(early[0]['dt'], TZ).isoformat(), '2027-04-04T02:45:00+10:00')


if __name__ == '__main__':
    unittest.main()
