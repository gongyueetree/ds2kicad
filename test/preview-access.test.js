import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/preview-access.js';
import { authenticate } from '../lib/auth.js';

function request(method, body, extra = {}) {
  const res = { code:200, headers:{}, setHeader(k,v){this.headers[k]=v;}, status(s){this.code=s;return this;}, json(data){this.data=data;return this;} };
  handler({ method,body,headers:{host:'preview.example','content-type':'application/json',...extra} },res);
  return res;
}
test('preview login is explicit, expires, uses a scoped authenticated cookie, and never opens production', () => {
  const saved={...process.env};
  try {
    Object.assign(process.env,{VERCEL_ENV:'preview',NODE_ENV:'production',OBJECT_STORE_MODE:'preview-postgres',PREVIEW_ACCESS_CODE:'preview-test-code-with-32-characters',PREVIEW_ACCESS_EXPIRES_AT:new Date(Date.now()+3600000).toISOString(),PREVIEW_STORAGE_NAMESPACE:'acceptance-test',EZPLM_JWT_SECRET:'test-only-secret',EZPLM_JWT_ISS:'preview-test',EZPLM_JWT_AUD:'preview-test',AUTH_MODE:'production'});
    assert.deepEqual(request('GET').data.authenticated,false);
    assert.equal(request('POST',{code:'wrong'}).code,401);
    assert.equal(request('POST',{code:process.env.PREVIEW_ACCESS_CODE},{origin:'https://evil.example'}).code,403);
    const login=request('POST',{code:process.env.PREVIEW_ACCESS_CODE},{origin:'https://preview.example'});
    assert.equal(login.code,200); assert.deepEqual(login.data,{ok:true});
    assert.match(login.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Strict/);
    const cookie=login.headers['Set-Cookie'].split(';')[0];
    const auth=authenticate({headers:{cookie}});
    assert.equal(auth.session.authenticated,true);assert.equal(auth.session.tenantId,'preview-acceptance-test');assert.ok(auth.session.roles.includes('publisher'));
    assert.equal(request('GET',null,{cookie}).data.authenticated,true);
    process.env.VERCEL_ENV='production';
    assert.equal(request('GET').data.enabled,false);assert.equal(request('POST',{code:process.env.PREVIEW_ACCESS_CODE}).code,404);
    process.env.VERCEL_ENV='preview';process.env.PREVIEW_ACCESS_EXPIRES_AT='2000-01-01';
    assert.equal(request('POST',{code:process.env.PREVIEW_ACCESS_CODE}).code,404);
  } finally { for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved); }
});
