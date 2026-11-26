// H5 standalone parser harness: drives uWS::HttpParser::consumePostPadded directly (no zun build).
// From the repo root:
//   clang++ -std=c++20 -O1 -g -fsanitize=address,undefined -DNEW \
//     -Ipackages/bun-uws/src -Ipackages/bun-usockets/src docs/rca/H5/parser-harness.cpp -o /tmp/h5 && /tmp/h5
// Drop -DNEW to build against pre-backport headers (no sawConnectionClose member).
// Expected output with the backport is in docs/rca/H5-serve-http1-smuggling.md.
#include <cstdio>
#include <cstdint>
#include <string>
#include <vector>
extern "C" size_t BUN_DEFAULT_MAX_HTTP_HEADER_SIZE = 16384;
extern "C" int16_t Bun__HTTPMethod__from(const char *str, size_t len) { return 1; }
#include "HttpParser.h"
using namespace uWS;
struct P : HttpParser {};
// Feed `chunks` (each one read) and report dispatches/body/error.
static std::string run(std::vector<std::string> chunks) {
  P p; bool isConnect = false; std::string out; int dummy;
  for (auto &c : chunks) {
    std::string buf = c; buf.append(64, '\0');
    auto r = p.consumePostPadded(0, isConnect, true, false, buf.data(), (unsigned)c.size(), &dummy, nullptr,
      [&](void *u, HttpRequest *req) -> void * { out += "[REQ " + std::string(req->getUrl()) + "]"; return u; },
      [&](void *u, std::string_view d, bool fin) -> void * { if (d.size()) out += "<" + std::string(d) + ">"; if (fin) out += "{fin}"; return u; });
    if (r.isError()) { out += "ERR status=" + std::to_string(r.httpErrorStatusCode()) + " code=" + std::to_string(r.parserError); return out; }
  }
#ifdef NEW
  if (p.sawConnectionClose) out += " (close-latched)";
#endif
  return out;
}
#define T(name, ...) printf("%-40s %s\n", name, run({__VA_ARGS__}).c_str())
int main() {
  std::string H = "Host: x\r\n";
  T("valid chunked", "POST /a HTTP/1.1\r\n" + H + "Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n");
  T("TE chunked, (trailing comma)", "POST /a HTTP/1.1\r\n" + H + "Transfer-Encoding: chunked,\r\n\r\n5\r\nhello\r\n0\r\n\r\n");
  T("TE gzip, chunked", "POST /a HTTP/1.1\r\n" + H + "Transfer-Encoding: gzip, chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n");
  T("TE gzip + TE chunked fields", "POST /a HTTP/1.1\r\n" + H + "Transfer-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n");
  T("TE chunked, chunked", "POST /a HTTP/1.1\r\n" + H + "Transfer-Encoding: chunked, chunked\r\n\r\n0\r\n\r\n");
  T("TE empty + CL (CL.TE)", "POST /a HTTP/1.1\r\n" + H + "Transfer-Encoding: \r\nContent-Length: 4\r\n\r\nABCDGET /admin HTTP/1.1\r\nHost: x\r\n\r\n");
  T("TE empty only", "POST /a HTTP/1.1\r\n" + H + "Transfer-Encoding: \r\n\r\nGET /admin HTTP/1.1\r\nHost: x\r\n\r\n");
  T("TE empty field then chunked", "POST /a HTTP/1.1\r\n" + H + "Transfer-Encoding:\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\nGET /after HTTP/1.1\r\nHost: x\r\n\r\n");
  T("HTTP/1.0 + TE chunked", "POST /a HTTP/1.0\r\n" + H + "Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n");
  T("trailer field after 0-chunk", "POST /a HTTP/1.1\r\n" + H + "Transfer-Encoding: chunked\r\n\r\n0\r\nX: y\r\n\r\n");
  std::string ext(17000, 'e');
  T("chunk ext 17000 B (one read)", "POST /a HTTP/1.1\r\n" + H + "Transfer-Encoding: chunked\r\n\r\n2;" + ext + "\r\nhi\r\n0\r\n\r\n");
  T("chunk ext 17000 B (split reads)", "POST /a HTTP/1.1\r\n" + H + "Transfer-Encoding: chunked\r\n\r\n2;" + ext.substr(0, 9000), ext.substr(9000) + "\r\nhi\r\n0\r\n\r\n");
  std::string small; for (int i = 0; i < 10; i++) small += "1;" + std::string(8000, 'e') + "\r\nx\r\n";
  T("10 chunks x 8000 B ext (per-chunk cap)", "POST /a HTTP/1.1\r\n" + H + "Transfer-Encoding: chunked\r\n\r\n" + small + "0\r\n\r\n");
  T("pipelined after Connection: close", "GET /a HTTP/1.1\r\n" + H + "Connection: close\r\n\r\nGET /b HTTP/1.1\r\n" + H + "\r\n");
  T("pipelined after keep-alive, close", "GET /a HTTP/1.1\r\n" + H + "Connection: keep-alive, Close\r\n\r\nGET /b HTTP/1.1\r\n" + H + "\r\n");
  T("pipelined after Connection: close (2nd read)", "GET /a HTTP/1.1\r\n" + H + "Connection: close\r\n\r\n", "GET /b HTTP/1.1\r\n" + H + "\r\n");
  T("pipelined after HTTP/1.0", "GET /a HTTP/1.0\r\n\r\nGET /b HTTP/1.1\r\n" + H + "\r\n");
  T("close-flagged POST body then pipelined", "POST /a HTTP/1.1\r\n" + H + "Connection: close\r\nContent-Length: 3\r\n\r\nabcGET /b HTTP/1.1\r\n" + H + "\r\n");
  T("Connection: nope! (5 bytes) pipelined", "GET /a HTTP/1.1\r\n" + H + "Connection: nope!\r\n\r\nGET /b HTTP/1.1\r\n" + H + "\r\n");
  T("keep-alive pipelining", "GET /a HTTP/1.1\r\n" + H + "\r\nGET /b HTTP/1.1\r\n" + H + "\r\n");
  T("TE whitespace around chunked", "POST /a HTTP/1.1\r\n" + H + "Transfer-Encoding: \tchunked \r\n\r\n5\r\nHello\r\n0\r\n\r\n");
}
