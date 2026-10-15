import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeRealBridge, sanitizeTask } from './real-bridge.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'realbridge-'));
const listen = handler => new Promise(resolve => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` })); });

test('reconciliation scenario: network-error attempt with null cost records abort evidence, no credential leakage', async () => {
  const dir = tmp();
  const keyFile = path.join(dir, 'key'); fs.writeFileSync(keyFile, 'sk-real-secret');
  const logs = [];
  const budgetedFetchImpl = fetchImpl => async (url, init) => { throw new Error('socket timeout'); };
  const bridge = makeRealBridge({ endpoint: 'http://127.0.0.1:1/x', apiKeyFile: keyFile, budgetedFetchImpl, logger: e => logs.push(e) });
  const local = await listen((req, res) => bridge.handle({ state: { task: 'ROUTER_CASE:k CHILD_k Audit locking. Return DONE_k.' } }, res));
  const res = await fetch(local.url, { method: 'POST', body: '{}' });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream-unavailable');
  assert.ok(logs.some(l => l.event === 'budget-network-error' && l.name === 'Error'));
  assert.ok(!JSON.stringify(logs).includes('sk-real-secret'));
  local.s.close();
});

test('bridge performs exactly one upstream attempt per plugin classification (no retry after success)', async () => {
  const dir = tmp();
  const keyFile = path.join(dir, 'key'); fs.writeFileSync(keyFile, 'sk-real-secret');
  let calls = 0;
  const upstream = await listen((req, res) => { calls++; res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({ id:`req_${calls}`, answers:{routing:{type:'choice',choice:'light'}}, usage:{cost:0.0000028} })); });
  const budgetedFetchImpl = fetchImpl => async (url, init) => fetchImpl(url, init);
  const bridge = makeRealBridge({ endpoint: upstream.url, apiKeyFile: keyFile, budgetedFetchImpl, logger: () => {} });
  const local = await listen((req, res) => { let b=''; req.on('data', c => b+=c); req.on('end', () => bridge.handle(JSON.parse(b), res)); });
  const r1 = await fetch(local.url, { method:'POST', body: JSON.stringify({ state:{ task:'ROUTER_CASE:a CHILD_a Fix typo. Return DONE_a.' } }) });
  assert.equal(r1.status, 200);
  await fetch(local.url, { method:'POST', body: JSON.stringify({ state:{ task:'ROUTER_CASE:b CHILD_b Add index. Return DONE_b.' } }) }).then(r => r.json());
  assert.equal(calls, 2); // one per distinct classification, never retried per call
  local.s.close(); upstream.s.close();
});

test('cost evidence rows carry requestId and exact usage.cost for reconciliation export', async () => {
  const dir = tmp();
  const keyFile = path.join(dir, 'key'); fs.writeFileSync(keyFile, 'sk-real-secret');
  const evidence = [];
  const upstream = await listen((req, res) => { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({ id:'req_recon', answers:{routing:{type:'choice',choice:'heavy'}}, usage:{cost:0.0000031} })); });
  const budgetedFetchImpl = fetchImpl => async (url, init) => fetchImpl(url, init);
  const bridge = makeRealBridge({ endpoint: upstream.url, apiKeyFile: keyFile, budgetedFetchImpl, logger: e => evidence.push(e) });
  const local = await listen((req, res) => bridge.handle({ state:{ task:'Design queue backpressure' } }, res));
  const res = await fetch(local.url, { method:'POST', body:'{}' });
  assert.equal(res.status, 200);
  const row = evidence.find(l => l.event === 'forwarded');
  assert.equal(row.requestId, 'req_recon');
  assert.equal(row.costUsd, 0.0000031);
  assert.ok(!JSON.stringify(evidence).includes('sk-real-secret'));
  local.s.close(); upstream.s.close();
});

test('sanitizeTask bounds length for oversized synthetic tasks', () => {
  const big = 'x'.repeat(9000);
  const out = sanitizeTask(big);
  assert.equal(out.length, 4000);
});
