import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConversations,listConversations,renameConversation,touchConversation} from '../../web/conversations.js';
const saved=(i:number,label='Original')=>({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,token:'a'.repeat(64),label});

test('old browser lists gain organization fields without losing session ownership or ordering',()=>{
  const a=saved(1),b=saved(2),items=normalizeConversations([a,null,{},b,a]);
  assert.deepEqual(items.map(item=>item.id),[a.id,b.id]);assert.equal(items[0].token,a.token);
  assert.equal(items[0].renamed,false);assert.equal(items[0].archived,false);assert.equal(items[0].pinned,false);
  assert.deepEqual(listConversations(items).map(item=>item.id),[a.id,b.id]);
});
test('pins stay above newer replies, archive hides conversations reversibly, and sorting does not mutate storage',()=>{
  const items=normalizeConversations([{...saved(1),updated_at:1,pinned:true},{...saved(2),updated_at:10},{...saved(3),updated_at:20,archived:true}]);
  assert.deepEqual(listConversations(items).map(item=>item.id),[items[0].id,items[1].id]);
  assert.deepEqual(listConversations(items,true).map(item=>item.id),[items[2].id]);
  items[2].archived=false;assert.deepEqual(listConversations(items).map(item=>item.id),[items[0].id,items[2].id,items[1].id]);
  assert.equal(items[1].id,saved(2).id);
});
test('custom titles survive future replies and storage reloads',()=>{
  const first=normalizeConversations([saved(1)])[0],named=renameConversation(first,'  我的论文笔记  '),continued=touchConversation(named,'An automatically generated title',123);
  assert.equal(continued.label,'我的论文笔记');assert.equal(continued.updated_at,123);assert.equal(continued.token,first.token);
  const reloaded=normalizeConversations(JSON.parse(JSON.stringify([continued])))[0];assert.equal(touchConversation(reloaded,'Another question',456).label,'我的论文笔记');
  assert.equal(touchConversation(first,'A new first question',123).label,'A new first question');
  assert.throws(()=>renameConversation(first,'   '));assert.throws(()=>renameConversation(first,'x'.repeat(81)));
});
