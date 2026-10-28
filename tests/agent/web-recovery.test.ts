import test from 'node:test';
import assert from 'node:assert/strict';
import {fauxAssistantMessage as reply} from '@earendil-works/pi-ai';
import {recoverWebSnapshot} from '../../agent/web-recovery.ts';
import {wrapSnapshot,unwrapSnapshot,type RuntimeControls} from '../../agent/main-controls.ts';
import {restoreSnapshot} from '../../agent/session-memory.ts';
import {mainFixture,preparation,final,PREPARED_INDEX} from './main-fixture.ts';

const controls:RuntimeControls={arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'a'.repeat(64)};
test('legacy web snapshots adapt to current answer/model settings and revalidate sources without changing saved data',async()=>{
  const f=await mainFixture([reply(JSON.stringify(preparation)),reply(JSON.stringify(final))],[[0]],{controls,answerPolicy:'workbench-v1'});
  try{
    await f.harness.runTurn('p1 requested fact',['p1'],'old-turn');const current=f.harness.snapshot(),state=structuredClone(current.state);delete state.answer_policy;delete state.context_state;
    const legacy=wrapSnapshot(state,controls),bytes=JSON.stringify(legacy),next={...controls,compaction:'native' as const,implementation_id:'b'.repeat(64)};
    const recovered=recoverWebSnapshot(legacy,next,PREPARED_INDEX,new Set(['p1']));assert.equal(recovered.state.answer_policy,'workbench-v1');assert.equal(JSON.stringify(legacy),bytes);assert.deepEqual(recovered.state.dialogue,state.dialogue);
    assert.equal(unwrapSnapshot(recovered,next,PREPARED_INDEX).profile,'B');assert.throws(()=>unwrapSnapshot(legacy,next,PREPARED_INDEX));
    const changed=recoverWebSnapshot(legacy,next,'new-corpus',new Set(['new-paper']));
    const checked=restoreSnapshot(changed.state,{profile:'B',indexVersion:'new-corpus',evidenceIndex:new Map(),publicPapers:[{paper_id:'new-paper',title:'New paper',abstract:''}]});
    assert.equal(checked.chunks.size,0);assert.equal(checked.snapshot.domain_state.current_paper,null);assert.deepEqual(checked.snapshot.domain_state.comparison_order,[]);assert.equal(checked.snapshot.dialogue.length,state.dialogue.length);
    const broken=structuredClone(legacy);broken.state.dialogue.push({turn_id:'injected',user_text:'extra',final_answer:'extra'});assert.throws(()=>recoverWebSnapshot(broken,next,PREPARED_INDEX,new Set(['p1'])),/Snapshot state/);
    const future=wrapSnapshot({...state,version:2} as unknown as typeof state,controls);assert.throws(()=>recoverWebSnapshot(future,next,PREPARED_INDEX,new Set(['p1'])),/Unsupported/);
  }finally{f.harness.dispose();}
});
