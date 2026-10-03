#!/usr/bin/env sh
# Regenerates the TEST-ONLY certificate chain used by test/verify.test.js.
# These keys protect nothing: the tests pass this root in as the only trusted root.
set -eu
cd "$(dirname "$0")"
DAYS=36500

cat > ca.ext <<'X'
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
X
cat > not-ca.ext <<'X'
basicConstraints = critical, CA:FALSE
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
X
cat > leaf.ext <<'X'
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
subjectAltName = DNS:echo-api.amazon.com
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
X
cat > leaf-wrong-san.ext <<'X'
basicConstraints = critical, CA:FALSE
subjectAltName = DNS:not-echo-api.example.com
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
X

key() { openssl genrsa -out "$1.key" 2048 2>/dev/null; }
sign() { # name subject issuer ext
  openssl req -new -key "$1.key" -subj "$2" -out "$1.csr" 2>/dev/null
  openssl x509 -req -in "$1.csr" -CA "$3.pem" -CAkey "$3.key" -CAcreateserial \
    -days $DAYS -sha256 -extfile "$4" -out "$1.pem" 2>/dev/null
}

key test-root
openssl req -x509 -new -key test-root.key -subj "/CN=Test Root CA" -days $DAYS -sha256 \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out test-root.pem 2>/dev/null

key test-intermediate; sign test-intermediate "/CN=Test Intermediate CA" test-root ca.ext
key test-leaf;         sign test-leaf "/CN=echo-api.amazon.com" test-intermediate leaf.ext
key test-leaf-wrong-san; sign test-leaf-wrong-san "/CN=not-echo-api.example.com" test-intermediate leaf-wrong-san.ext
key test-not-ca;       sign test-not-ca "/CN=Not A CA" test-root not-ca.ext
key test-leaf-under-not-ca; sign test-leaf-under-not-ca "/CN=echo-api.amazon.com" test-not-ca leaf.ext

cat test-leaf.pem test-intermediate.pem > chain-valid.pem
cat test-leaf-wrong-san.pem test-intermediate.pem > chain-wrong-san.pem
cat test-leaf.pem > chain-missing-intermediate.pem
cat test-leaf-under-not-ca.pem test-not-ca.pem > chain-not-ca-issuer.pem

# Keep only what the tests read.
cp test-leaf.key signing-key.pem
cp test-leaf-wrong-san.key other-key.pem
rm -f ./*.csr ./*.srl ./*.ext test-*.key test-intermediate.pem test-leaf*.pem test-not-ca.pem
