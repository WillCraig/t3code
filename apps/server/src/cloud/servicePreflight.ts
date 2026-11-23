// @effect-diagnostics nodeBuiltinImport:off -- Unit paths differ by platform; the preflight subprocess only reads the unit.
import * as NodePath from "node:path";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import { BUILD_MIGRATION_HEAD, recordedMigrations } from "../persistence/databaseMigrationHead.ts";
import { skippedV2Migrations } from "../persistence/Migrations.ts";
import { reconciledV2PreviewHistory } from "../persistence/reconcileV2PreviewMigration.ts";
import type * as ProcessRunner from "../processRunner.ts";
import {
  pinnedRuntimeCommand,
  PinnedRuntimeInstallError,
  type PinnedRuntimePaths,
  PinnedRuntimePreflightBlockedError,
} from "./pinnedRuntime.ts";
import {
  compareExactServiceVersions,
  decodeServiceUnit,
  isExactServiceVersion,
  isSupportedLauncherProtocol,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_UNIT_ENV,
  serviceRuntimeVersionOf,
  serviceUnitProgramOf,
  type SupportedLauncherProtocol,
} from "./serviceProtocol.ts";

/** First launcher with the 30-minute prepared deadline. Older ones still report protocol 3. */
export const PREPARED_DEADLINE_LAUNCHER_VERSION = "0.0.46-nightly.20261014.3105";

// A staged runtime's cold start can take over a minute on a loaded, swapping host.
const PREFLIGHT_TIMEOUT = Duration.minutes(3);
const decodePreflightJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      /** The launcher protocol the server named; it accepts no other in reply. */
      readonly launcherProtocol: SupportedLauncherProtocol;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

/** Where the service manager keeps the unit named by `T3_BOOT_SERVICE_UNIT`, when that variable is set. */
export function serviceUnitPathFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const unitName = env[SERVICE_UNIT_ENV]?.trim();
  if (unitName === undefined || unitName === "") return undefined;
  if (unitName.endsWith(".xml")) {
    const localAppData = env.LOCALAPPDATA?.trim();
    return localAppData === undefined || localAppData === ""
      ? undefined
      : NodePath.win32.join(localAppData, "t3code", unitName);
  }
  const home = env.HOME?.trim();
  if (home === undefined || home === "") return undefined;
  if (unitName.endsWith(".plist")) {
    return NodePath.join(home, "Library", "LaunchAgents", unitName);
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim() ?? "";
  return NodePath.join(
    xdgConfigHome !== "" && NodePath.isAbsolute(xdgConfigHome)
      ? xdgConfigHome
      : NodePath.join(home, ".config"),
    "systemd",
    "user",
    unitName,
  );
}

export function launcherVersionFromUnit(bytes: Uint8Array): string | undefined {
  const program = serviceUnitProgramOf(decodeServiceUnit(bytes));
  return program === undefined ? undefined : serviceRuntimeVersionOf(program);
}

export function installedLauncherVersion(
  env: Readonly<Record<string, string | undefined>>,
  readUnit: (path: string) => Uint8Array | undefined,
): string | undefined {
  const unitPath = serviceUnitPathFromEnvironment(env);
  if (unitPath === undefined) return undefined;
  const bytes = readUnit(unitPath);
  return bytes === undefined ? undefined : launcherVersionFromUnit(bytes);
}

function launcherMissesPreparedDeadline(version: string): boolean {
  return (
    isExactServiceVersion(version) &&
    compareExactServiceVersions(version, PREPARED_DEADLINE_LAUNCHER_VERSION) < 0
  );
}

export function runServicePreflight(input: {
  readonly databasePath: string;
  readonly launcherProtocol: number;
  /** Set when this process is the service child and the unit names a runtime. Absent for `t3 update`. */
  readonly launcherVersion?: string;
  readonly version?: string;
}): ServicePreflightResult {
  const version = input.version ?? packageJson.version;
  const { launcherProtocol } = input;
  if (!isSupportedLauncherProtocol(launcherProtocol)) {
    return {
      status: "blocked",
      version,
      // A stale `t3` earlier on PATH (an old npm/nvm global) makes `t3 service install`
      // reinstall itself and report success, so name the exact install and the path check.
      reason: [
        `The installed service launcher speaks protocol ${launcherProtocol}, but t3@${version} requires protocol ${SERVICE_LAUNCHER_PROTOCOL}.`,
        `On the server machine, install this exact CLI: \`curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION=${version} sh\`.`,
        `Check that \`t3 --version\` prints ${version} and that \`which -a t3\` lists no older t3 (such as an npm or nvm install) first, then run \`~/.local/bin/t3 service install\` (the installer's default path).`,
        "Updating the desktop app does not update this CLI, and `t3 service update` only repairs the service with whichever CLI runs it.",
      ].join(" "),
    };
  }

  // A remote update never replaces the launcher. One from before the 30-minute deadline kills the
  // trial after 2 minutes, restores the database, and the client offers the same update again.
  const launcherVersion = input.launcherVersion;
  if (launcherVersion !== undefined && launcherMissesPreparedDeadline(launcherVersion)) {
    return {
      status: "blocked",
      version,
      reason: [
        `The installed service launcher is t3@${launcherVersion}, which stops a remote update after 2 minutes.`,
        `t3@${version} needs a launcher from ${PREPARED_DEADLINE_LAUNCHER_VERSION} or newer, which waits 30 minutes.`,
        "On the server machine, run `t3 update` to replace the launcher, then update again from the client.",
        "Retrying from the client cannot finish this update until that command replaces the launcher.",
      ].join(" "),
    };
  }

  const recorded = recordedMigrations(input.databasePath);
  if (recorded === null) {
    return {
      status: "blocked",
      version,
      reason: `Could not read this database to confirm t3@${version} supports it.`,
    };
  }
  const newer = recorded
    .filter(({ id }) => id > BUILD_MIGRATION_HEAD)
    .map(({ id, name }) => `${id}_${name}`);
  if (newer.length > 0) {
    return {
      status: "blocked",
      version,
      reason: `This database has migrations that t3@${version} does not know: ${newer.join(", ")}. A newer build wrote them, and running t3@${version} on this database is not safe. Stay on the newer release, or wait for a release that includes these migrations.`,
    };
  }

  // Startup reconciles V2 preview ids before it checks the history, so check what it will see.
  const reconciled = reconciledV2PreviewHistory(recorded);
  const incompatible =
    reconciled === null ? ["an unexpected V2 preview history"] : skippedV2Migrations(reconciled);
  if (incompatible.length > 0) {
    return {
      status: "blocked",
      version,
      reason: `This database has incompatible migration history: ${incompatible.join(", ")}. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
    };
  }

  return { status: "ready", version, launcherProtocol };
}

function decodeServicePreflightResult(
  value: unknown,
  launcherProtocol: SupportedLauncherProtocol,
): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === launcherProtocol &&
    typeof record.version === "string"
  ) {
    return { status: "ready", version: record.version, launcherProtocol };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}

/** Asks a staged runtime whether it can run on this database under this launcher protocol. */
export const runStagedServicePreflight = Effect.fn("cloud.service_preflight.run_staged")(
  function* (input: {
    readonly runner: ProcessRunner.ProcessRunner["Service"];
    readonly runtime: PinnedRuntimePaths;
    readonly targetVersion: string;
    readonly databasePath: string;
    readonly launcherProtocol: SupportedLauncherProtocol;
  }) {
    const step = "running the staged service preflight";
    const command = pinnedRuntimeCommand(input.runtime);
    const result = yield* input.runner
      .run({
        command: command.command,
        args: [
          ...command.args,
          "__service-preflight",
          "--database-path",
          input.databasePath,
          "--launcher-protocol",
          String(input.launcherProtocol),
        ],
        timeout: PREFLIGHT_TIMEOUT,
      })
      .pipe(Effect.mapError((cause) => new PinnedRuntimeInstallError({ step, cause })));
    if (result.code !== 0) {
      return yield* new PinnedRuntimeInstallError({
        step,
        exitCode: Number(result.code),
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
      });
    }
    const parsed = yield* decodePreflightJson(result.stdout.trim()).pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({ step: "decoding the staged service preflight", cause }),
      ),
    );
    const preflight = decodeServicePreflightResult(parsed, input.launcherProtocol);
    if (preflight === undefined || preflight.version !== input.targetVersion) {
      return yield* new PinnedRuntimeInstallError({
        step: "verifying the staged service preflight",
      });
    }
    if (preflight.status === "blocked") {
      return yield* new PinnedRuntimePreflightBlockedError({
        version: input.targetVersion,
        reason: preflight.reason,
      });
    }
  },
);
