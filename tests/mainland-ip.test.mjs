import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workerSource = await readFile(new URL('../_worker.js', import.meta.url), 'utf8');
const start = workerSource.indexOf('function 识别运营商(request) {');
const end = workerSource.indexOf('async function 获取优选订阅生成器数据', start);
assert.notEqual(start, -1, 'carrier/IP functions must be present in the Worker');
assert.notEqual(end, -1, 'carrier/IP function block must have a closing boundary');
const functionBlock = workerSource.slice(start, end);

function loadHelpers(fetchImpl) {
  const factory = new Function('fetch', '特征码字典', `${functionBlock}\nreturn { 识别运营商, 生成随机IP };`);
  return factory(fetchImpl, ['', 'test-owner']);
}

function request(url, cf) {
  const req = new Request(url);
  Object.defineProperty(req, 'cf', { value: cf });
  return req;
}

function cidrFetch(pools, requested = []) {
  return async url => {
    const parsed = new URL(url);
    const file = parsed.pathname.split('/').at(-1);
    requested.push(file);
    const body = Object.hasOwn(pools, file) ? pools[file] : '';
    return { ok: true, async text() { return body; } };
  };
}

test('detects China Telecom, China Mobile and China Unicom from metadata', () => {
  const { 识别运营商 } = loadHelpers(async () => { throw new Error('not used'); });
  assert.equal(识别运营商({ cf: { country: 'CN', asOrganization: 'CHINANET', asn: 0 } }), 'ct');
  assert.equal(识别运营商({ cf: { country: 'CN', asOrganization: 'unknown', asn: 9808 } }), 'cmcc');
  assert.equal(识别运营商({ cf: { country: 'CN', asOrganization: 'China Unicom', asn: 0 } }), 'cu');
  assert.equal(识别运营商({ cf: { country: 'US', asOrganization: 'China Telecom', asn: 4134 } }), 'cf');
});

test('unknown Mainland carrier uses the combined China carrier pool', async () => {
  const files = [];
  const { 生成随机IP } = loadHelpers(cidrFetch({
    'ct.txt': '11.22.0.0/16',
    'cu.txt': '22.33.0.0/16',
    'cmcc.txt': '33.44.0.0/16',
  }, files));
  const [ips, text] = await 生成随机IP(request('https://example.test/sub', {
    country: 'CN', asn: 99999, asOrganization: 'Regional Broadband',
  }), 8, 443);
  assert.deepEqual(files.sort(), ['cmcc.txt', 'ct.txt', 'cu.txt']);
  assert.equal(ips.length, 8);
  assert.equal(text.split('\n').length, 8);
  for (const line of ips) {
    assert.match(line, /#CF大陆汇总优选\d+$/);
    assert.match(line, /^(11\.22|22\.33|33\.44)\.\d+\.\d+:443#/);
  }
});

test('cnIspCode override requests only the selected carrier list', async () => {
  const files = [];
  const { 生成随机IP } = loadHelpers(cidrFetch({ 'ct.txt': '12.34.0.0/16' }, files));
  const [ips] = await 生成随机IP(request('https://example.test/sub?cnIspCode=ct', {
    country: 'US', asn: 0, asOrganization: 'unknown',
  }), 2, 2053);
  assert.deepEqual(files, ['ct.txt']);
  assert.ok(ips.every(line => /^12\.34\.\d+\.\d+:2053#CF电信优选/.test(line)));
});

test('falls back safely when the CIDR source is empty or malformed', async () => {
  for (const body of ['', 'garbage,999.1.1.1/24,192.0.2.1/33']) {
    const { 生成随机IP } = loadHelpers(cidrFetch({ 'CF-CIDR.txt': body }));
    const [ips] = await 生成随机IP(request('https://example.test/sub?cnIspCode=cf', {
      country: 'US', asn: 0, asOrganization: 'unknown',
    }), 3, 443);
    assert.equal(ips.length, 3);
    assert.ok(ips.every(line => /^104\.(1[6-9]|2[0-3])\.\d+\.\d+:443#CF官方回退\d+$/.test(line)));
  }
});

test('ignores invalid CIDRs and uses valid entries in the same source', async () => {
  const { 生成随机IP } = loadHelpers(cidrFetch({ 'cmcc.txt': 'bad,256.0.0.0/24,44.55.0.0/16' }));
  const [ips] = await 生成随机IP(request('https://example.test/sub?cnIspCode=cmcc', {
    country: 'CN', asn: 9808, asOrganization: 'CMCC',
  }), 4, 8443);
  assert.ok(ips.every(line => /^44\.55\.\d+\.\d+:8443#CF移动优选/.test(line)));
});
