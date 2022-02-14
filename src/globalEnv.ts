// These ugly globals help us use stable versions of tools.

import { execUtils } from "@yarnpkg/core";
import { PortablePath } from "@yarnpkg/fslib";

export let bsdtarExe = "bsdtar";

export async function initGlobalEnv() {
  const libarchive = await getNixPackagePath("libarchive");

  bsdtarExe = `${libarchive}/bin/bsdtar`;
}

async function getNixPackagePath(name: string) {
  const { stdout } = await execUtils.execvp(
    "nix-build",
    ["<nixpkgs>", "-A", name, "--no-out-link"],
    {
      cwd: PortablePath.root,
      strict: true,
    }
  );

  return stdout.trim() as PortablePath;
}
