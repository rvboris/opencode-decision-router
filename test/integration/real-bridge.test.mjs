import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeRealBridge, sanitizeTask } from './real-bridge.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'realbridge-'));
const listen = handler => new Promise(resolve => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` })); });

test('sanitizeTask strips fixture routing markers, keeps semantic task', () => {
  const out = sanitizeTask('ROUTER_CASE:smoke-1 CHILD_smoke-1 Rename a variable in one file and return DONE_smoke-1.');
  assert.ok(!/ROUTER_CASE|CHILD_/.test(out));
  assert.match(out, /Rename a variable/);
});

test('bridge strips fixture markers, uses real credential, dummy bearer never forwarded', async () => {
  const dir = tmp();
  const keyFile = path.join(dir, 'key'); fs.writeFileSync(keyFile, 'sk-real-secret\n');
  const seen = [];
  const upstream = await listen((req, res) => { let b=''; req.on('data', c => b+=c); req.on('end', () => { seen.push({ auth: req.headers.authorization, body: b }); res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({ id:'req_1', answers:{routing:{type:'choice',choice:'light'}}, usage:{cost:0.002} })); }); });
  const attempts = [];
  const budgetedFetchImpl = fetchImpl => async (url, init) => { attempts.push({ url, taskId: init.__taskId, auth: init.headers.authorization }); return fetchImpl(url, init); };
  const bridge = makeRealBridge({ endpoint: upstream.url, apiKeyFile: keyFile, budgetedFetchImpl });
  const local = await listen((req, res) => { let b=''; req.on('data', c => b+=c); req.on('end', () => bridge.handle(JSON.parse(b), res)); });
  const res = await fetch(local.url, { method:'POST', headers:{ authorization:'Bearer dummy-loopback' }, body: JSON.stringify({ model:'microsoft/microsoft-decision-1', state:{ task:'ROUTER_CASE:x CHILD_x Apply a one-line rename. Return DONE_x.' }, questions:{ routing:{ type:'choice' } } }) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.answers.routing.choice, 'light');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].auth, 'Bearer sk-real-secret');
  assert.ok(!seen[0].body.includes('ROUTER_CASE'));
  assert.ok(!seen[0].body.includes('DONE_'));
  assert.equal(attempts[0].taskId, 'decision-router-e2e');
  assert.notEqual(attempts[0].auth, 'Bearer dummy-loopback');
  local.s.close(); upstream.s.close();
});

test('missing usage.cost aborts and is recorded without credential leakage', async () => {
  const dir = tmp();
  const keyFile = path.join(dir, 'key'); fs.writeFileSync(keyFile, 'sk-real-secret');
  const logs = [];
  const upstream = await listen((req, res) => { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({ id:'req_2', answers:{routing:{type:'choice',choice:'light'}} })); });
  const budgetedFetchImpl = fetchImpl => async (url, init) => fetchImpl(url, init);
  const bridge = makeRealBridge({ endpoint: upstream.url, apiKeyFile: keyFile, budgetedFetchImpl, logger: e => logs.push(e) });
  const local = await listen((req, res) => bridge.handle({ state:{ task:'Explain distributed consensus' } }, res));
  const res = await fetch(local.url, { method:'POST', body:'{}' });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'budget-abort');
  assert.ok(logs.some(l => l.event === 'abort' && l.hasUsageCost === false && l.requestId === 'req_2'));
  assert.ok(!JSON.stringify(logs).includes('sk-real-secret'));
  local.s.close(); upstream.s.close();
});

test('network error surfaces 502 without retry', async () => {
  const dir = tmp();
  const keyFile = path.join(dir, 'key'); fs.writeFileSync(keyFile, 'sk-real-secret');
  const calls = { n: 0 };
  const budgetedFetchImpl = fetchImpl => async (url, init) => { calls.n++; throw new Error('unreachable'); };
  const bridge = makeRealBridge({ endpoint: 'http://127.0.0.1:1/none', apiKeyFile: keyFile, budgetedFetchImpl });
  const local = await listen((req, res) => bridge.handle({ state:{ task:'x' } }, res));
  const res = await fetch(local.url, { method:'POST', body:'{}' });
  assert.equal(res.status, 502); assert.equal(calls.n, 1);
  local.s.close();
});
