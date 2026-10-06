import test from 'node:test';import assert from 'node:assert/strict';
import {validateReleaseTrust} from '../lib/trust.mjs';
test('pinned root rotation accepts bounded overlap, rejects revoked/expired roots and extended releases',()=>{
 const now=Date.parse('2026-10-06T00:00:00Z');
 const policies={old:{notBefore:'2026-10-01',notAfter:'2026-10-08'},next:{notBefore:'2026-10-05',notAfter:'2026-11-01'}};
 const manifest={createdAt:'2026-10-06T00:00:00Z',expiresAt:'2026-10-07T00:00:00Z'};
 for(const id of ['old','next'])validateReleaseTrust(id,policies,manifest,true,now);
 assert.throws(()=>validateReleaseTrust('missing',policies,manifest,true,now),/missing/);
 assert.throws(()=>validateReleaseTrust('old',policies,{...manifest,expiresAt:'2026-10-09'},true,now),/lifetime/);
 assert.throws(()=>validateReleaseTrust('old',{old:{...policies.old,revoked:true}},manifest,true,now),/revoked/);
 assert.throws(()=>validateReleaseTrust('old',policies,manifest,true,Date.parse('2026-10-08')),/validity/);
});
