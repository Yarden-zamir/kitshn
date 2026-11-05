import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bindSources,
  composeFiles,
  composeRisks,
  envFileRisks,
  nestedSources,
  rawRisks,
  realpathOf,
  realpathOnDisk,
  spreadData,
} from "./guard.ts";

const roots = ["/apps/a/src", "/apps/a/data", "/apps/a/logs", "/apps/a/sockets"] as const;
const same = (path: string) => path;
const risks = (config: unknown, uninterpolated: unknown = {}) =>
  [...envFileRisks(uninterpolated, roots, same), ...composeRisks(config, "a", roots, same)].sort();

describe("risky Compose settings (K-818)", () => {
  it("passes an app that stays in its own folders", () => {
    const config = {
      name: "a",
      services: {
        web: {
          build: { context: "/apps/a/src", dockerfile: "Dockerfile" },
          environment: { A: "1" },
          networks: { default: null },
          volumes: [
            { type: "bind", source: "/apps/a/data/state", target: "/data" },
            { type: "volume", source: "cache", target: "/cache" },
          ],
          restart: "unless-stopped",
        },
      },
      volumes: { cache: { name: "a_cache" } },
      networks: { default: { name: "a_default" } },
    };
    expect(risks(config, { services: { web: { env_file: [{ path: "/apps/a/src/.env" }] } } })).toEqual([]);
  });
  it("names every setting that reaches past the app, also ones it does not know", () => {
    const config = {
      services: {
        evil: {
          privileged: true,
          cap_add: ["SYS_ADMIN"],
          pid: "host",
          provider: { type: "./evil.sh" },
          volumes_from: ["container:other"],
          post_start: [{ command: "x", privileged: true }],
          ports: ["0.0.0.0:22:22"],
          security_opt: ["seccomp=./allow.json"],
          build: { context: "/", additional_contexts: { host: "/" } },
          networks: { other_default: null },
          volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/s" }],
        },
      },
      volumes: { theirs: { external: true, name: "b_data" }, root: { driver_opts: { o: "lowerdir=/" } } },
      networks: { other_default: { external: true, name: "b_default" } },
      secrets: { token: { file: "/home/kitshn/.config/kitshn/join.json" } },
    };
    const uninterpolated = { services: { evil: { env_file: [{ path: "/apps/b/params.env" }] } } };
    expect(risks(config, uninterpolated)).toEqual([
      "bind:/var/run/docker.sock",
      "build:/",
      "cap_add",
      "env_file:/apps/b/params.env",
      "file:/home/kitshn/.config/kitshn/join.json",
      "network:b_default",
      "pid",
      "ports",
      "post_start",
      "privileged",
      "provider",
      "security_opt",
      "volume:root",
      "volume:theirs",
      "volumes_from",
    ]);
  });
  it("follows symlinks of the part of a path that exists, also when the rest does not exist yet", () => {
    const links: Record<string, string> = { "/apps/a/src/etc": "/etc" };
    const exists = (path: string) => path === "/apps/a/src/etc" || !path.startsWith("/apps/a/src/etc");
    const real = (path: string) => realpathOf(path, (p) => links[p] ?? p, exists);
    expect(real("/apps/a/src/etc/systemd/system/ssh.service.d")).toBe("/etc/systemd/system/ssh.service.d");
    const config = {
      services: { web: { volumes: [{ type: "bind", source: "/apps/a/src/etc/systemd", target: "/x" }] } },
    };
    expect(composeRisks(config, "a", roots, real)).toEqual([
      "bind:/apps/a/src/etc/systemd",
      "link:/apps/a/src/etc/systemd",
    ]);
    expect(bindSources(config)).toEqual(["/apps/a/src/etc/systemd"]);
  });
  it("keeps values of safe keys inside the app: names, logging, networks, build inputs", () => {
    const config = {
      services: {
        web: {
          build: {
            context: "/apps/a/src",
            dockerfile: "../../b/Dockerfile",
            tags: ["postgres:16"],
            cache_from: ["type=local,src=/"],
          },
          image: "busybox:1.38",
          container_name: "b-web",
          logging: { driver: "fluentd", options: { "fluentd-address": "unix:///run/x.sock" } },
          networks: { "kitshn-edge": { aliases: ["other-db"] } },
        },
        ok: {
          build: { context: "/apps/a/src" },
          image: "a-ok",
          container_name: "a-ok",
          logging: { driver: "local", options: { "max-size": "10m" } },
        },
      },
      networks: { inner: { ipam: { config: [{ subnet: "169.254.0.0/16" }] } } },
      secrets: { s: { environment: "HOME" } },
    };
    expect(risks(config)).toEqual([
      "build.cache_from",
      "build.tags",
      "build:../../b/Dockerfile",
      "container_name",
      "image",
      "logging",
      "network:inner",
      "network:kitshn-edge",
      "networks.options",
      "secrets.environment",
    ]);
  });
  it("names only the app's own service as an image, container or build tag", () => {
    const named = (name: string, tag: string) => ({
      services: {
        web: { build: { context: "/apps/a/src", tags: [tag] }, image: name, container_name: name },
      },
    });
    const preview = (config: unknown) => composeRisks(config, "a-pr-1", roots, same);
    expect(preview(named("a-pr-1-web", "a-pr-1-web:v2"))).toEqual([]);
    // Another app's project starts with this one's name: a-pr-12 owns a-pr-12-web.
    expect(preview(named("a-pr-12-web", "a-pr-12-web:latest"))).toEqual([
      "build.tags",
      "container_name",
      "image",
    ]);
    expect(preview(named("a-pr-1-db", "a-pr-1-web:5000/x"))).toEqual([
      "build.tags",
      "container_name",
      "image",
    ]);
  });
  it("needs an allowance for the shared kitshn-edge network, also under another key", () => {
    const config = {
      services: { web: { networks: { edge: null } } },
      networks: { edge: { name: "kitshn-edge", external: true } },
    };
    expect(risks(config)).toEqual(["network:kitshn-edge"]);
  });
});

describe("real apps (K-818)", () => {
  // `docker compose config --format json` of real repos, with placeholder params and values.
  const real = (repo: string) => {
    const project = `${repo}-prod`;
    const config: unknown = JSON.parse(
      readFileSync(new URL(`fixtures/${repo}.config.json`, import.meta.url), "utf8"),
    );
    const folders = ["src", "data", "logs", "sockets"].map((folder) => `/apps/${project}/${folder}`);
    return composeRisks(config, project, [folders[0] ?? "", ...folders.slice(1)], same);
  };
  it("passes real apps, and names only the settings that they really need", () => {
    expect(real("tick3d")).toEqual([]);
    expect(real("riffle")).toEqual([]);
    expect(real("dozzle")).toEqual(["bind:/var/run/docker.sock"]);
    expect(real("gr52")).toEqual(["network:kitshn-edge"]);
  });
});

describe("binds under other binds (K-818)", () => {
  const bind = (source: string, readOnly = false) => ({
    type: "bind",
    source,
    target: `/m${source}`,
    read_only: readOnly,
  });
  const app = (...services: Array<Array<ReturnType<typeof bind>>>) => ({
    services: Object.fromEntries(services.map((volumes, index) => [`s${index}`, { volumes }])),
  });
  // Docker follows symlinks at each start: the app can turn data/x into a link to / through /m/apps/a/data.
  it("refuses a bind or file source under a writable bind of any service", () => {
    expect(risks(app([bind("/apps/a/data"), bind("/apps/a/data/x")]))).toEqual(["nested:/apps/a/data/x"]);
    expect(risks(app([bind("/apps/a/src")], [bind("/apps/a/src/sub")]))).toEqual(["nested:/apps/a/src/sub"]);
    const secret = { ...app([bind("/apps/a/data")]), secrets: { key: { file: "/apps/a/data/key" } } };
    expect(risks(secret)).toEqual(["nested:/apps/a/data/key"]);
  });
  it("passes the same root twice, and paths under a read-only bind", () => {
    expect(risks(app([bind("/apps/a/sockets")], [bind("/apps/a/sockets")]))).toEqual([]);
    expect(risks(app([bind("/apps/a/data", true), bind("/apps/a/data/x")]))).toEqual([]);
  });
  // A link can change after the check: the app re-points it through a writable bind before a restart.
  it("refuses a bind or file source that is a link, also one that the repo ships", () => {
    const links: Record<string, string> = {
      "/apps/a/data/link": "/apps/a/src/sub",
      "/apps/a/src/link": "/apps/a/src/sub",
    };
    const real = (path: string) => links[path] ?? path;
    const check = (config: unknown) => composeRisks(config, "a", roots, real);
    expect(check(app([bind("/apps/a/src")], [bind("/apps/a/data/link")]))).toEqual([
      "link:/apps/a/data/link",
      "nested:/apps/a/data/link",
    ]);
    expect(check(app([bind("/apps/a/src")], [bind("/apps/a/src/link")]))).toEqual([
      "link:/apps/a/src/link",
      "nested:/apps/a/src/link",
    ]);
    expect(check({ secrets: { key: { file: "/apps/a/src/link" } } })).toEqual(["link:/apps/a/src/link"]);
  });
  it("passes an app folder that is itself a link, as /var is on macOS", () => {
    const real = (path: string) => path.replace("/apps/", "/private/apps/");
    expect(composeRisks(app([bind("/apps/a/data/x")]), "a", roots, real)).toEqual([]);
  });
  it("compares the paths after symlinks", () => {
    const real = (path: string) => (path === "/apps/a/data/link" ? "/apps/a/src/sub" : path);
    const config = app([bind("/apps/a/src")], [bind("/apps/a/data/link")]);
    expect(nestedSources(config, real)).toEqual(["/apps/a/data/link"]);
  });
});

describe("settings that need no allowance (K-818)", () => {
  it("passes scale, profiles, extra hosts, internal networks and build contexts in the source", () => {
    const config = {
      services: {
        web: {
          scale: 2,
          profiles: ["web"],
          extra_hosts: ["host.docker.internal:host-gateway"],
          build: { context: "/apps/a/src", additional_contexts: { git: "/apps/a/src/.git" } },
          networks: { inner: null },
        },
      },
      networks: { inner: { name: "a_inner", internal: true, ipam: {} } },
    };
    expect(risks(config)).toEqual([]);
  });
  it("keeps build inputs and env files in the new source, which no running container can change", () => {
    const config = {
      services: {
        web: { build: { context: "/apps/a/data", additional_contexts: { up: "/apps/a/data/x" } } },
      },
    };
    const uninterpolated = { services: { web: { env_file: ["/apps/a/data/.env"] } } };
    expect(risks(config, uninterpolated)).toEqual([
      "build:/apps/a/data",
      "build:/apps/a/data/x",
      "env_file:/apps/a/data/.env",
    ]);
  });
  it("refuses labels in the namespace of Compose", () => {
    const config = { services: { web: { labels: { "com.docker.compose.project": "b" } } } };
    expect(risks(config)).toEqual(["labels"]);
  });
});

describe("data of a spread app (K-826)", () => {
  it("names each volume and each bind below the data folder, and passes binds of the source", () => {
    const config = {
      services: {
        web: {
          volumes: [
            { type: "bind", source: "/apps/a/src/config.yml", target: "/config.yml" },
            { type: "bind", source: "/apps/a/data/db", target: "/db" },
            { type: "tmpfs", target: "/tmp" },
          ],
        },
        cache: {
          volumes: [
            { type: "volume", source: "cache", target: "/cache" },
            { type: "volume", target: "/x" },
          ],
        },
      },
    };
    expect(spreadData(config, "/apps/a/data", same)).toEqual([
      "cache: volume (anonymous)",
      "cache: volume cache",
      "web: bind /apps/a/data/db",
    ]);
    expect(spreadData({ services: { web: { image: "nginx" } } }, "/apps/a/data", same)).toEqual([]);
  });
});

describe("raw Compose files (K-818)", () => {
  it("finds include and extends in every YAML form that Compose reads", () => {
    const files = [
      "include:\n  - ../other.yml\nservices:\n  web:\n    extends:\n      file: /x.yml\n",
      '"include":\n  - ../other.yml\nservices:\n  web:\n    "extends": {file: /x.yml, service: a}\n',
      "include :\n  - ../other.yml\nservices:\n  web:\n    extends :\n      file: /x.yml\n",
      "{include: [../other.yml], services: {web: {extends: {file: /x.yml, service: a}}}}",
      '{"include": ["../other.yml"], "services": {"web": {"extends": {"file": "/x.yml", "service": "a"}}}}',
      "x-base: &base\n  extends: {file: /x.yml, service: a}\n<<: {include: [../other.yml]}\nservices:\n  web:\n    <<: *base\n",
    ];
    for (const file of files) expect(rawRisks(file)).toEqual(["include", "extends"]);
    expect(rawRisks("services:\n  web:\n    image: a-web\n")).toEqual([]);
  });
  it("refuses a file that is not one YAML mapping", () => {
    expect(() => rawRisks("services: [\n")).toThrow();
    expect(() => rawRisks("services: {}\n---\ninclude: [../other.yml]\n")).toThrow();
    expect(() => rawRisks("<<: 5\nservices: {}\n")).toThrow();
  });
});

describe("Compose files of an app (K-818)", () => {
  const source = "/apps/a/src";
  const files = (present: ReadonlyArray<string>, file: string | null = null) =>
    composeFiles(source, file, (path) => present.includes(path), same);
  it("picks the files that Compose picks on its own: one main file and its override", () => {
    expect(
      files([
        "/apps/a/src/compose.yml",
        "/apps/a/src/docker-compose.yml",
        "/apps/a/src/compose.override.yaml",
      ]),
    ).toEqual(["/apps/a/src/compose.yml", "/apps/a/src/compose.override.yaml"]);
    expect(() => files([])).toThrow();
  });
  it("takes a named file only inside the source, and only when it exists", () => {
    expect(files(["/apps/a/src/deploy/compose.yml"], "deploy/compose.yml")).toEqual([
      "/apps/a/src/deploy/compose.yml",
    ]);
    expect(() => files(["/apps/a/src/deploy/compose.yml"], "compose.yml")).toThrow();
    expect(() => files(["/apps/b/src/compose.yml"], "../../b/src/compose.yml")).toThrow();
    expect(() => files(["/etc/compose.yml"], "/etc/compose.yml")).toThrow();
    const linked = (path: string) => (path === "/apps/a/src/compose.yml" ? "/apps/b/src/compose.yml" : path);
    expect(() => composeFiles(source, "compose.yml", () => true, linked)).toThrow();
    // The app folder itself may be a link, as /var is on macOS.
    const moved = (path: string) => path.replace("/apps/", "/private/apps/");
    expect(composeFiles(source, "compose.yml", () => true, moved)).toEqual(["/apps/a/src/compose.yml"]);
  });
});

describe("links on disk (K-818)", () => {
  it("fails on a dangling link, also as a middle folder, instead of passing it as a new folder", () => {
    const app = mkdtempSync(join(tmpdir(), "kitshn-guard-"));
    try {
      mkdirSync(join(app, "data"));
      symlinkSync(join(app, "missing-later"), join(app, "data", "dangling"));
      expect(() => realpathOnDisk(join(app, "data", "dangling"))).toThrow(/target is missing/);
      expect(() => realpathOnDisk(join(app, "data", "dangling", "sub"))).toThrow(/target is missing/);
      expect(realpathOnDisk(join(app, "data", "new", "folder")).endsWith("/data/new/folder")).toBe(true);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });
});
