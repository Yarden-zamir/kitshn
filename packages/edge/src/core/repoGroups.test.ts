import { describe, expect, it } from "vitest";
import { seed } from "./seed.ts";
import type { Resource, State } from "./model.ts";
import { githubWayOf, matchProblem, repoGroupId, repoGroupMatches } from "./repoGroups.ts";

describe("repo groups (K-1733, K-1760)", () => {
  it("matches an owner, a name, or a pattern with one *, in any case", () => {
    expect(repoGroupMatches("Yarden-zamir", "yarden-zamir/riffle")).toBe(true);
    expect(repoGroupMatches("Yarden-zamir/trek-*", "Yarden-zamir/trek-gr52")).toBe(true);
    expect(repoGroupMatches("Yarden-zamir/trek-*", "Yarden-zamir/riffle")).toBe(false);
    expect(repoGroupMatches("Yarden-zamir/*-site", "Yarden-zamir/my-site")).toBe(true);
    expect(repoGroupMatches("Yarden-zamir/riffle", "Yarden-zamir/riffle2")).toBe(false);
    expect(repoGroupMatches("Yarden-zamir", "other/riffle")).toBe(false);
  });

  it("refuses a match with two stars, more parts or other characters", () => {
    expect(matchProblem("Yarden-zamir/trek-*")).toBeNull();
    for (const bad of ["", "a/*b*", "a/b/c", "a b", "a/"])
      expect(matchProblem(bad)).toEqual(expect.any(String));
  });

  it("makes a card id of a-z, 0-9 and dashes", () => {
    expect(repoGroupId("Yarden-zamir/trek-*")).toBe("repo-group-yarden-zamir--trek-x");
  });

  it("takes the way of the owner group, else the default", () => {
    const s = seed(["owner@example.com"], "kit.example.com");
    const group: Resource = {
      id: "repo-group-yarden-zamir",
      kind: "repo.group",
      name: "Yarden-zamir",
      addresses: [],
      status: "unknown",
      group: null,
      machine: null,
      match: "Yarden-zamir",
      githubWay: "app",
    };
    const state: State = {
      circles: new Map(s.circles.map((circle) => [circle.id, circle])),
      resources: new Map([[group.id, group]]),
      places: new Map(),
      shareSettings: new Map(),
      ends: new Map(),
      stacks: new Map(),
      paused: null,
      machines: new Map(),
      actors: new Map(s.actors.map((actor) => [actor.id, actor])),
    };
    expect(githubWayOf(state, "yarden-zamir", "not-kitshn")).toBe("app");
    expect(githubWayOf(state, "qlik-trial", "not-kitshn")).toBe("not-kitshn");
  });
});
