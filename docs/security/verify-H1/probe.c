// Build: cc -I<patched picohttpparser dir> probe.c <dir>/picohttpparser.c -o probe  (prints decoder states per EOF point)
#include <stdio.h>
#include <string.h>
#include <stddef.h>
#include "picohttpparser.h"
static void run(const char *name, const char *in) {
  struct phr_chunked_decoder d; memset(&d, 0, sizeof d); d.consume_trailer = 1;
  char buf[256]; size_t n = strlen(in); memcpy(buf, in, n);
  ssize_t r = phr_decode_chunked(&d, buf, &n);
  printf("%-40s ret=%zd state=%d in_trailers=%d\n", name, r, d._state, phr_decode_chunked_is_in_trailers(&d));
}
int main(void) {
  printf("offsets: bytes_left=%zu consume_trailer=%zu _hex_count=%zu _state=%zu _total_read=%zu _total_overhead=%zu size=%zu align=%zu\n",
    offsetof(struct phr_chunked_decoder, bytes_left_in_chunk), offsetof(struct phr_chunked_decoder, consume_trailer),
    offsetof(struct phr_chunked_decoder, _hex_count), offsetof(struct phr_chunked_decoder, _state),
    offsetof(struct phr_chunked_decoder, _total_read), offsetof(struct phr_chunked_decoder, _total_overhead),
    sizeof(struct phr_chunked_decoder), _Alignof(struct phr_chunked_decoder));
  run("mid chunk '5\\r\\nhel'", "5\r\nhel");
  run("after data '5\\r\\nhello'", "5\r\nhello");
  run("inside CRLF '5\\r\\nhello\\r'", "5\r\nhello\r");
  run("before terminal '5\\r\\nhello\\r\\n'", "5\r\nhello\r\n");
  run("in trailers '...0\\r\\nX-T'", "5\r\nhello\r\n0\r\nX-T");
  run("bare LF terminator", "5\r\nhello\r\n0\r\n\n");
  run("CR CR LF terminator", "5\r\nhello\r\n0\r\n\r\r\n");
  run("surplus after terminator", "5\r\nhello\r\n0\r\n\r\nGARBAGE");
  return 0;
}
