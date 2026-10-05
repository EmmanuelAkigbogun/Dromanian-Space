// Local adapter for the same web-standard handlers deployed by Vercel.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createServer as createViteServer } from 'vite';
import * as health from '../api/health.js';
import * as status from '../api/ai/status.js';
import * as run from '../api/agents/run.js';
import * as mention from '../api/agents/mention.js';
import * as jobs from '../api/jobs/run.js';
import { methodNotAllowed, errorResponse, HttpError } from '../server/http.js';
const handlers:Record<string,Record<string,(r:Request)=>Promise<Response>>>={'/api/health':health,'/api/ai/status':status,'/api/agents/run':run,'/api/agents/mention':mention,'/api/jobs/run':jobs};
const http=createServer(async(req,res)=>{
 try{const url=new URL(req.url??'/', 'http://localhost:5174');const route=handlers[url.pathname];const handler=route?.[req.method??'GET'];
  if(!handler){const r=methodNotAllowed();res.writeHead(route?405:404,Object.fromEntries(r.headers));res.end(await r.text());return;}
  const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>65536)throw new HttpError(413,'too_large','Request is too large.');chunks.push(chunk);}
  const request=new Request(url,{method:req.method,headers:req.headers as Record<string,string>,body:chunks.length?Buffer.concat(chunks):undefined});
  const response=await handler(request);res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(res);else res.end();
 }catch(e){const response=errorResponse(e);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());}
});
http.listen(5174,'127.0.0.1');
const vite=await createViteServer({server:{host:'127.0.0.1'}});await vite.listen();vite.printUrls();
console.log('Local API: http://127.0.0.1:5174');
