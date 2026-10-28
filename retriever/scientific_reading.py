"""Independent, on-demand reading sources; never modifies the retrieval index."""
from __future__ import annotations

import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import time
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler

VERSION = "scientific-html-v1"
MAX_HTML = 8 * 1024 * 1024
MAX_BLOCK = 8000
ALLOWED_HOSTS = {"arxiv.org", "ar5iv.labs.arxiv.org"}


class Element:
    def __init__(self, tag, attrs=(), parent=None):
        self.tag, self.attrs, self.parent, self.children = tag, dict(attrs), parent, []

    def walk(self, tag=None):
        if tag is None or self.tag == tag:
            yield self
        for child in self.children:
            if isinstance(child, Element):
                yield from child.walk(tag)


class Document(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = Element("root")
        self.stack = [self.root]
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        node = Element(tag, attrs, self.stack[-1]); self.stack[-1].children.append(node)
        if tag not in {"br", "img", "meta", "link", "hr", "input", "wbr", "source"}:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if self.stack[-1].tag == tag:
            self.stack.pop()

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]; break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def plain(node):
    return "".join(plain(child) if isinstance(child, Element) else child for child in node.children)


def math_tex(node):
    if node.attrs.get("alttext"):
        return node.attrs["alttext"]
    annotation = next((item for item in node.walk("annotation") if "tex" in item.attrs.get("encoding", "").lower()), None)
    if annotation:
        return plain(annotation)
    children = [child for child in node.children if isinstance(child, Element) and child.tag not in {"annotation", "annotation-xml"}]
    if node.tag in {"mi", "mn", "mo", "mtext"}:
        value = plain(node).strip().replace("−", "-")
        return r"\text{" + value.replace("{", r"\{").replace("}", r"\}") + "}" if node.tag == "mtext" else value
    values = [math_tex(child) for child in children]
    if any(value is None for value in values):
        return None
    if node.tag in {"math", "mrow", "semantics", "mstyle", "mpadded", "mtd"}:
        return " ".join(values)
    if node.tag == "mfrac" and len(values) == 2:
        return r"\frac{" + values[0] + "}{" + values[1] + "}"
    if node.tag in {"msup", "msub", "mover", "munder"} and len(values) == 2:
        if node.tag in {"mover", "munder"}:
            return (r"\overset" if node.tag == "mover" else r"\underset") + "{" + values[1] + "}{" + values[0] + "}"
        return "{" + values[0] + "}" + ("^" if node.tag == "msup" else "_") + "{" + values[1] + "}"
    if node.tag == "msubsup" and len(values) == 3:
        return "{" + values[0] + "}_{" + values[1] + "}^{" + values[2] + "}"
    if node.tag == "msqrt":
        return r"\sqrt{" + " ".join(values) + "}"
    if node.tag == "mroot" and len(values) == 2:
        return r"\sqrt[" + values[1] + "]{" + values[0] + "}"
    if node.tag == "mfenced":
        return r"\left" + node.attrs.get("open", "(") + " ".join(values) + r"\right" + node.attrs.get("close", ")")
    if node.tag == "mtr":
        return " & ".join(values)
    if node.tag == "mtable":
        return r"\begin{matrix}" + r" \\ ".join(values) + r"\end{matrix}"
    if node.tag == "mspace":
        return " "
    return None


def render(node, cell=False):
    if node.tag in {"script", "style", "nav", "aside"}:
        return ""
    if node.tag == "math":
        tex = math_tex(node)
        if not tex:
            return "[原公式的结构暂未恢复，请查看 PDF]"
        if cell:
            tex = tex.replace(r"\|", r"\Vert ").replace("|", r"\vert ")
        return "$" + tex + "$"
    if node.tag == "br":
        return " " if cell else "\n"
    return "".join(render(child, cell) if isinstance(child, Element) else child for child in node.children)


def compact(text):
    return re.sub(r"\s+", " ", text).strip()


def ancestor(node, test):
    while node:
        if test(node):
            return node
        node = node.parent
    return None


def section_name(node):
    section = ancestor(node, lambda item: item.tag == "section")
    if section:
        header = next((child for child in section.children if isinstance(child, Element) and child.tag in {"h2", "h3", "h4", "h5"}), None)
        if header:
            return compact(render(header))
    return "Original paper"


class ExtractedBlocks(list):
    incomplete = False


def extract_blocks(source):
    document = Document(source).root
    root = next(document.walk("article"), document)
    blocks = ExtractedBlocks()
    def add(kind, text, node, title):
        text = text.strip()
        if len(text) > 16000: blocks.incomplete = True
        if text and len(text) <= 16000 and not any(item["text"] == text for item in blocks):
            blocks.append({"kind": kind, "text": text, "section": title, "locator": node.attrs.get("id", ""), "format": "markdown"})
    for table in root.walk("table"):
        if "eqn" in table.attrs.get("class", "") or ancestor(table.parent, lambda item: item.tag == "table"):
            continue
        figure = ancestor(table, lambda item: "ltx_table" in item.attrs.get("class", ""))
        caption = next(figure.walk("figcaption"), None) if figure else None
        title = compact(render(caption)) if caption else section_name(table)
        rows, headers, spans = [], [], {}
        for r, tr in enumerate(table.walk("tr")):
            cells = [child for child in tr.children if isinstance(child, Element) and child.tag in {"td", "th"}]
            if not cells:
                continue
            row, c = [], 0
            for td in cells:
                while (r, c) in spans:
                    row.append(""); c += 1
                value = compact(render(td, True)).replace("|", r"\|")
                row.append(value)
                try:
                    colspan = max(1, min(50, int(td.attrs.get("colspan", "1"))))
                    rowspan = max(1, min(200, int(td.attrs.get("rowspan", "1"))))
                except ValueError:
                    colspan = rowspan = 1
                for rr in range(r + 1, r + rowspan):
                    for cc in range(c, c + colspan): spans[rr, cc] = True
                row.extend([""] * (colspan - 1)); c += colspan
            if not rows and not headers and all(td.tag == "th" for td in cells): headers = row
            else: rows.append(row)
        if not rows:
            continue
        if not headers and len(rows) > 1 and re.fullmatch(r"(?:model|method|system|approach|dataset|task|measure|metric|setting|feature)s?", rows[0][0], re.I):
            headers = rows.pop(0)
        columns = max(map(len, rows + [headers]))
        headers = headers or [f"列 {i + 1}" for i in range(columns)]
        headers += [""] * max(0, columns - len(headers))
        prefix = "### " + title + "\n\n| " + " | ".join(headers) + " |\n| " + " | ".join(["---"] * columns) + " |\n"
        group, groups = "", []
        for row in rows:
            line = "| " + " | ".join(row + [""] * (columns - len(row))) + " |\n"
            if group and len(prefix + group + line) > MAX_BLOCK:
                groups.append(prefix + group); group = ""
            group += line
        if group: groups.append(prefix + group)
        for part, text in enumerate(groups):
            if len(groups) > 1: text = f"原表分组 {part + 1}/{len(groups)}（表头保留，后续行可继续读取）\n\n" + text
            add("table", text, figure or table, title)
    for math in root.walk("math"):
        equation = ancestor(math, lambda item: "ltx_equation" in item.attrs.get("class", "") or "ltx_eqn_row" in item.attrs.get("class", ""))
        paragraph = ancestor(math, lambda item: item.tag == "p")
        if ancestor(math, lambda item: item.tag == "table" and "eqn" not in item.attrs.get("class", "")):
            continue
        if paragraph and not equation and math.attrs.get("display") != "block":
            text = render(paragraph)
            if "[原公式的结构暂未恢复" not in text: add("equation", text, paragraph, section_name(math))
            continue
        tex = math_tex(math)
        if not tex:
            continue
        owner = equation or paragraph or math
        title = section_name(math)
        label = next((item for item in owner.walk() if "ltx_tag" in item.attrs.get("class", "")), None)
        if label: title += " " + compact(render(label))
        anchor = ancestor(owner, lambda item: item.parent and item.parent.tag in {"section", "article"}) or owner
        context = ""
        if anchor.parent:
            siblings = [child for child in anchor.parent.children if isinstance(child, Element)]
            before = siblings[:siblings.index(anchor)] if anchor in siblings else []
            prior = next((item for item in reversed(before) if item.tag == "p"), None)
            if prior and len(render(prior)) <= 2000: context = render(prior).strip() + "\n\n"
        add("equation", "### " + title + "\n\n" + context + "$$\n" + tex + "\n$$", owner, title)
    return blocks


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        parsed = urlparse(newurl)
        if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or parsed.port not in {None, 443} or parsed.username or parsed.password:
            raise ValueError("Unexpected source redirect")
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def fetch_html(url):
    request = Request(url, headers={"User-Agent": "AsterCite/1.2 (public paper reading)", "Accept": "text/html"})
    with build_opener(SafeRedirect()).open(request, timeout=6) as response:
        data = response.read(MAX_HTML + 1)
        if len(data) > MAX_HTML or "html" not in response.headers.get("Content-Type", "").lower():
            raise ValueError("Source is not bounded HTML")
        return data.decode("utf-8"), response.geturl()


def make_chunk(block, paper_id, index, digest, number, url):
    text = block["text"]; cid = f"{index}:scientific-v1:{paper_id}:{digest[:16]}:{number}:c0-{len(text)}"
    return {"paper_id": paper_id, "paragraph_id": f"{paper_id}:scientific-v1:{digest[:16]}:{number}", "chunk_id": cid,
            "section": block["section"], "text": text, "start": 0, "end": len(text), "index_version": index,
            "citation": f"[{cid}]", "truncated": False, "format": "markdown", "content_type": block["kind"],
            "source_url": url + ("#" + block["locator"] if block.get("locator") else "")}


class ScientificReader:
    def __init__(self, directory: Path, index: str, fetcher=fetch_html):
        self.directory = directory / hashlib.sha256(index.encode()).hexdigest()[:16]
        self.index, self.fetcher, self.failures = index, fetcher, {}

    def document(self, paper_id):
        if not re.fullmatch(r"\d{4}\.\d{4,5}", paper_id):
            return None
        manifest, original = self.directory / (paper_id + ".json"), self.directory / (paper_id + ".html")
        try:
            if original.stat().st_size > MAX_HTML or manifest.stat().st_size > MAX_HTML: raise ValueError("Oversized source cache")
            data = json.loads(manifest.read_text(encoding="utf-8"))
            raw = original.read_bytes()
            if data["version"] == VERSION and data["index_version"] == self.index and data["paper_id"] == paper_id and hashlib.sha256(raw).hexdigest() == data["original_sha256"]:
                parsed = extract_blocks(raw.decode("utf-8"))
                if data["blocks"] == parsed[:512] and data["blocks_sha256"] == hashlib.sha256(json.dumps(data["blocks"], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(): return data
        except (OSError, ValueError, KeyError):
            pass
        if self.failures.get(paper_id, 0) > time.monotonic():
            return None
        for url in (f"https://arxiv.org/html/{paper_id}v1", f"https://ar5iv.labs.arxiv.org/html/{paper_id}v1"):
            try:
                source, final_url = self.fetcher(url)
                parsed = urlparse(final_url)
                if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or parsed.port not in {None, 443} or parsed.username or parsed.password or f"{paper_id}v1" not in parsed.path or len(source.encode()) > MAX_HTML:
                    continue
                blocks = extract_blocks(source)
                if not blocks: continue
                digest = hashlib.sha256(source.encode()).hexdigest()
                data = {"version": VERSION, "index_version": self.index, "paper_id": paper_id, "original_sha256": digest, "source_url": final_url, "blocks": blocks[:512], "source_limited": len(blocks) > 512 or blocks.incomplete}
                data["blocks_sha256"] = hashlib.sha256(json.dumps(data["blocks"], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
                self.directory.mkdir(parents=True, exist_ok=True)
                original.write_text(source, encoding="utf-8", newline="")
                manifest.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
                return data
            except (OSError, ValueError, UnicodeError):
                continue
        self.failures[paper_id] = time.monotonic() + 300
        return None

    def retrieve(self, params, papers, pool=None):
        ids, kind = params.get("paper_ids"), params.get("content_type", "all")
        top_k, offset = params.get("top_k", 8), params.get("offset", 0)
        if not isinstance(ids, list) or not 1 <= len(ids) <= 4 or any(not isinstance(pid, str) or pid not in papers for pid in ids) or len(set(ids)) != len(ids) or kind not in {"table", "equation", "all"} or type(top_k) is not int or not 1 <= top_k <= 20 or type(offset) is not int or not 0 <= offset <= 512:
            raise ValueError("Invalid structured reading request")
        query = params.get("query", "")
        if not isinstance(query, str) or len(query) > 1000: raise ValueError("Invalid query")
        chunks, unavailable, incomplete = [], [], []
        for pid in ids:
            source = self.document(pid)
            if source is None: unavailable.append(pid); continue
            if source.get("source_limited"): incomplete.append(pid)
            chunks.extend(make_chunk(block, pid, self.index, source["original_sha256"], i, source["source_url"]) for i, block in enumerate(source["blocks"]) if kind == "all" or block["kind"] == kind)
        terms = set(re.findall(r"[\w]+", query.lower()))
        chunks.sort(key=lambda chunk: (-sum(term in chunk["text"].lower() for term in terms), chunk["chunk_id"]))
        if pool is not None and chunks:
            candidates = chunks[:40]; scores = pool.rerank(query or kind, [chunk["text"] for chunk in candidates])
            chunks = [chunk for _, chunk in sorted(zip(scores, candidates), key=lambda item: (-item[0], item[1]["chunk_id"]))] + chunks[40:]
        selected, used, consumed = [], 0, 0
        for chunk in chunks[offset:offset + top_k]:
            if used + len(chunk["text"]) > 24000: break
            selected.append(chunk); used += len(chunk["text"]); consumed += 1
        return {"backend": VERSION, "index_version": self.index, "chunks": selected,
                "selection": {"offset": offset, "returned": len(selected), "total": len(chunks), "next_offset": offset + consumed, "has_more": offset + consumed < len(chunks), "unavailable_papers": unavailable,"incomplete_sources":incomplete}}
