import http from 'node:http';
import {readFile} from 'node:fs/promises';
const files={'/live-dom-cases.js':new URL('./live-dom-cases.js',import.meta.url),'/live-edit.js':new URL('../../public/live-edit.js',import.meta.url),'/editor.js':new URL('../../public/editor.js',import.meta.url),'/fragments.js':new URL('../../public/fragments.js',import.meta.url)};
http.createServer(async(req,res)=>{
 if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><meta charset="utf-8"><title>实时编辑 DOM 验收</title><h1>实时编辑 DOM 验收</h1><p id="summary">Running</p><ul id="results"></ul><div id="sandbox" hidden></div><script type="module" src="/live-dom-cases.js"></script></html>');return;}
 if(!files[req.url]){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(await readFile(files[req.url]));
}).listen(3214,'127.0.0.1',()=>console.log('DOM QA: http://127.0.0.1:3214'));
