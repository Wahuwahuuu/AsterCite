const compact=text=>text.replace(/\s+/gu,' ').trim();
const heading=line=>/^\d+\.\s+[A-Z][A-Z\s-]{2,}$/u.test(line);
const point=line=>/^(?:[•●]\s*|\d+[.)]\s+)/u.test(line);

// PDF layout is handled only for reading; the stored source stays untouched.
export function parseEvidenceText(text){
  const lines=text.replace(/\r\n?/g,'\n').split('\n').map(line=>line.trim());
  const blocks=[];
  const next=from=>{while(from<lines.length&&!lines[from])from++;return from;};
  function tableAt(start){
    if(!/^Table\s+\d+[.:]\s+\S/iu.test(lines[start]))return null;
    const a=next(start+1),b=next(a+1);
    if(lines[a]?.toLowerCase()!=='term'||lines[b]?.toLowerCase()!=='frequency')return null;
    const rows=[];let cursor=b+1;
    while(cursor<lines.length){
      const term=next(cursor),count=next(term+1);
      if(!lines[term]||!/^\d+(?:\.\d+)?$/u.test(lines[count]??'')||lines[term].length>80||heading(lines[term])||point(lines[term]))break;
      rows.push([compact(lines[term]),lines[count]]);cursor=count+1;
    }
    return rows.length>=2?{block:{kind:'table',caption:compact(lines[start]),headers:[lines[a],lines[b]],rows},end:cursor}:null;
  }
  for(let i=0;i<lines.length;){
    if(!lines[i]){i++;continue;}
    const table=tableAt(i);
    if(table){blocks.push(table.block);i=table.end;continue;}
    if(heading(lines[i])){blocks.push({kind:'heading',text:lines[i++]});continue;}
    const paragraph=[lines[i++]];
    while(i<lines.length&&lines[i]&&!heading(lines[i])&&!point(lines[i])&&!tableAt(i))paragraph.push(lines[i++]);
    blocks.push({kind:'paragraph',text:compact(paragraph.join(' '))});
  }
  return blocks;
}

export function evidencePreview(blocks,limit=520,maxRows=6){
  const preview=[];let remaining=limit;
  for(const [index,block] of blocks.entries()){
    if(remaining<=0)return {blocks:preview,hasMore:true};
    if(block.kind==='table'){
      const rows=block.rows.slice(0,maxRows),omittedRows=block.rows.length-rows.length;
      preview.push({...block,rows,omittedRows});
      remaining-=block.caption.length+block.headers.join(' ').length+rows.flat().join(' ').length;
      if(omittedRows)return {blocks:preview,hasMore:true};
    }else{
      if(block.text.length>remaining){
        if(remaining>=60||!preview.length){
          let excerpt=block.text.slice(0,remaining);
          const boundary=excerpt.lastIndexOf(' ');
          if(boundary>remaining*.65)excerpt=excerpt.slice(0,boundary);
          preview.push({...block,text:excerpt.trimEnd()+'…'});
        }
        return {blocks:preview,hasMore:true};
      }
      preview.push(block);remaining-=block.text.length;
    }
    if(remaining<=0&&index<blocks.length-1)return {blocks:preview,hasMore:true};
  }
  return {blocks:preview,hasMore:false};
}
