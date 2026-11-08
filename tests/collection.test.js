import test from 'node:test';
import assert from 'node:assert/strict';
import {filterCollection} from '../src/web/examples.js';

test('collection filters combine language and query without changing the selected source index',()=>{
  const files=[
    {index:0,id:'CHAT_RU_A',language:'RU',preview:'Как открыть счёт?'},
    {index:1,id:'CHAT_KZ_A',language:'KZ',preview:'Шот ашу туралы'},
    {index:2,id:'CHAT_RU_B',language:'RU',preview:'Уже открыл счёт'},
    {index:3,id:'CALL_EN',language:'EN',preview:''}
  ];
  const before=JSON.stringify(files);
  const result=filterCollection(files,' СЧЁТ ','RU');
  assert.deepEqual(result.map(f=>f.index),[0,2]);assert.equal(result[1],files[2]);
  assert.deepEqual(filterCollection(files,'kz_a','all'),[files[1]]);
  assert.deepEqual(filterCollection(files,'несуществующая фраза','all'),[]);
  assert.deepEqual(filterCollection(files,'','EN'),[files[3]]);
  assert.equal(JSON.stringify(files),before);
});
