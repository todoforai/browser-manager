import crypto from 'crypto';
import nacl from 'tweetnacl';

const HASH_LEN = 32;
const TAG_LEN = 16;
const NONCE_LEN = 12;
const PROTOCOL_NAME = Buffer.from('Noise_NX_25519_ChaChaPoly_BLAKE2s');

export interface KeyPair {
    secretKey: Buffer;
    publicKey: Buffer;
}

export interface CipherState {
    key: Buffer | null;
    nonce: bigint;
}

interface SymmetricState {
    ck: Buffer;
    h: Buffer;
    cipher: CipherState;
}

export interface HandshakeState {
    symmetric: SymmetricState;
    s?: KeyPair;
    e: KeyPair | null;
    rs: Buffer;
    re: Buffer | null;
    messageIndex: number;
    complete: boolean;
}

export interface TransportState {
    send: CipherState;
    recv: CipherState;
}

export function keypairFromSecret(secretKey: Buffer): KeyPair {
    if (secretKey.length !== 32) throw new Error('secret key must be 32 bytes');
    return { secretKey: Buffer.from(secretKey), publicKey: Buffer.from(nacl.scalarMult.base(secretKey)) };
}

export function hexToBytes(hex: string): Buffer {
    const value = hex.trim();
    if (value.length !== 64 || !/^[0-9a-f]+$/i.test(value)) throw new Error('expected 32-byte hex key');
    return Buffer.from(value, 'hex');
}

function hash(parts: Uint8Array[]): Buffer {
    const h = crypto.createHash('blake2s256');
    for (const part of parts) h.update(part);
    return h.digest();
}

function hmac(key: Uint8Array, data: Uint8Array[]): Buffer {
    const h = crypto.createHmac('blake2s256', key);
    for (const part of data) h.update(part);
    return h.digest();
}

function hkdf2(chainingKey: Buffer, ikm: Uint8Array): [Buffer, Buffer] {
    const prk = hmac(chainingKey, [ikm]);
    const out1 = hmac(prk, [Buffer.from([0x01])]);
    const out2 = hmac(prk, [out1, Buffer.from([0x02])]);
    return [out1, out2];
}

function nonceBytes(nonce: bigint): Buffer {
    const out = Buffer.alloc(NONCE_LEN);
    out.writeBigUInt64LE(nonce, 4);
    return out;
}

function dh(secretKey: Buffer, publicKey: Buffer): Buffer {
    return Buffer.from(nacl.scalarMult(secretKey, publicKey));
}

function encrypt(key: Buffer, nonce: bigint, ad: Buffer, plaintext: Buffer): Buffer {
    const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonceBytes(nonce), { authTagLength: TAG_LEN });
    cipher.setAAD(ad, { plaintextLength: plaintext.length });
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([ct, cipher.getAuthTag()]);
}

function decrypt(key: Buffer, nonce: bigint, ad: Buffer, ciphertext: Buffer): Buffer {
    if (ciphertext.length < TAG_LEN) throw new Error('ciphertext too short');
    const body = ciphertext.subarray(0, -TAG_LEN);
    const tag = ciphertext.subarray(-TAG_LEN);
    const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonceBytes(nonce), { authTagLength: TAG_LEN });
    decipher.setAAD(ad, { plaintextLength: body.length });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
}

function cipherState(key: Buffer | null = null): CipherState {
    return { key, nonce: 0n };
}

function encryptWithAd(state: CipherState, ad: Buffer, plaintext: Buffer): Buffer {
    if (!state.key) return Buffer.from(plaintext);
    const out = encrypt(state.key, state.nonce, ad, plaintext);
    state.nonce += 1n;
    return out;
}

function decryptWithAd(state: CipherState, ad: Buffer, ciphertext: Buffer): Buffer {
    if (!state.key) return Buffer.from(ciphertext);
    const out = decrypt(state.key, state.nonce, ad, ciphertext);
    state.nonce += 1n;
    return out;
}

function symmetricState(): SymmetricState {
    const h = PROTOCOL_NAME.length <= HASH_LEN ? Buffer.concat([PROTOCOL_NAME, Buffer.alloc(HASH_LEN - PROTOCOL_NAME.length)]) : hash([PROTOCOL_NAME]);
    return { ck: Buffer.from(h), h, cipher: cipherState() };
}

function mixHash(state: SymmetricState, data: Buffer): void {
    state.h = hash([state.h, data]);
}

function mixKey(state: SymmetricState, ikm: Buffer): void {
    const [ck, tempK] = hkdf2(state.ck, ikm);
    state.ck = ck;
    state.cipher = cipherState(tempK);
}

function encryptAndHash(state: SymmetricState, plaintext: Buffer): Buffer {
    const out = encryptWithAd(state.cipher, state.h, plaintext);
    mixHash(state, out);
    return out;
}

function decryptAndHash(state: SymmetricState, ciphertext: Buffer): Buffer {
    const out = decryptWithAd(state.cipher, state.h, ciphertext);
    mixHash(state, ciphertext);
    return out;
}

function split(state: SymmetricState): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(state.ck, Buffer.alloc(0));
    return [cipherState(k1), cipherState(k2)];
}

export function initiatorHandshake(remoteStatic: Buffer): HandshakeState {
    return { symmetric: symmetricState(), e: null, rs: remoteStatic, re: null, messageIndex: 0, complete: false };
}

export function responderHandshake(localStatic: KeyPair): HandshakeState {
    return { symmetric: symmetricState(), s: localStatic, e: null, rs: Buffer.alloc(0), re: null, messageIndex: 0, complete: false };
}

export function writeMessage1(state: HandshakeState, _payload = Buffer.alloc(0)): Buffer {
    if (state.messageIndex !== 0) throw new Error('wrong message index');
    state.e = keypairFromSecret(Buffer.from(nacl.randomBytes(32)));
    mixHash(state.symmetric, state.e.publicKey);
    state.messageIndex = 1;
    return Buffer.from(state.e.publicKey);
}

export function readMessage1(state: HandshakeState, msg: Buffer): Buffer {
    if (state.messageIndex !== 0) throw new Error('wrong message index');
    if (msg.length < 32) throw new Error('truncated handshake message');
    state.re = msg.subarray(0, 32);
    mixHash(state.symmetric, state.re);
    state.messageIndex = 1;
    return Buffer.alloc(0);
}

export function readMessage2(state: HandshakeState, msg: Buffer): Buffer {
    if (state.messageIndex !== 1 || !state.e) throw new Error('wrong message index');
    if (msg.length < 32 + 48 + 16) throw new Error('truncated handshake message');
    let offset = 0;
    state.re = msg.subarray(offset, offset + 32);
    mixHash(state.symmetric, state.re);
    offset += 32;
    mixKey(state.symmetric, dh(state.e.secretKey, state.re));
    const remoteStatic = decryptAndHash(state.symmetric, msg.subarray(offset, offset + 48));
    offset += 48;
    if (!remoteStatic.equals(state.rs)) throw new Error('remote static key mismatch');
    mixKey(state.symmetric, dh(state.e.secretKey, remoteStatic));
    const payload = decryptAndHash(state.symmetric, msg.subarray(offset));
    state.messageIndex = 2;
    state.complete = true;
    return payload;
}

export function writeMessage2(state: HandshakeState, payload = Buffer.alloc(0)): Buffer {
    if (state.messageIndex !== 1 || !state.re) throw new Error('wrong message index');
    if (!state.s) throw new Error('missing responder static key');
    const e = Buffer.from(nacl.randomBytes(32)) as Buffer;
    const ep = Buffer.from(nacl.scalarMult.base(e)) as Buffer;
    const parts = [ep];
    mixHash(state.symmetric, ep);
    mixKey(state.symmetric, dh(e, state.re));
    parts.push(encryptAndHash(state.symmetric, state.s.publicKey));
    mixKey(state.symmetric, dh(state.s.secretKey, state.re));
    parts.push(encryptAndHash(state.symmetric, payload));
    state.messageIndex = 2;
    state.complete = true;
    return Buffer.concat(parts);
}

export function toTransport(state: HandshakeState): TransportState {
    if (!state.complete) throw new Error('handshake not complete');
    // split() returns [initiator→responder, responder→initiator] per Noise spec.
    // Responder sends with k2 and receives with k1.
    const [initToResp, respToInit] = split(state.symmetric);
    return { send: respToInit, recv: initToResp };
}

export function transportRead(state: TransportState, ciphertext: Buffer): Buffer {
    return decryptWithAd(state.recv, Buffer.alloc(0), ciphertext);
}

export function transportWrite(state: TransportState, plaintext: Buffer): Buffer {
    return encryptWithAd(state.send, Buffer.alloc(0), plaintext);
}
