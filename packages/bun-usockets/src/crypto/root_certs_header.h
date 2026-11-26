#include <openssl/pem.h>
#include <openssl/x509.h>

#ifdef __cplusplus
#define CPPDECL extern "C"

STACK_OF(X509) *us_get_root_extra_cert_instances();
STACK_OF(X509) *us_get_root_system_cert_instances();

#else
#define CPPDECL extern
#endif

CPPDECL X509_STORE *us_get_default_ca_store();
CPPDECL X509_STORE *us_get_shared_default_ca_store();

// blocked_spkis.cpp (zun security C2, from Bun 1.4.5)
// After X509_verify_cert: X509_V_OK, or the error of a chain that holds a blocked public key.
CPPDECL int us_x509_store_ctx_blocked_key_error(X509_STORE_CTX *ctx);
CPPDECL void us_add_blocked_spki_for_testing(const uint8_t *hash);
CPPDECL void us_clear_blocked_spkis_for_testing();
