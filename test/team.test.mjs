import test from 'node:test';import assert from 'node:assert/strict';import {selectTeam} from '../lib/team.mjs';
test('team selection never creates entitlement or picks an ambiguous namespace',()=>{
 const item=id=>({id,state:'active'});
 assert.equal(selectTeam({items:[item('second')]}),'second');
 assert.equal(selectTeam({items:[item('mzr-books'),item('second')]}),'mzr-books');
 assert.equal(selectTeam({items:[item('first'),item('second')]},'second'),'second');
 for(const [catalog,request] of [[{items:[]},''],[{items:[item('first'),item('second')]},''],[{items:[item('first')]},'unknown'],[{items:[item('../bad')]},'']])assert.throws(()=>selectTeam(catalog,request));
});
