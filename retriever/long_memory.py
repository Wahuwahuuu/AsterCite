"""Private Qdrant Edge memory. It never reads or mutates the paper index."""
from collections import OrderedDict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import uuid

KINDS = {"preference", "note", "reading"}
FIELDS = {"id", "kind", "content", "paper_ids", "source_session", "source_turn", "created_at", "updated_at", "slot", "edited"}


def native_path(directory):
    path = str(Path(directory).resolve())
    if os.name == 'nt' and not path.startswith('\\\\?\\'):
        return '\\\\?\\UNC\\' + path[2:] if path.startswith('\\\\') else '\\\\?\\' + path
    return path


class MemoryStore:
    def __init__(self, root, dimensions, encoder, model):
        self.root, self.dimensions, self.encoder, self.model = Path(root), dimensions, encoder, model
        self.shards = OrderedDict()
        self.upgraded = set()

    def shard(self, owner):
        from qdrant_edge import EdgeShard, EdgeConfig, EdgeVectorParams, Distance, UpdateOperation, PayloadSchemaType
        if owner in self.shards:
            self.shards.move_to_end(owner)
            return self.shards[owner]
        directory = Path(native_path(self.root / hashlib.sha256(owner.encode()).hexdigest()[:32]))
        directory.mkdir(parents=True, exist_ok=True)
        manifest = directory / "memory-schema.json"
        expected = {"version": 1, "dimensions": self.dimensions, "model": self.model}
        config = EdgeConfig(vectors={"memory": EdgeVectorParams(size=self.dimensions, distance=Distance.Cosine)})
        if manifest.exists():
            if json.loads(manifest.read_text(encoding="utf-8")) != expected:
                raise ValueError("Memory embedding configuration changed")
            shard = EdgeShard.load(native_path(directory))
        else:
            shard = EdgeShard.create(native_path(directory), config)
            for field in ("owner", "kind", "source_session", "paper_ids"):
                shard.update(UpdateOperation.create_field_index(field, PayloadSchemaType.Keyword))
            shard.update(UpdateOperation.create_field_index('updated_at', PayloadSchemaType.Datetime))
            shard.flush()
            manifest.write_text(json.dumps(expected), encoding="utf-8")
        self.shards[owner] = shard
        if len(self.shards) > 8:
            _, old = self.shards.popitem(last=False); old.flush(); old.close()
        return shard

    @staticmethod
    def scope(owner, **fields):
        from qdrant_edge import Filter, FieldCondition, MatchValue
        return Filter(must=[FieldCondition(key=key, match=MatchValue(value=value)) for key, value in {"owner": owner, **fields}.items()])

    @staticmethod
    def public(point):
        return {key: value for key, value in point.payload.items() if key in FIELDS}

    def upgrade_reading(self, owner, shard, papers):
        """Replace legacy automatic transcripts with one progress record per paper."""
        if owner in self.upgraded: return
        from qdrant_edge import ScrollRequest, UpdateOperation
        rows, cursor = [], None
        while True:
            batch, cursor = shard.scroll(ScrollRequest(offset=cursor, limit=100, filter=self.scope(owner, kind='reading'), with_payload=True, with_vector=False))
            rows.extend(self.public(point) for point in batch)
            if cursor is None: break
        legacy = [row for row in rows if row.get('slot', '').startswith('reading:') and not row['slot'].startswith('reading:v2:') and not row.get('edited')]
        existing = {row.get('slot') for row in rows if row.get('slot', '').startswith('reading:v2:')}
        newest = {}
        for row in sorted(legacy, key=lambda row: row.get('updated_at', '')):
            for paper_id in row.get('paper_ids', []):
                if paper_id in papers: newest[paper_id] = row
        for paper_id, row in newest.items():
            slot = 'reading:v2:' + paper_id
            if slot in existing: continue
            question = re.search(r'讨论问题：([^\n]*)', row['content'])
            text = question.group(1) if question else ''
            topics = [('摘要|abstract', '摘要'), ('方法|原理|method', '研究方法'), ('实验|结果|experiment', '实验与结果'), ('数据集|dataset', '数据集'), ('比较|对比', '论文比较')]
            topic = next((label for pattern, label in topics if re.search(pattern, text, re.I)), '论文内容与研究思路')
            title = papers[paper_id].get('title', paper_id)[:160]
            self.dispatch({'owner': owner, 'action': 'upsert', 'entry': {'kind': 'reading', 'slot': slot, 'paper_ids': [paper_id],
                'source_session': row.get('source_session', ''), 'source_turn': row.get('source_turn', ''),
                'content': f'论文：{title}\n当前主题：{topic}\n阅读进度：曾讨论{topic}；可从来源对话继续阅读。'}}, papers, flush=False)
        if legacy:
            shard.update(UpdateOperation.delete_points([row['id'] for row in legacy])); shard.flush()
        self.upgraded.add(owner)

    def dispatch(self, params, papers, flush=True):
        from qdrant_edge import ScrollRequest, QueryRequest, Query, UpdateOperation, Point, CountRequest, OrderBy, Direction
        if not isinstance(params, dict) or set(params) - {"owner", "action", "query", "paper_ids", "entry", "entries", "id", "cursor", "source_session", "preferences_only", "recent_reading"}:
            raise ValueError("Invalid memory operation")
        owner, action = params.get("owner"), params.get("action")
        if not isinstance(owner, str) or not re.fullmatch(r"(?:web:[a-f0-9-]{36}|cli:local)", owner):
            raise ValueError("Invalid memory owner")
        if action not in {"list", "recall", "upsert", "upsert_batch", "delete", "clear", "delete_session"}:
            raise ValueError("Invalid memory action")
        shard = self.shard(owner)
        if action in {'list', 'recall'}: self.upgrade_reading(owner, shard, papers)
        scope = self.scope(owner)
        if action == 'upsert_batch':
            values = params.get('entries')
            if not isinstance(values, list) or not 1 <= len(values) <= 20: raise ValueError('Invalid memory batch')
            entries = []
            try:
                for entry in values:
                    try: entries.append(self.dispatch({'owner': owner, 'action': 'upsert', 'entry': entry}, papers, flush=False)['entry'])
                    except ValueError: continue
            finally: shard.flush()
            return {'backend': 'qdrant-edge', 'entries': entries}
        if action == "list":
            cursor = params.get("cursor")
            if cursor is not None:
                uuid.UUID(cursor)
            rows, next_offset = shard.scroll(ScrollRequest(offset=cursor, limit=100, filter=scope, with_payload=True, with_vector=False))
            return {"backend": "qdrant-edge", "entries": [self.public(row) for row in rows], "next_cursor": str(next_offset) if next_offset else None, "total": shard.count(CountRequest(filter=scope, exact=True))}
        if action == "recall":
            text, ids = params.get("query"), params.get("paper_ids", [])
            if not isinstance(text, str) or not 1 <= len(text) <= 12000 or not isinstance(ids, list) or any(pid not in papers for pid in ids):
                raise ValueError("Invalid memory query")
            preferences, _ = shard.scroll(ScrollRequest(limit=20, filter=self.scope(owner, kind="preference"), with_payload=True))
            chosen = {row.id: self.public(row) for row in preferences}
            if params.get('recent_reading') and not params.get('preferences_only'):
                recent, _ = shard.scroll(ScrollRequest(limit=3, filter=self.scope(owner, kind='reading'), order_by=OrderBy(key='updated_at', direction=Direction.Desc), with_payload=True))
                for point in recent:
                    row = self.public(point)
                    if not ids or not row['paper_ids'] or set(ids).intersection(row['paper_ids']): chosen[point.id] = row
            if not params.get('preferences_only') and shard.count(CountRequest(filter=scope, exact=True)) > len(preferences):
                vector = self.encoder([text[:2000]])[0].tolist()
                hits = shard.query(QueryRequest(limit=20, query=Query.Nearest(vector, using="memory"), filter=scope, with_payload=True, score_threshold=0.48))
                # Exclude unrelated paper notes before they can consume the projection budget.
                for point in hits:
                    row = self.public(point)
                    if row["kind"] == "preference": continue
                    if ids and row["paper_ids"] and not set(ids).intersection(row["paper_ids"]): continue
                    chosen[point.id] = {**row, "score": float(point.score)}
                    if len(chosen) >= len(preferences) + 5: break
            entries, used = [], 0
            for row in chosen.values():
                size = len(row["content"])
                if used + size > 3500: continue
                entries.append(row); used += size
            return {"backend": "qdrant-edge", "entries": entries}
        if action == "upsert":
            entry = params.get("entry")
            if not isinstance(entry, dict) or set(entry) - FIELDS or entry.get("kind") not in KINDS:
                raise ValueError("Invalid memory entry")
            content, ids = entry.get("content"), entry.get("paper_ids", [])
            if not isinstance(content, str) or not content.strip() or len(content) > 1200 or not isinstance(ids, list) or len(ids) > 20 or any(pid not in papers for pid in ids):
                raise ValueError("Invalid memory contents")
            slot = entry.get("slot", "")
            if not isinstance(slot, str) or len(slot) > 200: raise ValueError("Invalid memory slot")
            identity = str(uuid.UUID(entry["id"])) if entry.get("id") else str(uuid.uuid5(uuid.NAMESPACE_URL, owner + ":" + slot)) if slot else str(uuid.uuid4())
            old = shard.retrieve([identity], with_payload=True, with_vector=False)
            if old and old[0].payload.get("owner") != owner: raise ValueError("Foreign memory entry")
            if old and old[0].payload.get('edited') and not entry.get('edited'):
                return {'backend': 'qdrant-edge', 'entry': self.public(old[0])}
            if old and not slot: slot = old[0].payload.get('slot', '')
            stamp = datetime.now(timezone.utc).isoformat()
            row = {"id": identity, "kind": entry["kind"], "content": content.strip(), "paper_ids": list(dict.fromkeys(ids)), "slot": slot,
                   "source_session": entry.get("source_session", ""), "source_turn": entry.get("source_turn", ""),
                   "created_at": old[0].payload["created_at"] if old else stamp, "updated_at": stamp, "edited": bool(entry.get("edited", False))}
            if any(not isinstance(row[key], str) or len(row[key]) > 200 for key in ("source_session", "source_turn")):
                raise ValueError("Invalid memory provenance")
            vector = self.encoder([row["content"]])[0].tolist()
            shard.update(UpdateOperation.upsert_points([Point(id=identity, vector={"memory": vector}, payload={**row, "owner": owner})]))
            if flush: shard.flush()
            return {"backend": "qdrant-edge", "entry": row}
        if action == "delete":
            identity = str(uuid.UUID(params.get("id", "")))
            rows = shard.retrieve([identity], with_payload=True, with_vector=False)
            if not rows or rows[0].payload.get("owner") != owner: raise ValueError("Unknown memory entry")
            shard.update(UpdateOperation.delete_points([identity]))
        else:
            if action == "delete_session":
                session = params.get("source_session")
                if not isinstance(session, str) or not session: raise ValueError("Missing source session")
                scope = self.scope(owner, source_session=session)
            shard.update(UpdateOperation.delete_points_by_filter(scope))
        shard.flush()
        return {"backend": "qdrant-edge", "deleted": True}

    def close(self):
        for shard in self.shards.values():
            shard.flush(); shard.close()
        self.shards.clear()
