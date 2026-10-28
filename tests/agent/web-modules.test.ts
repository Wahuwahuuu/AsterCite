import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {createWebServer} from '../../agent/web-server.ts';

test('all relative modules imported by the browser entrypoints are served as JavaScript',async()=>{
  const server=await createWebServer({root:process.cwd(),mode:'demo'});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
  const origin='http://127.0.0.1:'+address.port,queue=['/app.js','/trace.js'],visited=new Set<string>();
  try{
    while(queue.length){const path=queue.shift()!;if(visited.has(path))continue;visited.add(path);
      const response=await fetch(origin+path);assert.equal(response.status,200,'Missing browser module: '+path);assert.match(response.headers.get('content-type')??'',/javascript/u,path);
      const file=ts.createSourceFile(path,await response.text(),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
      const add=(value:string)=>{assert.ok(value.startsWith('.'),'Unexpected external browser module: '+value);queue.push(new URL(value,origin+path).pathname);};
      for(const statement of file.statements)if((ts.isImportDeclaration(statement)||ts.isExportDeclaration(statement))&&statement.moduleSpecifier&&ts.isStringLiteral(statement.moduleSpecifier))add(statement.moduleSpecifier.text);
      const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0]))add(node.arguments[0].text);ts.forEachChild(node,visit);};visit(file);
    }
    assert.ok(visited.has('/answer-format.js'));assert.ok(visited.has('/task-progress.js'));assert.ok(visited.has('/vendor/katex.mjs'));
    assert.equal((await fetch(origin+'/agent/web-server.ts')).status,404);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
