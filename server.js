'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const PORT = Number(process.env.PORT || 3000);
const html = fs.readFileSync(path.join(__dirname, 'index.html'));
const rooms = new Map();
const TTL = 40000;
const CAP = 60;
function roomName(x){return typeof x==='string' ? (x.toUpperCase().replace(/[^A-Z0-9-]/g,'').slice(0,18)||'SAN-CHUA') : 'SAN-CHUA'}
function playerId(x){return typeof x==='string'&&/^[A-Za-z0-9-]{8,80}$/.test(x)?x:null}
function safeName(x){return typeof x==='string'?x.trim().replace(/\s+/g,' ').slice(0,22):''}
function limit(x,min,max,d=0){return Number.isFinite(Number(x))?Math.max(min,Math.min(max,Number(x))):d}
function getRoom(key){if(!rooms.has(key))rooms.set(key,{players:new Map(),clients:new Set(),chat:[]});return rooms.get(key)}
function compact(p){const {id,name,color,x,y,merit,moving}=p;return {id,name,color,x,y,merit,moving}}
function send(res,event,data){try{res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n');return true}catch{return false}}
function broadcast(room,event,data){for(const res of room.clients)if(!send(res,event,data))room.clients.delete(res)}
function reply(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))}
function jsonBody(req){return new Promise((resolve,reject)=>{let total=0,s='';req.on('data',chunk=>{total+=chunk.length;if(total>4096){reject(new Error('Too large'));req.destroy();return}s+=chunk});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'))}catch{reject(new Error('Invalid JSON'))}});req.on('error',reject)})}
function remove(room,id){if(room.players.delete(id))broadcast(room,'leave',{id})}
setInterval(()=>{const now=Date.now();for(const [key,room] of rooms){for(const [id,p] of room.players)if(now-p.seen>TTL)remove(room,id);for(const res of room.clients){try{res.write(': ping\n\n')}catch{room.clients.delete(res)}}if(!room.players.size&&!room.clients.size)rooms.delete(key)}},12000).unref();
http.createServer(async(req,res)=>{
 let url;try{url=new URL(req.url,'http://localhost')}catch{return reply(res,400,{error:'Invalid URL'})}
 if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/index.html')){
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(html);return;
 }
 if(req.method==='GET'&&url.pathname==='/api/health')return reply(res,200,{ok:true,mode:'multiplayer',rooms:rooms.size});
 if(req.method==='GET'&&url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return}
 if(req.method==='GET'&&url.pathname==='/api/events'){
   const key=roomName(url.searchParams.get('room')),id=playerId(url.searchParams.get('id'));
   const room=rooms.get(key);
   if(!room||!id||!room.players.has(id))return reply(res,403,{error:'Join first'});
   res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
   res.write(': connected\n\n');room.clients.add(res);
   send(res,'snapshot',{players:[...room.players.values()].map(compact),online:room.players.size,chat:room.chat});
   req.on('close',()=>room.clients.delete(res));return;
 }
 if(req.method==='POST'&&url.pathname.startsWith('/api/')){
   if(req.headers['content-type']?.split(';')[0]!=='application/json')return reply(res,415,{error:'Expected JSON'});
   let data;try{data=await jsonBody(req)}catch{return reply(res,400,{error:'Bad request'})}
   const id=playerId(data.id),key=roomName(data.room);if(!id)return reply(res,400,{error:'Invalid ID'});
   const room=getRoom(key);
   if(url.pathname==='/api/join'){
     const name=safeName(data.name);if(name.length<2)return reply(res,400,{error:'Invalid name'});
     if(!room.players.has(id)&&room.players.size>=CAP)return reply(res,429,{error:'Sảnh đã đầy'});
     const old=room.players.get(id);
     const p={id,name,color:Math.round(limit(data.color,0,3)),x:limit(data.x,58,1615,839),y:limit(data.y,364,866,676),merit:Math.floor(limit(data.merit,0,1000000)),moving:false,seen:Date.now()};
     if(old)p.merit=Math.max(old.merit,p.merit);
     room.players.set(id,p);broadcast(room,old?'state':'join',{player:compact(p),online:room.players.size});
     return reply(res,200,{ok:true,online:room.players.size,room:key});
   }
   const p=room.players.get(id);if(!p)return reply(res,403,{error:'Rejoin first'});
   if(url.pathname==='/api/state'){
     p.x=limit(data.x,58,1615,p.x);p.y=limit(data.y,364,866,p.y);p.moving=!!data.moving;
     p.name=safeName(data.name)||p.name;p.color=Math.round(limit(data.color,0,3,p.color));
     p.merit=Math.max(p.merit,Math.floor(limit(data.merit,0,1000000,p.merit)));p.seen=Date.now();
     broadcast(room,'state',{player:compact(p)});return reply(res,200,{ok:true});
   }
   if(url.pathname==='/api/action'){
     const points={incense:10,flower:15,scripture:30,meditate:20};const type=String(data.type||'');
     if(!Object.prototype.hasOwnProperty.call(points,type))return reply(res,400,{error:'Unknown action'});
     p.seen=Date.now();p.merit=Math.max(p.merit,Math.floor(limit(data.merit,0,1000000,p.merit)));
     broadcast(room,'action',{id:p.id,type,points:points[type],merit:p.merit,x:p.x,y:p.y});return reply(res,200,{ok:true});
   }
   if(url.pathname==='/api/chat'){
     const message=typeof data.text==='string'?data.text.trim().replace(/[\r\n\t]+/g,' ').slice(0,180):'';
     if(!message)return reply(res,400,{error:'Empty message'});
     const now=Date.now();if(p.lastChat&&now-p.lastChat<1250)return reply(res,429,{error:'Slow down'});
     p.lastChat=now;p.seen=now;
     const msg={id:p.id,name:p.name,text:message,at:now};
     room.chat.push(msg);if(room.chat.length>30)room.chat.shift();broadcast(room,'chat',msg);return reply(res,200,{ok:true});
   }
   if(url.pathname==='/api/leave'){remove(room,id);return reply(res,200,{ok:true})}
   return reply(res,404,{error:'Not found'});
 }
 reply(res,404,{error:'Not found'});
}).listen(PORT,'0.0.0.0',()=>console.log('Chua An Nhien multiplayer listening on port '+PORT));
