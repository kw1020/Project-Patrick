import unittest

from car_flipper.analyzer import analyze
from car_flipper.parser import parse_listing
from car_flipper.sources.craigslist import parse_search_page


class ParserTests(unittest.TestCase):
    def test_parses_basics(self):
        l = parse_listing("2009 Honda Civic LX - $2,800\n178k miles, dirty")
        self.assertEqual((l.year, l.make, l.model, l.price, l.miles), (2009, "Honda", "Civic", 2800, 178000))

    def test_odometer_and_comma_miles(self):
        self.assertEqual(parse_listing("2010 Corolla odometer: 165,000").miles, 165000)
        self.assertEqual(parse_listing("2010 Corolla 165,000 miles").miles, 165000)

    def test_fit_not_matched_inside_profit(self):
        self.assertIsNone(parse_listing("2012 car great profit").model)


class AnalyzerTests(unittest.TestCase):
    def test_good_deal_is_buy_and_opens_below_asking(self):
        a = analyze(parse_listing("2009 Honda Civic $2,800\n178k miles, interior dirty"))
        self.assertEqual(a.verdict, "BUY")
        self.assertLess(a.opening_offer, 2800)
        self.assertGreater(a.list_price, a.expected_sale)
        self.assertTrue(any("deep clean" in s.step for s in a.cleaning_plan))

    def test_salvage_is_pass(self):
        a = analyze(parse_listing("2009 Honda Civic salvage title $1,500"))
        self.assertEqual(a.verdict, "PASS")

    def test_rebuilt_transmission_is_not_rebuilt_title(self):
        a = analyze(parse_listing("2009 Honda Civic $2,500 rebuilt transmission"))
        self.assertEqual(a.dealbreakers, [])

    def test_carpet_does_not_trigger_pet_hair(self):
        a = analyze(parse_listing("2009 Honda Civic $2,500 carpets are clean"))
        self.assertFalse(any("pet hair" in s.step for s in a.cleaning_plan))

    def test_overpriced_is_pass(self):
        self.assertEqual(analyze(parse_listing("2006 Honda Civic 230k miles $6,000")).verdict, "PASS")

    def test_way_too_cheap_is_suspicious(self):
        self.assertEqual(analyze(parse_listing("2014 Toyota Camry 90k miles $1,200")).verdict, "SUSPICIOUS")

    def test_warnings_lower_max_offer(self):
        clean = analyze(parse_listing("2009 Honda Civic $2,500 178k miles"))
        cel = analyze(parse_listing("2009 Honda Civic $2,500 178k miles check engine light on"))
        self.assertLess(cel.max_offer, clean.max_offer)

    def test_comps_override_book_value(self):
        target = parse_listing("2009 Honda Civic $2,500")
        comps = [parse_listing(f"2009 Honda Civic ${p}") for p in (4000, 4200, 4400, 4600, 4800)]
        a = analyze(target, comps=comps)
        self.assertIn("comps", a.value_source)
        self.assertEqual(a.market_value, int(4400 * 0.9))

    def test_user_market_value(self):
        a = analyze(parse_listing("2009 Honda Civic $2,500"), market_value=6000)
        self.assertEqual((a.market_value, a.value_source), (6000, "your number"))

    def test_unknown_model(self):
        self.assertEqual(analyze(parse_listing("2009 Pontiac Aztek $2,000")).verdict, "UNKNOWN")


SAMPLE_CL = """
<script type="application/ld+json" id="ld_searchpage_results">
{"@type":"ItemList","itemListElement":[
 {"@type":"ListItem","position":"0","item":{"@type":"Product","name":"2008 Toyota Corolla LE",
  "offers":{"@type":"Offer","price":"2900.00","availableAtOrFrom":{"address":{"addressLocality":"Oakland"}}}}}
]}
</script>
<ol><li class="cl-static-search-result" title="2008 Toyota Corolla LE">
<a href="https://sfbay.craigslist.org/eby/cto/d/oakland-2008-toyota-corolla/123.html">
<div class="title">2008 Toyota Corolla LE</div><div class="details"><div class="price">$2,900</div>
<div class="location">Oakland</div></div></a></li></ol>
"""


class CraigslistTests(unittest.TestCase):
    def test_json_ld(self):
        [l] = parse_search_page(SAMPLE_CL)
        self.assertEqual((l.model, l.year, l.price, l.location), ("Corolla", 2008, 2900, "Oakland"))
        self.assertTrue(l.url.endswith("123.html"))

    def test_html_fallback(self):
        page = SAMPLE_CL.split("</script>")[1]
        [l] = parse_search_page(page)
        self.assertEqual((l.model, l.price), ("Corolla", 2900))


if __name__ == "__main__":
    unittest.main()
