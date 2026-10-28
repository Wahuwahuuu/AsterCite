import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseEvidenceText, evidencePreview, type EvidenceBlock } from "../../web/evidence-format.js";

const normalize=(text:string)=>text.replace(/\s+/gu," ").trim();
const contents=(blocks:EvidenceBlock[])=>blocks.map(block=>block.kind==="table"?[block.caption,...block.headers,...block.rows.flat()].join(" "):block.text).join(" ");
const sample=JSON.parse(await readFile(new URL("../../web/sample.json",import.meta.url),"utf8")) as {turns:{sources:{text:string;paper_id:string}[]}[]};
const termTable=sample.turns.flatMap(turn=>turn.sources).find(source=>source.text.startsWith("Table 6: Part of new negative terms"));
assert.ok(termTable,"The demo includes the term-frequency table");

test("PDF term tables retain all twelve terms and their paired frequencies",()=>{
  const source=termTable,blocks=parseEvidenceText(source.text),table=blocks[0];
  assert.equal(source.paper_id,"1611.09441");assert.equal(table.kind,"table");
  if(table.kind!=="table")throw new Error("Expected the term-frequency table");
  assert.equal(table.caption,"Table 6: Part of new negative terms");
  assert.deepEqual(table.headers,["term","frequency"]);
  assert.deepEqual(table.rows,[["tweetcongress","19"],["lie","15"],["txgop","11"],["taxes","11"],["tpp","9"],["deem","9"],["gov’t","8"],["vulnerable","8"],["sad","7"],["stupid","7"],["cancer","7"],["unconstitutional","7"]]);
  assert.equal(normalize(contents(blocks)),normalize(source.text));
});

test("full display retains every demo source in its original order while removing PDF layout whitespace",()=>{
  for(const turn of sample.turns)for(const source of turn.sources){
    const blocks=parseEvidenceText(source.text);
    assert.equal(normalize(contents(blocks)),normalize(source.text));
    for(const block of blocks)if(block.kind!=="table")assert.ok(!/[\r\n]| {2}/u.test(block.text));
  }
});

test("unrecognized or incomplete table fragments remain text without invented rows",()=>{
  for(const source of ["Table 1: Measurements\n\nvalue\n\nfrequency\n\nalpha\n\n3\n\nbeta\n\n4","Table 2: Terms\n\nterm\n\nfrequency\n\nalpha\n\nunknown","Table 3: Terms\n\nterm\n\nfrequency\n\nalpha\n\n3\n\nbeta"]){
    const blocks=parseEvidenceText(source);assert.ok(!blocks.some(block=>block.kind==="table"));
    assert.equal(normalize(contents(blocks)),normalize(source));
  }
  assert.deepEqual(parseEvidenceText("\n\t\r\n"),[]);
});

test("preview limits long tables without changing the complete source or splitting English words",()=>{
  const blocks=parseEvidenceText(termTable.text),original=structuredClone(blocks),preview=evidencePreview(blocks);
  assert.equal(preview.hasMore,true);assert.equal(preview.blocks.length,1);
  const table=preview.blocks[0];assert.equal(table.kind,"table");
  if(table.kind!=="table")throw new Error("Expected preview table");
  assert.equal(table.rows.length,6);assert.equal(table.omittedRows,6);assert.deepEqual(blocks,original);
  const text="A short sentence. Another complete sentence. A third sentence has a longer explanation.";
  const shortened=evidencePreview(parseEvidenceText(text),69);
  assert.equal(shortened.hasMore,true);
  const excerpt=contents(shortened.blocks);assert.ok(excerpt.endsWith("…"));
  const prefix=excerpt.slice(0,-1);assert.ok(text.startsWith(prefix));assert.equal(text[prefix.length]," ");
  assert.equal(evidencePreview(parseEvidenceText("A short source.")).hasMore,false);
});

test('scientific evidence keeps general Markdown tables and whole LaTeX formulas readable',()=>{
  const text='### Results (%)\n\n| Model | A | B |\n| --- | --- | --- |\n'+Array.from({length:12},(_,i)=>`| Model ${i} | ${i}.1 | $\\frac{a}{b}$ |`).join('\n');
  const full=parseEvidenceText(text);assert.deepEqual(full,[{kind:'markdown',text}]);
  const preview=evidencePreview(full,80,6);assert.equal(preview.hasMore,true);const view=contents(preview.blocks);
  assert.ok(view.includes('| Model | A | B |'));assert.equal((view.match(/\| Model \d+/gu)??[]).length,6);assert.ok(view.includes('还有 6 行'));assert.equal(contents(full),text);
  const equation='The equation is\n\n$$\nL = \\frac{1}{N} \\sum_i x_i^2\n$$';
  const formula=evidencePreview(parseEvidenceText(equation),10);assert.equal(formula.hasMore,false);assert.equal(contents(formula.blocks),equation);
});
