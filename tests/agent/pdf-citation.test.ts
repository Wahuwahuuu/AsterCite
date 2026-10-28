import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePdfText,indexPdfText,matchPdfCitation,citationBoxes} from '../../web/pdf-citation.js';

const item=(str:string,y=100)=>({str,fontName:'body',transform:[10,0,0,10,20,y],width:200,height:10});
const paragraph='We propose a hierarchical model with local contextual attention for dialogue act recognition. Experiments show that contextual dependencies improve the representation of neighbouring utterances.';

test('PDF matching tolerates line breaks, hyphens and typographic ligatures while retaining the text positions',()=>{
  const index=indexPdfText({items:[item('An unrelated heading',150),item('We propose a hier-'),item('archical model with local contextual attention for dialogue act recognition. Experiments show that contextual dependencies improve the representation of neighbouring utterances.',80)]});
  const match=matchPdfCitation(index,paragraph);assert.ok(match?.complete);assert.equal(index.spans.length,3);
  assert.equal(index.text.slice(match.ranges[0].start,match.ranges[0].end),normalizePdfText(paragraph));
  assert.equal(normalizePdfText('Efﬁcient classiﬁcation\n方法 — 80%'),normalizePdfText('Efficient classification 方法80%'));
});

test('a long cross-page source locates a coherent partial paragraph and rejects short or unrelated fragments',()=>{
  const first=paragraph.slice(0,104),index=indexPdfText({items:[item(first)]});
  const partial=matchPdfCitation(index,paragraph);assert.ok(partial&&!partial.complete);assert.ok(partial.coverage>=.45&&partial.coverage<1);
  assert.equal(matchPdfCitation(index,'A different scientific method with no quoted evidence from this paragraph.'),null);
  assert.equal(matchPdfCitation(index,'model'),null);
  const muchLonger=paragraph+' Unrelated remaining material explaining another method and entirely different findings.'.repeat(8);
  assert.equal(matchPdfCitation(index,muchLonger),null);
});

test('highlight rectangles follow the canvas scale and preserve partial-run boundaries',()=>{
  const index=indexPdfText({items:[item('The cited sentence ends here. Another sentence follows.')]});
  const match=matchPdfCitation(index,'The cited sentence ends here.');assert.ok(match);
  const a=citationBoxes(index,match,{transform:[1,0,0,-1,0,600]}),b=citationBoxes(index,match,{transform:[2,0,0,-2,0,1200]});
  assert.equal(a.length,1);assert.ok(a[0].width>0&&a[0].width<200);assert.equal(a[0].left,20);assert.equal(a[0].angle,0);
  for(const field of ['left','top','width','height'] as const)assert.equal(b[0][field],a[0][field]*2);
  assert.equal(citationBoxes(index,match,{transform:[0,1,1,0,0,0]})[0].angle,90);
});
