// @effect-diagnostics nodeBuiltinImport:off -- The preflight subprocess reads the service unit before the Effect runtime does other work.
import * as NodeFS from "node:fs";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/cli";

import { installedLauncherVersion, runServicePreflight } from "../cloud/servicePreflight.ts";

const readUnit = (path: string): Uint8Array | undefined => {
  try {
    return NodeFS.readFileSync(path);
  } catch {
    return undefined;
  }
};

export const servicePreflightCommand = Command.make("__service-preflight", {
  databasePath: Flag.String("database-path"),
  launcherProtocol: Flag.Int("launcher-protocol"),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ databasePath, launcherProtocol }) => {
    // The service child inherits T3_BOOT_SERVICE_UNIT. `t3 update` does not, and replaces the launcher.
    const launcherVersion = installedLauncherVersion(process.env, readUnit);
    return Console.log(
      JSON.stringify(
        runServicePreflight({
          databasePath,
          launcherProtocol,
          ...(launcherVersion === undefined ? {} : { launcherVersion }),
        }),
      ),
    ).pipe(Effect.asVoid);
  }),
);
