// @todo: Discuss with upstream. Maybe we can create a supported path for this
// instead of patching the loader script.

import { generateSplitScript } from "@yarnpkg/pnp";

const SETUP_STATE = `
  var path = require('path');
  var dataLocation = path.resolve(process.env.NIX_YARN_PNP_BASE, "pnp.data.json");
  return hydrateRuntimeState(require(dataLocation), {basePath: basePath || path.dirname(dataLocation)});
`;

/**
 * Takes the source code of a PnP split loader, and generates a shared loader
 * that uses a `NIX_YARN_PNP_BASE` environment variable to locate data. The
 * resulting loader can be shared by all builds made by yarn-nixpkgs. This is
 * possible because the only difference between split/inline/shared loaders is
 * the injected `$$SETUP_STATE` function.
 */
export default function generateSharedLoader() {
  const { loaderFile } = generateSplitScript({
    dataLocation: "",
    packageRegistry: new Map(),
    dependencyTreeRoots: [],
  });

  const idx = loaderFile.indexOf("$$SETUP_STATE");
  if (idx === -1) {
    throw Error("Invalid loader: no $$SETUP_STATE found");
  }

  let start = 0;
  let end = 0;
  let depth = 0;
  for (const match of loaderFile.slice(idx).matchAll(/[{}]/g)) {
    if (depth === 0) {
      if (match[0] !== "{") {
        throw Error("Invalid loader: unbalanced braces");
      }
      start = idx + match.index! + 1;
    }

    switch (match[0]) {
      case "{":
        depth++;
        break;
      case "}":
        depth--;
        break;
      default:
        throw Error("Assertion failed: regex match returned unexpected result");
    }

    if (depth === 0) {
      end = idx + match.index!;
      break;
    }
  }

  return loaderFile.slice(0, start) + SETUP_STATE + loaderFile.slice(end);
}
