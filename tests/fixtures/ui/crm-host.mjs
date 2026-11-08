// Local synthetic CRM host + 390px iframe viewport. No real tenant or model.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
const conversation={conversation_id:'synthetic-crm-bridge-only',channel:'agent chat',language:'KZ',transcript:[
  {speaker:'client',timestamp:'00:00',text:'ТЕСТ: Есепті қайдан көруге болады?'},
  {speaker:'operator',timestamp:'00:02',text:'ТЕСТ: Сәлеметсіз бе! Менің атым Анна. «Есептер» бөлімін ашыңыз.'},
  {speaker:'client',timestamp:'00:04',text:'ТЕСТ: Рақмет, таптым.'},
  {speaker:'operator',timestamp:'00:06',text:'ТЕСТ: Есеп табылды. Қосымша сұрақтарыңыз болса, хабарласыңыз. Сау болыңыз!'}]};
const server=http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><html><head><meta charset="utf-8"><title>Synthetic CRM host</title><link rel="stylesheet" href="/preview.css"><script defer src="/preview.js"></script></head><body><h1>Тест встраивания CRM</h1><p>390 px · синтетический транскрипт · тестовый провайдер</p><iframe id="resource" src="/freax-host.html" title="CRM web resource"></iframe><output id="event">Ожидание…</output></body></html>');}
  if(path==='/preview.css'){res.setHeader('Content-Type','text/css');return res.end('body{font:14px Arial;background:#e8ece9;margin:24px}h1{font-size:20px}#resource{width:390px;height:844px;border:1px solid #bbc7bf;background:white}output{display:block;padding:12px}');}
  if(path==='/preview.js'){res.setHeader('Content-Type','text/javascript');return res.end(`const frame=document.getElementById('resource');frame.onload=()=>frame.contentWindow.FreaxHost.init({appUrl:'http://127.0.0.1:3002',conversation:${JSON.stringify(conversation)},onResult:result=>document.getElementById('event').textContent=JSON.stringify(result)});`);}
  const assets={'/freax-host.html':['freax-host.html','text/html'],'/freax-host.js':['freax-host.js','text/javascript'],'/freax-host.css':['freax-host.css','text/css']};
  if(assets[path]){res.setHeader('Content-Type',assets[path][1]+'; charset=utf-8');return res.end(await readFile(new URL('../../../integrations/dynamics365/'+assets[path][0],import.meta.url)));}
  res.writeHead(404);res.end();
});server.listen(3005,'127.0.0.1',()=>console.log('SYNTHETIC CRM iframe UI host: http://127.0.0.1:3005'));
