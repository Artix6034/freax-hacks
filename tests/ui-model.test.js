import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowState,appendNotice} from '../src/web/ui-model.js';
import {hwfStep,hwfWarmth,hwfRadius} from '../src/web/halftone.js';

test('workflow never marks AI completed merely because a model or transcript is available',()=>{
 const ready=workflowState({active:true,modelReady:true,criteria:8,version:1,running:false,evaluated:false});
 assert.equal(ready.stages[2].state,'ready');assert.equal(ready.stages[3].state,'blocked');assert.match(ready.summary,/Готов/);
 const blocked=workflowState({active:true,modelReady:false,criteria:8,version:1,running:false});
 assert.equal(blocked.stages[2].state,'blocked');assert.match(blocked.log,/требуется подключение/);
});
test('workflow distinguishes an actual request, partial result and failed result',()=>{
 const base={active:true,modelReady:true,criteria:8,version:2};
 assert.equal(workflowState({...base,running:true}).stages[2].state,'active');
 const partial=workflowState({...base,evaluationStatus:'partial'});assert.match(partial.summary,/проверка/);assert.match(partial.stages[3].label,/неопределённость/);
 const failed=workflowState({...base,evaluationStatus:'failed'});assert.equal(failed.stages[2].state,'error');assert.equal(failed.stages[3].state,'blocked');
 assert.equal(workflowState({...base,evaluationStatus:'completed'}).stages[2].state,'done');
});
test('notification history ignores blank messages, deduplicates repeats and is bounded',()=>{
 let items=[];assert.equal(appendNotice(items,' '),items);
 items=appendNotice(items,'Импортирован новый набор',1);assert.equal(appendNotice(items,'Импортирован новый набор',2),items);
 for(let i=0;i<40;i++)items=appendNotice(items,`Событие ${i}`,i+3);
 assert.equal(items.length,30);assert.equal(items[0].message,'Событие 39');assert.equal(items.at(-1).message,'Событие 10');
});
test('halftone springs return a displaced dot home after the pointer leaves',()=>{
 let [x,y,vx,vy]=[35,12,2,-1];for(let i=0;i<250;i++)[x,y,vx,vy]=hwfStep(x,y,vx,vy,0,0,-10000,-10000,76);
 assert.ok(Math.hypot(x,y)<.001);assert.ok(Math.hypot(vx,vy)<.001);
 const pushed=hwfStep(5,0,0,0,5,0,0,0,76);assert.ok(pushed[0]>5);
 assert.equal(hwfWarmth(0,0,0,0,28),0);assert.equal(hwfWarmth(100,0,0,0,28),1);
 assert.equal(hwfRadius(-1,6),0);assert.equal(hwfRadius(2,6),hwfRadius(1,6));
});
