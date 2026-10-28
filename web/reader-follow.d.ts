import type {WebActivity,WebSource,WebView} from '../agent/web-session.ts';
export function lastCitedPaper(text:string,sources:readonly Pick<WebSource,'chunk_id'|'paper_id'>[],known:ReadonlySet<string>):string|null;
export class ReaderFollow {
  constructor(options:{open:(id:string)=>void;current:()=>string|null});
  enabled:boolean;pinned:boolean;
  setPapers(papers:readonly {paper_id:string}[]):void;
  beginTurn():void;
  manual():void;
  setEnabled(enabled:boolean):void;
  activity(event:Pick<WebActivity,'kind'|'tool'|'status'|'paper_ids'>):void;
  answer(update:{text:string;sources?:readonly Pick<WebSource,'chunk_id'|'paper_id'>[]}):void;
  finish(view:Pick<WebView,'turns'|'memory'>):void;
}
