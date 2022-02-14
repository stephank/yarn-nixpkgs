import { Locator, execUtils, hashUtils, structUtils } from "@yarnpkg/core";
import { createHash } from "crypto";
import { getLibzipPromise } from "@yarnpkg/libzip";
import {
  Filename,
  PortablePath,
  ZipFS,
  constants,
  ppath,
  xfs,
} from "@yarnpkg/fslib";

import { bsdtarExe } from "./globalEnv";

const BASE32_CHARSET = "0123456789abcdfghijklmnpqrsvwxyz";
const CACHE_KEY_NS = "nix.1/";

/**
 * Short-hand for simple hash computation.
 */
export function computeHash(algorithm: string, data: string | Buffer) {
  return createHash(algorithm).update(data).digest();
}

/**
 * Nix-compatible hash compression.
 */
export function compressHash(hash: Buffer, size: number) {
  const result = Buffer.alloc(size);
  for (let idx = 0; idx < hash.length; idx++) {
    result[idx % size] ^= hash[idx];
  }
  return result;
}

/**
 * Nix-compatible base32 encoding.
 *
 * This is probably a super inefficient implementation, but we only process
 * small inputs. (20 bytes)
 */
export function encodeBase32(buf: Buffer) {
  let result = "";
  let bits = [...buf]
    .reverse()
    .map((n) => n.toString(2).padStart(8, "0"))
    .join("");
  while (bits) {
    result += BASE32_CHARSET[parseInt(bits.slice(0, 5), 2)];
    bits = bits.slice(5);
  }
  return result;
}

/**
 * Compute the Nix store path for a fixed-output derivation.
 */
export function computeFixedOutputStorePath(
  name: string,
  hash: string,
  hashAlgorithm: string = "sha512",
  storePath = "/nix/store" as PortablePath
) {
  if (hash.startsWith(CACHE_KEY_NS)) {
    hash = hash.slice(CACHE_KEY_NS.length);
  }

  const innerStr = `fixed:out:${hashAlgorithm}:${hash}:`;
  const innerHash = computeHash("sha256", innerStr);
  const innerHashHex = innerHash.toString("hex");

  const outerStr = `output:out:sha256:${innerHashHex}:${storePath}:${name}`;
  const outerHash = computeHash("sha256", outerStr);
  const outerHash32 = encodeBase32(compressHash(outerHash, 20));

  return ppath.join(storePath, `${outerHash32}-${name}` as Filename);
}

/**
 * Creates a valid derivation name from a potentially invalid one.
 *
 * Matches lib.strings.sanitizeDerivationName in Nixpkgs.
 */
export function sanitizeDerivationName(name: string) {
  return (
    name
      .replace(/^\.+/, "")
      .replace(/[^a-zA-Z0-9+._?=-]+/g, "-")
      .slice(0, 207) || "unknown"
  );
}

/**
 * Creates a Nix `fetchurl` derivation name for a locator.
 */
export function locatorDerivationName(locator: Locator) {
  return sanitizeDerivationName(structUtils.stringifyLocator(locator) + ".zip");
}

/**
 * Fetch a ZIP package from the Nix store, or invoke the loader.
 *
 * This is a replacement for Yarn's `Cache.fetchPackageFromCache`.
 */
export async function fetchPackageFromNixStore(
  locator: Locator,
  expectedChecksum: string | null,
  {
    onHit,
    onMiss,
    loader,
  }: {
    onHit: () => void;
    onMiss: () => void;
    loader: () => Promise<PortablePath>;
  }
): Promise<[ZipFS, () => void, string | null]> {
  const derivationName = locatorDerivationName(locator);
  let storePath = expectedChecksum
    ? computeFixedOutputStorePath(derivationName, expectedChecksum)
    : null;

  let checksum: string;
  if (storePath && (await xfs.existsPromise(storePath))) {
    onHit();
    checksum = expectedChecksum!;
  } else {
    onMiss();

    const resultPath = await loader();
    checksum = CACHE_KEY_NS + (await hashUtils.checksumFile(resultPath));
    storePath = computeFixedOutputStorePath(derivationName, checksum);

    if (await xfs.existsPromise(storePath)) {
      await xfs.unlinkPromise(resultPath);
    } else {
      // Rename to match the `fetchurl` derivation name.
      // NOTE: Assumes the file is in a temp dir, per `convertTgzToZip`.
      const tempDir = ppath.dirname(resultPath);
      const loadPath = ppath.join(tempDir, derivationName as Filename);
      await xfs.renamePromise(resultPath, loadPath);

      // With the file properly named, load it into the store.
      const { stdout } = await execUtils.execvp(
        "nix-store",
        ["--add-fixed", "sha512", `./${derivationName}`],
        { cwd: tempDir, strict: true }
      );
      if (stdout.trim() !== storePath) {
        throw Error(
          "Assertion failed: nix-store path and computed path mismatch"
        );
      }

      await xfs.unlinkPromise(loadPath);
    }
  }

  const libzip = await getLibzipPromise();
  const packageFs = new ZipFS(storePath, { libzip, readOnly: true });
  const releaseFs = () => {
    packageFs.discardAndClose();
  };

  return [packageFs, releaseFs, checksum];
}

/**
 * Alternate to `tgzUtils.convertToZip` which uses a method we can replicate in
 * Nix as a `postFetch` hook to `fetchurl`. (We want to avoid a chicken-egg
 * problem by not depending on anything in the Node.js ecosystem.)
 *
 * Unlike the original, this returns a path to the resulting ZIP file. The file
 * is guaranteed to be in a temporary directory by itself.
 */
export async function convertTgzToZip(tgz: Buffer): Promise<PortablePath> {
  const tempDir = await xfs.mktempPromise();

  const tgzPath = ppath.join(tempDir, "archive.tgz" as Filename);
  const zipPath = ppath.join(tempDir, "archive.zip" as Filename);

  await xfs.writeFilePromise(tgzPath, tgz);
  await xfs.utimesPromise(tgzPath, constants.SAFE_TIME, constants.SAFE_TIME);
  await execUtils.execvp(
    bsdtarExe,
    ["-cf", zipPath, "--format=zip", `@${tgzPath}`],
    {
      cwd: PortablePath.root,
      strict: true,
      env: { TZ: "UTC" },
    }
  );
  await xfs.unlinkPromise(tgzPath);

  return zipPath;
}

/**
 * Convert a hex hash to an SRI hash.
 */
export function hashToSri(
  hash: string,
  hashAlgorithm: string = "sha512"
): string {
  const b64 = Buffer.from(hash, "hex").toString("base64");
  return `${hashAlgorithm}-${b64}`;
}
