import {readFile,writeFile,copyFile,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),target=join(root,'web/vendor');
await mkdir(join(target,'fonts'),{recursive:true});
const files:Array<[string,string]>=[['marked/lib/marked.esm.js','marked.js'],['marked/LICENSE','marked-LICENSE'],['dompurify/dist/purify.es.mjs','purify.mjs'],['dompurify/LICENSE','purify-LICENSE'],['dompurify/LICENSE-MPL','purify-LICENSE-MPL'],['katex/dist/katex.mjs','katex.mjs'],['katex/dist/katex.min.css','katex.css'],['katex/LICENSE','katex-LICENSE']];
for(const name of (await readdir(join(root,'node_modules/katex/dist/fonts'))).sort())if(/\.(?:woff2|woff|ttf)$/u.test(name))files.push(['katex/dist/fonts/'+name,'fonts/'+name]);
for(const [source,name] of files){const from=join(root,'node_modules',source),to=join(target,name);if(name.includes('LICENSE'))await writeFile(to,(await readFile(from,'utf8')).replace(/[ \t]+$/gmu,''));else await copyFile(from,to);}
const versions=Object.fromEntries(await Promise.all(['marked','dompurify','katex'].map(async name=>[name,JSON.parse(await readFile(join(root,'node_modules',name,'package.json'),'utf8')).version])));
await writeFile(join(target,'render-assets.json'),JSON.stringify({versions,files:files.map(([,name])=>name)},null,2)+'\n');
const productPath=join(root,'desktop/product-files.json'),product=JSON.parse(await readFile(productPath,'utf8')) as string[];
for(const name of ['agent/answer-stream.ts','scripts/sync-web-renderer.ts','web/markdown.js','web/markdown.d.ts','web/answer-preview.js','web/vendor/render-assets.json',...files.map(([,name])=>'web/vendor/'+name)])if(!product.includes(name))product.push(name);
await writeFile(productPath,JSON.stringify(product,null,2)+'\n');
console.log(`Prepared ${files.length} local renderer assets.`);
