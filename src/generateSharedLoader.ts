import { generateLoader } from "@yarnpkg/pnp";

const SETUP_STATE = `\
var path = require('path');
var dataLocation = path.resolve(process.env.NIX_YARN_PNP_BASE, "pnp.data.json");
return hydrateRuntimeState(require(dataLocation), {basePath: basePath || path.dirname(dataLocation)});
`;

/**
 * Generates a loader that uses a `NIX_YARN_PNP_BASE` environment variable to
 * locate data. The resulting loader can be shared by all builds made by the
 * same version of yarn-nixpkgs.
 */
export default function generateSharedLoader() {
  return generateLoader(null, SETUP_STATE);
}
