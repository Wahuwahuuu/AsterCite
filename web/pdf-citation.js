export function normalizePdfText(text){return String(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');}
export function indexPdfText(content){
  let text='';const spans=[];
  for(const item of content.items){
    if(typeof item.str!=='string')continue;
    const normalized=normalizePdfText(item.str);if(!normalized)continue;
    spans.push({start:text.length,end:text.length+normalized.length,item,style:content.styles?.[item.fontName]??{}});text+=normalized;
  }
  return {text,spans};
}
function mergeRanges(ranges){
  const merged=[];
  for(const range of ranges.sort((a,b)=>a.start-b.start)){
    const last=merged.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range});
  }
  return merged;
}
/** Exact matching first; partial matches must cover a substantial, coherently ordered fragment. */
export function matchPdfCitation(index,source){
  const query=normalizePdfText(source);if(query.length<12)return null;
  const exact=index.text.indexOf(query);
  if(exact>=0)return {ranges:[{start:exact,end:exact+query.length}],matched:query.length,coverage:1,complete:true};
  if(query.length<48)return null;
  const groups=[],tolerance=Math.max(24,Math.min(80,query.length*.05));
  const offsets=new Set();for(let q=0;q<=query.length-32;q+=16)offsets.add(q);offsets.add(query.length-32);
  for(const q of offsets){
    const anchor=query.slice(q,q+32);let found=index.text.indexOf(anchor),hits=0;
    while(found>=0&&hits++<3){
      let start=found,end=found+32,qs=q,qe=q+32;
      while(start>0&&qs>0&&index.text[start-1]===query[qs-1]){start--;qs--;}
      while(end<index.text.length&&qe<query.length&&index.text[end]===query[qe]){end++;qe++;}
      const delta=start-qs;let group=groups.find(item=>Math.abs(item.delta-delta)<=tolerance);
      if(!group){group={delta,ranges:[],query:[]};groups.push(group);}
      group.ranges.push({start,end});group.query.push({start:qs,end:qe});found=index.text.indexOf(anchor,found+1);
    }
  }
  let best=null;
  for(const group of groups){
    const matched=mergeRanges(group.query).reduce((sum,range)=>sum+range.end-range.start,0),coverage=matched/query.length;
    if(matched>=48&&coverage>=.45&&(!best||matched>best.matched))best={ranges:mergeRanges(group.ranges),matched,coverage,complete:false};
  }
  return best;
}
/** Convert matched PDF text runs to the same CSS coordinates used by the rendered canvas. */
export function citationBoxes(index,match,viewport){
  const [a,b,c,d,e,f]=viewport.transform,scale=Math.hypot(a,b),boxes=[];
  for(const span of index.spans){
    for(const range of match.ranges){
      const start=Math.max(span.start,range.start),end=Math.min(span.end,range.end);if(start>=end)continue;
      const item=span.item,t=item.transform;if(!t||t.length!==6)continue;
      const x=a*t[4]+c*t[5]+e,y=b*t[4]+d*t[5]+f;
      const height=Math.hypot(a*t[2]+c*t[3],b*t[2]+d*t[3])||item.height*scale;
      const angle=Math.atan2(b*t[0]+d*t[1],a*t[0]+c*t[1]),ascent=height*(span.style.ascent??.8);
      const length=span.end-span.start,from=(start-span.start)/length,to=(end-span.start)/length;
      const width=item.width*scale,offset=width*(item.dir==='rtl'?1-to:from);
      const box={left:x+ascent*Math.sin(angle)+offset*Math.cos(angle),top:y-ascent*Math.cos(angle)+offset*Math.sin(angle)-height*.08,width:width*(to-from),height:height*1.12,angle:angle*180/Math.PI};
      if(Object.values(box).every(Number.isFinite)&&box.width>0&&box.height>0)boxes.push(box);
    }
  }
  return boxes;
}
