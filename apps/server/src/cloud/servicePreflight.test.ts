import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  BUILD_MIGRATION_HEAD,
  databaseMigrationHead,
} from "../persistence/databaseMigrationHead.ts";
import { migrationManifest } from "../persistence/Migrations.ts";

import {
  installedLauncherVersion,
  launcherVersionFromUnit,
  PREPARED_DEADLINE_LAUNCHER_VERSION,
  runServicePreflight,
  serviceUnitPathFromEnvironment,
} from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL, SERVICE_UNIT_ENV } from "./serviceProtocol.ts";

const OLD_LAUNCHER = "0.0.46-nightly.20261003.2610";
const encoder = new TextEncoder();

// regression: #13239 a stale CLI shadowing the updated one kept "updating" to itself
it.each([1])("blocks legacy launcher protocol %i with exact recovery steps", (launcherProtocol) => {
  const result = runServicePreflight({
    databasePath: "/missing/state.sqlite",
    launcherProtocol,
    version: "9.8.7",
  });

  expect(result).toMatchObject({ status: "blocked", version: "9.8.7" });
  const reason = result.status === "blocked" ? result.reason : "";
  expect(reason).toMatch(new RegExp(`\\b${launcherProtocol}\\b`));
  expect(reason).toMatch(new RegExp(`\\b${SERVICE_LAUNCHER_PROTOCOL}\\b`));
  expect(reason).toContain("curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION=9.8.7 sh");
  expect(reason).toContain("~/.local/bin/t3 service install");
  expect(reason).toContain("t3 --version");
  expect(reason).toContain("which -a t3");
});

// regression: #34502 every installed launcher was protocol 3, so protocol 4 blocked every remote update
it.each([3, SERVICE_LAUNCHER_PROTOCOL])(
  "is ready under launcher protocol %i and reports it back",
  (launcherProtocol) => {
    // A released server accepts a ready result only when it names that server's own protocol.
    expect(
      runServicePreflight({
        databasePath: "/missing/state.sqlite",
        launcherProtocol,
        version: "9.8.7",
      }),
    ).toEqual({ status: "ready", version: "9.8.7", launcherProtocol });
  },
);

// regression: #38526 a protocol-3 launcher from before the 30-minute deadline still reports protocol 3
it.each([OLD_LAUNCHER, "0.0.46-nightly.20261014.3104", "0.0.45"])(
  "refuses remote update under launcher %s and tells the operator to run t3 update",
  (launcherVersion) => {
    const result = runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol: 3,
      launcherVersion,
      version: "9.8.7",
    });
    expect(result.status).toBe("blocked");
    const reason = result.status === "blocked" ? result.reason : "";
    expect(reason).toContain(`t3@${launcherVersion}`);
    expect(reason).toContain(PREPARED_DEADLINE_LAUNCHER_VERSION);
    expect(reason).toContain("run `t3 update`");
    expect(reason).toContain("2 minutes");
    expect(reason).not.toContain("curl");
  },
);

it.each([PREPARED_DEADLINE_LAUNCHER_VERSION, "0.0.46-nightly.20261015.3200", "0.1.10"])(
  "allows launcher %s that has the 30-minute prepared deadline",
  (launcherVersion) => {
    expect(
      runServicePreflight({
        databasePath: "/missing/state.sqlite",
        launcherProtocol: 3,
        launcherVersion,
        version: "9.8.7",
      }),
    ).toEqual({ status: "ready", version: "9.8.7", launcherProtocol: 3 });
  },
);

it("still names the protocol install when the launcher protocol itself is unsupported", () => {
  const result = runServicePreflight({
    databasePath: "/missing/state.sqlite",
    launcherProtocol: 1,
    launcherVersion: OLD_LAUNCHER,
    version: "9.8.7",
  });
  expect(result.status === "blocked" ? result.reason : "").toContain(
    "curl -fsSL https://t3.codes/install.sh",
  );
});

it("reads the launcher version from the unit a service child inherits", () => {
  const version = OLD_LAUNCHER;
  const program = `/home/a/.t3/runtime/versions/${version}/t3`;
  const unit = `ExecStart="${program}" __service-launcher\n`;
  const plist = `<key>ProgramArguments</key><array><string>${program}</string></array>`;
  const task = `<Arguments>--headless "C:\\Users\\a\\.t3\\runtime\\versions\\${version}\\t3.exe" "__service-launcher"`;
  expect(launcherVersionFromUnit(encoder.encode(unit))).toBe(version);
  expect(launcherVersionFromUnit(encoder.encode(plist))).toBe(version);
  expect(launcherVersionFromUnit(encoder.encode(task))).toBe(version);
  expect(launcherVersionFromUnit(encoder.encode("ExecStart=/usr/local/bin/t3\n"))).toBeUndefined();

  const unitPath = "/home/a/.config/systemd/user/t3code.service";
  expect(
    serviceUnitPathFromEnvironment({
      [SERVICE_UNIT_ENV]: "t3code.service",
      HOME: "/home/a",
    }),
  ).toBe(unitPath);
  expect(
    serviceUnitPathFromEnvironment({
      [SERVICE_UNIT_ENV]: "com.t3tools.t3code.service.plist",
      HOME: "/Users/a",
    }),
  ).toBe("/Users/a/Library/LaunchAgents/com.t3tools.t3code.service.plist");
  expect(
    serviceUnitPathFromEnvironment({
      [SERVICE_UNIT_ENV]: "t3code-task.xml",
      LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
    }),
  ).toBe("C:\\Users\\a\\AppData\\Local\\t3code\\t3code-task.xml");
  expect(serviceUnitPathFromEnvironment({})).toBeUndefined();

  const reads = new Map<string, Uint8Array>([[unitPath, encoder.encode(unit)]]);
  expect(
    installedLauncherVersion({ [SERVICE_UNIT_ENV]: "t3code.service", HOME: "/home/a" }, (path) =>
      reads.get(path),
    ),
  ).toBe(version);
  expect(
    installedLauncherVersion(
      { [SERVICE_UNIT_ENV]: "t3code.service", HOME: "/home/a" },
      () => undefined,
    ),
  ).toBeUndefined();
  expect(installedLauncherVersion({}, () => encoder.encode(unit))).toBeUndefined();
});

it.layer(NodeServices.layer)("service preflight database", (it) => {
  it.effect("blocks a database that a newer build migrated", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const databasePath = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-preflight-" }),
        "state.sqlite",
      );
      const db = new NodeSqlite.DatabaseSync(databasePath);
      db.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)");
      const insert = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
      for (const [id, name] of migrationManifest) insert.run(id, name);
      const preflight = () =>
        runServicePreflight({ databasePath, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL });

      expect(preflight().status).toBe("ready");
      expect(databaseMigrationHead(databasePath)).toBe(BUILD_MIGRATION_HEAD);

      db.prepare("UPDATE effect_sql_migrations SET name = ? WHERE migration_id = ?").run(
        "ForkMigration",
        BUILD_MIGRATION_HEAD,
      );
      const conflict = preflight();
      expect(conflict.status).toBe("blocked");
      expect(conflict.status === "blocked" ? conflict.reason : "").toContain("ForkMigration");
      db.prepare("UPDATE effect_sql_migrations SET name = ? WHERE migration_id = ?").run(
        migrationManifest.at(-1)![1],
        BUILD_MIGRATION_HEAD,
      );

      // Startup reconciles this V2 preview history, so it must not block an update.
      const preview = path.join(path.dirname(databasePath), "preview.sqlite");
      const previewDb = new NodeSqlite.DatabaseSync(preview);
      previewDb.exec(
        "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)",
      );
      const insertPreview = previewDb.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
      for (const [id, name] of migrationManifest.filter(([id]) => id < 53)) {
        insertPreview.run(id, name);
      }
      insertPreview.run(53, "PullRequestFilesViewed");
      insertPreview.run(54, "OrchestrationV2");
      insertPreview.run(55, "RemoveRedundantProjectionIndexes");
      previewDb.close();
      expect(
        runServicePreflight({ databasePath: preview, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL })
          .status,
      ).toBe("ready");

      const newerId = Math.max(...migrationManifest.map(([id]) => id)) + 1;
      insert.run(newerId, "FromNightly");
      db.close();
      const result = preflight();
      expect(result.status).toBe("blocked");
      expect(result.status === "blocked" ? result.reason : "").toContain(`${newerId}_FromNightly`);
      // Servers report this head, so clients see a database a newer build migrated.
      expect(databaseMigrationHead(databasePath)).toBe(newerId);

      // A database that exists but cannot be read has an unknown history, so it blocks.
      const unreadable = path.join(path.dirname(databasePath), "unreadable.sqlite");
      yield* fs.writeFileString(unreadable, "not a database");
      expect(databaseMigrationHead(unreadable)).toBeUndefined();
      expect(
        runServicePreflight({
          databasePath: unreadable,
          launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        }).status,
      ).toBe("blocked");
      // A missing database is a fresh install.
      expect(databaseMigrationHead(path.join(path.dirname(databasePath), "missing.sqlite"))).toBe(
        BUILD_MIGRATION_HEAD,
      );
    }),
  );
});
