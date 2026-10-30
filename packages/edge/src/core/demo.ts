import { type Usage, analyticsRows, countRows } from "./usage.ts";
import type { MachineOs } from "./icons.ts";
import type { Machine } from "./machine.ts";
import type { Circle, Point, Resource } from "./model.ts";

/** K-524: the demo machines, offline, with the system of their last status, so their cards show it. */
export const DEMO_MACHINES: ReadonlyArray<{ readonly machine: Machine; readonly os: MachineOs }> = [
  {
    machine: {
      id: "mac",
      name: "Mac",
      labels: ["laptop"],
      order: 0,
      serviceTokenId: "demo-mac",
      clientId: "demo-mac.access",
      tunnelId: "demo-mac",
    },
    os: "macos",
  },
  {
    machine: {
      id: "vps",
      name: "VPS",
      labels: ["server", "deploy"],
      order: 1,
      serviceTokenId: "demo-vps",
      clientId: "demo-vps.access",
      tunnelId: "demo-vps",
    },
    os: "linux",
  },
];

/** K-1113: the stored icon of the demo static site. */
export const DEMO_ICONS = [
  {
    id: "tick3d",
    type: "image/svg+xml",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#FFE14D"/><path d="M7 17l6 6L25 9" fill="none" stroke="#000" stroke-width="5"/></svg>',
  },
  // K-1114: a Compose app with the icon of the running app.
  {
    id: "riffle",
    type: "image/svg+xml",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#8B5CF6"/><path d="M6 22c4-10 8-10 10 0s6 10 10 0" fill="none" stroke="#fff" stroke-width="4"/></svg>',
  },
] as const;

/** Local development only (DEV_DEMO): sample cards and circles, so the map has something to show. */
export function demo() {
  const resource = (
    id: string,
    kind: Resource["kind"],
    name: string,
    address: string | null,
    group: string | null = null,
  ): Resource => ({
    id,
    kind,
    name,
    addresses: address ? [address] : [],
    status: "running",
    group,
    machine: null,
  });
  const resources = [
    resource("mac", "machine", "Mac", "t3-mac.example.com"),
    resource("vps", "machine", "VPS", "t3-vps.example.com"),
    resource("riffle", "site.compose", "riffle", "riffle.example.com", "riffle"),
    resource("riffle-pr-41", "site.compose", "riffle pr-41", "riffle-pr-41.example.com", "riffle"),
    resource("riffle-pr-42", "site.compose", "riffle pr-42", "riffle-pr-42.example.com", "riffle"),
    resource("tick3d", "site.static", "tick3d", "tick3d.example.com"),
    resource("ci-times", "page", "CI time table", null),
    resource("slides", "file", "slides.pdf", null),
    resource("kitshn-repo", "repo", "Yarden-zamir/kitshn", null),
  ];
  const places: Array<readonly [string, Point]> = [
    ["mac", { x: -175, y: -190 }],
    ["vps", { x: 120, y: -190 }],
    ["riffle", { x: 250, y: 120 }],
    ["riffle-pr-41", { x: 250, y: 120 }],
    ["riffle-pr-42", { x: 250, y: 120 }],
    ["tick3d", { x: 760, y: 40 }],
    ["kitshn-repo", { x: 760, y: 200 }],
  ];
  const her: Circle = {
    id: "her",
    name: "Her",
    color: "#FF5277",
    level: "use",
    members: [{ _tag: "email", email: "her@example.com" }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 380,
    y: 360,
    r: 240,
  };
  const qlik: Circle = {
    id: "qlik",
    name: "Qlik",
    color: "#00B3FF",
    level: "view",
    members: [
      { _tag: "domain", domain: "qlik.com" },
      { _tag: "ip", range: "10.0.0.0/8" },
    ],
    match: "all",
    needsPasskey: false,
    endsAt: null,
    x: -300,
    y: 520,
    r: 220,
  };
  // K-718: an agent key that manages the sites in its circle, and nothing else.
  const agents: Circle = {
    id: "agents",
    name: "Agents",
    color: "#14B8A6",
    level: "control",
    members: [{ _tag: "device", tokenId: "demo-agent", clientId: "demo-agent.access", name: "Deploy bot" }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 760,
    y: 600,
    r: 200,
  };
  return { resources, places, circles: [her, qlik, agents] };
}

/**
 * Local development only (DEV_DEMO=teams): the map of a small company, for the teams pages. Engineering has the
 * company domain, Design two people, a contractor one email for a week, the office a domain and a network, and an
 * agent key manages staging. The machines and the repo gate are the same as in `demo()`.
 */
export function teamsDemo(now: number) {
  const resource = (
    id: string,
    kind: Resource["kind"],
    name: string,
    address: string | null,
    group: string | null = null,
  ): Resource => ({
    id,
    kind,
    name,
    addresses: address ? [address] : [],
    status: "running",
    group,
    machine: null,
  });
  const resources = [
    resource("mac", "machine", "Mac", "t3-mac.example.com"),
    resource("vps", "machine", "VPS", "t3-vps.example.com"),
    resource("admin-panel", "site.worker", "Admin panel", "admin.acme.dev"),
    resource("api", "site.compose", "api", "api.acme.dev", "api"),
    resource("api-pr-118", "site.compose", "api pr-118", "api-pr-118.acme.dev", "api"),
    resource("api-pr-121", "site.compose", "api pr-121", "api-pr-121.acme.dev", "api"),
    resource("design-system", "site.static", "Design system", "ds.acme.dev"),
    resource("launch", "site.static", "Launch page", "launch.acme.dev"),
    resource("docs", "site.static", "Docs", "docs.acme.dev"),
    resource("status", "site.static", "Status", "status.acme.dev"),
    resource("metabase", "site.compose", "Metabase", "bi.acme.dev"),
    resource("handbook", "file", "handbook.pdf", null),
    resource("staging", "site.compose", "staging", "staging.acme.dev"),
    resource("experiment", "site.static", "experiment", "experiment.acme.dev"),
    resource("platform-repo", "repo", "acme/platform", null),
  ];
  const places: Array<readonly [string, Point]> = [
    ["mac", { x: -175, y: -190 }],
    ["vps", { x: 120, y: -190 }],
    ["admin-panel", { x: -90, y: 640 }],
    ["api", { x: -40, y: 800 }],
    ["api-pr-118", { x: -40, y: 800 }],
    ["api-pr-121", { x: -40, y: 800 }],
    ["design-system", { x: 230, y: 740 }],
    ["launch", { x: 900, y: 660 }],
    ["docs", { x: 700, y: -40 }],
    ["status", { x: 820, y: 80 }],
    ["metabase", { x: -600, y: 260 }],
    ["handbook", { x: -540, y: 380 }],
    ["staging", { x: 1250, y: 220 }],
  ];
  const circle = (
    id: string,
    name: string,
    color: string,
    level: Circle["level"],
    members: Circle["members"],
    [x, y, r]: readonly [number, number, number],
    more: Partial<Pick<Circle, "match" | "needsPasskey" | "endsAt">> = {},
  ): Circle => ({
    id,
    name,
    color,
    level,
    members,
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x,
    y,
    r,
    ...more,
  });
  const circles = [
    circle(
      "engineering",
      "Engineering",
      "#8B5CF6",
      "control",
      [{ _tag: "domain", domain: "acme.dev" }],
      [0, 700, 280],
      {
        needsPasskey: true,
      },
    ),
    circle(
      "design",
      "Design",
      "#FF5277",
      "use",
      [
        { _tag: "email", email: "maya@acme.dev" },
        { _tag: "email", email: "noa@acme.dev" },
      ],
      [440, 740, 220],
    ),
    circle(
      "contractor",
      "Contractor",
      "#FFB347",
      "view",
      [{ _tag: "email", email: "dana@studio.example" }],
      [900, 660, 180],
      {
        endsAt: now + 7 * 86_400_000,
      },
    ),
    circle(
      "office",
      "Office",
      "#00B3FF",
      "use",
      [
        { _tag: "domain", domain: "acme.dev" },
        { _tag: "ip", range: "10.20.0.0/16" },
      ],
      [-570, 320, 220],
      { match: "all" },
    ),
    circle(
      "ci",
      "CI bots",
      "#14B8A6",
      "control",
      [{ _tag: "device", tokenId: "demo-agent", clientId: "demo-agent.access", name: "Deploy bot" }],
      [1250, 220, 190],
    ),
  ];
  return { resources, places, circles };
}

/** K-1303: the Usage view of the local demo, so captures show each level without a Cloudflare account. */
export const demoUsage = (now: number): Usage => ({
  at: now,
  rows: [
    ...analyticsRows(
      {
        workers: [{ sum: { requests: 6_100 } }],
        objects: [
          { sum: { requests: 2_500 }, dimensions: { type: "alarm" } },
          { sum: { requests: 36_000 }, dimensions: { type: "hibernation" } },
        ],
        rows: [{ sum: { rowsRead: 4_210_000, rowsWritten: 7_600 } }],
        objectStorage: [{ max: { storedBytes: 36_800_000 } }],
        d1: [{ sum: { rowsRead: 100, rowsWritten: 44 } }],
        d1Storage: null,
        kv: [
          { sum: { requests: 424 }, dimensions: { actionType: "read" } },
          { sum: { requests: 850 }, dimensions: { actionType: "write" } },
        ],
        kvStorage: [{ max: { byteCount: 85_000 } }],
        r2: [
          { sum: { requests: 1_200 }, dimensions: { actionType: "PutObject" } },
          { sum: { requests: 3_400 }, dimensions: { actionType: "GetObject" } },
        ],
        r2Storage: [{ max: { payloadSize: 21_900_000, metadataSize: 1_400 } }],
      },
      { d1Storage: "not authorized for that account" },
    ),
    ...countRows({
      seats: { used: 2 },
      applications: { used: 47 },
      serviceTokens: { used: 12 },
      scripts: { used: 18 },
      zones: [
        {
          name: "example.com",
          records: { used: 70 },
          createdOn: { used: Date.parse("2026-09-29T00:00:00Z") },
        },
      ],
    }),
  ],
});
