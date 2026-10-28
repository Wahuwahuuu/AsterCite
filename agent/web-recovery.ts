import {RuntimeFailure} from './contracts.ts';
import {parseRuntimeControls,unwrapSnapshot,wrapSnapshot,type ControlledSnapshot,type RuntimeControls} from './main-controls.ts';

/** Validate the saved envelope before adapting it in memory for a product conversation. */
export function recoverWebSnapshot(saved:ControlledSnapshot,current:RuntimeControls,index:string,papers:ReadonlySet<string>):ControlledSnapshot{
  if(!saved||typeof saved.index_version!=='string')throw new RuntimeFailure('INVALID_SNAPSHOT','Missing saved session envelope');
  const original=parseRuntimeControls(saved.controls);
  const state=unwrapSnapshot(saved,original,saved.index_version);
  if(original.arm!=='C'||state.profile!=='B'||state.version!==1||!['strict','workbench-v1'].includes(state.answer_policy??'strict'))throw new RuntimeFailure('INVALID_SNAPSHOT','Unsupported web conversation format');
  state.answer_policy='workbench-v1';state.index_version=index;
  const memory=state.domain_state;
  if(!memory||!Array.isArray(memory.comparison_order))throw new RuntimeFailure('INVALID_SNAPSHOT','Unsupported saved reading memory');
  if(memory.current_paper&&!papers.has(memory.current_paper.paper_id))memory.current_paper=null;
  memory.comparison_order=memory.comparison_order.filter(id=>papers.has(id));
  if(!memory.current_paper&&!memory.comparison_order.length)memory.object_source_turn=null;
  // The Harness's existing restoreSnapshot path revalidates every retained source
  // against the active corpus, including after an index change. Saved files stay untouched.
  return wrapSnapshot(state,current);
}
