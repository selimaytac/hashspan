// The Rundler release the matrix runs: the signed linux tarball of alchemyplatform/rundler v0.11.0 for the Docker VM's
// architecture (not the host's), checked before its binary goes into the COPY context of docker/rundler.Dockerfile.
//
// The release publishes a tarball and an ASCII-armored detached signature (.asc) per platform and no checksum file, so
// the SHA-256 of each asset is pinned here, as read from the release on 2026-10-21 (they equal the digests the release
// API lists). Every .asc since v0.2.2 names the same issuer key, pinned below. That public key is not published where
// it could be fetched (not in the repository, not on keys.openpgp.org or keyserver.ubuntu.com, not among the GPG keys
// of the release's authors on GitHub), and the release notes name another fingerprint, of 39 hex digits, which no
// .asc carries. So by default a build checks the issuer of the signature against the pin, and the pinned digests do
// the rest; given the key (`--rundler-key <file>`), gpgv also verifies the signature itself and its key must be the
// pinned one.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const RUNDLER_RELEASE = {
  repo: 'https://github.com/alchemyplatform/rundler',
  tag: 'v0.11.0',
  commit: '2a3db23724bc995e3d7fcf7ee270fa2b759612aa',
  /** The issuer of every .asc of the release, from the signature packet's issuer-fingerprint subpacket. */
  signer: {
    fingerprint: '30994DED9E4003FB5BBC15A014D8B18F33C823B0',
    keyId: '14D8B18F33C823B0',
  },
  /** The release's linux assets by the Docker VM's architecture. */
  assets: {
    aarch64: {
      name: 'rundler-v0.11.0-aarch64-unknown-linux-gnu.tar.gz',
      sha256: '3c00812dfc10770d3b7e9ca946e8678927664b65a130a4e47c796380471cfb43',
      ascSha256: '0998e2bf0f68be4a302dcb1cf46adacc92cebd4d340bdf18a94665ee3439d325',
    },
    x86_64: {
      name: 'rundler-v0.11.0-x86_64-unknown-linux-gnu.tar.gz',
      sha256: 'b9d9baf7ee145976aab5c392e3e6de16d6aae2e9126a0b20b10a0acab3d75240',
      ascSha256: '4d819e3188a1788d88ad3a8d768dce0613981975f32ef73d4982513503eb1bf4',
    },
  },
};

/** The asset architecture of a Docker VM architecture (`docker info --format '{{.Architecture}}'`). */
export function rundlerArch(dockerArch) {
  const arch = { aarch64: 'aarch64', arm64: 'aarch64', x86_64: 'x86_64', amd64: 'x86_64' }[
    String(dockerArch).trim()
  ];
  if (!arch) throw new Error(`Rundler ${RUNDLER_RELEASE.tag} has no linux asset for ${dockerArch}`);
  return arch;
}

/** The download URL of a release asset. */
export const assetUrl = (name) =>
  `${RUNDLER_RELEASE.repo}/releases/download/${RUNDLER_RELEASE.tag}/${name}`;

/** SHA-256 of bytes, in hex. */
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Throws unless `bytes` hash to the pinned value. */
export function checkDigest(bytes, pinned, what) {
  if (!/^[0-9a-f]{64}$/.test(pinned)) throw new Error(`${what}: the pin is not a SHA-256 in hex`);
  if (sha256(bytes) !== pinned) throw new Error(`${what} does not match its pinned SHA-256`);
}

/** The bytes of an ASCII-armored OpenPGP block. */
export function dearmor(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const begin = lines.findIndex((l) => /^-----BEGIN PGP SIGNATURE-----$/.test(l));
  const end = lines.findIndex((l) => /^-----END PGP SIGNATURE-----$/.test(l));
  if (begin === -1 || end < begin) throw new Error('not an armored PGP signature');
  let i = begin + 1;
  // Armor headers end at the first empty line.
  while (i < end && lines[i] !== '') i++;
  const body = lines
    .slice(i + 1, end)
    .filter((l) => !l.startsWith('='))
    .join('');
  if (!/^[A-Za-z0-9+/]+=*$/.test(body)) throw new Error('the armored body is not base64');
  return Buffer.from(body, 'base64');
}

/** The tag and body of the first packet of `bytes` (old and new packet formats). */
function firstPacket(bytes) {
  const ctb = bytes[0];
  if (ctb === undefined || (ctb & 0x80) === 0) throw new Error('not an OpenPGP packet');
  let tag;
  let length;
  let offset;
  if (ctb & 0x40) {
    tag = ctb & 0x3f;
    const first = bytes[1];
    if (first < 192) [length, offset] = [first, 2];
    else if (first < 224) [length, offset] = [((first - 192) << 8) + bytes[2] + 192, 3];
    else if (first === 255) [length, offset] = [bytes.readUInt32BE(2), 6];
    else throw new Error('partial packet lengths are not supported');
  } else {
    tag = (ctb >> 2) & 0x0f;
    const type = ctb & 0x03;
    if (type === 0) [length, offset] = [bytes[1], 2];
    else if (type === 1) [length, offset] = [bytes.readUInt16BE(1), 3];
    else if (type === 2) [length, offset] = [bytes.readUInt32BE(1), 5];
    else throw new Error('indeterminate packet lengths are not supported');
  }
  if (offset + length > bytes.length) throw new Error('the packet is cut short');
  return { tag, body: bytes.subarray(offset, offset + length) };
}

/** The subpackets of one subpacket area, as `{ type, data }`. */
function subpackets(area) {
  const out = [];
  let i = 0;
  while (i < area.length) {
    let length;
    const first = area[i];
    if (first < 192) [length, i] = [first, i + 1];
    else if (first < 255) [length, i] = [((first - 192) << 8) + area[i + 1] + 192, i + 2];
    else [length, i] = [area.readUInt32BE(i + 1), i + 5];
    if (length < 1 || i + length > area.length) throw new Error('a subpacket is cut short');
    out.push({ type: area[i] & 0x7f, data: area.subarray(i + 1, i + length) });
    i += length;
  }
  return out;
}

/**
 * What a v4 detached signature says about itself: its type, algorithms, creation time and issuer (the fingerprint
 * from the hashed area, the key id from either area). Reads only; it verifies nothing.
 */
export function signatureInfo(ascText) {
  const { tag, body } = firstPacket(dearmor(ascText));
  if (tag !== 2) throw new Error(`the first packet is not a signature (tag ${tag})`);
  if (body[0] !== 4) throw new Error(`signature version ${body[0]} is not supported`);
  const hashedLength = body.readUInt16BE(4);
  const hashed = subpackets(body.subarray(6, 6 + hashedLength));
  const unhashedAt = 6 + hashedLength;
  const unhashed = subpackets(
    body.subarray(unhashedAt + 2, unhashedAt + 2 + body.readUInt16BE(unhashedAt)),
  );
  const fpr = hashed.find((s) => s.type === 33);
  const keyId = [...hashed, ...unhashed].find((s) => s.type === 16);
  const created = hashed.find((s) => s.type === 2);
  return {
    signatureType: body[1],
    publicKeyAlgorithm: body[2],
    hashAlgorithm: body[3],
    created: created ? created.data.readUInt32BE(0) : undefined,
    issuerFingerprint:
      fpr && fpr.data[0] === 4 ? fpr.data.subarray(1, 21).toString('hex').toUpperCase() : undefined,
    issuerKeyId: keyId ? keyId.data.toString('hex').toUpperCase() : undefined,
  };
}

/**
 * Throws unless the .asc is a binary-document signature whose hashed issuer fingerprint is the pinned one (and its
 * key id, where given, that fingerprint's last 16 digits); returns what it read.
 */
export function checkSignatureIssuer(ascText, signer = RUNDLER_RELEASE.signer) {
  const info = signatureInfo(ascText);
  if (info.signatureType !== 0x00) throw new Error('the signature is not over a binary document');
  if (info.issuerFingerprint !== signer.fingerprint) {
    throw new Error(
      `the signature names issuer ${info.issuerFingerprint ?? 'none'}, not the pinned key`,
    );
  }
  if (info.issuerKeyId !== undefined && info.issuerKeyId !== signer.fingerprint.slice(-16)) {
    throw new Error('the signature key id does not belong to its issuer fingerprint');
  }
  return info;
}

/** The fingerprint of a good signature in gpgv's `--status-fd` output (`[GNUPG:] VALIDSIG <fpr> ...`), if any. */
export function validSignatureFingerprint(status) {
  const line = String(status)
    .split('\n')
    .find((l) => l.startsWith('[GNUPG:] VALIDSIG '));
  return line?.split(' ')[2]?.toUpperCase();
}

/**
 * Verifies a detached signature with gpgv against a keyring the caller supplies, and requires the key that made it to
 * be the pinned one. For a run given `--rundler-key`.
 */
export async function verifyWithKey(
  keyring,
  ascPath,
  archivePath,
  signer = RUNDLER_RELEASE.signer,
) {
  let stdout;
  try {
    ({ stdout } = await run('gpgv', [
      '--status-fd',
      '1',
      '--keyring',
      keyring,
      ascPath,
      archivePath,
    ]));
  } catch (error) {
    throw new Error(
      `gpgv rejected the signature: ${String(error?.stdout ?? error?.message).trim()}`,
    );
  }
  const fingerprint = validSignatureFingerprint(stdout);
  if (fingerprint !== signer.fingerprint) {
    throw new Error(`the signature verifies with ${fingerprint ?? 'no key'}, not the pinned key`);
  }
  return fingerprint;
}

/**
 * Downloads the tarball and the .asc of `arch`, checks both pinned digests and the issuer of the signature, and
 * returns the bytes and how the signature was checked. Needs the network, at build time only.
 */
/**
 * @param {string} arch
 * @param {{ fetchImpl?: (url: string) => Promise<Response> }} [options]
 */
export async function downloadRundler(arch, { fetchImpl = fetch } = {}) {
  const asset = RUNDLER_RELEASE.assets[arch];
  if (!asset) throw new Error(`no pinned Rundler asset for ${arch}`);
  const get = async (name) => {
    const response = await fetchImpl(assetUrl(name));
    if (!response.ok) throw new Error(`could not download ${name}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const archive = await get(asset.name);
  const asc = await get(`${asset.name}.asc`);
  checkDigest(archive, asset.sha256, asset.name);
  checkDigest(asc, asset.ascSha256, `${asset.name}.asc`);
  const info = checkSignatureIssuer(asc.toString('utf8'));
  return { asset, archive, asc, signature: { issuer: info.issuerFingerprint, verified: false } };
}
