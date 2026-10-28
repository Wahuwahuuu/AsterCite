/** Reader actions use returned sources and visible citations, never a new model request. */
export function lastCitedPaper(text,sources,known){
  const byChunk=new Map(sources.map(source=>[source.chunk_id,source.paper_id]));
  let paper=null;
  const visible=String(text??'').replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/gu,'');
  for(const match of visible.matchAll(/\[cite:([^\]\n]+)\]/gu)){
    const id=byChunk.get(match[1]);if(id&&known.has(id))paper=id;
  }
  return paper;
}

export class ReaderFollow {
  constructor({open,current}){this.open=open;this.current=current;this.papers=new Set();this.enabled=true;this.beginTurn();}
  setPapers(papers){this.papers=new Set(papers.map(paper=>paper.paper_id));}
  beginTurn(){this.pinned=false;this.anchored=false;this.lastOpened=null;}
  manual(){this.pinned=true;}
  setEnabled(enabled){this.enabled=enabled;if(enabled)this.beginTurn();}
  choose(id){
    if(!this.enabled||this.pinned||!this.papers.has(id))return;
    this.anchored=true;
    if(this.lastOpened!==id||this.current()!==id){this.lastOpened=id;this.open(id);}
  }
  activity(event){
    if(!this.anchored&&event.kind==='tool'&&event.tool==='retrieve_chunks'&&event.status==='completed')this.choose(event.paper_ids?.find(id=>this.papers.has(id)));
  }
  answer(update){this.choose(lastCitedPaper(update.text,update.sources??[],this.papers));}
  finish(view){
    const turn=view.turns.at(-1);if(!turn)return;
    const cited=lastCitedPaper(turn.answer,turn.sources,this.papers);
    if(cited){this.choose(cited);return;}
    const ids=[...new Set(turn.sources.map(source=>source.paper_id))].filter(id=>this.papers.has(id));
    const remembered=view.memory?.paper_id;
    const id=ids.includes(remembered)?remembered:ids.includes(this.current())?this.current():ids[0];
    this.choose(id??(view.memory?.object_source_turn===turn.turn_id?remembered:null));
  }
}
