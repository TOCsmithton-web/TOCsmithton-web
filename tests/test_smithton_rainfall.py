"""Regression checks for observed Smithton rainfall at 9am, no fabricated days."""
import importlib.util
import unittest
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/fetch-smithton-rainfall.py'
spec = importlib.util.spec_from_file_location('smithton_rain', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ZONE = ZoneInfo('Australia/Hobart')


def sample(day, hour, minute, rain):
    ts = datetime(2026, 10, day, hour, minute, tzinfo=ZONE)
    return {'aifstime_utc': ts.astimezone(timezone.utc).strftime('%Y%m%d%H%M%S'),
            'rain_trace': str(rain)}


class SmithtonRainfallTests(unittest.TestCase):
    def test_live_and_recent_9am_reporting_dates(self):
        data = {'daily': {'2026-10-12': 1.5}}
        payload = {'observations': {'data': [
            sample(14, 9, 30, 0.2),
            sample(14, 8, 30, 3.2),
            sample(14, 9, 0, 0.0),
            sample(13, 8, 30, 1.1),
            sample(12, 8, 30, 2.4),
        ]}}
        module.add_live_observations(data, payload, datetime(2026, 10, 14, 9, 35, tzinfo=ZONE))
        self.assertEqual(data['live']['rain_since_9am'], 0.2)
        self.assertEqual(data['daily']['2026-10-14'], 3.2)
        self.assertEqual(data['daily']['2026-10-13'], 1.1)
        self.assertEqual(data['daily']['2026-10-12'], 1.5)
        self.assertEqual(data['live']['period_start'].split('T')[0], '2026-10-14')

    def test_stale_reading_is_rejected(self):
        data = {'daily': {}}
        payload = {'observations': {'data': [sample(13, 7, 30, 3.2)]}}
        with self.assertRaisesRegex(RuntimeError, 'stale'):
            module.add_live_observations(data, payload, datetime(2026, 10, 14, 9, 35, tzinfo=ZONE))
        self.assertEqual(data['daily'], {})

    def test_missing_rain_is_not_zero(self):
        data = {'daily': {}}
        payload = {'observations': {'data': [sample(14, 9, 30, 'N/A')]}}
        with self.assertRaisesRegex(RuntimeError, 'no numeric'):
            module.add_live_observations(data, payload, datetime(2026, 10, 14, 9, 35, tzinfo=ZONE))
        self.assertNotIn('live', data)


if __name__ == '__main__':
    unittest.main()
