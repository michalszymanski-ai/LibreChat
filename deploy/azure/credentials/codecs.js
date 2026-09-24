const crypto = require('node:crypto');

/** Hex-decodes a credential and checks its byte length, mirroring LibreChat's `CREDS_*` format. */
function readCredential(name, bytes, env = process.env) {
  const value = env[name] ?? '';
  const buffer = Buffer.from(value, 'hex');
  if (buffer.length !== bytes || buffer.toString('hex') !== value.toLowerCase()) {
    throw new Error(`${name} must be ${bytes * 2} hex characters`);
  }
  return buffer;
}

function readCredentialPair(prefix, env = process.env) {
  return {
    key: readCredential(`${prefix}CREDS_KEY`, 32, env),
    iv: readCredential(`${prefix}CREDS_IV`, 16, env),
  };
}

const cbcDecrypt = (key, iv, hex) => {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString(
    'utf8',
  );
};

const cbcEncrypt = (key, iv, text) => {
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('hex');
};

/**
 * Byte-compatible with packages/data-schemas/src/crypto: v1 is AES-256-CBC with the fixed
 * CREDS_IV, v2 prefixes a random CBC IV (`iv:cipher`), v3 is AES-256-CTR (`v3:iv:cipher`).
 */
const codecs = {
  v1: {
    matches: (value) => /^[0-9a-f]+$/.test(value) && value.length % 32 === 0,
    decrypt: (creds, value) => cbcDecrypt(creds.key, creds.iv, value),
    encrypt: (creds, text) => cbcEncrypt(creds.key, creds.iv, text),
  },
  v2: {
    matches: (value) => /^[0-9a-f]{32}:[0-9a-f]+$/.test(value),
    decrypt: (creds, value) => {
      const [iv, cipherHex] = value.split(':');
      return cbcDecrypt(creds.key, Buffer.from(iv, 'hex'), cipherHex);
    },
    encrypt: (creds, text) => {
      const iv = crypto.randomBytes(16);
      return `${iv.toString('hex')}:${cbcEncrypt(creds.key, iv, text)}`;
    },
  },
  v3: {
    matches: (value) => /^v3:[0-9a-f]{32}:[0-9a-f]*$/.test(value),
    decrypt: (creds, value) => {
      const [, iv, cipherHex] = value.split(':');
      const decipher = crypto.createDecipheriv('aes-256-ctr', creds.key, Buffer.from(iv, 'hex'));
      return Buffer.concat([
        decipher.update(Buffer.from(cipherHex, 'hex')),
        decipher.final(),
      ]).toString('utf8');
    },
    encrypt: (creds, text) => {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-ctr', creds.key, iv);
      const cipherHex = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString(
        'hex',
      );
      return `v3:${iv.toString('hex')}:${cipherHex}`;
    },
  },
};

const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const REPLACEMENT_CHARACTER = 0xfffd;

/** Rejects C0 controls (other than whitespace) and U+FFFD, the signatures of a wrong-key decrypt. */
const isReadableCodePoint = (codePoint) =>
  codePoint === TAB ||
  codePoint === LINE_FEED ||
  codePoint === CARRIAGE_RETURN ||
  (codePoint >= 0x20 && codePoint !== REPLACEMENT_CHARACTER);

const validators = {
  text: (text) =>
    text.length > 0 && [...text].every((char) => isReadableCodePoint(char.codePointAt(0))),
  json: (text) => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  },
  base32: (text) => /^[A-Z2-7]+=*$/.test(text),
};

/**
 * Decides which credential pair a ciphertext belongs to. Both pairs are tried because a wrong CBC
 * key occasionally yields valid padding and CTR never fails; the validator rejects such garbage.
 */
function classify(codec, value, validate, creds) {
  const attempt = (pair) => {
    try {
      const text = codec.decrypt(pair, value);
      return validate(text) ? text : undefined;
    } catch {
      return undefined;
    }
  };
  const underOld = attempt(creds.old);
  const underNew = attempt(creds.new);
  if (underOld !== undefined && underNew === undefined) {
    return { state: 'old', plaintext: underOld };
  }
  if (underNew !== undefined && underOld === undefined) {
    return { state: 'new' };
  }
  return { state: underOld === undefined ? 'unreadable' : 'ambiguous' };
}

module.exports = { codecs, validators, classify, readCredentialPair };
