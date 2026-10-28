import json
from pathlib import Path
import tempfile
import unittest

from retriever.scientific_reading import ScientificReader, extract_blocks
from retriever.p2 import P2Corpus
from retriever.worker import ParameterError


PAPER = "1908.10084"
HTML = r'''<article><section id="S2"><h2>Results</h2><p>Scores are percentages; higher is better.</p>
<figure class="ltx_table" id="T1"><figcaption>Table 1: Accuracy (%)</figcaption><table>
<tr><th>Model</th><th>Score (%)</th><th>Objective</th></tr>
<tr><td rowspan="2">Encoder</td><td>89.2</td><td><math alttext="\|x\|^2"></math></td></tr>
<tr><td>90.1</td><td>cosine</td></tr><tr><td colspan="2">Baseline</td><td>78</td></tr></table></figure>
<p>The loss measures the prediction error.</p><div class="ltx_equation" id="E1"><span class="ltx_tag">(1)</span>
<math display="block" alttext="L = \frac{1}{n}\sum_i (y_i-\hat{y}_i)^2"></math></div>
<div id="E2"><math display="block"><mfrac><mi>a</mi><msup><mi>b</mi><mn>2</mn></msup></mfrac></math></div>
<script>DO NOT INCLUDE SCRIPT</script></section></article>'''


class ScientificReadingTests(unittest.TestCase):
    def test_tables_and_math_preserve_values_structure_units_and_original_locators(self):
        blocks = extract_blocks(HTML)
        table = next(block for block in blocks if block["kind"] == "table")
        self.assertIn("| Model | Score (%) | Objective |", table["text"])
        self.assertIn(r"| Encoder | 89.2 | $\Vert x\Vert ^2$ |", table["text"])
        self.assertIn("|  | 90.1 | cosine |", table["text"])
        self.assertIn("| Baseline |  | 78 |", table["text"])
        self.assertEqual(table["locator"], "T1")
        equations = [block for block in blocks if block["kind"] == "equation"]
        self.assertEqual(len(equations), 2)
        self.assertIn(r"L = \frac{1}{n}\sum_i (y_i-\hat{y}_i)^2", equations[0]["text"])
        self.assertIn(r"\frac{a}{{b}^{2}}", equations[1]["text"])
        self.assertIn("The loss measures", equations[0]["text"])
        self.assertNotIn("DO NOT INCLUDE", json.dumps(blocks))

    def test_long_tables_split_only_between_rows_and_repeat_headers(self):
        rows = [f"<tr><td>row-{i}</td><td>{'value ' * 120}</td></tr>" for i in range(35)]
        blocks = extract_blocks('<article><table><tr><th>Item</th><th>Value</th></tr>'+''.join(rows)+'</table></article>')
        self.assertGreater(len(blocks), 1)
        self.assertEqual(sum(block["text"].count("| row-") for block in blocks), 35)
        for block in blocks:
            self.assertIn("| Item | Value |", block["text"])
            self.assertTrue(block["text"].rstrip().endswith("|"))
        self.assertEqual(sum(f"| row-{i} |" in block["text"] for block in blocks for i in range(35)), 35)

    def test_paging_cache_recovery_and_tamper_rejection(self):
        calls = []
        def fetch(url):
            calls.append(url)
            return HTML, url
        with tempfile.TemporaryDirectory(prefix="astercite-scientific-") as temporary:
            reader = ScientificReader(Path(temporary), "index-fixture", fetch)
            params = {"paper_ids": [PAPER], "query": "Results", "top_k": 1, "offset": 0, "content_type": "all"}
            first = reader.retrieve(params, {PAPER: {}})
            self.assertEqual(len(first["chunks"]), 1)
            self.assertTrue(first["selection"]["has_more"])
            self.assertEqual(first["selection"]["next_offset"], 1)
            second = reader.retrieve({**params, "offset": 1}, {PAPER: {}})
            self.assertNotEqual(first["chunks"][0]["chunk_id"], second["chunks"][0]["chunk_id"])
            self.assertEqual(len(calls), 1)
            restored = ScientificReader(Path(temporary), "index-fixture", lambda _: self.fail("No network on cache reuse"))
            self.assertEqual(restored.retrieve(params, {PAPER: {}})["chunks"], first["chunks"])
            manifest = reader.directory / (PAPER + ".json")
            data = json.loads(manifest.read_text(encoding="utf-8")); data["blocks"][0]["text"] += "forged"
            manifest.write_text(json.dumps(data), encoding="utf-8")
            reader.retrieve(params, {PAPER: {}})
            self.assertEqual(len(calls), 2)
            self.assertNotIn("forged", manifest.read_text(encoding="utf-8"))
            self.assertEqual(reader.retrieve({**params, "offset": 500}, {PAPER: {}})["selection"]["next_offset"], 500)

    def test_unavailable_sources_and_oversized_objects_are_explicit(self):
        huge = '<table><tr><th>Cell</th><th>Value</th></tr><tr><td>a</td><td>'+('x' * 18000)+'</td></tr></table>'
        self.assertTrue(extract_blocks(huge).incomplete)
        with tempfile.TemporaryDirectory(prefix="astercite-source-") as temporary:
            reader = ScientificReader(Path(temporary), "idx", lambda url: (HTML, "https://example.com/"))
            result = reader.retrieve({"paper_ids": [PAPER], "query": "x"}, {PAPER: {}})
            self.assertEqual(result["chunks"], [])
            self.assertEqual(result["selection"]["unavailable_papers"], [PAPER])
            self.assertIsNone(reader.document("../private"))
            with self.assertRaises(ValueError): reader.retrieve({"paper_ids": ["foreign"], "query": "x"}, {PAPER: {}})

    def test_strict_retrieval_keeps_five_and_product_reading_continues_same_ranking(self):
        corpus = object.__new__(P2Corpus)
        corpus.papers = {"p1": {"title": "Study"}}
        corpus.chunks = [{"paper_id": "p1", "chunk_id": str(i)} for i in range(25)]
        corpus.profile, corpus.index_version, corpus.backend = "bm25", "fixture", "bm25"
        corpus._lexical = lambda query, eligible: [(25-i, corpus.chunks[i]) for i in eligible]
        query = {"paper_ids": ["p1"], "query": "Study details"}
        strict = corpus.retrieve_chunks(query)
        self.assertEqual(len(strict["chunks"]), 5)
        self.assertNotIn("selection", strict)
        with self.assertRaises(ParameterError): corpus.retrieve_chunks({**query, "top_k": 6})
        with self.assertRaises(ParameterError): corpus.retrieve_chunks({**query, "offset": 5})
        product = corpus.retrieve_chunks({**query, "reading_mode": "workbench-v1", "top_k": 20})
        self.assertEqual(len(product["chunks"]), 20)
        rest = corpus.retrieve_chunks({**query, "reading_mode": "workbench-v1", "offset": 20})
        self.assertEqual([c["chunk_id"] for c in product["chunks"]+rest["chunks"]], [str(i) for i in range(25)])
        self.assertFalse(rest["selection"]["has_more"])


if __name__ == "__main__":
    unittest.main()
