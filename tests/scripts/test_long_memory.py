import importlib.util
from pathlib import Path
import tempfile
import unittest
import os
import shutil

from retriever.long_memory import MemoryStore, native_path

OWNER = 'web:00000000-0000-4000-8000-000000000001'
OTHER = 'web:00000000-0000-4000-8000-000000000002'
PAPERS = {'p1': {}, 'p2': {}}


class Vector(list):
    def tolist(self): return list(self)


def encode(texts):
    return [Vector([1., 0., 0., 0.] if '情绪' in text or '情感' in text else [0., 1., 0., 0.]) for text in texts]


@unittest.skipUnless(importlib.util.find_spec('qdrant_edge'), 'Install the optional memory dependency')
class LongMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='astercite-qdrant-')
        self.store = MemoryStore(Path(self.temporary.name), 4, encode, 'fixture-encoder-v1')

    def tearDown(self):
        self.store.close()
        if os.name == 'nt':
            target = Path(self.temporary.name).resolve()
            self.assertEqual(target.parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(target.name.startswith('astercite-qdrant-'))
            shutil.rmtree(native_path(target))
        self.temporary.cleanup()

    def request(self, action, owner=OWNER, **values):
        return self.store.dispatch({'owner': owner, 'action': action, **values}, PAPERS)

    def test_real_engine_persists_vectors_and_owner_scoped_records(self):
        one = self.request('upsert', entry={'kind': 'note', 'content': '研究情感分析', 'paper_ids': ['p1']})['entry']
        self.request('upsert', OTHER, entry={'kind': 'note', 'content': '另一用户的情感记忆'})
        result = self.request('recall', query='情绪识别', paper_ids=['p1'])
        self.assertEqual([entry['id'] for entry in result['entries']], [one['id']])
        self.store.close()
        self.store = MemoryStore(Path(self.temporary.name), 4, encode, 'fixture-encoder-v1')
        self.assertEqual(self.request('list')['entries'][0]['content'], '研究情感分析')
        self.assertEqual(self.request('recall', query='无关主题', paper_ids=[])['entries'], [])

    def test_updates_replace_the_same_slot_and_deletion_stops_recall_after_reopen(self):
        first, second = self.request('upsert_batch', entries=[{'kind': 'preference', 'content': '回答简洁', 'slot': 'preference:detail'}, {'kind': 'preference', 'content': '详细解释', 'slot': 'preference:detail'}])['entries']
        self.assertEqual(first['id'], second['id']); self.assertEqual(self.request('list')['total'], 1)
        self.assertEqual(self.request('recall', query='你好', preferences_only=True)['entries'][0]['content'], '详细解释')
        self.request('delete', id=first['id']); self.store.close()
        self.store = MemoryStore(Path(self.temporary.name), 4, encode, 'fixture-encoder-v1')
        self.assertEqual(self.request('recall', query='你好', preferences_only=True)['entries'], [])

    def test_paper_filters_recent_reading_and_source_session_deletion(self):
        for paper in ('p1', 'p2'):
            self.request('upsert', entry={'kind': 'reading', 'content': '阅读情感分析 '+paper, 'paper_ids': [paper], 'source_session': paper})
        note = self.request('upsert', entry={'kind': 'note', 'content': '用户手动保存的笔记'})['entry']
        result = self.request('recall', query='继续上次', paper_ids=['p1'], recent_reading=True)
        self.assertTrue(any(row['paper_ids'] == ['p1'] for row in result['entries']))
        self.assertFalse(any(row['paper_ids'] == ['p2'] for row in result['entries']))
        self.request('delete_session', source_session='p1')
        remaining = self.request('list')['entries']
        self.assertFalse(any(row['source_session'] == 'p1' for row in remaining)); self.assertTrue(any(row['id'] == note['id'] for row in remaining))

    def test_multiple_pages_no_cross_owner_delete_and_schema_binding(self):
        from qdrant_edge import Point, UpdateOperation
        import uuid
        shard = self.store.shard(OWNER)
        def point(i):
            identity = str(uuid.uuid4())
            return Point(id=identity, vector={'memory': [0.,1.,0.,0.]}, payload={'id': identity, 'owner': OWNER, 'kind': 'note', 'content': '笔记 '+str(i), 'paper_ids': [], 'source_session': '', 'source_turn': '', 'slot': '', 'edited': False, 'created_at': '2026-10-28T00:00:00Z', 'updated_at': '2026-10-28T00:00:00Z'})
        shard.update(UpdateOperation.upsert_points([point(i) for i in range(103)])); shard.flush()
        page = self.request('list'); self.assertEqual(len(page['entries']), 100); self.assertEqual(page['total'], 103)
        rest = self.request('list', cursor=page['next_cursor']); self.assertEqual(len(rest['entries']), 3)
        other = self.request('upsert', OTHER, entry={'kind': 'note', 'content': '独立内容'})['entry']
        with self.assertRaises(ValueError): self.request('delete', id=other['id'])
        self.request('clear'); self.assertEqual(self.request('list')['total'], 0); self.assertEqual(self.request('list', OTHER)['total'], 1)
        self.store.close(); self.store = MemoryStore(Path(self.temporary.name), 8, encode, 'changed-encoder')
        with self.assertRaises(ValueError): self.request('list')

    def test_invalid_owners_scope_and_content_are_rejected(self):
        for owner in ('../outside', 'web:guess', '', 'cli:other'):
            with self.assertRaises(ValueError): self.request('list', owner)
        with self.assertRaises(ValueError): self.request('upsert', entry={'kind': 'note', 'content': 'x', 'paper_ids': ['foreign']})
        with self.assertRaises(ValueError): self.request('upsert', entry={'kind': 'note', 'content': 'x'*1201})

    def test_legacy_auto_transcripts_become_one_progress_record_and_manual_edits_are_preserved(self):
        for i in range(2):
            self.request('upsert', entry={'kind': 'reading', 'content': '阅读论文：示例\n讨论问题：讲实验结果\n阅读摘记（需要原文再次核实）：完整回答不得再存入记忆', 'paper_ids': ['p1'], 'slot': 'reading:old:'+str(i), 'source_session': 'old', 'source_turn': str(i)})
        rows = self.request('list')['entries']
        self.assertEqual(len(rows), 1); self.assertEqual(rows[0]['slot'], 'reading:v2:p1')
        self.assertNotIn('完整回答', rows[0]['content']); self.assertIn('阅读进度', rows[0]['content'])
        edited = self.request('upsert', entry={**rows[0], 'content': '我手动整理的阅读进度', 'edited': True})['entry']
        automatic = self.request('upsert', entry={'kind': 'reading', 'content': '新的自动进度', 'slot': 'reading:v2:p1', 'paper_ids': ['p1']})['entry']
        self.assertEqual(automatic['content'], edited['content'])
        self.store.close(); self.store = MemoryStore(Path(self.temporary.name), 4, encode, 'fixture-encoder-v1')
        self.assertEqual(self.request('list')['entries'][0]['content'], '我手动整理的阅读进度')

    def test_windows_deep_installation_paths_persist_and_reopen(self):
        import os
        if os.name != 'nt': self.skipTest('Windows native path handling')
        self.store.close()
        directory = Path(self.temporary.name) / ('long-install-directory-'*3) / ('memory-data-'*3)
        self.store = MemoryStore(directory, 4, encode, 'fixture-encoder-v1')
        saved = self.request('upsert', entry={'kind': 'note', 'content': '深层安装路径中的情感分析笔记'})['entry']
        self.store.close(); self.store = MemoryStore(directory, 4, encode, 'fixture-encoder-v1')
        self.assertEqual(self.request('list')['entries'][0]['id'], saved['id'])


if __name__ == '__main__': unittest.main()
