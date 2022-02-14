import { Locator, Project, structUtils } from "@yarnpkg/core";
import { ppath } from "@yarnpkg/fslib";
import { SerializedState } from "@yarnpkg/pnp";

import { NpmSemverFetcher } from "./fetchers/NpmSemverFetcher";
import {
  hashToSri,
  locatorDerivationName,
  sanitizeDerivationName,
} from "./nixUtils";

const NPM_REGISTRY = "https://registry.npmjs.org";

export default function generateNixExpr({
  project,
  pnpData,
}: {
  project: Project;
  pnpData: SerializedState;
}) {
  // Find the main package.
  const topLevelDependencies = [
    ...project.topLevelWorkspace.dependencies.values(),
  ];
  if (topLevelDependencies.length !== 1) {
    throw Error("Assertion failed: expected exactly 1 toplevel dependency");
  }
  const [mainDescriptor] = topLevelDependencies;
  const mainPackage = project.storedPackages.get(
    project.storedResolutions.get(mainDescriptor.descriptorHash)!
  )!;

  // Find binaries. We don't use `scriptUtils.getPackageAccessibleBinaries`,
  // because that creates absolute paths to our temporary directory. In
  // addition, we can't determine absolute paths for virtual paths at this
  // point, because we don't know the exact Nix store path where the
  // installation will live.
  const mainPackageName = structUtils.stringifyIdent(mainPackage);
  const mainPackageLocation = pnpData.packageRegistryData
    .find(([ident]) => ident === mainPackageName)![1]
    .find(([ref]) => ref === mainPackage.reference)![1].packageLocation;
  let binaries = "\n";
  for (const [binaryName, binaryPath] of mainPackage.bin.entries()) {
    const finalPath = ppath.join(mainPackageLocation, binaryPath);
    const escapedName = JSON.stringify(binaryName);
    const escapedPath = JSON.stringify(finalPath);
    binaries += `${escapedName} = ${escapedPath};\n`;
  }

  // Generate fetch derivations for packages.
  let packageDerivations = "";
  for (const pkg of project.storedPackages.values()) {
    if (pkg.reference.startsWith("npm:")) {
      const url = new URL(pkg.reference);
      const archiveUrl =
        url.searchParams.get("__archiveUrl") ||
        NPM_REGISTRY + NpmSemverFetcher.getLocatorUrl(pkg);
      const [, checksum] = project.storedChecksums
        .get(pkg.locatorHash)!
        .split("/");
      packageDerivations += `
(fetchNpm {
  name = "${locatorDerivationName(pkg)}";
  url = ${JSON.stringify(archiveUrl)};
  hash = "${hashToSri(checksum)}";
})
`;
    } else if (pkg.reference.startsWith("virtual:")) {
      // Ignore, because we'll loop over the non-virtual packages as well.
    } else if (pkg.reference === "workspace:.") {
      // Ignore our (toplevel) workspace. Should not be any other workspaces.
    } else {
      const strLocator = structUtils.stringifyLocator(pkg);
      throw Error(
        `Cannot generate fetch derivation for package: ${strLocator}`
      );
    }
  }

  return template({
    mainPackage: structUtils.isVirtualLocator(mainPackage)
      ? structUtils.devirtualizeLocator(mainPackage)
      : mainPackage,
    binaries,
    packageDerivations,
  });
}

const template = ({
  mainPackage,
  binaries,
  packageDerivations,
}: {
  mainPackage: Locator;
  binaries: string;
  packageDerivations: string;
}) => `\
{ lib, stdenvNoCC, runtimeShell, nodejs, fetchurl, libarchive }:
let

inherit (lib) getBin escapeShellArg;

fetchNpm = args: fetchurl (args // {
  downloadToTemp = true;
  postFetch = ''
    \${getBin libarchive}/bin/bsdtar -cf $out --format=zip "@$downloadedFile"
  '';
});

yarnBins = {${binaries}};

yarnPkgs = [${packageDerivations}];

in stdenvNoCC.mkDerivation {
  pname = "${sanitizeDerivationName(structUtils.stringifyIdent(mainPackage))}";
  version = "${sanitizeDerivationName(mainPackage.reference)}";

  dummyInputs = yarnPkgs;

  phases = [ "installPhase" ];
  installPhase = ''
    mkdir -p \$out/bin

    install -m0644 '\${./pnp.data.json}' \$out/pnp.data.json

    cat > \$out/pnp.env << EOF
    #!\${runtimeShell}
    export NIX_YARN_PNP_BASE='\$out'
    export NODE_OPTIONS='--require \${./pnp.cjs}'
    EOF

    # Create binary wrappers.
    cd \$out/bin
    \${lib.concatStrings (lib.mapAttrsToList (name: bin: ''
    cat > \${escapeShellArg name} << EOF
    \$(<\$out/pnp.env)
    exec \${getBin nodejs}/bin/node $out/\${escapeShellArg bin} "\\\$@"
    EOF
    chmod 0755 \${escapeShellArg name}
    '') yarnBins)}
  '';
}
`;
