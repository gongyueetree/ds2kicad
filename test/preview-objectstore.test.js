import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PreviewPostgresObjectStore} from '../lib/preview-objectstore.js';

// Protocol-level fake. Real PostgreSQL integration may be run separately against a disposable database.
function poolFake() {
  const rows = new Map(), calls = [];
  const pool = {rows,calls,async connect(){return {...pool,release(){calls.push('release');}};},async query(sql,p=[]){
    calls.push(sql);const key=JSON.stringify(p.slice(0,2));
    if(sql.startsWith('SELECT sha256'))return {rows:rows.has(key)?[{sha256:rows.get(key).sha256}]:[]};
    if(sql.startsWith('SELECT COALESCE'))return {rows:[{bytes:[...rows.values()].filter(r=>r.namespace===p[0]).reduce((n,r)=>n+r.body.length,0)}]};
    if(sql.startsWith('INSERT INTO')){rows.set(key,{namespace:p[0],sha256:p[2],body:p[4]});return {rows:[]};}
    if(sql.startsWith('SELECT body'))return {rows:rows.has(key)?[rows.get(key)]:[]};
    if(sql.startsWith('SELECT 1'))return {rows:rows.has(key)?[{}]:[]};
    return {rows:[]};
  }};return pool;
}
test('preview files survive adapter recreation; keys are immutable, integrity checked, and namespaces isolated',async()=>{
  const pool=poolFake(),a=new PreviewPostgresObjectStore({pool,namespace:'a'}),b=new PreviewPostgresObjectStore({pool,namespace:'a'}),other=new PreviewPostgresObjectStore({pool,namespace:'b'});
  const file=Buffer.from('%PDF-original');await a.put('tenant/source',file);await a.put('tenant/source',file);
  assert.deepEqual(await b.get('tenant/source'),file);assert.equal(await other.get('tenant/source'),null);
  await assert.rejects(a.put('tenant/source',Buffer.from('different')),/冲突/);
  assert.equal(await b.exists('tenant/source'),true);assert.ok(pool.calls.includes('ROLLBACK'));assert.ok(pool.calls.some(x=>x.includes('pg_advisory_xact_lock')));
  pool.rows.get(JSON.stringify(['a','tenant/source'])).body=Buffer.from('corrupt');
  await assert.rejects(b.get('tenant/source'),/校验失败/);
});
test('preview file and total capacity limits reject additions but permit identical retries',async()=>{
  const pool=poolFake(),store=new PreviewPostgresObjectStore({pool,namespace:'limited',maxBytes:5,quotaBytes:8});
  await assert.rejects(store.put('a',Buffer.alloc(6)),/20MB/);
  await store.put('a',Buffer.alloc(5));await store.put('a',Buffer.alloc(5));
  await assert.rejects(store.put('b',Buffer.alloc(4)),/空间已满/);
  assert.equal(await store.exists('b'),false);
  assert.throws(()=>new PreviewPostgresObjectStore({pool,namespace:'bad/name'}),/NAMESPACE/);
});
