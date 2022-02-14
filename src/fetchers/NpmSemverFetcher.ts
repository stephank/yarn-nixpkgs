import { FetchOptions, Locator } from "@yarnpkg/core";
import { NpmSemverFetcher as OriginalFetcher } from "@yarnpkg/plugin-npm/lib/NpmSemverFetcher";
import { PortablePath } from "@yarnpkg/fslib";
import { convertTgzToZip, fetchPackageFromNixStore } from "../nixUtils";
import { npmHttpUtils } from "@yarnpkg/plugin-npm";

export class NpmSemverFetcher extends OriginalFetcher {
  async fetch(locator: Locator, opts: FetchOptions) {
    const expectedChecksum = opts.checksums.get(locator.locatorHash) || null;

    const [packageFs, releaseFs, checksum] = await fetchPackageFromNixStore(
      locator,
      expectedChecksum,
      {
        onHit: () => opts.report.reportCacheHit(locator),
        onMiss: () => opts.report.reportCacheMiss(locator),
        loader: () => this.fetchFromNetworkAlt(locator, opts),
      }
    );

    return {
      packageFs,
      releaseFs,
      // @todo: Breaks convention, see `nixUtils.convertTgzToZip`.
      //prefixPath: structUtils.getIdentVendorPath(locator),
      prefixPath: "package/" as PortablePath,
      checksum,
    };
  }

  private async fetchFromNetworkAlt(locator: Locator, opts: FetchOptions) {
    // This snippet matches the original NpmSemverFetcher.
    let sourceBuffer;
    try {
      sourceBuffer = await npmHttpUtils.get(
        OriginalFetcher.getLocatorUrl(locator),
        {
          configuration: opts.project.configuration,
          ident: locator,
        }
      );
    } catch (error) {
      sourceBuffer = await npmHttpUtils.get(
        OriginalFetcher.getLocatorUrl(locator).replace(/%2f/g, "/"),
        {
          configuration: opts.project.configuration,
          ident: locator,
        }
      );
    }

    // Use alternative method to transform TGZ to ZIP.
    return convertTgzToZip(sourceBuffer);
  }
}
