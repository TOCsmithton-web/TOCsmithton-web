import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('extract_nre', Path(__file__).parents[1] / 'scripts/extract-nre-classification.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ClassificationTests(unittest.TestCase):
    def text(self, status='OPEN', details=''):
        return f'''Classification Notice No. 2026/057 Duck Bay Harvest Area (Duck Bay) {status}
        Classification Duck Bay Harvest Area (Lease numbers 22, 23, 24)
        Current harvest status Duck Bay Harvest Area is OPEN for all regulated fish from 0615hrs 13/10/2026 {details}
        Page 7 of 17 Primary Produce Safety (Seafood) Regulations 2023
        Kemps Bay Harvest Area (Duck Bay) OPEN (CONDITIONAL) Current harvest status Depuration required from 1030hrs 05/03/2026.'''

    def test_open(self):
        x=module.extract(self.text())
        self.assertEqual(x['statusLabel'],'OPEN')
        self.assertEqual(x['effectiveFrom'],'0615hrs 13/10/2026')
        self.assertNotIn('Kemps',x['details'])
        self.assertNotIn('Page 7',x['details'])

    def test_conditional(self):
        x=module.extract(self.text('OPEN (CONDITIONAL)','subject to transfer for depuration.'))
        self.assertTrue(x['conditional'])
        self.assertEqual(x['statusLabel'],'OPEN (CONDITIONAL)')
        self.assertIn('depuration',x['details'])

    def test_missing_boundary(self):
        with self.assertRaises(ValueError):module.extract('Classification Notice No. 2026/057 Duck Bay Harvest Area (Duck Bay) OPEN')


if __name__ == '__main__':unittest.main()
