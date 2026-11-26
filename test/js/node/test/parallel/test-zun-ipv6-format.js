'use strict';

const common = require('../common');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { lookup } = require('node:dns').promises;
const { once } = require('node:events');
const net = require('node:net');
const os = require('node:os');

if (!common.hasIPv6) common.skip('no IPv6 loopback');

// The optional namespace setup in the TQ-9 RCA assigns these addresses to lo.
const scoped = process.env.ZUN_TEST_IPV6_NAMESPACE === '1';
const listenCases = {
  '::1': '::1',
  '::': '::',
  '::ffff:127.0.0.1': '::ffff:127.0.0.1',
  '127.0.0.1': '127.0.0.1',
};
if (scoped) {
  listenCases['fe80::1%lo'] = 'fe80::1%lo';
  listenCases['2001:db8:0:0:0:1:0:1'] = '2001:db8::1:0:1';
}
const connectCases = {
  '::': ['127.0.0.1', '::ffff:127.0.0.1'],
  '::1': ['::1', '::1'],
  'fe80::1%lo': ['fe80::1%lo', 'fe80::1%lo'],
};

async function endpoint(host, clientHost) {
  let local;
  let peer;
  const server = net.createServer((socket) => {
    local = socket.localAddress;
    peer = socket.remoteAddress;
    socket.end();
  });
  try {
    await once(server.listen(0, host), 'listening');
    const address = server.address();
    if (clientHost) await once(net.connect(address.port, clientHost), 'close');
    return { address: address.address, local, peer };
  } finally {
    server.close();
  }
}

async function udpEndpoint(host) {
  const server = dgram.createSocket('udp6');
  const client = dgram.createSocket('udp6');
  try {
    await once(server.bind(0, host), 'listening');
    const bound = server.address();
    const connected = once(client, 'connect');
    client.connect(bound.port, host);
    await connected;
    return [bound.address, client.remoteAddress().address];
  } finally {
    server.close();
    client.close();
  }
}

async function main() {
  const actual = {};
  const expected = {};
  for (const [host, address] of Object.entries(listenCases)) {
    const [client, connectedAddress] = connectCases[host] ?? [];
    actual[host] = await endpoint(host, client);
    expected[host] = { address, local: connectedAddress, peer: connectedAddress };
  }

  actual.lookup = (await lookup('localhost', { family: 6 })).address;
  expected.lookup = '::1';

  const interfaces = Object.values(os.networkInterfaces()).flat();
  const loopbacks = interfaces.filter((entry) => entry.internal && entry.family === 'IPv6' && entry.scopeid === 0);
  const loopback = loopbacks.find((entry) => entry.address === '::1');
  actual.loopback = loopback ? [loopback.address, loopback.cidr] : loopbacks.map((entry) => entry.cidr);
  expected.loopback = ['::1', '::1/128'];

  if (scoped) {
    const linkLocal = os.networkInterfaces().lo.find((entry) => entry.scopeid !== undefined && entry.scopeid !== 0);
    actual.linkLocal = [linkLocal.address, linkLocal.cidr, linkLocal.netmask, linkLocal.scopeid];
    expected.linkLocal = ['fe80::1', 'fe80::1/64', 'ffff:ffff:ffff:ffff::', 1];
    actual.udp = await udpEndpoint('fe80::1%lo');
    expected.udp = ['fe80::1%lo', 'fe80::1%lo'];
  }

  assert.deepStrictEqual(actual, expected);
}

main().then(common.mustCall()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
