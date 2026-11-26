# TQ-9 IPv6 addresses lose compression and endpoint scopes

- **Status** — **Fixed and verified 2026-11-27** (built; `test-zun-ipv6-format.js` passes, gate green).
- **Severity** — Low, security-relevant for applications that compare peer address strings against access rules.
- **Found by / date** — Parity harness, 2026-11-26. Reproduced on 2026-11-27.

## Symptom

With zun snapshot `ffd9f0b`, the same Linux socket addresses produce different strings from Node v26.13.1. The new regression doubles as the reproducer. The private network namespace provides the synthetic addresses on loopback and confines the test to local traffic.

```sh
test_file=test/js/node/test/parallel/test-zun-ipv6-format.js
snapshot=/home/fak3/.t3/projects/zun/build/snap-ffd9f0b/zun-debug
unshare --user --map-root-user --net sh -c '
    ip link set lo up &&
    ip -6 addr add fe80::1/64 dev lo nodad &&
    ip -6 addr add 2001:db8:0:0:0:1:0:1/128 dev lo nodad || exit
    export ZUN_TEST_IPV6_NAMESPACE=1 BUN_DEBUG_QUIET_LOGS=1
    node "$1"
    printf "Node exit %s\n" "$?"
    "$2" "$1"
    printf "zun exit %s\n" "$?"
' sh "$test_file" "$snapshot"
```

Node exited 0. The snapshot exited 1 with `ERR_ASSERTION` and these differences.

| Observation | Node v26.13.1 | zun `ffd9f0b` |
| --- | --- | --- |
| TCP listener and both connected endpoints on `::1` | `::1` | `0:0:0:0:0:0:0:1` |
| TCP listener on `::` | `::` | `0:0:0:0:0:0:0:0` |
| TCP listener on `::ffff:127.0.0.1` and both connected endpoints of an IPv4 connection to a dual-stack listener | `::ffff:127.0.0.1` | `0:0:0:0:0:ffff:7f00:1` |
| TCP listener and both connected endpoints on `fe80::1%lo` | `fe80::1%lo` | `fe80:0:0:0:0:0:1` |
| TCP listener on `2001:db8:0:0:0:1:0:1` | `2001:db8::1:0:1` | `2001:db8:0:0:0:1:0:1` |
| IPv6 `dns.lookup('localhost')` | `::1` | `0:0:0:0:0:0:0:1` |
| `os.networkInterfaces().lo` link-local address, CIDR, netmask, and scopeid | `fe80::1`, `fe80::1/64`, `ffff:ffff:ffff:ffff::`, `1` | `fe80:0:0:0:0:0:1`, `fe80:0:0:0:0:0:1/64`, `ffff:ffff:ffff:ffff:0:0:0:0`, `1` |
| UDP `address()` and `remoteAddress()` for `fe80::1%lo` | `fe80::1%lo` | `fe80::1` |

The last row is independent of the UDP message callback. A separate send to the same local address produced `rinfo.address === 'fe80::1%lo'` on both runtimes.

[parity.json](../status/parity.json) records all seven tests in the [TQ-9 cluster](../status/parity.md) as `FAIL`.

| Test directory | Tests |
| --- | --- |
| `node/sequential` | `test-net-server-address.js`, `test-net-server-bind.js`, `test-net-better-error-messages-port.js` |
| `node/parallel` | `test-net-remote-address-port.js`, `test-net-dns-lookup.js`, `test-dns-resolveany.js`, `test-dgram-udp6-link-local-address.js` |

The saved `build/parity/r2a/results.json` shows that the UDP test builds its expected scoped string from the expanded OS interface address and then receives the already-compressed string. The DNS tests expose `0:0:0:0:0:0:0:42` and `0:0:0:0:0:0:0:1`. The server tests expose both loopback and wildcard expansion. The remote-address test fails its accepted-string membership check, and the direct reproduction above isolates the wrong peer strings.

## Root cause

There are two independent mechanisms.

1. **Text conversion.** Before the patch, [bzrt_compat.zig:587](../../src/bun_core/bzrt_compat.zig) wrote all eight big-endian 16-bit groups with hexadecimal formatting and colons. It had no longest-zero-run selection or mapped IPv4 branch. `bun.fmt.formatIp` removed the brackets and port from that result. DNS's `addressToString` did the same by slicing independently. Both history searches identify root commit `a1c009d4a3de70596caceb290f3955655a68cca9` (`bzrt: strip Bun 1.3.14 to thin zig 0.16 runtime (WIP)`).

   ```sh
   git log -S 'pub const NetAddress = extern union' -- src/bun_core/bzrt_compat.zig
   git log -S 'while (i < 16) : (i += 2)' -- src/bun_core/bzrt_compat.zig
   ```

   The read-only Bun 1.3.14 checkout at `0d9b296af33f2b851fcbf4df3e9ec89751734ba4` uses `std.net.Address.format` in both paths. Its pinned Oven Zig `04e7f6ac1e009525bc00934f20199c68f04e0a24` already selected the longest run of two or more zero groups and emitted dotted-decimal IPv4-mapped tails. The Zig 0.16 port required replacing the old API. Cruller's replacement dropped those behaviors. Zig 0.16.0 and 0.17.1 both already compress the test addresses under `std.Io.net.Ip6Address.format`. [Bun 1.3.14 formatter](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/bun_core/fmt.zig#L1361), [Bun's pinned Zig formatter](https://github.com/oven-sh/zig/blob/04e7f6ac1e009525bc00934f20199c68f04e0a24/lib/std/net.zig#L676).

2. **Scope loss.** The TCP listener and peer getters copied only the address bytes through uSockets and passed `scope_id = 0` into `NetAddress.initIp6`. UDP's endpoint getters also used byte-only accessors. The same byte-only paths are present in Bun 1.3.14 and entered this repository in `a1c009d`. `os.networkInterfaces()` carries the numeric scope from the original `sockaddr_in6`, and Node also returns bare interface addresses and a separate `scopeid`. Node's TCP and UDP endpoint conversion adds `%iface` for link-local IPv6 with a nonzero scope. [Bun 1.3.14 listener](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/runtime/socket/Listener.zig#L886), [Node endpoint conversion](https://github.com/nodejs/node/blob/v26.13.1/src/tcp_wrap.cc), [Node interface conversion](https://github.com/nodejs/node/blob/v26.13.1/src/node_os.cc).

## Why it wasn't caught

The 0.17 checkpoint covered build and runtime smoke tests. It had no exact IPv6 address assertions. Bun's vendored Node tests do assert the strings. The parity harness recorded the failures, and earlier CommonJS runs were unreliable because the launcher could swallow assertion failures. Scoped cases also require a configured link-local address. [0.17 checkpoint](../status/zig-017.md), [parity run notes](../status/parity.md), [RT-2 RCA](RT-2-cjs-entry-errors-swallowed.md).

## Fix

- [`NetAddress.formatHost`](../../src/bun_core/bzrt_compat.zig) calls the already-linked `ares_inet_ntop` with the original network-order bytes and a bounded buffer. The vendored formatter and Node's libuv formatter use the same zero-run and embedded IPv4 rules, including the first run on ties. `NetAddress.format` adds brackets and the port when requested. [Node's vendored libuv formatter](https://github.com/nodejs/node/blob/v26.13.1/deps/uv/src/inet.c).
- [`formatIp`](../../src/bun_core/fmt.zig) writes just the host for OS interfaces, DNS, and WebSocket presentation. The OS code adds the CIDR suffix immediately after the rendered host and reports the numeric scope separately.
- [`NetAddress.fromSocket`](../../src/bun_core/bzrt_compat.zig) captures a full IP sockaddr from `getsockname` or `getpeername`, with family and length checks before reading it. TCP and UDP use [`formatScopedIp`](../../src/bun_core/fmt.zig) to retain the kernel scope for link-local endpoints. The formatter uses the existing UDP convention of falling back to the numeric index when libc cannot find the interface name. Node raises an error in that lookup-failure case.
- Zig 0.17.1 `ast-check` passed for the changed Zig files. Clang `-fsyntax-only` passed for the uSockets change with the recorded build flags. An isolated Zig check exercised the patched formatter with system c-ares and verified a scoped sockaddr from the kernel. The integrated zun binary still needs a build and regression run.

## Regression test

[`test-zun-ipv6-format.js`](../../test/js/node/test/parallel/test-zun-ipv6-format.js) exercises TCP listener output and both addresses on the accepted socket, IPv4, IPv4-mapped IPv6, OS output, and DNS lookup on an ordinary IPv6 loopback system. The optional namespace mode adds both synthetic addresses and tests the scoped TCP and UDP endpoint strings alongside the numeric OS scope. Both modes passed on Node v26.13.1 and failed on snapshot `ffd9f0b` with exit 1. A pass on the patched runtime is pending.

## Sibling search

Searched with `rg -n 'formatIp|NetAddress|ares_inet_ntop|inet_ntop|scope_id' src` and for the uSockets byte-only getters in `src/uws_sys` and `packages/bun-usockets`.

- `Listener.zig`, `socket.zig`, and `udp_socket.zig` now read complete endpoint sockaddrs. `node_os.zig` and `dns/dns.zig` share the host formatter. This covers DNS paths such as `resolveAny`'s AAAA records that use `addressToJS`. The OS change addresses the input to the existing scoped UDP message assertion.
- `ServerWebSocket.zig` gets canonical text through `formatIp`. Its Bun-specific getter still receives raw bytes from uWebSockets, so the inherited lack of scope metadata there remains open.
- `SocketAddress.zig`, other DNS response paths, and TLS IP formatting have separate address formatters. UDP message receive already reads the peer scope directly. None used the eight-group shim for those paths.

## Lessons

[The Zig probe](../zig/probes/ipv6-format/format.zig) passed on Zig 0.16.0 and 0.17.1. Normal std formatting omits scope, and the 0.17 formatter spells the well-known NAT64 prefix with a dotted tail where Node's formatter uses hex. The Linux threaded backend panics when asked to resolve an interface index through `formatResolved` on both tested toolchains. Use a formatter chosen for the JS API's text contract and exercise kernel scope retrieval separately. [Lessons log](../zig/lessons.md).
