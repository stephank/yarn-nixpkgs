#!/usr/bin/env node

import NpmPlugin from "@yarnpkg/plugin-npm";
import PnpPlugin from "@yarnpkg/plugin-pnp";
import { Cli, Command, Option } from "clipanion";
import { Filename, PortablePath, VirtualFS, ppath, xfs } from "@yarnpkg/fslib";
import { SerializedState, generatePrettyJson } from "@yarnpkg/pnp";
import {
  Cache,
  Configuration,
  InstallMode,
  MultiFetcher,
  Project,
  StreamReport,
  VirtualFetcher,
  WorkspaceFetcher,
  structUtils,
} from "@yarnpkg/core";

import generateNixExpr from "./generateNixExpr";
import generateSharedLoader from "./generateSharedLoader";
import { NpmSemverFetcher } from "./fetchers/NpmSemverFetcher";
import { initGlobalEnv } from "./globalEnv";

class PrepareCommand extends Command {
  package = Option.String();
  output = Option.String();

  async execute() {
    await initGlobalEnv();

    const descriptor = structUtils.parseDescriptor(this.package);
    const output = this.output as PortablePath;
    await xfs.mkdirpPromise(output);

    // Create a temporary workspace.
    const workdir = await xfs.mktempPromise();
    await xfs.mkdirpPromise(ppath.join(workdir, ".yarn/cache" as PortablePath));
    await xfs.writeJsonPromise(ppath.join(workdir, Filename.manifest), {
      name: "yarn-nixpkgs-install",
      dependencies: {
        [structUtils.stringifyIdent(descriptor)]:
          descriptor.range === "unknown" ? "latest" : descriptor.range,
      },
    });
    try {
      await xfs.copyFilePromise(
        ppath.join(output, Filename.lockfile),
        ppath.join(workdir, Filename.lockfile)
      );
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }

    // Load only supported plugins.
    const plugins = new Map([
      ["@yarnpkg/plugin-pnp", PnpPlugin],
      ["@yarnpkg/plugin-npm", NpmPlugin],
    ]);
    const configuration = Configuration.create(workdir, workdir, plugins);
    // We use a shared PnP loader for all builds produced by yarn-nixpkgs, so
    // want the PnP data separately as a JSON file.
    configuration.useWithSource(
      "<yarn-nixpkgs>",
      { pnpEnableInlining: false },
      workdir,
      { overwrite: true }
    );
    // Override fetchers with our Nix-compatible variants
    configuration.makeFetcher = () =>
      new MultiFetcher([
        new VirtualFetcher(),
        new WorkspaceFetcher(),
        new NpmSemverFetcher(),
      ]);

    const { project } = await Project.find(configuration, workdir);
    const cache = await Cache.find(configuration, { immutable: true });

    // Clear resolutions, as if `yarn up "*"`. We use the lockfile for cache,
    // but always want to reresolve everything to get the latest.
    project.storedDescriptors.clear();
    project.storedResolutions.clear();

    // Run installation as if `yarn install --immutable --mode=skip-build`. We
    // make cache immutable because our fetchers use the Nix store as cache,
    // and so nothing should ever be written to the Yarn cache.
    const report = await StreamReport.start(
      {
        configuration,
        stdout: this.context.stdout,
        includeLogs: true,
      },
      async (report: StreamReport) => {
        await project.install({
          cache,
          report,
          mode: InstallMode.SkipBuild,
        });
      }
    );
    if (report.hasErrors()) {
      return 1;
    }

    // At this point, we read and transform PnP data. Yarn advises against
    // this, because the format is unstable, but we are using a known version
    // of Yarn and using its typehints to make this safe for us. So in
    // practice, unstable just means we may have to change this code now and
    // then when we upgrade Yarn.
    const pnpData: SerializedState = JSON.parse(
      await xfs.readFilePromise(configuration.get("pnpDataPath"), "utf8")
    );

    // Transform package locations to be relative to the final install
    // location. Our fetchers placed dependencies in `/nix/store`, but PnP does
    // module lookup using an index of relative paths, so we can't use absolute
    // `/nix/store` paths. But we know roughly where the final installation
    // will live.
    for (const [, store] of pnpData.packageRegistryData) {
      for (const [reference, info] of store) {
        // Skip root and toplevel workspace.
        if (!reference || reference === "workspace:.") {
          continue;
        }

        let absLocation = ppath.resolve(project.cwd, info.packageLocation);

        // Special handling for virtual paths
        if (info.packageLocation.startsWith("./.yarn/__virtual__/")) {
          absLocation = VirtualFS.makeVirtualPath(
            "/nix/store/DUMMY/__virtual__" as PortablePath,
            info.packageLocation.split("/")[3] as Filename,
            VirtualFS.resolveVirtual(absLocation)
          );
        }

        let newLocation = ppath.relative(
          "/nix/store/DUMMY" as PortablePath,
          absLocation
        );

        // Virtual path transformation may result in `__virtual__/...`, where
        // PnP wants `./__virtual__/...`.
        if (!newLocation.startsWith(".")) {
          newLocation = `./${newLocation}` as PortablePath;
        }

        // Preserve the trailing slash, which is significant for PnP, but may
        // be stripped by `ppath.resolve`.
        if (info.packageLocation.endsWith("/")) {
          newLocation = `${newLocation}/` as PortablePath;
        }

        info.packageLocation = newLocation;
      }
    }

    // @todo: Generate Nix derivations for package build steps, and transform
    // PnP data to point `packageLocation` to the result.

    // Generate output.
    await xfs.writeFilePromise(
      ppath.join(output, "pnp.cjs" as Filename),
      generateSharedLoader()
    );
    await xfs.writeFilePromise(
      ppath.join(output, "pnp.data.json" as Filename),
      generatePrettyJson(pnpData)
    );
    await xfs.writeFilePromise(
      ppath.join(output, "package.nix" as Filename),
      generateNixExpr({ project, pnpData })
    );
    await xfs.writeFilePromise(
      ppath.join(output, "default.nix" as Filename),
      "{ pkgs ? import <nixpkgs> { } }:\npkgs.callPackage ./package.nix { }"
    );
    await xfs.copyFilePromise(
      ppath.join(workdir, Filename.lockfile),
      ppath.join(output, Filename.lockfile)
    );

    return 0;
  }
}

const [node, app, ...args] = process.argv;
const cli = new Cli({
  binaryLabel: "Yarn packaging for Nixpkgs",
  binaryName: `${node} ${app}`,
  binaryVersion: "0.0.1",
});

cli.register(PrepareCommand);
cli.runExit(args);
